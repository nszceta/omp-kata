import { accessSync, chmodSync, constants, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
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
 * Removes the shim of an enclosing omp (omp run from an omp bash command): its PATH entry, state
 * variables and shell prefix. Left in place they would route this process's kata calls through the
 * outer process's shim, even with `identity` off.
 */
export function detachInheritedShim(env: Env): void {
	// Shim dirs are `<root>/omp-kata-<pid>-XXXXXX/bin`.
	const isShimDir = (dir: string) => basename(dir) === "bin" && STATE_DIR_NAME.test(basename(dirname(dir)));
	if (env.PATH !== undefined) env.PATH = env.PATH.split(":").filter(dir => !isShimDir(dir)).join(":");
	delete env.OMP_KATA_STATE_DIR;
	delete env.OMP_KATA_REAL;
	for (const name of ["PI_SHELL_PREFIX", "CLAUDE_CODE_SHELL_PREFIX"] as const) {
		const value = env[name];
		if (value === undefined) continue;
		const user = stripShellPrefix(value);
		if (user === "") delete env[name];
		else env[name] = user;
	}
}

/** True when the kernel lets this process execute `path`: false on a noexec mount (EACCES). */
function canExecute(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * True for an absolute path that is a real directory (not a symlink) owned by this user and closed to
 * group and others. Anything else (for example a user's runtime dir inherited by `sudo -E`) could let
 * another account swap our state dir for its own, so it is not trusted to hold a shim we will run.
 */
function isPrivateOwnDir(path: string): boolean {
	if (!isAbsolute(path)) return false;
	try {
		// Without trailing slashes: `lstat("link/")` follows the link.
		const stat = lstatSync(path.replace(/\/+$/, "") || "/");
		return stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0;
	} catch {
		return false;
	}
}

export interface ShimHostOptions {
	/**
	 * Candidate roots for the state dir, tried in order. A single path or a list; default
	 * `$XDG_RUNTIME_DIR` (when a private directory of this user; normally exec-allowed) then the OS temp dir.
	 */
	tmpRoot?: string | readonly string[];
	/** Shim script to copy; default: the package's bin/kata. */
	shimSource?: string;
	/** Executability probe for the copied shim, injectable because a noexec mount needs privileges. */
	canExecute?: (path: string) => boolean;
	/** Platform to assume; default process.platform. Identity delivery is POSIX-only, so win32 never installs. */
	platform?: NodeJS.Platform;
}

/** Thrown by ShimHost.install when no candidate root can hold an executable shim. */
export class ShimUnavailableError extends Error {
	constructor(
		readonly attempts: readonly string[],
		reason?: string,
	) {
		super(reason ?? `no directory allows executing the kata shim (${attempts.join("; ")})`);
		this.name = "ShimUnavailableError";
	}
}

/**
 * Delivers per-session kata identity without touching command text. A private per-process state
 * directory holds one env file per omp session id, and a `kata` shim script in a directory prepended
 * to PATH reads the file selected by PI_SESSION_ID (which omp sets for every bash command).
 *
 * The state dir lives in the first candidate root where the copied shim is executable: PATH lookup
 * silently skips files on a noexec mount and would run the real kata, losing every identity.
 *
 * `env` is the environment omp's bash tool inherits: process.env in production, a stand-in in tests.
 */
export class ShimHost {
	private stateDir: string | undefined;
	private shimDir: string | undefined;
	private exitHook = false;
	/** Set once every root failed: later installs fail fast instead of retrying on each bash call. */
	private failure: ShimUnavailableError | undefined;
	private failureReported = false;

	constructor(
		private readonly env: Env,
		private readonly options: ShimHostOptions = {},
	) {
		detachInheritedShim(env);
	}

	private candidateRoots(): readonly string[] {
		const configured = this.options.tmpRoot;
		if (configured !== undefined) return typeof configured === "string" ? [configured] : configured;
		const runtime = this.env.XDG_RUNTIME_DIR;
		return runtime && isPrivateOwnDir(runtime) ? [runtime, tmpdir()] : [tmpdir()];
	}

	/** Creates the state dir and shim in `root`; removes the dir again and throws when the shim cannot run there. */
	private createIn(root: string): { stateDir: string; shimDir: string } {
		const stateDir = mkdtempSync(join(root, `${STATE_DIR_PREFIX}${process.pid}-`));
		try {
			chmodSync(stateDir, 0o700);
			const shimDir = join(stateDir, "bin");
			mkdirSync(shimDir, { mode: 0o700 });
			// A private copy: independent of the package directory's file modes and location.
			const target = join(shimDir, "kata");
			copyFileSync(this.options.shimSource ?? SHIM_SOURCE, target);
			chmodSync(target, 0o755);
			if (!(this.options.canExecute ?? canExecute)(target)) throw new Error("not executable (noexec mount?)");
			return { stateDir, shimDir };
		} catch (error) {
			rmSync(stateDir, { recursive: true, force: true });
			throw error;
		}
	}

	private ensureDirs(): { stateDir: string; shimDir: string } {
		if (this.stateDir && this.shimDir) return { stateDir: this.stateDir, shimDir: this.shimDir };
		if (this.failure) throw this.failure;
		if ((this.options.platform ?? process.platform) === "win32") {
			this.failure = new ShimUnavailableError([], "per-agent identity is POSIX-only (Linux, macOS, WSL) and unavailable on Windows");
			throw this.failure;
		}
		const attempts: string[] = [];
		for (const root of this.candidateRoots()) {
			try {
				const dirs = this.createIn(root);
				sweepStaleStateDirs(root);
				this.stateDir = dirs.stateDir;
				this.shimDir = dirs.shimDir;
				if (!this.exitHook) {
					this.exitHook = true;
					process.once("exit", () => this.dispose());
				}
				return dirs;
			} catch (error) {
				attempts.push(`${root}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		this.failure = new ShimUnavailableError(attempts);
		throw this.failure;
	}

	/**
	 * Warning text for the user when identity is disabled because no root could hold an executable shim,
	 * returned once per host (all sessions of the process share it); undefined otherwise.
	 */
	takeFailureNotice(): string | undefined {
		if (!this.failure || this.failureReported) return undefined;
		this.failureReported = true;
		return `kata identity disabled: ${this.failure.message}. kata commands run without per-agent identity.`;
	}

	/** The real executable path: `executable` itself when it has a slash, else the first PATH hit outside the shim dir. */
	resolveReal(executable: string): string {
		if (executable.includes("/")) return executable;
		const path = (this.env.PATH ?? "")
			.split(":")
			.filter(dir => dir !== "" && dir !== this.shimDir)
			.join(":");
		return Bun.which(executable, { PATH: path }) ?? executable;
	}

	/** Creates the state dir and shim, prepends the shim dir to PATH once, exports OMP_KATA_* variables. Idempotent. */
	install(realExecutable: string): string {
		const { stateDir, shimDir } = this.ensureDirs();
		const parts = (this.env.PATH ?? "").split(":");
		if (!parts.includes(shimDir)) this.env.PATH = [shimDir, ...parts.filter(Boolean)].join(":");
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
