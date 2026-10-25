import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, statSync, symlinkSync } from "node:fs";
import { delimiter, join } from "node:path";
import { bashCall, FAKE_KATA, waitFor } from "./helpers";
import { identityFileText, prompt, Rig, SESSION } from "./extension-harness";

const SUB = "HandicappedSailfish";
const SUB_SESSION = "sub-sess-1";
const NO_CONTRACT = { OMP_KATA_CONTRACT: "0" };
const WHOAMI_OK = JSON.stringify({ kata_api_version: 1, actor: "fakeuser", source: "env" });

let rig: Rig;
beforeEach(() => {
	rig = new Rig();
});
afterEach(() => rig.dispose());

const published = (sessionId: string) => rig.hasIdentity(sessionId);

describe("bash tool calls are never rewritten", () => {
	test("tool_call returns undefined for kata, non-kata and non-bash calls, and leaves the input untouched", async () => {
		const host = await rig.load();
		const ctx = rig.session();

		for (const command of ["kata list", "ls -la", "export KATA_AUTHOR=evil; kata list"]) {
			const event = { ...bashCall(command), input: { command, timeout: 30 } };
			expect(await host.emitOne("tool_call", event, ctx)).toBeUndefined();
			expect(event.input).toEqual({ command, timeout: 30 });
		}
		expect(await host.emitOne("tool_call", { toolName: "edit", toolCallId: "t2", input: { command: "kata list" } }, ctx)).toBeUndefined();
	});
});

describe("identity file contents", () => {
	test("main agent without teammate: unset KATA_TEAMMATE, inbox is the actor", async () => {
		const host = await rig.load();
		await host.emit("session_start", {}, rig.session());

		await waitFor(() => published(SESSION), 5000, "identity file");

		expect(rig.readIdentity(SESSION)).toBe(
			[
				"KATA_AUTHOR=fakeuser; export KATA_AUTHOR",
				"unset KATA_TEAMMATE",
				"KATA_INBOX_USER=fakeuser; export KATA_INBOX_USER",
				`OMP_KATA_REAL=${FAKE_KATA}; export OMP_KATA_REAL`,
				"",
			].join("\n"),
		);
	});

	test("main agent with KATA_TEAMMATE=alice exports it and uses actor/alice as inbox user", async () => {
		const host = await rig.load({ KATA_TEAMMATE: "alice" });
		await host.emit("session_start", {}, rig.session());

		await waitFor(() => published(SESSION), 5000, "identity file");

		expect(rig.readIdentity(SESSION)).toBe(identityFileText("alice", "fakeuser/alice"));
	});

	test("a subagent's teammate is its id; the main agent's env never leaks in", async () => {
		const host = await rig.load({ KATA_TEAMMATE: "alice", KATA_INBOX_USER: "zed", KATA_REF: "abcd" });
		await host.emit("session_start", {}, rig.session({ agent: { kind: "sub", id: SUB }, sessionId: SUB_SESSION }));

		await waitFor(() => published(SUB_SESSION), 5000, "identity file");

		expect(rig.readIdentity(SUB_SESSION)).toBe(identityFileText(SUB, `fakeuser/${SUB}`));
		expect(rig.calls("agent-hook")).toEqual([]);
	});

	test("the identity file is mode 0600 and the state dir mode 0700", async () => {
		const host = await rig.load();
		await host.emit("session_start", {}, rig.session());
		await waitFor(() => published(SESSION), 5000, "identity file");

		expect(statSync(rig.identityPath(SESSION)).mode & 0o777).toBe(0o600);
		expect(statSync(rig.stateDir ?? "").mode & 0o777).toBe(0o700);
	});
});

describe("publication lifecycle", () => {
	test("main and subagent sessions sharing one shim host get distinct files, one state dir and one PATH entry", async () => {
		const mainHost = await rig.load();
		const subHost = await rig.load({ KATA_TEAMMATE: "alice" });
		const mainCtx = rig.session();
		const subCtx = rig.session({ agent: { kind: "sub", id: SUB }, sessionId: SUB_SESSION });

		await mainHost.emit("session_start", {}, mainCtx);
		await subHost.emit("session_start", {}, subCtx);
		await waitFor(() => published(SESSION) && published(SUB_SESSION), 5000, "both identity files");

		expect(rig.readIdentity(SESSION)).toBe(identityFileText("", "fakeuser"));
		expect(rig.readIdentity(SUB_SESSION)).toBe(identityFileText(SUB, `fakeuser/${SUB}`));
		expect(rig.shimDirs()).toHaveLength(1);
		const shimBin = join(rig.stateDir ?? "", "bin");
		expect(rig.shimEnv.PATH).toBe([shimBin, rig.originalPath].join(delimiter));
		expect(rig.shimEnv.OMP_KATA_REAL).toBe(FAKE_KATA);
	});

	test("before_agent_start awaits publication, even when whoami is slow", async () => {
		rig.fake.reply("whoami", { stdout: WHOAMI_OK, sleepMs: 400 });
		const host = await rig.load(NO_CONTRACT);

		await prompt(host, rig.session());

		expect(published(SESSION)).toBe(true);
		expect(rig.readIdentity(SESSION)).toBe(identityFileText("", "fakeuser"));
	});

	test("tool_call publishes a file that is missing because whoami failed earlier", async () => {
		rig.fake.reply("whoami", { code: 1, stderr: "daemon unavailable" });
		const host = await rig.load();
		const ctx = rig.session();
		await host.emit("session_start", {}, ctx);
		await host.emitOne("tool_call", bashCall("kata list"), ctx);
		expect(rig.stateDir).toBeUndefined();
		expect(rig.shimDirs()).toEqual([]);

		rig.fake.clearReplies();
		rig.time += 10_001;
		await host.emitOne("tool_call", bashCall("kata list"), ctx);

		expect(rig.readIdentity(SESSION)).toBe(identityFileText("", "fakeuser"));
	});

	test("the file is written once per session id, not on every bash call", async () => {
		const host = await rig.load();
		const ctx = rig.session();
		await host.emitOne("tool_call", bashCall("kata list"), ctx);
		const first = rig.readIdentity(SESSION);
		rig.fake.reply("whoami", { stdout: JSON.stringify({ kata_api_version: 1, actor: "other", source: "env" }) });

		await host.emitOne("tool_call", bashCall("kata list"), ctx);

		expect(rig.readIdentity(SESSION)).toBe(first);
		expect(rig.calls("whoami")).toHaveLength(1);
	});

	test("session_shutdown removes this session's file and leaves other sessions' files", async () => {
		const mainHost = await rig.load();
		const subHost = await rig.load();
		const subCtx = rig.session({ agent: { kind: "sub", id: SUB }, sessionId: SUB_SESSION });
		await mainHost.emit("session_start", {}, rig.session());
		await subHost.emit("session_start", {}, subCtx);
		await waitFor(() => published(SESSION) && published(SUB_SESSION), 5000, "both identity files");

		await subHost.emit("session_shutdown", {}, subCtx);

		expect(published(SUB_SESSION)).toBe(false);
		expect(published(SESSION)).toBe(true);
	});

	test("session_switch removes the old id's file and publishes the new id's", async () => {
		const host = await rig.load();
		const ctx = rig.session({ sessionId: "sess-old" });
		await host.emit("session_start", {}, ctx);
		await waitFor(() => published("sess-old"), 5000, "old identity file");

		ctx.sessionId = "sess-new";
		await host.emit("session_switch", {}, ctx);
		await waitFor(() => published("sess-new"), 5000, "new identity file");

		expect(published("sess-old")).toBe(false);
		expect(rig.readIdentity("sess-new")).toBe(identityFileText("", "fakeuser"));
	});

	test("a session id containing a slash is never published", async () => {
		const host = await rig.load();
		const ctx = rig.session({ sessionId: "../escape" });

		await prompt(host, ctx);
		await host.emitOne("tool_call", bashCall("kata list"), ctx);

		expect(rig.stateDir).toBeUndefined();
		expect(rig.shimDirs()).toEqual([]);
	});
});

describe("when the shim stays out of the way", () => {
	test("identity=false (OMP_KATA_IDENTITY=0): no files, PATH untouched, shim dir never created", async () => {
		const host = await rig.load({ OMP_KATA_IDENTITY: "0" });
		const ctx = rig.session();

		await host.emit("session_start", {}, ctx);
		await prompt(host, ctx);
		await host.emitOne("tool_call", bashCall("kata list"), ctx);

		expect(rig.shimDirs()).toEqual([]);
		expect(rig.shimEnv).toEqual({ PATH: rig.originalPath });
	});

	test("outside a kata workspace: no files, PATH untouched, shim dir never created", async () => {
		const host = await rig.load();
		const ctx = rig.session({ cwd: rig.ws.outside });

		await host.emit("session_start", {}, ctx);
		await prompt(host, ctx);
		await host.emitOne("tool_call", bashCall("kata list"), ctx);

		expect(rig.shimDirs()).toEqual([]);
		expect(rig.shimEnv).toEqual({ PATH: rig.originalPath });
		expect(rig.fake.calls()).toEqual([]);
	});
});

describe("the real executable", () => {
	/** A directory holding a `kata` symlink to the fake, standing in for the user's real kata on PATH. */
	function pathWithFakeKata(): string {
		const dir = join(rig.tmpRoot, "userbin");
		mkdirSync(dir, { recursive: true });
		symlinkSync(FAKE_KATA, join(dir, "kata"));
		chmodSync(dir, 0o755);
		return dir;
	}

	test("a bare executable name resolves on PATH outside the shim dir, and the shim is never recorded as real", async () => {
		const userBin = pathWithFakeKata();
		rig.shimEnv.PATH = [userBin, rig.originalPath].join(delimiter);
		const first = await rig.load({ OMP_KATA_EXECUTABLE: "kata" });
		await first.emit("session_start", {}, rig.session());
		await waitFor(() => published(SESSION), 5000, "identity file");

		// The shim dir now leads PATH, so a naive lookup of `kata` would find the shim; resolution must not.
		expect(rig.shimEnv.PATH?.startsWith(join(rig.stateDir ?? "", "bin"))).toBe(true);
		const second = await rig.load({ OMP_KATA_EXECUTABLE: "kata" });
		await second.emit("session_start", {}, rig.session({ sessionId: "sess-B" }));
		await waitFor(() => published("sess-B"), 5000, "second identity file");

		const realLine = `OMP_KATA_REAL=${join(userBin, "kata")}; export OMP_KATA_REAL\n`;
		expect(rig.readIdentity(SESSION)).toEndWith(realLine);
		expect(rig.readIdentity("sess-B")).toEndWith(realLine);
		expect(rig.shimEnv.OMP_KATA_REAL).toBe(join(userBin, "kata"));
		expect(rig.fake.callsTo("whoami").length).toBeGreaterThanOrEqual(1);
	});

	test("an absolute executable setting is used as given", async () => {
		const host = await rig.load();
		await host.emit("session_start", {}, rig.session());
		await waitFor(() => published(SESSION), 5000, "identity file");

		expect(rig.shimEnv.OMP_KATA_REAL).toBe(FAKE_KATA);
		expect(rig.readIdentity(SESSION)).toContain(`OMP_KATA_REAL=${FAKE_KATA}; export OMP_KATA_REAL\n`);
	});
});

describe("the published identity applied by the shim in a real shell", () => {
	async function runShell(shell: string, command: string, sessionId: string, ambient: Record<string, string> = {}): Promise<void> {
		// What omp's bash tool provides: the inherited env (with the shim on PATH) plus PI_SESSION_ID per command.
		const env: Record<string, string> = { ...ambient, ...rig.fake.env(), PI_SESSION_ID: sessionId };
		for (const [key, value] of Object.entries(rig.shimEnv)) if (value !== undefined) env[key] = value;
		const proc = Bun.spawn([shell, "-c", command], { cwd: rig.ws.root, env, stdout: "pipe", stderr: "pipe" });
		const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
		if (code !== 0) throw new Error(`${shell} failed (${code}): ${stderr}`);
	}

	const kataCalls = () => rig.fake.calls().filter(c => c.args[0] !== "whoami");

	test("a subagent's identity beats a model-authored export in the same command (sh and bash)", async () => {
		const host = await rig.load();
		const ctx = rig.session({ agent: { kind: "sub", id: SUB }, sessionId: SUB_SESSION });
		await host.emitOne("tool_call", bashCall("kata list"), ctx);
		const authored = 'export KATA_AUTHOR=evil KATA_INBOX_USER=evil/w KATA_TEAMMATE=evil; kata comment abcd -m "hi"; kata list';

		for (const shell of ["sh", "bash"]) await runShell(shell, authored, SUB_SESSION, { KATA_TEAMMATE: "ambient" });

		const calls = kataCalls();
		expect(calls.map(c => c.args)).toEqual([
			["comment", "abcd", "-m", "hi"],
			["list"],
			["comment", "abcd", "-m", "hi"],
			["list"],
		]);
		for (const call of calls) {
			expect(call.env.KATA_AUTHOR).toBe("fakeuser");
			expect(call.env.KATA_TEAMMATE).toBe(SUB);
			expect(call.env.KATA_INBOX_USER).toBe(`fakeuser/${SUB}`);
		}
	});

	test("the main agent is teammate-less even when the ambient env carries a teammate", async () => {
		const host = await rig.load();
		await host.emitOne("tool_call", bashCall("kata list"), rig.session());

		await runShell("sh", "export KATA_TEAMMATE=evil; kata comment abcd -m hi", SESSION, {
			KATA_TEAMMATE: "ambient",
			KATA_INBOX_USER: "ambient",
		});

		const [call] = kataCalls();
		expect(call?.env.KATA_AUTHOR).toBe("fakeuser");
		expect(call?.env.KATA_TEAMMATE).toBeUndefined();
		expect(call?.env.KATA_INBOX_USER).toBe("fakeuser");
	});

	test("a session without a published file passes straight through to the real kata", async () => {
		const host = await rig.load();
		await host.emitOne("tool_call", bashCall("kata list"), rig.session());

		await runShell("sh", "kata list", "unrelated-session", { KATA_AUTHOR: "ambient-author", KATA_TEAMMATE: "ambient" });

		const [call] = kataCalls();
		expect(call?.env.KATA_AUTHOR).toBe("ambient-author");
		expect(call?.env.KATA_TEAMMATE).toBe("ambient");
	});
});
