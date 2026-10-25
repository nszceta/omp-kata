import { describe, expect, test } from "bun:test";
import { SHORT_ID, T, withEnv } from "./harness.ts";

describe("issue lifecycle driven by the scripted model", () => {
	test("search, create+replay, claim, meta, comment+reply, label, schedule, close", async () => {
		await withEnv({}, async env => {
			const D = "$E2E_DIR";
			const REF = `$(cat ${D}/ref)`;
			const evidence = "Implemented and verified the lifecycle scenario end to end in e2e.";
			const create = (out: string) =>
				`kata create "Lifecycle probe issue" --body "scripted body" --idempotency-key e2e-key-1 --json | tee ${D}/${out}.json | ${SHORT_ID} > ${D}/${out}`;
			const res = await env.run(
				{
					main: [
						{ bash: `kata search "lifecycle probe" --agent > ${D}/search.txt` },
						{ bash: create("ref") },
						{ bash: create("ref2") },
						{ bash: `kata claim ${REF} --agent` },
						{ bash: `kata meta set ${REF} work.attention ok && kata meta set ${REF} work.branch feat/e2e` },
						{ bash: `kata comment ${REF} -m "first scripted comment" --agent` },
						{ bash: `kata show ${REF} --agent | grep -o 'handle=c:[a-z0-9]*' | head -1 | cut -d= -f2 > ${D}/handle` },
						{ bash: `kata comment ${REF} -m "reply to first" --reply $(cat ${D}/handle) --agent` },
						{ bash: `kata label add ${REF} needs-review --comment "remaining review" --agent` },
						{ bash: `kata schedule ${REF} 2030-01-01 --agent` },
						{ bash: `kata close ${REF} --done -m "${evidence}" --commit abc1234 --agent` },
						{ text: "lifecycle complete" },
					],
				},
				"go",
			);
			expect(res.code).toBe(0);
			const ref = env.file("ref");
			expect(ref).toMatch(/^[a-z0-9]{4}$/);
			expect(env.file("ref2")).toBe(ref); // idempotent replay returns the same issue
			expect(env.file("search.txt")).toContain("OK search count=0");

			const show = await env.show(ref);
			expect(show.issue.status).toBe("closed");
			expect(show.issue.closed_reason).toBe("done");
			expect(show.issue.owner).toBe("e2e-actor");
			expect(show.issue.labels).toContain("needs-review");
			const bodies = show.comments.map((c: any) => c.body);
			expect(bodies).toContain("first scripted comment");
			expect(bodies).toContain("reply to first");
			const meta = await env.meta(ref);
			expect(meta["work.branch"]).toBe("feat/e2e");
			expect(meta["scheduled_on"]).toBe("2030-01-01");
			// claimed then closed: must not be downgraded by session end
			expect(meta["work.attention"]).not.toBe("needs-human");
			// every scripted step produced a successful result
			const last = res.requests.at(-1)!;
			expect(last.messages.filter(m => m.role === "toolResult" && m.isError).length).toBe(0);
		});
	}, T);
});
