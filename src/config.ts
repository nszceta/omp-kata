import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";

export const PLUGIN_NAME = "omp-kata";

export interface KataSettings {
	executable: string;
	contract: boolean;
	contractSource: string;
	inbox: boolean;
	inboxPollSeconds: number;
	wakeOnInbox: boolean;
	attention: boolean;
	/** Write the per-session identity file the PATH shim reads; false = shim passes straight through. */
	identity: boolean;
	/** What to do when a tool call would write a kata ref into repository content. */
	refGuard: RefGuardMode;
}

export type RefGuardMode = "block" | "warn" | "off";

/** Upper bound for `inboxPollSeconds`: a huge value overflows Node's timer range and can become a 1 ms loop. */
export const MAX_INBOX_POLL_SECONDS = 86_400;

export const DEFAULT_SETTINGS: Readonly<KataSettings> = {
	executable: "kata",
	contract: true,
	contractSource: "",
	inbox: true,
	inboxPollSeconds: 15,
	wakeOnInbox: false,
	attention: true,
	identity: true,
	refGuard: "block",
};

export const ENV_NAMES: Readonly<Record<keyof KataSettings, string>> = {
	executable: "OMP_KATA_EXECUTABLE",
	contract: "OMP_KATA_CONTRACT",
	contractSource: "OMP_KATA_CONTRACT_SOURCE",
	inbox: "OMP_KATA_INBOX",
	inboxPollSeconds: "OMP_KATA_INBOX_POLL_SECONDS",
	wakeOnInbox: "OMP_KATA_WAKE_ON_INBOX",
	attention: "OMP_KATA_ATTENTION",
	identity: "OMP_KATA_IDENTITY",
	refGuard: "OMP_KATA_REF_GUARD",
};

export type Env = Record<string, string | undefined>;
export type SettingsLoader = (cwd: string) => Promise<Record<string, unknown>>;

/** Each parser returns undefined for values it cannot interpret, so resolution falls through to the next source. */
export function parseBoolean(raw: unknown): boolean | undefined {
	if (typeof raw === "boolean") return raw;
	if (typeof raw === "number") return raw === 1 ? true : raw === 0 ? false : undefined;
	if (typeof raw !== "string") return undefined;
	switch (raw.trim().toLowerCase()) {
		case "true":
		case "1":
			return true;
		case "false":
		case "0":
			return false;
		default:
			return undefined;
	}
}

export function parseNonNegativeNumber(raw: unknown): number | undefined {
	let value: number;
	if (typeof raw === "number") value = raw;
	else if (typeof raw === "string" && raw.trim() !== "") value = Number(raw);
	else return undefined;
	return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseExecutable(raw: unknown): string | undefined {
	return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined;
}

export function parseRefGuardMode(raw: unknown): RefGuardMode | undefined {
	if (typeof raw !== "string") return undefined;
	const value = raw.trim().toLowerCase();
	return value === "block" || value === "warn" || value === "off" ? value : undefined;
}

function parseSource(raw: unknown): string | undefined {
	return typeof raw === "string" ? raw.trim() : undefined;
}

const PARSERS: { [K in keyof KataSettings]: (raw: unknown) => KataSettings[K] | undefined } = {
	executable: parseExecutable,
	contract: parseBoolean,
	contractSource: parseSource,
	inbox: parseBoolean,
	inboxPollSeconds: parseNonNegativeNumber,
	wakeOnInbox: parseBoolean,
	attention: parseBoolean,
	identity: parseBoolean,
	refGuard: parseRefGuardMode,
};

interface PluginsModule {
	getPluginSettings(pluginName: string, cwd: string): Promise<Record<string, unknown>>;
}

/**
 * omp's `getPluginSettings(name, cwd)` merges repository-controlled project overrides over user settings,
 * and this plugin's settings choose a command to execute and a prompt source. Scope every read to the
 * filesystem root, which cannot be repo content even if `HOME` points into a repository.
 */
const SETTINGS_SCOPE = parse(homedir()).root || parse(process.cwd()).root;

/** Reads user-level omp plugin settings; project-local overrides are deliberately ignored. Any failure yields no settings. */
export const loadPluginSettings: SettingsLoader = async _cwd => {
	try {
		// Dynamic on purpose: the host provides this module; outside omp (unit tests, tooling) it may not resolve.
		const mod = (await import("@oh-my-pi/pi-coding-agent/extensibility/plugins")) as unknown as PluginsModule;
		const settings = await mod.getPluginSettings(PLUGIN_NAME, SETTINGS_SCOPE);
		return settings && typeof settings === "object" ? settings : {};
	} catch {
		return {};
	}
};

export interface ResolveOptions {
	env?: Env;
	loader?: SettingsLoader;
}

/** env OMP_KATA_* > plugin settings > defaults; per key, an uninterpretable value falls through. */
export async function resolveSettings(cwd: string, options: ResolveOptions = {}): Promise<KataSettings> {
	const env = options.env ?? process.env;
	let stored: Record<string, unknown> = {};
	try {
		stored = (await (options.loader ?? loadPluginSettings)(cwd)) ?? {};
	} catch {
		stored = {};
	}
	const result: Record<string, unknown> = { ...DEFAULT_SETTINGS };
	for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof KataSettings)[]) {
		const parse = PARSERS[key] as (raw: unknown) => unknown;
		const fromEnv = env[ENV_NAMES[key]];
		const value = (fromEnv !== undefined ? parse(fromEnv) : undefined) ?? parse(stored[key]);
		if (value !== undefined) result[key] = value;
	}
	result.inboxPollSeconds = Math.min(result.inboxPollSeconds as number, MAX_INBOX_POLL_SECONDS);
	return result as unknown as KataSettings;
}

function isInside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function realOrSelf(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** Absolute path outside `root` and outside its real path (a workspace root may be a symlink). */
function safePath(value: string, root: string): boolean {
	if (!isAbsolute(value)) return false;
	const path = resolve(value);
	const roots = [root, realOrSelf(root)];
	const paths = [path, realOrSelf(path)];
	return !paths.some(candidate => roots.some(candidateRoot => isInside(candidateRoot, candidate)));
}

/**
 * Defense in depth for settings that reach a process spawn or the system prompt: `executable` must be
 * a bare PATH name or an absolute path outside the workspace, and `contractSource` must be absolute and
 * outside the workspace. Relative paths are resolved by kata against the workspace root, which is
 * exactly where repo-controlled files live.
 */
export function sanitizeSettings(settings: KataSettings, root: string): KataSettings {
	// Treat both separators as a path on every platform: on Windows `..\payload` is as dangerous as
	// `../payload`, and a bare name never needs either separator.
	const isPath = settings.executable.includes("/") || settings.executable.includes("\\");
	const executable =
		isPath && !safePath(settings.executable, root) ? DEFAULT_SETTINGS.executable : settings.executable;
	const contractSource =
		settings.contractSource !== "" && !safePath(settings.contractSource, root) ? "" : settings.contractSource;
	return { ...settings, executable, contractSource };
}
