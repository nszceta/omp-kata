import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	clearActorCache,
	deriveIdentity,
	lookupActor,
	shellQuote,
} from "../../src/identity";
import { KataCli } from "../../src/kata";
import { FAKE_KATA, FakeKata, REAL_KATA, RealKata, tempDir } from "./helpers";

const MAIN = { kind: "main", id: "main" } as const;

describe("shellQuote", () => {
	test("safe words stay unquoted", () => {
		for (const word of ["adam", "a.b-c_d", "adam/bob", "a=b:c,d@e%f+g", "/usr/bin/kata"]) expect(shellQuote(word)).toBe(word);
	});

	test("empty string becomes ''", () => {
		expect(shellQuote("")).toBe("''");
	});

	test("unsafe characters get single quotes", () => {
		expect(shellQuote("a b")).toBe("'a b'");
		expect(shellQuote("$HOME")).toBe("'$HOME'");
		expect(shellQuote("`id`")).toBe("'`id`'");
		expect(shellQuote("a\nb")).toBe("'a\nb'");
		expect(shellQuote("a;b")).toBe("'a;b'");
		expect(shellQuote("~")).toBe("'~'");
	});

	test("embedded single quotes use the '\\'' idiom", () => {
		expect(shellQuote("o'brien")).toBe(`'o'\\''brien'`);
		expect(shellQuote("'")).toBe(`''\\'''`);
	});

	test("a real sh echoes every nasty string back byte-exact", () => {
		const nasty = [
			"",
			" ",
			"a b",
			"o'brien",
			"'",
			"''",
			"'a'b'",
			"$HOME",
			"${HOME}",
			"$(echo pwned)",
			"`echo pwned`",
			"a\nb\n",
			"\ttab",
			"back\\slash",
			"\\'",
			'dq"uote',
			"a;b&&c||d|e",
			"*",
			"~",
			"!x",
			"#comment",
			"-n",
			"%s",
			"ünï ☃",
		];
		for (const value of nasty) {
			const out = Bun.spawnSync(["sh", "-c", `printf %s ${shellQuote(value)}`]);
			expect({ value, code: out.exitCode, stdout: out.stdout.toString() }).toEqual({ value, code: 0, stdout: value });
		}
	});
});

describe("deriveIdentity", () => {
	test("main agent without env: no teammate, inbox is the actor", () => {
		expect(deriveIdentity(MAIN, "adam", {})).toEqual({ actor: "adam", teammate: "", inboxUser: "adam" });
	});

	test("main agent with KATA_TEAMMATE: inbox is actor/teammate", () => {
		expect(deriveIdentity(MAIN, "adam", { KATA_TEAMMATE: "bob" })).toEqual({ actor: "adam", teammate: "bob", inboxUser: "adam/bob" });
	});

	test("main agent: KATA_INBOX_USER overrides the derived inbox only", () => {
		expect(deriveIdentity(MAIN, "adam", { KATA_TEAMMATE: "bob", KATA_INBOX_USER: "shared" })).toEqual({
			actor: "adam",
			teammate: "bob",
			inboxUser: "shared",
		});
		expect(deriveIdentity(MAIN, "adam", { KATA_INBOX_USER: "shared" })).toEqual({ actor: "adam", teammate: "", inboxUser: "shared" });
	});

	test("main agent: empty KATA_INBOX_USER and empty KATA_TEAMMATE fall back to derived values", () => {
		expect(deriveIdentity(MAIN, "adam", { KATA_INBOX_USER: "", KATA_TEAMMATE: "bob" }).inboxUser).toBe("adam/bob");
		expect(deriveIdentity(MAIN, "adam", { KATA_INBOX_USER: "", KATA_TEAMMATE: "" })).toEqual({ actor: "adam", teammate: "", inboxUser: "adam" });
	});

	test("sub agent uses its id and never consults KATA_TEAMMATE / KATA_INBOX_USER", () => {
		const env = { KATA_TEAMMATE: "leaked", KATA_INBOX_USER: "leaked-inbox" };
		expect(deriveIdentity({ kind: "sub", id: "HandicappedSailfish" }, "adam", env)).toEqual({
			actor: "adam",
			teammate: "HandicappedSailfish",
			inboxUser: "adam/HandicappedSailfish",
		});
	});
});

describe("lookupActor (fake kata)", () => {
	const saved: Record<string, string | undefined> = {};
	const fake = new FakeKata();
	let root = "";
	let otherRoot = "";

	beforeAll(() => {
		for (const [key, value] of Object.entries(fake.env())) {
			saved[key] = process.env[key];
			process.env[key] = value;
		}
		root = tempDir();
		otherRoot = tempDir();
	});

	afterAll(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		fake.cleanup();
		rmSync(root, { recursive: true, force: true });
		rmSync(otherRoot, { recursive: true, force: true });
	});

	beforeEach(() => {
		clearActorCache();
		fake.clearReplies();
		writeFileSync(fake.logPath, "");
	});

	afterEach(() => clearActorCache());

	const cli = new KataCli(FAKE_KATA);

	test("returns the actor from `whoami --json` run in the workspace root, and caches it", async () => {
		expect(await lookupActor(cli, root, {})).toBe("fakeuser");
		expect(await lookupActor(cli, root, {})).toBe("fakeuser");
		const calls = fake.callsTo("whoami");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.args).toEqual(["whoami", "--json"]);
		expect(calls[0]?.cwd).toBe(root);
	});

	test("a failing whoami gives undefined and is NOT cached", async () => {
		fake.reply("whoami", { code: 1, stderr: "boom" });
		expect(await lookupActor(cli, root, {})).toBeUndefined();
		expect(await lookupActor(cli, root, {})).toBeUndefined();
		expect(fake.callsTo("whoami")).toHaveLength(2);

		fake.reply("whoami", { stdout: JSON.stringify({ actor: "recovered" }) });
		expect(await lookupActor(cli, root, {})).toBe("recovered");
		expect(await lookupActor(cli, root, {})).toBe("recovered");
		expect(fake.callsTo("whoami")).toHaveLength(3);
	});

	test("an unspawnable executable gives undefined", async () => {
		expect(await lookupActor(new KataCli(join(root, "no-such-kata")), root, {})).toBeUndefined();
	});

	test("unusable output gives undefined and is not cached", async () => {
		for (const stdout of ["not json", "[]", '"adam"', "{}", '{"actor":""}', '{"actor":5}', '{"actor":null}', ""]) {
			fake.reply("whoami", { stdout });
			expect({ stdout, actor: await lookupActor(cli, root, {}) }).toEqual({ stdout, actor: undefined });
		}
		fake.reply("whoami", { stdout: '{"actor":"ok"}' });
		expect(await lookupActor(cli, root, {})).toBe("ok");
	});

	test("the cache key includes root and env.KATA_AUTHOR", async () => {
		await lookupActor(cli, root, { KATA_AUTHOR: "a" });
		await lookupActor(cli, root, { KATA_AUTHOR: "a" });
		expect(fake.callsTo("whoami")).toHaveLength(1);
		await lookupActor(cli, root, { KATA_AUTHOR: "b" });
		expect(fake.callsTo("whoami")).toHaveLength(2);
		await lookupActor(cli, root, {});
		expect(fake.callsTo("whoami")).toHaveLength(3);
		await lookupActor(cli, otherRoot, { KATA_AUTHOR: "a" });
		expect(fake.callsTo("whoami")).toHaveLength(4);
		await lookupActor(cli, root, { KATA_AUTHOR: "b" });
		expect(fake.callsTo("whoami")).toHaveLength(4);
	});

	test("clearActorCache(root) drops only that root; clearActorCache() drops all", async () => {
		await lookupActor(cli, root, {});
		await lookupActor(cli, otherRoot, {});
		expect(fake.callsTo("whoami")).toHaveLength(2);

		clearActorCache(root);
		await lookupActor(cli, otherRoot, {});
		expect(fake.callsTo("whoami")).toHaveLength(2);
		await lookupActor(cli, root, {});
		expect(fake.callsTo("whoami")).toHaveLength(3);

		clearActorCache();
		await lookupActor(cli, root, {});
		await lookupActor(cli, otherRoot, {});
		expect(fake.callsTo("whoami")).toHaveLength(5);
	});

	// The cache is keyed on env.KATA_AUTHOR, so the lookup must run with that same env.
	test("the env it is given is the environment kata whoami runs with", async () => {
		await lookupActor(cli, root, { ...process.env, KATA_AUTHOR: "injected" });
		expect(fake.callsTo("whoami")[0]?.env.KATA_AUTHOR).toBe("injected");
	});
});

describe("real kata", () => {
	const rk = new RealKata("unit-actor");
	const saved: Record<string, string | undefined> = {};

	beforeAll(async () => {
		for (const [key, value] of Object.entries(rk.env())) {
			saved[key] = process.env[key];
			process.env[key] = value;
		}
		await rk.init();
	}, 60_000);

	afterAll(async () => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		clearActorCache();
		await rk.cleanup();
	}, 60_000);

	test("lookupActor reports the KATA_AUTHOR actor of the isolated kata", async () => {
		clearActorCache();
		expect(await lookupActor(new KataCli(REAL_KATA), rk.root, process.env)).toBe("unit-actor");
	}, 30_000);
});
