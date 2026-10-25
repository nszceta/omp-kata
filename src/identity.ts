import type { Env } from "./config";
import { parseJsonObject } from "./json";
import type { KataCli } from "./kata";

export interface Identity {
	/** kata actor (`kata whoami`). */
	actor: string;
	/** Teammate attribution; "" means none. */
	teammate: string;
	/** Inbox address: `actor` or `actor/teammate`. */
	inboxUser: string;
}

/** The subset of omp's ExtensionAgentIdentity that identity depends on. */
export interface AgentIdentity {
	kind: "main" | "sub";
	id: string;
}

/**
 * Main agents may inherit teammate/inbox identity from the launching environment. Subagents run in
 * the same process and share process.env with the main agent, so their identity comes only from
 * their agent id; KATA_TEAMMATE / KATA_INBOX_USER from env are never consulted for them.
 */
export function deriveIdentity(agent: AgentIdentity, actor: string, env: Env): Identity {
	if (agent.kind === "sub") {
		return { actor, teammate: agent.id, inboxUser: `${actor}/${agent.id}` };
	}
	const teammate = env.KATA_TEAMMATE ?? "";
	const inboxUser = env.KATA_INBOX_USER || (teammate ? `${actor}/${teammate}` : actor);
	return { actor, teammate, inboxUser };
}

/** POSIX shell quoting; leaves plainly safe words unquoted. */
export function shellQuote(value: string): string {
	if (value !== "" && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

const actorCache = new Map<string, string>();

function actorKey(cli: KataCli, root: string, env: Env): string {
	return `${cli.executable}\0${root}\0${env.KATA_AUTHOR ?? ""}`;
}

/** `kata whoami --json` -> actor, cached per process per (executable, root, KATA_AUTHOR). Failures are not cached. */
export async function lookupActor(cli: KataCli, root: string, env: Env = process.env): Promise<string | undefined> {
	const key = actorKey(cli, root, env);
	const cached = actorCache.get(key);
	if (cached !== undefined) return cached;
	const result = await cli.run(["whoami", "--json"], { cwd: root, timeoutMs: 10_000, env });
	if (result.code !== 0) return undefined;
	const actor = parseJsonObject(result.stdout)?.actor;
	if (typeof actor !== "string" || actor === "") return undefined;
	actorCache.set(key, actor);
	return actor;
}

export function clearActorCache(root?: string): void {
	if (root === undefined) {
		actorCache.clear();
		return;
	}
	for (const key of [...actorCache.keys()]) {
		if (key.split("\0")[1] === root) actorCache.delete(key);
	}
}
