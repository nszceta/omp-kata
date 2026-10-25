import { describe, expect, test } from "bun:test";
import { ACTOR, contractBlocks, count, fullText, spawnedAgentId, systemBlocks, T, withEnv } from "./harness.ts";

const SPIN = { main: [{ bash: "echo one" }, { bash: "echo two" }, { text: "done" }] };

describe("contract injection", () => {
	test("linked plugin: own system block, exactly once across turns, skill listed", async () => {
		await withEnv({ link: true }, async env => {
			const res = await env.run(SPIN, "go");
			expect(res.code).toBe(0);
			const main = res.requests.filter(r => r.agent === "main");
			expect(main.length).toBe(3);
			for (const req of main) {
				const blocks = contractBlocks(req);
				expect(blocks.length).toBe(1);
				expect(blocks[0]!.startsWith("<kata_contract>")).toBe(true);
				expect(blocks[0]!.trimEnd().endsWith("</kata_contract>")).toBe(true);
				expect(blocks[0]).toContain("Kata is the system of record for intent");
				// separate block, not glued onto the base prompt
				expect(systemBlocks(req).length).toBeGreaterThan(1);
				expect(count(fullText(req), "<kata_contract>")).toBe(1);
			}
			// plugin skill discovered through `omp plugin link`
			expect(systemBlocks(main[0]!).join("\n")).toMatch(/-\s+kata:/);
		});
	}, T);

	test("-e <dir> load: contract present", async () => {
		await withEnv({}, async env => {
			const res = await env.run(SPIN, "go");
			expect(res.code).toBe(0);
			expect(contractBlocks(res.requests[0]!).length).toBe(1);
		});
	}, T);

	test("outside a kata workspace: no contract", async () => {
		await withEnv({ workspace: false }, async env => {
			const res = await env.run(SPIN, "go");
			expect(res.code).toBe(0);
			expect(res.requests.length).toBe(3);
			for (const req of res.requests) expect(fullText(req)).not.toContain("<kata_contract>");
		});
	}, T);

	test("omp addendum states per-agent identity (main: no teammate; child: own agent id)", async () => {
		await withEnv({}, async env => {
			const res = await env.run(
				{
					main: [{ task: { name: "kid" } }, { wait: true }, { text: "done" }],
					children: { kid: [{ bash: "echo hi" }, { yield: true }] },
				},
				"go",
			);
			expect(res.code).toBe(0);
			const agentId = spawnedAgentId(res);
			const main = contractBlocks(res.requests.find(r => r.agent === "main")!);
			expect(main.length).toBe(1);
			expect(main[0]).toContain("Do NOT export KATA_AUTHOR, KATA_TEAMMATE or KATA_INBOX_USER");
			expect(main[0]).toContain(`identity: actor=${ACTOR} teammate=(none) inbox=${ACTOR}\n`);
			const kid = res.requests.filter(r => r.agent === "kid");
			expect(kid.length).toBeGreaterThan(0);
			for (const req of kid) {
				const blocks = contractBlocks(req);
				expect(blocks.length).toBe(1);
				expect(blocks[0]).toContain("Do NOT export KATA_AUTHOR, KATA_TEAMMATE or KATA_INBOX_USER");
				expect(blocks[0]).toContain(`identity: actor=${ACTOR} teammate=${agentId} inbox=${ACTOR}/${agentId}`);
			}
		});
	}, T);
});
