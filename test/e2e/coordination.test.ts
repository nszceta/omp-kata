import { describe, expect, test } from "bun:test";
import { ACTOR, fullText, SHORT_ID, T, withEnv } from "./harness.ts";

describe("coordination round-trip", () => {
	test("parent waits on child attention, receives child's notify, closes child issue", async () => {
		await withEnv({ env: { OMP_KATA_INBOX_POLL_SECONDS: "0" } }, async env => {
			const D = "$E2E_DIR";
			const CHILD = `$(cat ${D}/child)`;
			const evidence = "Child delegated work reviewed by the parent and accepted after the round trip.";
			const res = await env.run(
				{
					main: [
						{ bash: `kata create "Coordinated child issue" --force-new --json | ${SHORT_ID} > ${D}/child` },
						{ task: { name: "kid", assignment: "claim the child issue, ask the parent for a decision, stop" } },
						{ bash: `kata wait ${CHILD} --until attention --any --timeout 60s --agent > ${D}/wait.txt 2>&1; echo rc=$? >> ${D}/wait.txt`, timeout: 90 },
						{ bash: "echo parent-after-wait" },
						{ bash: `kata close ${CHILD} --done -m "${evidence}" --commit abc1234 --agent` },
						{ wait: true },
						{ text: "coordination complete" },
					],
					children: {
						kid: [
							{ bash: `until [ -s ${D}/child ]; do sleep 0.1; done; kata claim ${CHILD} --agent` },
							// notify first, attention last: the parent's wait returning implies the notify is stored
							{ bash: `kata notify ${CHILD} --to ${ACTOR} --message "child needs a decision" --agent` },
							{ bash: `kata meta set ${CHILD} work.attention needs-human && kata meta set ${CHILD} work.attention_msg "awaiting parent decision"` },
							{ yield: true },
						],
					},
				},
				"go",
			);
			expect(res.code).toBe(0);
			const wait = env.file("wait.txt");
			expect(wait).toContain("reason=attention");
			expect(wait).toContain("needs-human");
			expect(wait).toContain("rc=0");

			// parent's request right after the wait carries the child's notify
			const main = res.requests.filter(r => r.agent === "main");
			const afterWait = main.find(r => r.index === 3)!;
			expect(fullText(afterWait)).toContain("child needs a decision");
			expect(fullText(main.find(r => r.index === 2)!)).not.toContain("child needs a decision");

			const child = env.file("child");
			const show = await env.show(child);
			expect(show.issue.status).toBe("closed");
			expect(show.issue.closed_reason).toBe("done");
		});
	}, T);
});
