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
}

export const DEFAULT_SETTINGS: Readonly<KataSettings> = {
	executable: "kata",
	contract: true,
	contractSource: "",
	inbox: true,
	inboxPollSeconds: 15,
	wakeOnInbox: false,
	attention: true,
	identity: true,
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
};

interface PluginsModule {
	getPluginSettings(pluginName: string, cwd: string): Promise<Record<string, unknown>>;
}

/** Reads omp plugin settings; any failure (module missing, storage unreadable) yields no settings. */
export const loadPluginSettings: SettingsLoader = async cwd => {
	try {
		// Dynamic on purpose: the host provides this module; outside omp (unit tests, tooling) it may not resolve.
		const mod = (await import("@oh-my-pi/pi-coding-agent/extensibility/plugins")) as unknown as PluginsModule;
		const settings = await mod.getPluginSettings(PLUGIN_NAME, cwd);
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
	return result as unknown as KataSettings;
}
