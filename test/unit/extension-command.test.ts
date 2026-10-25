import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FAKE_KATA, bashCall, bashResult } from "./helpers";
import {
	ADDENDUM_HEAD,
	ADDENDUM_TAIL,
	CONTRACT_BLOCK,
	contractBlockOf,
	identityFileText,
	INBOX_TEXT,
	prompt,
	Rig,
	SESSION,
} from "./extension-harness";

let rig: Rig;
beforeEach(() => {
	rig = new Rig();
});
afterEach(() => rig.dispose());

function settingsLine(message: string): unknown {
	const line = message.split("\n").find(l => l.startsWith("settings: "));
	return JSON.parse(line?.slice("settings: ".length) ?? "null");
}

describe("/kata status", () => {
	test("reports workspace, identity, tracked refs, contract size and effective settings", async () => {
		const host = await rig.load({ KATA_TEAMMATE: "alice" }, { settings: { inboxPollSeconds: 42 } });
		const ctx = rig.session();
		await prompt(host, ctx);
		await host.emitOne("tool_result", bashResult("kata claim abcd"), ctx);

		await host.runCommand("kata", "status", ctx);

		expect(ctx.notifications).toHaveLength(1);
		const { message, level } = ctx.notifications[0] ?? { message: "", level: "" };
		expect(level).toBe("info");
		expect(message.split("\n").slice(0, 7)).toEqual([
			`kata workspace: ${rig.ws.root}`,
			"actor: fakeuser",
			"teammate: alice",
			"inbox user: fakeuser/alice",
			"tracked refs: abcd",
			"contract: 18 bytes",
			"inbox: 0 request(s)",
		]);
		expect(settingsLine(message)).toEqual({
			executable: FAKE_KATA,
			contract: true,
			contractSource: "",
			inbox: true,
			inboxPollSeconds: 42,
			wakeOnInbox: false,
			attention: true,
			identity: true,
		});
	});

	test("an empty argument list means status", async () => {
		const host = await rig.load();
		const ctx = rig.session();

		await host.runCommand("kata", "  ", ctx);

		expect(ctx.notifications[0]?.message).toContain(`kata workspace: ${rig.ws.root}\nactor: fakeuser\nteammate: (none)\n`);
	});

	test("settings reflect env overrides; a failing whoami is reported, not thrown", async () => {
		rig.fake.reply("whoami", { code: 1, stderr: "daemon unavailable" });
		const host = await rig.load({ OMP_KATA_IDENTITY: "0", OMP_KATA_CONTRACT: "0" });
		const ctx = rig.session();

		await host.runCommand("kata", "status", ctx);

		const message = ctx.notifications[0]?.message ?? "";
		expect(message).toContain("actor: unknown (kata whoami failed)\n");
		expect(message).toContain("inbox user: unknown\n");
		expect(message).toContain("contract: disabled\n");
		expect(settingsLine(message)).toMatchObject({ identity: false, contract: false });
	});
});

describe("/kata inbox", () => {
	test("prints the current inbox text for the session's address", async () => {
		rig.fake.reply("inbox", { stdout: `${INBOX_TEXT}\n` });
		const host = await rig.load();
		const ctx = rig.session();

		await host.runCommand("kata", "inbox", ctx);

		expect(ctx.notifications).toEqual([{ message: INBOX_TEXT, level: "info" }]);
		expect(rig.calls("inbox")).toEqual([["inbox", "--context", "--for", "fakeuser"]]);
	});

	test("says so when the inbox is empty", async () => {
		const host = await rig.load();
		const ctx = rig.session();

		await host.runCommand("kata", "inbox", ctx);

		expect(ctx.notifications).toEqual([{ message: "kata inbox empty", level: "info" }]);
	});

	test("viewing the inbox does not count as delivering it", async () => {
		rig.fake.reply("inbox", { stdout: INBOX_TEXT });
		const host = await rig.load({ OMP_KATA_CONTRACT: "0" });
		const ctx = rig.session();

		await host.runCommand("kata", "inbox", ctx);
		const result = await prompt(host, ctx);

		expect(result?.message?.content).toBe(`<kata_inbox>\n${INBOX_TEXT}\n</kata_inbox>`);
	});
});

describe("/kata refresh", () => {
	test("drops the cached actor and contract, republishes the identity file, and the next prompt sees the new state", async () => {
		const host = await rig.load();
		const ctx = rig.session();
		await prompt(host, ctx);
		expect(rig.readIdentity(SESSION)).toBe(identityFileText("", "fakeuser"));

		rig.fake.reply("whoami", { stdout: JSON.stringify({ kata_api_version: 1, actor: "newuser", source: "env" }) });
		rig.fake.reply("agent-contract-hook", {
			stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "NEW CONTRACT" } }),
		});

		// Before refresh: contract and identity are served from cache and the file is untouched.
		await host.emitOne("tool_call", bashCall("kata list"), ctx);
		expect(rig.readIdentity(SESSION)).toBe(identityFileText("", "fakeuser"));
		expect((await prompt(host, ctx))?.systemPrompt).toEqual(["base A", "base B", CONTRACT_BLOCK]);

		await host.runCommand("kata", "refresh", ctx);
		expect(ctx.notifications).toEqual([{ message: "kata: contract and identity caches cleared", level: "info" }]);

		const result = await prompt(host, ctx);

		expect(result?.systemPrompt).toEqual([
			"base A",
			"base B",
			contractBlockOf(
				"NEW CONTRACT",
				`${ADDENDUM_HEAD}\nidentity: actor=newuser teammate=(none) inbox=newuser\n${ADDENDUM_TAIL}`,
			),
		]);
		expect(rig.readIdentity(SESSION)).toBe(identityFileText("", "fakeuser").replaceAll("fakeuser", "newuser"));
	});
});

describe("/kata with an unknown subcommand", () => {
	test("warns with usage and does nothing else", async () => {
		const host = await rig.load();
		const ctx = rig.session();

		await host.runCommand("kata", "bogus --flag", ctx);

		expect(ctx.notifications).toEqual([{ message: "usage: /kata [status | inbox | refresh]", level: "warning" }]);
		expect(rig.fake.calls()).toEqual([]);
	});
});
