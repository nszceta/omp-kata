import { asObject, parseJsonObject } from "./json";
import type { KataCli } from "./kata";
import { parseRefEvents } from "./refs";

/** The harness name is hashed into kata's attention owner id: start and end MUST use the same one. */
export const HARNESS = "pi";

const START_TIMEOUT_MS = 5_000;

/**
 * Tracks issues this session claimed and drives `kata agent-hook attention-native`.
 *
 * kata derives the owner id from the host pid and refuses to act when that pid is dead, so a
 * detached `end` that outlives omp would silently do nothing. Every call therefore also sets
 * KATA_SESSION_ID (kata's launcher-id override), which makes ownership independent of pid
 * liveness; start and end use the same value so they address the same owner.
 */
export class AttentionTracker {
	/** ref -> session id it was started under (needed to end it correctly after a session switch). */
	private readonly tracked = new Map<string, string>();

	constructor(
		private readonly cli: KataCli,
		private readonly root: string,
		private readonly hostPid: number,
	) {}

	refs(): string[] {
		return [...this.tracked.keys()];
	}

	has(ref: string): boolean {
		return this.tracked.has(ref);
	}

	private args(action: "start" | "end", ref: string, sessionId: string): string[] {
		return [
			"agent-hook",
			"attention-native",
			HARNESS,
			action,
			"--session",
			sessionId,
			"--host-pid",
			String(this.hostPid),
			"--ref",
			ref,
			"--workspace",
			this.root,
		];
	}

	private env(sessionId: string): Record<string, string> {
		return { KATA_SESSION_ID: `omp-${sessionId}` };
	}

	/** Starts attention for `ref` and tracks it. Already-tracked refs under the same session are no-ops. */
	async start(ref: string, sessionId: string): Promise<boolean> {
		if (this.tracked.get(ref) === sessionId) return true;
		this.tracked.set(ref, sessionId);
		const result = await this.cli.run(this.args("start", ref, sessionId), {
			cwd: this.root,
			timeoutMs: START_TIMEOUT_MS,
			env: this.env(sessionId),
		});
		return result.code === 0;
	}

	/** An already-closed issue must not get attention (kata would still write metadata to it). */
	async isClosed(ref: string): Promise<boolean> {
		const result = await this.cli.run(["show", ref, "--json"], { cwd: this.root, timeoutMs: START_TIMEOUT_MS });
		if (result.code !== 0) return false;
		return asObject(parseJsonObject(result.stdout)?.issue)?.status === "closed";
	}

	/** Closed issues keep their attention state; ending would downgrade ok to needs-human. */
	untrack(ref: string): void {
		this.tracked.delete(ref);
	}

	/** Applies the claim/close events of a successful bash command. Returns whether tracking changed. */
	async applyCommand(command: string, sessionId: string, names: readonly string[]): Promise<boolean> {
		let changed = false;
		for (const event of parseRefEvents(command, names)) {
			if (event.action === "claim") {
				if (this.tracked.get(event.ref) === sessionId) continue;
				await this.start(event.ref, sessionId);
				changed = true;
			} else if (this.tracked.delete(event.ref)) {
				changed = true;
			}
		}
		return changed;
	}

	/** Ends every tracked ref via detached processes (shutdown has a 2s budget) and clears tracking. */
	endAll(): string[] {
		const ended = this.refs();
		for (const [ref, sessionId] of this.tracked) {
			this.cli.spawnDetached(this.args("end", ref, sessionId), { cwd: this.root, env: this.env(sessionId) });
		}
		this.tracked.clear();
		return ended;
	}
}
