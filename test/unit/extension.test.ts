import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { bashCall, bashResult } from "./helpers";
import {
	addendum,
	ADDENDUM_HEAD,
	ADDENDUM_TAIL,
	CONTRACT_BLOCK,
	contractBlockOf,
	MAIN_ADDENDUM,
	MAIN_TAIL,
	prompt,
	Rig,
	subContractBlock,
} from "./extension-harness";

let rig: Rig;
beforeEach(() => {
	rig = new Rig();
});
afterEach(() => rig.dispose());

describe("inertness", () => {
	test("outside a kata workspace every handler returns undefined and kata is never invoked", async () => {
		const host = await rig.load();
		const ctx = rig.session({ cwd: rig.ws.outside, hasUI: true });

		expect(await host.emit("session_start", {}, ctx)).toEqual([undefined]);
		expect(await prompt(host, ctx)).toBeUndefined();
		expect(await host.emitOne("tool_call", bashCall("kata list"), ctx)).toBeUndefined();
		expect(await host.emitOne("tool_result", bashResult("kata claim abcd"), ctx)).toBeUndefined();
		expect(await host.emit("session_shutdown", {}, ctx)).toEqual([undefined]);

		expect(rig.fake.calls()).toEqual([]);
		expect(ctx.statuses).toEqual([
			{ key: "kata", text: undefined },
			{ key: "kata", text: undefined },
		]);
		expect(ctx.liveIntervals).toEqual([]);
	});

	test("/kata reports 'not a kata workspace' outside a workspace", async () => {
		const host = await rig.load();
		const ctx = rig.session({ cwd: rig.ws.outside });

		await host.runCommand("kata", "", ctx);
		await host.runCommand("kata", "inbox", ctx);

		expect(ctx.notifications[0]?.level).toBe("info");
		expect(ctx.notifications[0]?.message).toContain(`kata: not a kata workspace (no .kata.toml at or above ${rig.ws.outside})`);
		expect(ctx.notifications[1]).toEqual({ message: "kata: not a kata workspace", level: "info" });
		expect(rig.fake.calls()).toEqual([]);
	});

	test("a workspace is detected from a nested cwd and kata runs at the workspace root", async () => {
		const host = await rig.load();
		const ctx = rig.session({ cwd: rig.ws.nested });

		const result = await prompt(host, ctx);
		await host.runCommand("kata", "status", ctx);

		expect(result?.systemPrompt).toEqual(["base A", "base B", CONTRACT_BLOCK]);
		expect(rig.fake.callsTo("agent-contract-hook")[0]?.cwd).toBe(rig.ws.root);
		expect(ctx.notifications[0]?.message).toContain(`kata workspace: ${rig.ws.root}`);
	});
});

describe("contract injection", () => {
	test("appends exactly one new block after the untouched base blocks", async () => {
		const host = await rig.load();
		const ctx = rig.session();

		const result = await prompt(host, ctx, ["base A", "base B"]);

		expect(result).toEqual({ systemPrompt: ["base A", "base B", CONTRACT_BLOCK] });
		expect(rig.calls("agent-contract-hook")).toEqual([["agent-contract-hook"]]);
	});

	test("a system prompt that already carries the contract is left alone", async () => {
		const host = await rig.load();
		const ctx = rig.session();
		const first = await prompt(host, ctx);

		expect(await prompt(host, ctx, first?.systemPrompt)).toBeUndefined();
	});

	test("contract=false (OMP_KATA_CONTRACT=0) injects nothing and never calls agent-contract-hook", async () => {
		const host = await rig.load({ OMP_KATA_CONTRACT: "0" });
		const ctx = rig.session();

		expect(await prompt(host, ctx)).toBeUndefined();
		expect(rig.calls("agent-contract-hook")).toEqual([]);
	});

	test("contractSource setting is passed as --source", async () => {
		const host = await rig.load({}, { settings: { contractSource: "/etc/kata/contract.txt" } });
		const ctx = rig.session();

		await prompt(host, ctx);

		expect(rig.calls("agent-contract-hook")).toEqual([["agent-contract-hook", "--source", "/etc/kata/contract.txt"]]);
	});

	test("an empty contract text injects nothing", async () => {
		rig.fake.reply("agent-contract-hook", {
			stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "" } }),
		});
		const host = await rig.load();

		expect(await prompt(host, rig.session())).toBeUndefined();
	});

	test("failure injects a stub block, warns once per session, and is not cached", async () => {
		const stub = `<kata_contract>\nKata contract is unavailable (exit 1: boom). Run \`kata quickstart --format contract\` before using kata.\n${MAIN_ADDENDUM}\n</kata_contract>`;
		rig.fake.reply("agent-contract-hook", { code: 1, stderr: "boom\nsecond line" });
		const host = await rig.load();
		const ctx = rig.session();

		const first = await prompt(host, ctx);
		const second = await prompt(host, ctx);

		expect(first?.systemPrompt).toEqual(["base A", "base B", stub]);
		expect(second?.systemPrompt).toEqual(["base A", "base B", stub]);
		expect(ctx.notifications).toEqual([{ message: "kata contract unavailable: exit 1: boom", level: "warning" }]);

		rig.fake.clearReplies();
		const third = await prompt(host, ctx);

		expect(third?.systemPrompt).toEqual(["base A", "base B", CONTRACT_BLOCK]);
		expect(rig.calls("agent-contract-hook")).toHaveLength(3);
		expect(ctx.notifications).toHaveLength(1);
	});

	test("subagent sessions get the contract too", async () => {
		const host = await rig.load();
		const ctx = rig.session({ agent: { kind: "sub", id: "HandicappedSailfish" } });

		expect((await prompt(host, ctx))?.systemPrompt).toEqual(["base A", "base B", subContractBlock("HandicappedSailfish")]);
	});
});

describe("omp addendum in the contract block", () => {
	test("main agent: one block, kata's text first, then the addendum with teammate (none) and inbox=<actor>", async () => {
		const host = await rig.load();

		const result = await prompt(host, rig.session());

		expect(result?.systemPrompt).toHaveLength(3);
		expect(result?.systemPrompt?.[2]).toBe(
			[
				"<kata_contract>",
				"FAKE CONTRACT TEXT",
				ADDENDUM_HEAD,
				"identity: actor=fakeuser teammate=(none) inbox=fakeuser",
				MAIN_TAIL,
				"</kata_contract>",
			].join("\n"),
		);
	});

	test("main agent with KATA_TEAMMATE states its teammate and actor/teammate inbox", async () => {
		const host = await rig.load({ KATA_TEAMMATE: "alice" });

		const result = await prompt(host, rig.session());

		expect(result?.systemPrompt?.[2]).toBe(contractBlockOf("FAKE CONTRACT TEXT", addendum("alice", "fakeuser/alice", true)));
	});

	test("subagent: teammate is its id and inbox is actor/id, regardless of the main agent's env", async () => {
		const host = await rig.load({ KATA_TEAMMATE: "alice", KATA_INBOX_USER: "zed" });
		const ctx = rig.session({ agent: { kind: "sub", id: "HandicappedSailfish" } });

		const result = await prompt(host, ctx);

		expect(result?.systemPrompt?.[2]).toBe(
			[
				"<kata_contract>",
				"FAKE CONTRACT TEXT",
				ADDENDUM_HEAD,
				"identity: actor=fakeuser teammate=HandicappedSailfish inbox=fakeuser/HandicappedSailfish",
				ADDENDUM_TAIL,
				"</kata_contract>",
			].join("\n"),
		);
	});

	test("the injected block is byte-identical on every prompt of a session (cache-stable)", async () => {
		const host = await rig.load();
		const ctx = rig.session();

		const first = await prompt(host, ctx);
		const second = await prompt(host, ctx);

		expect(second?.systemPrompt).toEqual(first?.systemPrompt);
		expect(first?.systemPrompt?.[2]).toContain(MAIN_ADDENDUM);
	});

	test("the addendum is also present after the failure stub text", async () => {
		rig.fake.reply("agent-contract-hook", { code: 1, stderr: "boom" });
		const host = await rig.load();

		const result = await prompt(host, rig.session());

		const block = result?.systemPrompt?.[2] ?? "";
		expect(block).toStartWith("<kata_contract>\nKata contract is unavailable (exit 1: boom).");
		expect(block).toEndWith(`before using kata.\n${MAIN_ADDENDUM}\n</kata_contract>`);
	});

	test("without a resolvable actor the addendum omits the identity line", async () => {
		rig.fake.reply("whoami", { code: 1, stderr: "daemon unavailable" });
		const host = await rig.load();

		const result = await prompt(host, rig.session());

		expect(result?.systemPrompt?.[2]).toBe(`<kata_contract>\nFAKE CONTRACT TEXT\n${ADDENDUM_HEAD}\n${MAIN_TAIL}\n</kata_contract>`);
	});
});
