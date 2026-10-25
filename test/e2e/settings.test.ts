import { describe, expect, test } from "bun:test";
import { contractBlocks, fullText, systemBlocks, T, withEnv } from "./harness.ts";

const SPIN = { main: [{ bash: "echo one" }, { text: "done" }] };

describe("settings", () => {
	test("contract=false (plugin settings via `omp plugin config set`) disables injection", async () => {
		await withEnv({ link: true, settings: { contract: false } }, async env => {
			const res = await env.run(SPIN, "go");
			expect(res.code).toBe(0);
			expect(res.requests.length).toBe(2);
			for (const r of res.requests) expect(fullText(r)).not.toContain("<kata_contract>");
			// the skill still ships with the plugin
			expect(systemBlocks(res.requests[0]!).join("\n")).toMatch(/-\s+kata:/);
		});
	}, T);

	test("OMP_KATA_CONTRACT=0 env overrides plugin settings", async () => {
		await withEnv({ link: true, settings: { contract: true }, env: { OMP_KATA_CONTRACT: "0" } }, async env => {
			const res = await env.run(SPIN, "go");
			expect(res.code).toBe(0);
			for (const r of res.requests) expect(fullText(r)).not.toContain("<kata_contract>");
		});
	}, T);

	test("contractSource: custom contract file replaces the built-in text", async () => {
		await withEnv({ env: {} }, async env => {
			const src = `${env.dir}/contract.txt`;
			await Bun.write(src, "CUSTOM CONTRACT TEXT e2e");
			const res = await env.run(SPIN, "go", { env: { OMP_KATA_CONTRACT_SOURCE: src } });
			expect(res.code).toBe(0);
			const blocks = contractBlocks(res.requests[0]!);
			expect(blocks.length).toBe(1);
			expect(blocks[0]).toContain("CUSTOM CONTRACT TEXT e2e");
			expect(blocks[0]).not.toContain("system of record");
		});
	}, T);

	test("nonexistent executable: session completes, unavailable stub injected", async () => {
		await withEnv({ link: true, settings: { executable: "/nonexistent/kata-binary" } }, async env => {
			const res = await env.run(SPIN, "go");
			expect(res.code).toBe(0);
			expect(res.timedOut).toBe(false);
			expect(res.requests.length).toBe(2);
			for (const r of res.requests) {
				const blocks = contractBlocks(r);
				expect(blocks.length).toBe(1);
				expect(blocks[0]).toContain("Kata contract is unavailable");
				expect(blocks[0]).toContain("kata quickstart --format contract");
			}
		});
	}, T);
});
