import { describe, expect, test } from "bun:test";
import type { Script } from "../fixtures/e2e/fake-provider.ts";
import { ACTOR, issuedBashCommands, SHORT_ID, spawnedAgentId, T, withEnv } from "./harness.ts";

/**
 * A user's ~/.bashrc that prepends the real kata dir to PATH must not defeat the identity shim
 * (omp sources the rc snapshot before every bash command).
 */
describe("rc file puts real kata first on PATH", () => {
	test("identity survives across consecutive bash calls in main and child, incl. impostor exports", async () => {
		await withEnv({ rcPathKata: true }, async env => {
			const D = "$E2E_DIR";
			const CHILD = `$(cat ${D}/child)`;
			const parent = await env.createIssue("Parent for rc PATH probe");
			const script: Script = {
				main: [
					{ bash: `kata create "RC path probe child issue" --parent ${parent} --force-new --json | ${SHORT_ID} > ${D}/child; command -v kata > ${D}/main_kata1` },
					{ bash: `kata comment ${CHILD} -m "main one" --json > ${D}/main1.json` },
					{ task: { name: "kid", assignment: "claim and comment twice" } },
					{ wait: true },
					{ bash: `export KATA_AUTHOR=evil KATA_TEAMMATE=evilmate; kata comment ${CHILD} -m "main two" --json > ${D}/main2.json; command -v kata > ${D}/main_kata2` },
					{ text: "done" },
				],
				children: {
					kid: [
						{ bash: `kata comment ${CHILD} -m "child one" --json > ${D}/child1.json; command -v kata > ${D}/kid_kata1` },
						{ bash: `export KATA_AUTHOR=impostor KATA_TEAMMATE=wrong KATA_INBOX_USER=impostor/wrong; kata claim ${CHILD} --agent && kata comment ${CHILD} -m "child two" --json > ${D}/child2.json` },
						{ bash: `kata inbox --json > ${D}/child_inbox.json` },
						{ yield: true },
					],
				},
			};
			const res = await env.run(script, "go");
			expect(res.code).toBe(0);
			const agentId = spawnedAgentId(res);

			for (const f of ["main_kata1", "main_kata2", "kid_kata1"]) expect(env.file(f)).toMatch(/kata$/);

			const c = (f: string) => JSON.parse(env.file(f)).comment;
			for (const f of ["main1.json", "main2.json"]) {
				expect(c(f).author).toBe(ACTOR);
				expect(c(f).teammate || "").toBe("");
			}
			for (const f of ["child1.json", "child2.json"]) {
				expect(c(f).author).toBe(ACTOR);
				expect(c(f).teammate).toBe(agentId);
			}
			expect((await env.show(env.file("child"))).issue.owner).toBe(ACTOR);
			expect(JSON.parse(env.file("child_inbox.json")).recipient).toBe(`${ACTOR}/${agentId}`);

			// provider-visible commands are exactly what the script issued
			const issued = (steps: Script["main"]) => steps.flatMap(s => ("bash" in s ? [s.bash] : []));
			const lastOf = (agent: string) => res.requests.filter(r => r.agent === agent).at(-1)!;
			expect(issuedBashCommands(lastOf("main"))).toEqual(issued(script.main));
			expect(issuedBashCommands(lastOf("kid"))).toEqual(issued(script.children!.kid!));
			for (const r of res.requests) {
				for (const cmd of issuedBashCommands(r)) {
					expect(cmd).not.toContain("kata()");
					expect(cmd.replace(/export KATA_AUTHOR=(evil|impostor)[^;]*;/, "")).not.toContain("export KATA_");
				}
			}
		});
	}, T);

	test("user's own PI_SHELL_PREFIX (a command wrapper, applied to the line) still applies alongside the shim", async () => {
		await withEnv({ rcPathKata: true }, async env => {
			const ref = await env.createIssue("User shell prefix probe");
			const res = await env.run(
				{
					main: [
						{ bash: `printenv E2E_PFX > $E2E_DIR/pfx; kata comment ${ref} -m "prefix probe" --json > $E2E_DIR/c.json` },
						{ text: "done" },
					],
				},
				"go",
				{ env: { PI_SHELL_PREFIX: "env E2E_PFX=yes" } },
			);
			expect(res.code).toBe(0);
			expect(env.file("pfx")).toBe("yes");
			const comment = JSON.parse(env.file("c.json")).comment;
			expect(comment.author).toBe(ACTOR);
			expect(comment.teammate || "").toBe("");
		});
	}, T);
});
