import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { bashResult, waitFor } from "./helpers";
import { attentionArgs, HOST_PID, INBOX_TEXT, prompt, Rig, SESSION } from "./extension-harness";

const NO_CONTRACT = { OMP_KATA_CONTRACT: "0" };
const START = "agent-hook attention-native pi start";
const END = "agent-hook attention-native pi end";
const CLOSE_CMD = 'kata close abcd --done -m "Implemented and verified end to end with tests passing" --commit abc1234';

let rig: Rig;
beforeEach(() => {
	rig = new Rig();
});
afterEach(() => rig.dispose());

/** agent-hook calls other than the sentinel's. */
function hookCalls(prefix = "agent-hook"): string[][] {
	return rig.calls(prefix).filter(args => !args.includes("sent1"));
}

/**
 * Proves that no detached `end` for earlier sessions is on its way: a sentinel session spawned afterwards
 * has logged its own `end`, so any earlier spawn would have had the same head start.
 */
async function settle(): Promise<void> {
	const host = await rig.load();
	const ctx = rig.session({ sessionId: "sentinel" });
	await host.emitOne("tool_result", bashResult("kata claim sent1"), ctx);
	await host.emit("session_shutdown", {}, ctx);
	await waitFor(() => rig.calls(END).some(a => a.includes("sent1")), 5000, "sentinel end");
}

describe("attention from KATA_REF", () => {
	test("a main session with KATA_REF starts attention under its session id and pid", async () => {
		const host = await rig.load({ KATA_REF: "abcd" });
		const ctx = rig.session();

		await host.emit("session_start", {}, ctx);

		expect(rig.calls("show")).toEqual([["show", "abcd", "--json"]]);
		expect(rig.calls(START)).toEqual([attentionArgs("start", SESSION, "abcd", rig.ws.root)]);
		expect(rig.fake.callsTo(START)[0]?.env.KATA_SESSION_ID).toBe(`omp-${SESSION}`);
	});

	test("a closed KATA_REF issue gets no attention", async () => {
		rig.fake.reply("show", { stdout: '{"issue":{"status":"closed"}}' });
		const host = await rig.load({ KATA_REF: "abcd" });
		const ctx = rig.session({ hasUI: true });

		await host.emit("session_start", {}, ctx);
		await host.emit("session_shutdown", {}, ctx);
		await settle();

		expect(hookCalls()).toEqual([]);
	});

	test("subagents and attention=false never start attention", async () => {
		const subHost = await rig.load({ KATA_REF: "abcd" });
		await subHost.emit("session_start", {}, rig.session({ agent: { kind: "sub", id: "Sailfish" } }));

		const off = await rig.load({ KATA_REF: "abcd", OMP_KATA_ATTENTION: "0" });
		const offCtx = rig.session();
		await off.emit("session_start", {}, offCtx);
		await off.emitOne("tool_result", bashResult("kata claim efgh"), offCtx);

		expect(rig.calls("agent-hook")).toEqual([]);
	});
});

describe("attention from claims", () => {
	test("a successful `kata claim` starts and tracks attention once per session", async () => {
		const host = await rig.load();
		const ctx = rig.session();

		await host.emitOne("tool_result", bashResult("kata claim abcd"), ctx);
		await host.emitOne("tool_result", bashResult("kata claim abcd"), ctx);

		expect(rig.calls(START)).toEqual([attentionArgs("start", SESSION, "abcd", rig.ws.root)]);
		expect(rig.fake.callsTo(START)[0]?.env.KATA_SESSION_ID).toBe(`omp-${SESSION}`);
	});

	test("failed claims and non-kata commands start nothing", async () => {
		const host = await rig.load();
		const ctx = rig.session();

		await host.emitOne("tool_result", bashResult("kata claim abcd", true), ctx);
		await host.emitOne("tool_result", bashResult("echo kata claim abcd"), ctx);
		await host.emitOne("tool_result", bashResult("ls"), ctx);

		expect(rig.calls("agent-hook")).toEqual([]);
	});

	test("claim then close in one command tracks nothing, so shutdown spawns no end", async () => {
		const host = await rig.load();
		const ctx = rig.session();

		await host.emitOne("tool_result", bashResult(`kata claim abcd && ${CLOSE_CMD}`), ctx);
		await host.runCommand("kata", "status", ctx);
		await host.emit("session_shutdown", {}, ctx);
		await settle();

		expect(ctx.notifications[0]?.message).toContain("tracked refs: (none)");
		expect(hookCalls(END)).toEqual([]);
	});

	test("a later close untracks the ref, so shutdown spawns no end", async () => {
		const host = await rig.load();
		const ctx = rig.session();
		await host.emitOne("tool_result", bashResult("kata claim abcd"), ctx);

		await host.emitOne("tool_result", bashResult(CLOSE_CMD), ctx);
		await host.emit("session_shutdown", {}, ctx);
		await settle();

		expect(hookCalls(START)).toHaveLength(1);
		expect(hookCalls(END)).toEqual([]);
	});

	test("shutdown ends every tracked ref detached, under the same session id and KATA_SESSION_ID", async () => {
		const host = await rig.load();
		const ctx = rig.session();
		await host.emitOne("tool_result", bashResult("kata claim abcd"), ctx);
		await host.emitOne("tool_result", bashResult("kata claim efgh"), ctx);

		await host.emit("session_shutdown", {}, ctx);
		await waitFor(() => rig.fake.callsTo(END).length === 2, 5000, "two end calls");

		const ends = rig.fake.callsTo(END);
		expect(ends.map(c => c.args).sort()).toEqual(
			[attentionArgs("end", SESSION, "abcd", rig.ws.root), attentionArgs("end", SESSION, "efgh", rig.ws.root)].sort(),
		);
		for (const call of ends) expect(call.env.KATA_SESSION_ID).toBe(`omp-${SESSION}`);
	});

	test("a subagent that claims ends under the subagent's own session id", async () => {
		const host = await rig.load({ KATA_REF: "main1" });
		const ctx = rig.session({ agent: { kind: "sub", id: "Sailfish" }, sessionId: "sub-sess-9" });

		await host.emitOne("tool_result", bashResult("kata claim abcd"), ctx);
		await host.emit("session_shutdown", {}, ctx);
		await waitFor(() => rig.fake.callsTo(END).length === 1, 5000, "end call");

		expect(rig.calls(START)).toEqual([attentionArgs("start", "sub-sess-9", "abcd", rig.ws.root)]);
		expect(rig.calls(END)).toEqual([attentionArgs("end", "sub-sess-9", "abcd", rig.ws.root)]);
		expect(rig.fake.callsTo(END)[0]?.env.KATA_SESSION_ID).toBe("omp-sub-sess-9");
	});

	test("session_switch ends old-session refs under the old id and re-starts KATA_REF under the new one", async () => {
		const host = await rig.load({ KATA_REF: "abcd" });
		const ctx = rig.session({ sessionId: "sess-old" });
		await host.emit("session_start", {}, ctx);
		await host.emitOne("tool_result", bashResult("kata claim efgh"), ctx);

		ctx.sessionId = "sess-new";
		await host.emit("session_switch", {}, ctx);
		await waitFor(() => rig.fake.callsTo(END).length === 2, 5000, "two end calls");

		expect(rig.calls(END).sort()).toEqual(
			[attentionArgs("end", "sess-old", "abcd", rig.ws.root), attentionArgs("end", "sess-old", "efgh", rig.ws.root)].sort(),
		);
		expect(rig.calls(START)).toEqual([
			attentionArgs("start", "sess-old", "abcd", rig.ws.root),
			attentionArgs("start", "sess-old", "efgh", rig.ws.root),
			attentionArgs("start", "sess-new", "abcd", rig.ws.root),
		]);

		await host.runCommand("kata", "status", ctx);
		expect(ctx.notifications[0]?.message).toContain("tracked refs: abcd\n");
	});

	test("the host pid given to the extension is what kata is told", async () => {
		const host = await rig.load({}, { hostPid: 31337 });

		await host.emitOne("tool_result", bashResult("kata claim abcd"), rig.session());

		expect(HOST_PID).not.toBe(31337);
		expect(rig.calls(START)).toEqual([attentionArgs("start", SESSION, "abcd", rig.ws.root, 31337)]);
	});
});

describe("status line", () => {
	test("shows actor, then tracked refs, then inbox count", async () => {
		const host = await rig.load(NO_CONTRACT);
		const ctx = rig.session({ hasUI: true });

		await host.emit("session_start", {}, ctx);
		expect(ctx.lastStatus).toBe("kata fakeuser");

		await host.emitOne("tool_result", bashResult("kata claim abcd"), ctx);
		expect(ctx.lastStatus).toBe("kata fakeuser · abcd");

		rig.fake.reply("inbox", { stdout: INBOX_TEXT });
		await prompt(host, ctx);
		expect(ctx.lastStatus).toBe("kata fakeuser · abcd · inbox 1");
		expect(ctx.statuses.every(s => s.key === "kata")).toBe(true);

		await host.emit("session_shutdown", {}, ctx);
		expect(ctx.lastStatus).toBeUndefined();
	});

	test("without a UI the status is never touched", async () => {
		rig.fake.reply("inbox", { stdout: INBOX_TEXT });
		const host = await rig.load(NO_CONTRACT);
		const ctx = rig.session({ hasUI: false });

		await host.emit("session_start", {}, ctx);
		await host.emitOne("tool_result", bashResult("kata claim abcd"), ctx);
		await prompt(host, ctx);
		await host.emit("session_shutdown", {}, ctx);

		expect(ctx.statuses).toEqual([]);
	});
});
