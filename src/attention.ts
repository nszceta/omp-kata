import { asObject, parseJsonObject } from "./json";
import type { KataCli } from "./kata";
import { parseRefEvents } from "./refs";

/** The harness name is hashed into kata's attention owner id: start and end MUST use the same one. */
export const HARNESS = "pi";

const START_TIMEOUT_MS = 5_000;
/** kata's exit code for a missing (e.g. deleted) issue. */
const NOT_FOUND_EXIT = 4;

/** `proj#abcd` -> `abcd`: kata addresses one issue either way, so tracking keys on the short id. */
function refKey(ref: string): string {
	const hash = ref.indexOf("#");
	return hash === -1 ? ref : ref.slice(hash + 1);
}

/**
 * Tracks issues this session claimed and drives `kata agent-hook attention-native`.
 *
 * kata derives the owner id from the host pid and refuses to act when that pid is dead, so a
 * detached `end` that outlives omp would silently do nothing. Every call therefore also sets
 * KATA_SESSION_ID (kata's launcher-id override), which makes ownership independent of pid
 * liveness; start and end use the same value so they address the same owner.
 */
export class AttentionTracker {
	/** short id -> the spelling sent to kata and the session it was started under (needed to end it correctly). */
	private readonly tracked = new Map<string, { ref: string; sessionId: string }>();
	/** Bumped by endAll: an operation that captured an older value must not act after it. */
	private generation = 0;

	constructor(
		private readonly cli: KataCli,
		private readonly root: string,
		private readonly hostPid: number,
	) {}

	refs(): string[] {
		return [...this.tracked.values()].map(entry => entry.ref);
	}

	has(ref: string): boolean {
		return this.tracked.has(refKey(ref));
	}

	/** Value to hand to {@link unchanged}: taken before an await, checked after it. */
	checkpoint(): number {
		return this.generation;
	}

	/** False once {@link endAll} ran after `checkpoint` was taken. */
	unchanged(checkpoint: number): boolean {
		return checkpoint === this.generation;
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

	/** Starts attention for `ref` and tracks it once kata accepted the start. Already-tracked refs under the same session are no-ops. */
	async start(ref: string, sessionId: string): Promise<boolean> {
		const key = refKey(ref);
		const checkpoint = this.generation;
		if (this.tracked.get(key)?.sessionId === sessionId) return true;
		const result = await this.cli.run(this.args("start", ref, sessionId), {
			cwd: this.root,
			timeoutMs: START_TIMEOUT_MS,
			env: this.env(sessionId),
		});
		// shutdown/switch ended this tracker while kata ran: do not track a ref nobody will end
		if (result.code !== 0 || !this.unchanged(checkpoint)) return false;
		this.tracked.set(key, { ref, sessionId });
		return true;
	}

	/** An already-closed issue must not get attention (kata would still write metadata to it). */
	async isClosed(ref: string): Promise<boolean> {
		const result = await this.cli.run(["show", ref, "--json"], { cwd: this.root, timeoutMs: START_TIMEOUT_MS });
		if (result.code !== 0) return false;
		return asObject(parseJsonObject(result.stdout)?.issue)?.status === "closed";
	}

	/** Closed issues keep their attention state; ending would downgrade ok to needs-human. Returns whether the ref was tracked. */
	untrack(ref: string): boolean {
		return this.tracked.delete(refKey(ref));
	}

	/**
	 * Evicts refs nobody in this session works on any more: closed (often by a subagent or another
	 * session, which this tracker never sees), deleted, or now owned by another actor.
	 * Evicted refs are only untracked, never ended: ending would write needs-human onto an issue this
	 * session no longer owns. Refs whose state cannot be read are kept. Returns the evicted refs.
	 */
	async reconcile(): Promise<string[]> {
		const snapshot = [...this.tracked];
		const verdicts = await Promise.all(snapshot.map(([, entry]) => this.isInactive(entry.ref)));
		const evicted: string[] = [];
		snapshot.forEach(([key, entry], i) => {
			// a re-claim under another session while the checks ran is newer than the verdict
			if (!verdicts[i] || this.tracked.get(key)?.sessionId !== entry.sessionId) return;
			this.tracked.delete(key);
			evicted.push(entry.ref);
		});
		return evicted;
	}

	/** `kata status`: closed, not found, or owned by another actor. Unknown state counts as active. */
	private async isInactive(ref: string): Promise<boolean> {
		const result = await this.cli.run(["status", ref, "--json"], { cwd: this.root, timeoutMs: START_TIMEOUT_MS });
		if (result.code === NOT_FOUND_EXIT) return true;
		if (result.code !== 0) return false;
		const status = parseJsonObject(result.stdout);
		if (status?.issue_status === "closed") return true;
		// Unowned issues (no owner field) stay: KATA_REF attention starts without a claim.
		const { owner, actor } = status ?? {};
		return typeof owner === "string" && owner !== "" && typeof actor === "string" && actor !== "" && owner !== actor;
	}

	/** Applies the claim/close events of a successful bash command. Returns whether tracking changed. */
	async applyCommand(command: string, sessionId: string, names: readonly string[]): Promise<boolean> {
		const checkpoint = this.generation;
		let changed = false;
		for (const event of parseRefEvents(command, names)) {
			// a session switch/shutdown during an earlier start ends the tracker; later events must not start new refs
			if (!this.unchanged(checkpoint)) break;
			if (event.action === "claim") {
				if (this.tracked.get(refKey(event.ref))?.sessionId === sessionId) continue;
				if (await this.start(event.ref, sessionId)) changed = true;
			} else if (this.untrack(event.ref)) {
				changed = true;
			}
		}
		return changed;
	}

	/** Ends every tracked ref via detached processes (shutdown has a 2s budget) and clears tracking. */
	endAll(): string[] {
		const ended = this.refs();
		this.generation++;
		for (const { ref, sessionId } of this.tracked.values()) {
			this.cli.spawnDetached(this.args("end", ref, sessionId), { cwd: this.root, env: this.env(sessionId) });
		}
		this.tracked.clear();
		return ended;
	}
}
