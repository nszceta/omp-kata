import type { KataCli } from "./kata";

const FETCH_TIMEOUT_MS = 5_000;

/** Number of requests in `kata inbox --context` output (one `- issue=...` line each). */
export function countRequests(text: string): number {
	return text.split("\n").filter(line => line.startsWith("- issue=")).length;
}

export function formatInbox(text: string, user: string): string {
	if (text === "") {
		return `<kata_inbox>\nKata inbox for "${user}" is now empty; earlier requests were cleared or handled.\n</kata_inbox>`;
	}
	return `<kata_inbox>\n${text}\n</kata_inbox>`;
}

export type IdleOutcome =
	| { kind: "wake"; payload: string; count: number }
	| { kind: "notify"; message: string; count: number };

/** Per-session inbox state: what was last delivered to the model, and when kata was last asked. */
export class InboxTracker {
	/** Text most recently delivered to the model; "" initially. */
	delivered = "";
	/** Requests in the most recent successful fetch. */
	count = 0;
	private lastCheck = Number.NEGATIVE_INFINITY;
	private notified = "";
	private checking = false;

	constructor(
		private readonly cli: KataCli,
		private readonly root: string,
		readonly user: string,
		private readonly pollSeconds: number,
	) {}

	/** inbox text ("" = empty), or undefined when kata failed or timed out. */
	async fetch(): Promise<string | undefined> {
		const result = await this.cli.run(["inbox", "--context", "--for", this.user], {
			cwd: this.root,
			timeoutMs: FETCH_TIMEOUT_MS,
		});
		if (result.code !== 0 || result.timedOut) return undefined;
		const text = result.stdout.trim();
		this.count = countRequests(text);
		return text;
	}

	/** True when a mid-turn poll is due (pollSeconds 0 = every call). */
	due(now: number): boolean {
		return this.pollSeconds === 0 || now - this.lastCheck >= this.pollSeconds * 1000;
	}

	/** Fetches and returns the payload to deliver when the inbox differs from what was delivered. */
	async check(now: number): Promise<string | undefined> {
		// Parallel tool results race: only one poll runs at a time so a payload is never delivered twice.
		if (this.checking) return undefined;
		this.checking = true;
		this.lastCheck = now;
		try {
			const text = await this.fetch();
			if (text === undefined || text === this.delivered) return undefined;
			this.delivered = text;
			return formatInbox(text, this.user);
		} finally {
			this.checking = false;
		}
	}

	/**
	 * Idle-session poll. With `wake` a new non-empty inbox is delivered (the caller starts a turn);
	 * otherwise it is only announced once per distinct text and stays undelivered, so the next prompt
	 * carries it.
	 */
	async idlePoll(wake: boolean): Promise<IdleOutcome | undefined> {
		if (this.checking) return undefined;
		const text = await this.fetch();
		if (text === undefined || text === "" || text === this.delivered) return undefined;
		if (wake) {
			this.delivered = text;
			return { kind: "wake", payload: formatInbox(text, this.user), count: this.count };
		}
		if (text === this.notified) return undefined;
		this.notified = text;
		return { kind: "notify", message: `kata: ${this.count} inbox request(s) for ${this.user}`, count: this.count };
	}
}
