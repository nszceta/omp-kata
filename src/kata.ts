import { spawn } from "node:child_process";

export interface KataRunResult {
	/** Process exit code; -1 when the process could not be spawned or was killed on timeout. */
	code: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

export interface KataRunOptions {
	cwd: string;
	timeoutMs?: number;
	/** Overrides merged over the ambient environment; `undefined` removes a variable. */
	env?: Record<string, string | undefined>;
}

export const DEFAULT_TIMEOUT_MS = 10_000;

function mergeEnv(
	base: Record<string, string | undefined> | undefined,
	overrides?: Record<string, string | undefined>,
): Record<string, string> {
	const merged: Record<string, string | undefined> = { ...process.env, ...base, ...overrides };
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(merged)) {
		if (value !== undefined) out[key] = value;
	}
	return out;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Thin wrapper over the kata executable. No method throws: spawn failures, timeouts and
 * non-zero exits are all reported through the result so hooks can degrade instead of crashing.
 */
export class KataCli {
	/** `baseEnv` is layered over process.env for every call (hermetic runs); per-call `env` wins over both. */
	constructor(
		readonly executable: string,
		private readonly baseEnv?: Record<string, string | undefined>,
	) {}

	async run(args: string[], options: KataRunOptions): Promise<KataRunResult> {
		const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
		try {
			proc = Bun.spawn([this.executable, ...args], {
				cwd: options.cwd,
				env: mergeEnv(this.baseEnv, options.env),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
		} catch (error) {
			return { code: -1, stdout: "", stderr: errorMessage(error), timedOut: false };
		}

		// A grandchild (an auto-started kata daemon) can keep the pipes open after kata itself exits
		// or is killed, so the deadline resolves the call instead of waiting for pipe EOF.
		const { promise: deadline, resolve: expire } = Promise.withResolvers<KataRunResult>();
		const timer = setTimeout(() => {
			try {
				proc.kill();
			} catch {
				// already exited
			}
			expire({ code: -1, stdout: "", stderr: "", timedOut: true });
		}, timeoutMs);
		const completion = Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]).then(
			([stdout, stderr, code]): KataRunResult => ({ code, stdout, stderr, timedOut: false }),
			(error): KataRunResult => ({ code: -1, stdout: "", stderr: errorMessage(error), timedOut: false }),
		);
		try {
			return await Promise.race([completion, deadline]);
		} finally {
			clearTimeout(timer);
		}
	}

	/** Fire-and-forget: survives the host process exiting. Never throws. */
	spawnDetached(args: string[], options: Pick<KataRunOptions, "cwd" | "env">): void {
		try {
			const child = spawn(this.executable, args, {
				cwd: options.cwd,
				env: mergeEnv(this.baseEnv, options.env),
				detached: true,
				stdio: "ignore",
			});
			child.on("error", () => {});
			child.unref();
		} catch {
			// best effort
		}
	}
}
