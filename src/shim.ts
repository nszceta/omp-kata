import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Env } from "./config";
import { type Identity, shellQuote } from "./identity";

/** The shim script shipped with the package. */
export const SHIM_SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/kata");

/** Text of `<state>/<sessionId>.env`, sourced by the shim just before it execs the real kata. */
export function renderIdentityFile(identity: Identity, realExecutable: string | undefined): string {
	const lines = [
		`KATA_AUTHOR=${shellQuote(identity.actor)}; export KATA_AUTHOR`,
		identity.teammate === ""
			? "unset KATA_TEAMMATE"
			: `KATA_TEAMMATE=${shellQuote(identity.teammate)}; export KATA_TEAMMATE`,
		`KATA_INBOX_USER=${shellQuote(identity.inboxUser)}; export KATA_INBOX_USER`,
	];
	if (realExecutable) lines.push(`OMP_KATA_REAL=${shellQuote(realExecutable)}; export OMP_KATA_REAL`);
	return `${lines.join("\n")}\n`;
}

/** State dirs are `omp-kata-<pid>-XXXXXX`: the pid lets a later process recognise leftovers of dead ones. */
export const STATE_DIR_PREFIX = "omp-kata-";
const STATE_DIR_NAME = /^omp-kata-(\d+)-[A-Za-z0-9]{6}$/;

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: exists but belongs to someone else, so it is alive.
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/**
 * Removes `omp-kata-<pid>-XXXXXX` directories in `root` whose process is gone (crash, SIGKILL, SIGTERM:
 * the exit hook cannot run then). Live pids, our own pid and any other name are left alone.
 * Returns the removed directory names.
 */
export function sweepStaleStateDirs(root: string): string[] {
	const removed: string[] = [];
	let names: string[];
	try {
		names = readdirSync(root);
	} catch {
		return removed;
	}
	for (const name of names) {
		const match = STATE_DIR_NAME.exec(name);
		if (!match) continue;
		const pid = Number(match[1]);
		if (pid === process.pid || isProcessAlive(pid)) continue;
		const path = join(root, name);
		try {
			if (!lstatSync(path).isDirectory()) continue;
			rmSync(path, { recursive: true, force: true });
			removed.push(name);
		} catch {
			// not ours to remove (permissions) or already gone
		}
	}
	return removed;
}

const PREFIX_VAR = "__omp_kata_d";
const PREFIX_END = `unset ${PREFIX_VAR};`;

/**
 * omp runs `${PI_SHELL_PREFIX} ${command}` for every bash command. Ours strips any existing occurrence of
 * the shim dir from PATH and prepends it, so the shim stays first no matter how rc files rebuilt PATH and
 * the persistent shell's PATH never grows. A user's own prefix is kept after ours; a previous
 * omp-kata prefix (other shim dir) is replaced, never stacked.
 */
export function composeShellPrefix(shimDir: string, existing: string | undefined): string {
	const mine = `${PREFIX_VAR}=${shellQuote(shimDir)}; PATH="$${PREFIX_VAR}:\${PATH#"$${PREFIX_VAR}":}"; ${PREFIX_END}`;
	const user = stripShellPrefix(existing);
	return user === "" ? mine : `${mine} ${user}`;
}

/** The user's own prefix: `value` without a prefix composed by composeShellPrefix. */
export function stripShellPrefix(value: string | undefined): string {
	if (!value) return "";
	if (!value.startsWith(`${PREFIX_VAR}=`)) return value;
	const end = value.indexOf(PREFIX_END);
	return end === -1 ? value : value.slice(end + PREFIX_END.length).trimStart();
}

/**
 * Delivers per-session kata identity without touching command text. A private per-process state
 * directory holds one env file per omp session id, and a `kata` shim script in a directory prepended
 * to PATH reads the file selected by PI_SESSION_ID (which omp sets for every bash command).
 *
 * `env` is the environment omp's bash tool inherits: process.env in production, a stand-in in tests.
 */
export class ShimHost {
	private stateDir: string | undefined;
	private shimDir: string | undefined;
	private exitHook = false;

	constructor(
		private readonly env: Env,
		private readonly options: { tmpRoot?: string; shimSource?: string } = {},
	) {}

	private ensureDirs(): { stateDir: string; shimDir: string } {
		if (!this.stateDir || !this.shimDir) {
			const root = this.options.tmpRoot ?? tmpdir();
			sweepStaleStateDirs(root);
			this.stateDir = mkdtempSync(join(root, `${STATE_DIR_PREFIX}${process.pid}-`));
			chmodSync(this.stateDir, 0o700);
			this.shimDir = join(this.stateDir, "bin");
			mkdirSync(this.shimDir, { mode: 0o700 });
			// A private copy: independent of the package directory's file modes and location.
			const target = join(this.shimDir, "kata");
			copyFileSync(this.options.shimSource ?? SHIM_SOURCE, target);
			chmodSync(target, 0o755);
			if (!this.exitHook) {
				this.exitHook = true;
				process.once("exit", () => this.dispose());
			}
		}
		return { stateDir: this.stateDir, shimDir: this.shimDir };
	}

	/** The real executable path: `executable` itself when it has a slash, else the first PATH hit outside the shim dir. */
	resolveReal(executable: string): string {
		if (executable.includes("/")) return executable;
		const path = (this.env.PATH ?? "")
			.split(delimiter)
			.filter(dir => dir !== "" && dir !== this.shimDir)
			.join(delimiter);
		return Bun.which(executable, { PATH: path }) ?? executable;
	}

	/** Creates the state dir and shim, prepends the shim dir to PATH once, exports OMP_KATA_* variables. Idempotent. */
	install(realExecutable: string): string {
		const { stateDir, shimDir } = this.ensureDirs();
		const parts = (this.env.PATH ?? "").split(delimiter);
		if (!parts.includes(shimDir)) this.env.PATH = [shimDir, ...parts.filter(Boolean)].join(delimiter);
		this.env.OMP_KATA_STATE_DIR = stateDir;
		this.env.OMP_KATA_REAL = realExecutable;
		// omp's bash tool rebuilds PATH from the user's rc files, which can put the real kata in front of
		// the shim; a command prefix (applied by omp's executor, invisible in tool-call history) restores it.
		const existing = this.env.PI_SHELL_PREFIX || this.env.CLAUDE_CODE_SHELL_PREFIX;
		this.env.PI_SHELL_PREFIX = composeShellPrefix(shimDir, existing);
		return stateDir;
	}

	identityPath(sessionId: string): string | undefined {
		return this.stateDir ? join(this.stateDir, `${sessionId}.env`) : undefined;
	}

	/** Atomically (temp file + rename) publishes the identity for one session id. */
	writeIdentity(sessionId: string, identity: Identity, realExecutable: string | undefined): void {
		const { stateDir } = this.ensureDirs();
		const target = join(stateDir, `${sessionId}.env`);
		const temp = `${target}.${process.pid}.tmp`;
		writeFileSync(temp, renderIdentityFile(identity, realExecutable), { mode: 0o600 });
		renameSync(temp, target);
	}

	removeIdentity(sessionId: string): void {
		const path = this.identityPath(sessionId);
		if (path) rmSync(path, { force: true });
	}

	/** Best-effort removal of everything this host created. */
	dispose(): void {
		if (this.stateDir) rmSync(this.stateDir, { recursive: true, force: true });
		this.stateDir = undefined;
		this.shimDir = undefined;
	}
}

let shared: ShimHost | undefined;

/** Process-wide host: all sessions (main and subagents) share one state dir and one PATH entry. */
export function sharedShimHost(): ShimHost {
	shared ??= new ShimHost(process.env);
	return shared;
}
