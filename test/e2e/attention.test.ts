import { describe, expect, test } from "bun:test";
import { T, withEnv } from "./harness.ts";

const HEX64 = /^[0-9a-f]{64}$/;

describe("attention lifecycle", () => {
	test("claim starts attention; unclosed claim becomes needs-human at session end", async () => {
		await withEnv({}, async env => {
			const ref = await env.createIssue("Attention unclosed claim probe");
			const res = await env.run(
				{
					main: [
						{ bash: `kata claim ${ref} --agent` },
						{ bash: `kata meta get ${ref} --json > $E2E_DIR/mid.json` },
						{ text: "leaving it claimed" },
					],
				},
				"go",
			);
			expect(res.code).toBe(0);
			const mid = JSON.parse(env.file("mid.json")).metadata;
			expect(mid["work.attention"]).toBe("ok");
			expect(mid["work.attention_session"]).toMatch(HEX64);

			const after = await env.metaUntil(ref, meta => meta["work.attention"] !== "ok");
			expect(after["work.attention"]).toBe("needs-human");
			expect(after["work.attention_msg"]).toBe("session ended without hand-off");
			expect(after["work.attention_session"]).toStartWith("ended:");
		});
	}, T);

	test("claimed then closed is not downgraded", async () => {
		await withEnv({}, async env => {
			const ref = await env.createIssue("Attention closed claim probe");
			const sentinel = await env.createIssue("Attention sentinel left open");
			const res = await env.run(
				{
					main: [
						{ bash: `kata claim ${ref} --agent && kata claim ${sentinel} --agent` },
						{ bash: `kata close ${ref} --done -m "Finished the closed-claim attention probe completely and verified." --commit abc1234 --agent` },
						{ text: "closed" },
					],
				},
				"go",
			);
			expect(res.code).toBe(0);
			// The sentinel's end proves shutdown's detached ends have landed before judging the closed issue.
			await env.metaUntil(sentinel, meta => meta["work.attention"] === "needs-human");
			const meta = await env.meta(ref);
			expect(meta["work.attention"]).toBe("ok");
			expect(meta["work.attention_msg"]).toBeUndefined();
			expect((await env.show(ref)).issue.status).toBe("closed");
		});
	}, T);

	test("KATA_REF: attention starts at session start and ends at shutdown", async () => {
		await withEnv({}, async env => {
			const ref = await env.createIssue("Attention KATA_REF probe");
			const res = await env.run(
				{ main: [{ bash: `kata meta get ${ref} --json > $E2E_DIR/mid.json` }, { text: "done" }] },
				"go",
				{ env: { KATA_REF: ref } },
			);
			expect(res.code).toBe(0);
			const mid = JSON.parse(env.file("mid.json")).metadata;
			expect(mid["work.attention"]).toBe("ok");
			expect(mid["work.attention_session"]).toMatch(HEX64);
			const after = await env.metaUntil(ref, meta => meta["work.attention"] !== "ok");
			expect(after["work.attention"]).toBe("needs-human");
			expect(after["work.attention_msg"]).toBe("session ended without hand-off");
		});
	}, T);

	test("attention=false: claim does not touch attention", async () => {
		await withEnv({}, async env => {
			const ref = await env.createIssue("Attention disabled probe");
			const res = await env.run({ main: [{ bash: `kata claim ${ref} --agent` }, { text: "x" }] }, "go", { env: { OMP_KATA_ATTENTION: "false" } });
			expect(res.code).toBe(0);
			const meta = await env.meta(ref);
			expect(meta["work.attention"]).toBeUndefined();
		});
	}, T);
});
