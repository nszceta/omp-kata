import { describe, expect, test } from "bun:test";
import { ACTOR, count, messagesText, messageTexts, T, withEnv } from "./harness.ts";

describe("inbox delivery", () => {
	test("prompt boundary: pre-seeded notify arrives as kata-inbox message in first request", async () => {
		await withEnv({}, async env => {
			const ref = await env.createIssue("Inbox prompt boundary probe");
			expect((await env.kata(["notify", ref, "--to", ACTOR, "--message", "please review the seeded thing"])).code).toBe(0);
			const res = await env.run({ main: [{ bash: "echo a" }, { text: "done" }] }, "go");
			expect(res.code).toBe(0);
			const first = res.requests[0]!;
			const hits = messageTexts(first).filter(t => t.includes("<kata_inbox>"));
			expect(hits.length).toBe(1);
			expect(hits[0]).toContain("please review the seeded thing");
			expect(hits[0]).toContain(ref);
			// not re-delivered later
			expect(count(messagesText(res.requests.at(-1)!), "<kata_inbox>")).toBe(1);
		});
	}, T);

	test("mid-turn: notify during the turn arrives as additionalContext; clear yields 'now empty'", async () => {
		await withEnv({ env: { OMP_KATA_INBOX_POLL_SECONDS: "0" } }, async env => {
			const ref = await env.createIssue("Inbox mid-turn probe");
			const res = await env.run(
				{
					main: [
						{ bash: "echo start" },
						{ bash: `kata notify ${ref} --to ${ACTOR} --message "mid turn ping" --agent` },
						{ bash: "echo after-notify" },
						{ bash: `kata notify ${ref} --to ${ACTOR} --clear --agent` },
						{ bash: "echo after-clear" },
						{ text: "done" },
					],
				},
				"go",
			);
			expect(res.code).toBe(0);
			const req = (i: number) => messagesText(res.requests[i]!);
			expect(req(0)).not.toContain("<kata_inbox>");
			expect(req(1)).not.toContain("mid turn ping");
			expect(req(2)).toContain("mid turn ping"); // request after the notify tool result
			expect(req(3)).toContain("mid turn ping");
			expect(req(3)).not.toContain("is now empty");
			expect(req(4)).toContain("is now empty"); // request after the clear tool result
			expect(req(4)).toContain(`Kata inbox for \\"${ACTOR}\\" is now empty`);
		});
	}, T);

	test("inbox=false: pre-seeded notify is not delivered", async () => {
		await withEnv({ env: { OMP_KATA_INBOX: "false" } }, async env => {
			const ref = await env.createIssue("Inbox disabled probe");
			await env.kata(["notify", ref, "--to", ACTOR, "--message", "should stay unseen"]);
			const res = await env.run({ main: [{ bash: "echo a" }, { text: "done" }] }, "go");
			expect(res.code).toBe(0);
			for (const r of res.requests) expect(messagesText(r)).not.toContain("should stay unseen");
		});
	}, T);
});

