import type { KataSettings } from "./config";
import type { Identity } from "./identity";
import { asObject, parseJsonObject } from "./json";
import type { KataCli } from "./kata";

export type ContractResult = { ok: true; text: string } | { ok: false; reason: string };

export const CONTRACT_OPEN = "<kata_contract>";
export const CONTRACT_CLOSE = "</kata_contract>";

const FETCH_TIMEOUT_MS = 10_000;

const cache = new Map<string, Promise<ContractResult>>();

function cacheKey(cli: KataCli, source: string, root: string): string {
	return `${cli.executable}\0${source}\0${root}`;
}

async function fetchContract(cli: KataCli, source: string, root: string): Promise<ContractResult> {
	const args = ["agent-contract-hook", ...(source !== "" ? ["--source", source] : [])];
	const result = await cli.run(args, { cwd: root, timeoutMs: FETCH_TIMEOUT_MS });
	if (result.timedOut) return { ok: false, reason: "timed out" };
	if (result.code !== 0) {
		const detail = result.stderr.trim().split("\n")[0]?.slice(0, 80);
		return { ok: false, reason: `exit ${result.code}${detail ? `: ${detail}` : ""}` };
	}
	const parsed = parseJsonObject(result.stdout);
	if (!parsed) return { ok: false, reason: "invalid JSON from kata agent-contract-hook" };
	const text = asObject(parsed.hookSpecificOutput)?.additionalContext;
	if (typeof text !== "string") return { ok: false, reason: "unexpected hook output" };
	return { ok: true, text };
}

/** Fetches the contract through `kata agent-contract-hook`; successes are cached per (executable, source, root). */
export function getContract(cli: KataCli, settings: Pick<KataSettings, "contractSource">, root: string): Promise<ContractResult> {
	const key = cacheKey(cli, settings.contractSource, root);
	const hit = cache.get(key);
	if (hit) return hit;
	const pending = fetchContract(cli, settings.contractSource, root);
	cache.set(key, pending);
	void pending.then(result => {
		if (!result.ok && cache.get(key) === pending) cache.delete(key);
	});
	return pending;
}

export function clearContractCache(root?: string): void {
	if (root === undefined) {
		cache.clear();
		return;
	}
	for (const key of [...cache.keys()]) {
		if (key.split("\0")[2] === root) cache.delete(key);
	}
}

/**
 * omp-specific notes appended inside the contract block. Identity is set by the plugin for every kata
 * invocation, so agents must not set it themselves (it would be ignored and confuse attribution). The main
 * agent additionally owns tracker upkeep. The text is constant for a session, which keeps the system prompt cache-stable.
 */
export function ompAddendum(identity: Identity | undefined, main = false): string {
	return [
		"omp-kata: omp sets kata identity automatically for every agent in every bash command. Do NOT export KATA_AUTHOR, KATA_TEAMMATE or KATA_INBOX_USER yourself and do NOT put them in task assignments.",
		...(identity
			? [`identity: actor=${identity.actor} teammate=${identity.teammate || "(none)"} inbox=${identity.inboxUser}`]
			: []),
		"Attention starts automatically on `kata claim` and ends when the session ends; inbox requests arrive as <kata_inbox> messages.",
		"Kata refs (<project>#<id> or bare short ids) are tracker-local handles. NEVER write them into repository content: source, tests, docs, config, file or directory names, scratch paths, or commit messages. Describe the problem in words in the repo. Link the other way: record commit SHAs and doc paths on the issue (`kata comment`, `--evidence commit:<sha>`).",
		...(main
			? [
					"Main agent: keep kata current as you work, not only at the end. Whenever work you did or reviewed resolves an open issue, close it right away with evidence, but ONLY after verifying it: every acceptance criterion in the body and comments is met and you observed proof (test run, command output, commit SHA, reviewed subagent diff). Partial, unverified, or merely claimed work stays open: comment progress instead. Check open children before closing a parent.",
				]
			: []),
	].join("\n");
}

export function contractBlock(result: ContractResult, addendum = ""): string | undefined {
	const tail = addendum === "" ? "" : `\n${addendum}`;
	if (result.ok) {
		return result.text.trim() === "" ? undefined : `${CONTRACT_OPEN}\n${result.text}${tail}\n${CONTRACT_CLOSE}`;
	}
	return `${CONTRACT_OPEN}\nKata contract is unavailable (${result.reason}). Run \`kata quickstart --format contract\` before using kata.${tail}\n${CONTRACT_CLOSE}`;
}

/**
 * New system prompt blocks with the contract appended as its own block (blocks are never joined:
 * omp places provider cache breakpoints per block), or undefined when nothing should change.
 */
export function withContract(systemPrompt: unknown, result: ContractResult, addendum = ""): string[] | undefined {
	const base = Array.isArray(systemPrompt) ? (systemPrompt as string[]) : [];
	if (base.some(block => typeof block === "string" && block.includes(CONTRACT_OPEN))) return undefined;
	const block = contractBlock(result, addendum);
	return block === undefined ? undefined : [...base, block];
}
