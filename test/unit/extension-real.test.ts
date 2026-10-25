/**
 * End-to-end through the extension with the real kata binary in a private KATA_HOME.
 * Everything the plugin does here is observed through kata itself (comments, inbox, issue metadata).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { clearContractCache } from "../../src/contract";
import { clearActorCache } from "../../src/identity";
import { ShimHost } from "../../src/shim";
import { bashCall, bashResult, FakeCtx, type FakeHost, loadExtension, REAL_KATA, RealKata, tempDir } from "./helpers";
import { prompt } from "./extension-harness";

const rk = new RealKata("unit-actor");
const tmpRoot = tempDir("omp-kata-shimroot-");
/** Stand-in for the environment omp's bash tool inherits; the shim host mutates it instead of process.env. */
const shimEnv: Record<string, string | undefined> = { PATH: process.env.PATH };
const shim = new ShimHost(shimEnv, { tmpRoot });
const SUB = "HandicappedSailfish";
const MAIN_SESSION = "real-main";
const SUB_SESSION = "real-sub";
const NO_CONTRACT = { OMP_KATA_CONTRACT: "0" };

function env(extra: Record<string, string> = {}): Record<string, string> {
	return { OMP_KATA_EXECUTABLE: REAL_KATA, HOME: rk.base, ...rk.env(), ...extra };
}

function load(extra: Record<string, string> = {}, hostPid = process.pid): Promise<FakeHost> {
	return loadExtension({ env: env(extra), loadSettings: async () => ({}), hostPid, shim });
}

function session(agent?: { kind: "sub"; id: string }): FakeCtx {
	return new FakeCtx({ cwd: rk.root, sessionId: agent ? SUB_SESSION : MAIN_SESSION, agent });
}

/**
 * Runs a command the way omp's bash tool would: the inherited env (shim dir first on PATH, OMP_KATA_*)
 * plus PI_SESSION_ID. The command text is exactly what the model wrote.
 */
async function sh(command: string, sessionId: string, shell = "sh"): Promise<string> {
	const base: Record<string, string> = { HOME: rk.base, ...rk.env(), PI_SESSION_ID: sessionId };
	for (const [key, value] of Object.entries(shimEnv)) if (value !== undefined) base[key] = value;
	const proc = Bun.spawn([shell, "-c", command], {
		cwd: rk.root,
		// Ambient values a leaky implementation would pick up; the published identity must override them.
		env: { ...base, KATA_TEAMMATE: "leaked-teammate", KATA_INBOX_USER: "leaked/user" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0) throw new Error(`${shell} -c failed (${code}): ${stdout}${stderr}`);
	return stdout;
}

/** Starts a session the way omp does and lets its first bash call publish the identity file. */
async function startSession(host: FakeHost, ctx: FakeCtx): Promise<void> {
	await host.emit("session_start", {}, ctx);
	await host.emitOne("tool_call", bashCall("kata whoami"), ctx);
}

/** Polls a real, detached kata process's effect; deterministic time control cannot apply to a child process. */
async function waitForAsync(check: () => Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(100);
	}
}

beforeAll(async () => {
	await rk.init();
}, 30_000);

afterAll(async () => {
	shim.dispose();
	rmSync(tmpRoot, { recursive: true, force: true });
	await rk.cleanup();
}, 30_000);

beforeEach(() => {
	clearActorCache();
	clearContractCache();
});

describe("real kata through the extension", () => {
	test("the real contract is appended to the system prompt as its own block", async () => {
		const hook = JSON.parse((await rk.kata(["agent-contract-hook"])).stdout) as {
			hookSpecificOutput: { additionalContext: string };
		};
		const host = await load();

		const result = await prompt(host, session());

		expect(result?.systemPrompt?.slice(0, 2)).toEqual(["base A", "base B"]);
		expect(result?.systemPrompt).toHaveLength(3);
		const block = result?.systemPrompt?.[2] ?? "";
		expect(block).toStartWith(`<kata_contract>\n${hook.hookSpecificOutput.additionalContext}\nomp-kata: omp sets kata identity automatically`);
		expect(block).toStartWith("<kata_contract>\nKata is the system of record for intent.");
		expect(block).toEndWith(
			"\nidentity: actor=unit-actor teammate=(none) inbox=unit-actor\n" +
				"Attention starts automatically on `kata claim` and ends when the session ends; inbox requests arrive as <kata_inbox> messages.\n</kata_contract>",
		);
	}, 30_000);

	test("the PATH shim attributes comments to the subagent, even after a model-authored export; the main agent gets no teammate", async () => {
		const ref = await rk.createIssue("Teammate attribution target");
		const subCtx = session({ kind: "sub", id: SUB });
		const mainCtx = session();
		const subHost = await load();
		const mainHost = await load();
		await startSession(subHost, subCtx);
		await startSession(mainHost, mainCtx);
		type Comment = { comment: { author: string; teammate?: string } };

		const sub = JSON.parse(await sh(`kata comment ${ref} -m "hello from the sub" --json`, SUB_SESSION)) as Comment;
		const main = JSON.parse(await sh(`kata comment ${ref} -m "hello from the main agent" --json`, MAIN_SESSION)) as Comment;

		expect(sub.comment).toMatchObject({ author: "unit-actor", teammate: SUB });
		expect(main.comment.author).toBe("unit-actor");
		expect(main.comment.teammate ?? "").toBe("");

		// The command text is untouched and a model-authored export in front of kata must not win.
		const authored = `export KATA_AUTHOR=evil KATA_INBOX_USER=evil/w KATA_TEAMMATE=evil; kata comment ${ref} -m "authored export" --json`;
		expect(await subHost.emitOne("tool_call", bashCall(authored), subCtx)).toBeUndefined();
		for (const shell of ["sh", "bash"]) {
			const out = JSON.parse(await sh(authored, SUB_SESSION, shell)) as Comment;
			expect(out.comment).toMatchObject({ author: "unit-actor", teammate: SUB });
		}
		const mainAuthored = JSON.parse(await sh(`export KATA_TEAMMATE=evil; kata comment ${ref} -m "main authored" --json`, MAIN_SESSION)) as Comment;
		expect(mainAuthored.comment.teammate ?? "").toBe("");

		const shown = JSON.parse((await rk.kata(["show", ref, "--json"])).stdout) as {
			comments: { author: string; teammate?: string; body: string }[];
		};
		expect(shown.comments.map(c => [c.body, c.author, c.teammate ?? ""])).toEqual([
			["hello from the sub", "unit-actor", SUB],
			["hello from the main agent", "unit-actor", ""],
			["authored export", "unit-actor", SUB],
			["authored export", "unit-actor", SUB],
			["main authored", "unit-actor", ""],
		]);
	}, 90_000);

	test("a kata notify addressed to the agent's inbox user arrives as the prompt message", async () => {
		const ref = await rk.createIssue("Inbox delivery target");
		const sent = await rk.kata(["notify", ref, "--to", `unit-actor/${SUB}`, "--message", "sub please look"]);
		expect(sent.code).toBe(0);

		const subResult = await prompt(await load(NO_CONTRACT), session({ kind: "sub", id: SUB }));
		const mainResult = await prompt(await load(NO_CONTRACT), session());

		expect(subResult?.message?.customType).toBe("kata-inbox");
		expect(subResult?.message?.display).toBe(true);
		expect(subResult?.message?.content).toStartWith(`<kata_inbox>\nKata inbox for "unit-actor/${SUB}".`);
		expect(subResult?.message?.content).toContain(`- issue="${ref}" title="Inbox delivery target" from="unit-actor" message="sub please look"`);
		expect(subResult?.message?.content).toEndWith("\n</kata_inbox>");
		// The main agent's address is `unit-actor`; a request for `unit-actor/<sub>` is not visible to it.
		expect(mainResult).toBeUndefined();

		const cleared = await rk.kata(["notify", ref, "--to", `unit-actor/${SUB}`, "--clear"]);
		expect(cleared.code).toBe(0);
	}, 60_000);

	test("claim starts attention and shutdown's detached end downgrades it, even with a dead host pid", async () => {
		const ref = await rk.createIssue("Attention lifecycle target");
		const claim = await rk.kata(["claim", ref]);
		expect(claim.code).toBe(0);
		const dead = Bun.spawn(["true"]);
		await dead.exited;
		const host = await load({}, dead.pid);
		const ctx = session();

		await host.emitOne("tool_result", bashResult(`kata claim ${ref}`), ctx);
		expect((await rk.meta(ref))["work.attention"]).toBe("ok");

		await host.emit("session_shutdown", {}, ctx);
		await waitForAsync(async () => (await rk.meta(ref))["work.attention"] === "needs-human", "attention needs-human");

		expect((await rk.meta(ref))["work.attention_msg"]).toBe("session ended without hand-off");
	}, 60_000);
});
