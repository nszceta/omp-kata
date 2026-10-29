import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { bashResult } from "./helpers";
import { CONTRACT_BLOCK, INBOX_PAYLOAD, INBOX_TEXT, prompt, Rig, T0 } from "./extension-harness";

const NO_CONTRACT = { OMP_KATA_CONTRACT: "0" };
const EMPTY_PAYLOAD =
	'<kata_inbox>\nKata inbox for "fakeuser" is now empty; earlier requests were cleared or handled.\n</kata_inbox>';
const INBOX_MESSAGE = { customType: "kata-inbox", content: INBOX_PAYLOAD, display: true };

let rig: Rig;
beforeEach(() => {
	rig = new Rig();
});
afterEach(() => rig.dispose());

describe("inbox at prompt time", () => {
	test("new text is delivered once, an unchanged inbox is not redelivered, clearing delivers 'now empty'", async () => {
		rig.fake.reply("inbox", { stdout: `${INBOX_TEXT}\n` });
		const host = await rig.load(NO_CONTRACT);
		const ctx = rig.session();

		expect(await prompt(host, ctx)).toEqual({ message: INBOX_MESSAGE });
		expect(rig.calls("inbox")).toEqual([["inbox", "--context", "--for", "fakeuser"]]);

		expect(await prompt(host, ctx)).toBeUndefined();

		rig.fake.clearReplies();
		expect(await prompt(host, ctx)).toEqual({ message: { customType: "kata-inbox", content: EMPTY_PAYLOAD, display: true } });
		expect(await prompt(host, ctx)).toBeUndefined();
	});

	test("a subagent reads its own address, actor/<agent id>", async () => {
		const host = await rig.load(NO_CONTRACT);
		const ctx = rig.session({ agent: { kind: "sub", id: "HandicappedSailfish" } });

		await prompt(host, ctx);

		expect(rig.calls("inbox")).toEqual([["inbox", "--context", "--for", "fakeuser/HandicappedSailfish"]]);
	});

	test("KATA_INBOX_USER overrides the main agent's address", async () => {
		const host = await rig.load({ ...NO_CONTRACT, KATA_INBOX_USER: "fakeuser/bob" });

		await prompt(host, rig.session());

		expect(rig.calls("inbox")).toEqual([["inbox", "--context", "--for", "fakeuser/bob"]]);
	});

	test("contract and inbox come back together in one result", async () => {
		rig.fake.reply("inbox", { stdout: INBOX_TEXT });
		const host = await rig.load();

		expect(await prompt(host, rig.session())).toEqual({
			systemPrompt: ["base A", "base B", CONTRACT_BLOCK],
			message: INBOX_MESSAGE,
		});
	});

	test("a failing inbox read delivers nothing and does not throw", async () => {
		rig.fake.reply("inbox", { code: 7, stderr: "daemon unavailable" });
		const host = await rig.load(NO_CONTRACT);

		expect(await prompt(host, rig.session())).toBeUndefined();
	});

	test("inbox=false never calls kata inbox, at prompt time or after tool results", async () => {
		rig.fake.reply("inbox", { stdout: INBOX_TEXT });
		const host = await rig.load({ OMP_KATA_INBOX: "0" });
		const ctx = rig.session();

		await host.emit("session_start", {}, ctx);
		expect(await prompt(host, ctx)).toEqual({ systemPrompt: ["base A", "base B", CONTRACT_BLOCK] });
		expect(await host.emitOne("tool_result", bashResult("ls"), ctx)).toBeUndefined();

		expect(rig.calls("inbox")).toEqual([]);
	});
});

describe("inbox after tool results", () => {
	test("polls are throttled by inboxPollSeconds and only report changes", async () => {
		const host = await rig.load(NO_CONTRACT);
		const ctx = rig.session();
		await prompt(host, ctx);
		expect(rig.calls("inbox")).toHaveLength(1);

		// Same instant: inside the 15s window, kata is not asked again.
		expect(await host.emitOne("tool_result", bashResult("ls"), ctx)).toBeUndefined();
		expect(rig.calls("inbox")).toHaveLength(1);

		rig.fake.reply("inbox", { stdout: INBOX_TEXT });
		rig.time = T0 + 14_999;
		expect(await host.emitOne("tool_result", bashResult("ls"), ctx)).toBeUndefined();
		expect(rig.calls("inbox")).toHaveLength(1);

		rig.time = T0 + 15_000;
		expect(await host.emitOne("tool_result", bashResult("ls"), ctx)).toEqual({ additionalContext: INBOX_PAYLOAD });
		expect(rig.calls("inbox")).toHaveLength(2);

		// Unchanged text on the next due poll: checked, not redelivered.
		rig.time = T0 + 30_000;
		expect(await host.emitOne("tool_result", bashResult("ls"), ctx)).toBeUndefined();
		expect(rig.calls("inbox")).toHaveLength(3);
	});

	test("inboxPollSeconds=0 checks on every tool result", async () => {
		const host = await rig.load(NO_CONTRACT, { settings: { inboxPollSeconds: 0 } });
		const ctx = rig.session();

		for (let i = 0; i < 3; i++) await host.emitOne("tool_result", bashResult("ls"), ctx);
		expect(rig.calls("inbox")).toHaveLength(3);

		rig.fake.reply("inbox", { stdout: INBOX_TEXT });
		expect(await host.emitOne("tool_result", bashResult("ls"), ctx)).toEqual({ additionalContext: INBOX_PAYLOAD });
	});

	test("a request delivered with a tool result is not delivered again at the next prompt", async () => {
		rig.fake.reply("inbox", { stdout: INBOX_TEXT });
		const host = await rig.load(NO_CONTRACT);
		const ctx = rig.session();

		expect(await host.emitOne("tool_result", bashResult("ls"), ctx)).toEqual({ additionalContext: INBOX_PAYLOAD });
		expect(await prompt(host, ctx)).toBeUndefined();
	});
});

describe("idle inbox watcher", () => {
	test.each([
		[15, 15_000],
		[1, 5_000],
		[0, 5_000],
		[60, 60_000],
	])("inboxPollSeconds=%d registers one interval of %d ms", async (seconds, ms) => {
		const host = await rig.load({}, { settings: { inboxPollSeconds: seconds } });
		const ctx = rig.session();

		await host.emit("session_start", {}, ctx);

		expect(ctx.intervals.map(i => i.ms)).toEqual([ms]);
	});

	test("no watcher for subagents or when both inbox and attention are disabled", async () => {
		const sub = rig.session({ agent: { kind: "sub", id: "Sailfish" } });
		await (await rig.load()).emit("session_start", {}, sub);
		expect(sub.intervals).toEqual([]);

		const disabled = rig.session();
		await (await rig.load({ OMP_KATA_INBOX: "0", OMP_KATA_ATTENTION: "0" })).emit("session_start", {}, disabled);
		expect(disabled.intervals).toEqual([]);

		// attention alone keeps the watcher: idle ticks reconcile tracked refs
		const attentionOnly = rig.session();
		await (await rig.load({ OMP_KATA_INBOX: "0" })).emit("session_start", {}, attentionOnly);
		expect(attentionOnly.intervals).toHaveLength(1);
	});

	test("a tick while the agent is busy never calls kata", async () => {
		rig.fake.reply("inbox", { stdout: INBOX_TEXT });
		const host = await rig.load();
		const ctx = rig.session();
		await host.emit("session_start", {}, ctx);

		ctx.idle = false;
		await ctx.tick();

		expect(rig.calls("inbox")).toEqual([]);
		expect(ctx.notifications).toEqual([]);
	});

	test("idle + new inbox, wakeOnInbox=false: notifies once per text and leaves delivery to the next prompt", async () => {
		rig.fake.reply("inbox", { stdout: INBOX_TEXT });
		const host = await rig.load(NO_CONTRACT);
		const ctx = rig.session();
		await host.emit("session_start", {}, ctx);

		await ctx.tick();
		await ctx.tick();

		expect(ctx.notifications).toEqual([{ message: "kata: 1 inbox request(s) for fakeuser", level: "info" }]);
		expect(rig.calls("inbox")).toHaveLength(2);
		expect(host.sent).toEqual([]);
		expect(await prompt(host, ctx)).toEqual({ message: INBOX_MESSAGE });
	});

	test("a changed inbox text is announced again", async () => {
		rig.fake.reply("inbox", { stdout: INBOX_TEXT });
		const host = await rig.load(NO_CONTRACT);
		const ctx = rig.session();
		await host.emit("session_start", {}, ctx);
		await ctx.tick();

		rig.fake.reply("inbox", { stdout: `${INBOX_TEXT}\n- issue="zz99" title="Other" from="adam" message="also"` });
		await ctx.tick();

		expect(ctx.notifications.map(n => n.message)).toEqual([
			"kata: 1 inbox request(s) for fakeuser",
			"kata: 2 inbox request(s) for fakeuser",
		]);
	});

	test("wakeOnInbox=true sends the payload with triggerTurn, once, and the next prompt does not redeliver", async () => {
		rig.fake.reply("inbox", { stdout: INBOX_TEXT });
		const host = await rig.load({ ...NO_CONTRACT, OMP_KATA_WAKE_ON_INBOX: "1" });
		const ctx = rig.session();
		await host.emit("session_start", {}, ctx);

		await ctx.tick();
		await ctx.tick();

		expect(host.sent).toEqual([{ message: INBOX_MESSAGE, options: { triggerTurn: true } }]);
		expect(ctx.notifications).toEqual([]);
		expect(await prompt(host, ctx)).toBeUndefined();
	});

	test("shutdown clears the interval", async () => {
		const host = await rig.load();
		const ctx = rig.session();
		await host.emit("session_start", {}, ctx);
		expect(ctx.liveIntervals).toHaveLength(1);

		await host.emit("session_shutdown", {}, ctx);

		expect(ctx.liveIntervals).toEqual([]);
	});
});
