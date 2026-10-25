import type { Script } from "../fixtures/e2e/fake-provider.ts";
import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync } from "node:fs";
import { ACTOR, issuedBashCommands, SHORT_ID, spawnedAgentId, T, withEnv } from "./harness.ts";

/** parent creates child issue, spawns subagent that comments + reads its inbox; parent comments after wait */
function script(): Script {
	const D = "$E2E_DIR";
	const CHILD = `$(cat ${D}/child)`;
	return {
		main: [
			{ bash: `kata create "Delegated subagent issue" --parent $(cat ${D}/parent) --force-new --json | ${SHORT_ID} > ${D}/child` },
			{ task: { name: "kid", assignment: "comment on the child issue and read your inbox" } },
			{ wait: true },
			{ bash: `kata comment ${CHILD} -m "parent comment" --agent` },
			{ text: "parent done" },
		],
		children: {
			kid: [
				{ bash: `kata comment ${CHILD} -m "child comment" --agent` },
				{ bash: `kata inbox --json > ${D}/child_inbox.json` },
				{ yield: true },
			],
		},
	};
}

describe("subagent identity", () => {
	test("child gets teammate + inbox identity; parent has none", async () => {
		await withEnv({}, async env => {
			const parent = await env.createIssue("Parent of delegated work");
			await Bun.write(`${env.dir}/parent`, parent);
			const res = await env.run(script(), "go");
			expect(res.code).toBe(0);
			const agentId = spawnedAgentId(res);
			const child = env.file("child");

			const show = await env.show(child);
			const by = (body: string) => show.comments.find((c: any) => c.body === body);
			expect(by("child comment")?.teammate).toBe(agentId);
			expect(by("child comment")?.author).toBe(ACTOR);
			expect(by("parent comment")).toBeDefined();
			expect(by("parent comment").teammate || "").toBe("");

			expect(JSON.parse(env.file("child_inbox.json")).recipient).toBe(`${ACTOR}/${agentId}`);
			// provider-visible history is exactly what the script issued: no identity preamble
			const sc = script();
			const issued = (steps: Script["main"]) => steps.flatMap(s => ("bash" in s ? [s.bash] : []));
			const lastOf = (agent: string) => res.requests.filter(r => r.agent === agent).at(-1)!;
			expect(issuedBashCommands(lastOf("main"))).toEqual(issued(sc.main).slice(0, issuedBashCommands(lastOf("main")).length));
			expect(issuedBashCommands(lastOf("main")).length).toBe(2);
			expect(issuedBashCommands(lastOf("kid"))).toEqual(issued(sc.children!.kid!).slice(0, 2));
			for (const r of res.requests) {
				for (const c of issuedBashCommands(r)) {
					expect(c).not.toContain("export KATA_AUTHOR");
					expect(c).not.toContain("kata()");
				}
			}
			// the issue really is a child of the parent
			const p = await env.show(parent);
			expect(JSON.stringify(p.links)).toContain(child);
		});
	}, T);

	test("identity=false (plugin settings via link): child comment lacks teammate", async () => {
		await withEnv({ link: true, settings: { identity: false } }, async env => {
			const parent = await env.createIssue("Parent for rewrite off");
			await Bun.write(`${env.dir}/parent`, parent);
			const res = await env.run(script(), "go");
			expect(res.code).toBe(0);
			const show = await env.show(env.file("child"));
			const c = show.comments.find((x: any) => x.body === "child comment");
			expect(c).toBeDefined();
			expect(c.teammate || "").toBe("");
		});
	}, T);

	test("child cannot override identity by exporting KATA_* vars", async () => {
		await withEnv({}, async env => {
			const D = "$E2E_DIR";
			const CHILD = `$(cat ${D}/child)`;
			const parent = await env.createIssue("Parent for override probe");
			await Bun.write(`${env.dir}/parent`, parent);
			const res = await env.run(
				{
					main: [
						{ bash: `kata create "Override probe child issue" --parent ${parent} --force-new --json | ${SHORT_ID} > ${D}/child` },
						{ task: { name: "kid", assignment: "claim the child issue and comment" } },
						{ wait: true },
						{ text: "done" },
					],
					children: {
						kid: [
							{
								bash: `export KATA_AUTHOR=impostor KATA_TEAMMATE=wrong KATA_INBOX_USER=impostor/wrong; kata claim ${CHILD} --agent && kata comment ${CHILD} -m "child override probe" --json > ${D}/override.json`,
							},
							{ yield: true },
						],
					},
				},
				"go",
			);
			expect(res.code).toBe(0);
			const agentId = spawnedAgentId(res);
			const show = await env.show(env.file("child"));
			expect(show.issue.owner).toBe(ACTOR);
			const comment = JSON.parse(env.file("override.json")).comment;
			expect(comment.author).toBe(ACTOR);
			expect(comment.teammate).toBe(agentId);
		});
	}, T);

	test("PATH shim is first on PATH during the run; state dir is gone after omp exits; identity=false has no shim", async () => {
		const probe: Script = {
			main: [{ bash: "echo $PATH | cut -d: -f1 > $E2E_DIR/path1; command -v kata > $E2E_DIR/kata_path" }, { text: "done" }],
		};
		await withEnv({}, async env => {
			const tmp = `${env.dir}/t`;
			mkdirSync(tmp, { recursive: true });
			const res = await env.run(probe, "go", { env: { TMPDIR: tmp } });
			expect(res.code).toBe(0);
			expect(env.file("path1")).toMatch(new RegExp(`^${tmp}/omp-kata-[^/]+/bin$`));
			expect(env.file("kata_path")).toBe(`${env.file("path1")}/kata`);
			expect(readdirSync(tmp).filter(n => n.startsWith("omp-kata-"))).toEqual([]);
		});
		await withEnv({}, async env => {
			const tmp = `${env.dir}/t`;
			mkdirSync(tmp, { recursive: true });
			const res = await env.run(probe, "go", { env: { TMPDIR: tmp, OMP_KATA_IDENTITY: "false" } });
			expect(res.code).toBe(0);
			expect(env.file("path1")).not.toContain("omp-kata-");
			expect(readdirSync(tmp).filter(n => n.startsWith("omp-kata-"))).toEqual([]);
		});
	}, T);
});
