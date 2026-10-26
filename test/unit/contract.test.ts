import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clearContractCache, contractBlock, getContract, ompAddendum, withContract } from "../../src/contract";
import { KataCli, type KataRunOptions, type KataRunResult } from "../../src/kata";
import { FAKE_KATA, FakeKata, type FakeReply, REAL_KATA, RealKata, tempDir } from "./helpers";

const HOOK = "agent-contract-hook";
const hookJson = (text: string): string => JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } });
const settings = (contractSource = ""): { contractSource: string } => ({ contractSource });

/** Real KataCli with a short deadline, so the (10s) production timeout path can be exercised quickly. */
class ShortDeadlineCli extends KataCli {
	override run(args: string[], options: KataRunOptions): Promise<KataRunResult> {
		return super.run(args, { ...options, timeoutMs: 300 });
	}
}

let fake: FakeKata;
let tmp: string;
let root: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
	fake = new FakeKata();
	tmp = tempDir("omp-kata-contract-");
	root = join(tmp, "root");
	// getContract spawns through KataCli.run with the ambient environment only
	savedEnv = {};
	for (const [key, value] of Object.entries(fake.env())) {
		savedEnv[key] = process.env[key];
		process.env[key] = value;
	}
	mkdirSync(root, { recursive: true });
});

afterEach(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	clearContractCache();
	fake.cleanup();
	rmSync(tmp, { recursive: true, force: true });
});

describe("getContract", () => {
	test("parses hookSpecificOutput.additionalContext and runs `agent-contract-hook` in the root", async () => {
		fake.reply(HOOK, { stdout: hookJson("line one\nline two\n") });
		const result = await getContract(new KataCli(FAKE_KATA), settings(), root);
		expect(result).toEqual({ ok: true, text: "line one\nline two\n" });
		const calls = fake.calls();
		expect(calls).toHaveLength(1);
		expect(calls[0]?.args).toEqual([HOOK]);
		expect(calls[0]?.cwd).toBe(root);
	});

	test("passes --source only when the source is non-empty", async () => {
		await getContract(new KataCli(FAKE_KATA), settings("/etc/contract.txt"), root);
		expect(fake.calls().map(c => c.args)).toEqual([[HOOK, "--source", "/etc/contract.txt"]]);
	});

	test("a cache hit does not call kata again; source, root and executable each get their own entry", async () => {
		const cli = new KataCli(FAKE_KATA);
		const otherRoot = join(tmp, "other-root");
		mkdirSync(otherRoot, { recursive: true });
		const otherExecutable = join(tmp, "kata-link");
		symlinkSync(FAKE_KATA, otherExecutable);
		const lookups: Array<() => Promise<unknown>> = [
			() => getContract(cli, settings(), root),
			() => getContract(cli, settings("src.txt"), root),
			() => getContract(cli, settings(), otherRoot),
			() => getContract(new KataCli(otherExecutable), settings(), root),
		];

		for (const lookup of lookups) await lookup();
		expect(fake.calls()).toHaveLength(4);

		for (const lookup of lookups) await lookup();
		expect(fake.calls()).toHaveLength(4);
	});

	const failures: Array<{ name: string; reply: FakeReply; reason: string }> = [
		{ name: "non-zero exit reports the first stderr line", reply: { code: 3, stderr: "kata: workspace broken\nsecond line\n" }, reason: "exit 3: kata: workspace broken" },
		{ name: "non-zero exit without stderr", reply: { code: 5 }, reason: "exit 5" },
		{ name: "stderr detail is cut to 80 characters", reply: { code: 2, stderr: "x".repeat(200) }, reason: `exit 2: ${"x".repeat(80)}` },
		{ name: "stdout that is not JSON", reply: { stdout: "not json" }, reason: "invalid JSON from kata agent-contract-hook" },
		{ name: "valid JSON that is not an object", reply: { stdout: "[]" }, reason: "invalid JSON from kata agent-contract-hook" },
		{ name: "valid JSON without hookSpecificOutput", reply: { stdout: "{}" }, reason: "unexpected hook output" },
		{
			name: "hookSpecificOutput without additionalContext",
			reply: { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart" } }) },
			reason: "unexpected hook output",
		},
		{
			name: "non-string additionalContext",
			reply: { stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: 5 } }) },
			reason: "unexpected hook output",
		},
	];

	for (const { name, reply, reason } of failures) {
		test(`failure is reported and not cached: ${name}`, async () => {
			fake.reply(HOOK, reply);
			const cli = new KataCli(FAKE_KATA);
			expect(await getContract(cli, settings(), root)).toEqual({ ok: false, reason });

			fake.clearReplies();
			expect(await getContract(cli, settings(), root)).toEqual({ ok: true, text: "FAKE CONTRACT TEXT" });
			expect(fake.callsTo(HOOK)).toHaveLength(2);
		});
	}

	test("a timeout reports 'timed out' and is not cached", async () => {
		fake.reply(HOOK, { sleepMs: 3000, stdout: hookJson("too late") });
		const cli = new ShortDeadlineCli(FAKE_KATA);
		expect(await getContract(cli, settings(), root)).toEqual({ ok: false, reason: "timed out" });

		fake.clearReplies();
		expect(await getContract(cli, settings(), root)).toEqual({ ok: true, text: "FAKE CONTRACT TEXT" });
		expect(fake.callsTo(HOOK)).toHaveLength(2);
	});

	test("a spawn failure is reported and not cached: the same executable path works once it exists", async () => {
		const executable = join(tmp, "kata-installed-later");
		const cli = new KataCli(executable);
		const failed = await getContract(cli, settings(), root);
		expect(failed.ok).toBe(false);
		if (!failed.ok) expect(failed.reason).toStartWith("exit -1: ENOENT");

		symlinkSync(FAKE_KATA, executable);
		expect(await getContract(cli, settings(), root)).toEqual({ ok: true, text: "FAKE CONTRACT TEXT" });
		expect(fake.callsTo(HOOK)).toHaveLength(1);
	});

	test("concurrent callers share one in-flight kata call", async () => {
		fake.reply(HOOK, { sleepMs: 400, stdout: hookJson("shared") });
		const cli = new KataCli(FAKE_KATA);
		const results = await Promise.all([getContract(cli, settings(), root), getContract(cli, settings(), root)]);
		expect(results).toEqual([
			{ ok: true, text: "shared" },
			{ ok: true, text: "shared" },
		]);
		expect(fake.callsTo(HOOK)).toHaveLength(1);
	});
});

describe("clearContractCache", () => {
	test("with a root evicts only that root; without arguments evicts everything", async () => {
		const cli = new KataCli(FAKE_KATA);
		const rootB = join(tmp, "root-b");
		mkdirSync(rootB, { recursive: true });
		await getContract(cli, settings(), root);
		await getContract(cli, settings(), rootB);
		expect(fake.calls().map(c => c.cwd)).toEqual([root, rootB]);

		clearContractCache(root);
		await getContract(cli, settings(), root);
		await getContract(cli, settings(), rootB);
		expect(fake.calls().map(c => c.cwd)).toEqual([root, rootB, root]);

		clearContractCache();
		await getContract(cli, settings(), root);
		await getContract(cli, settings(), rootB);
		expect(fake.calls().map(c => c.cwd)).toEqual([root, rootB, root, root, rootB]);
	});

	test("clearing a root does not evict a root nested below it", async () => {
		const cli = new KataCli(FAKE_KATA);
		const nested = join(root, "nested");
		mkdirSync(nested, { recursive: true });
		await getContract(cli, settings(), root);
		await getContract(cli, settings(), nested);

		clearContractCache(root);
		await getContract(cli, settings(), nested);
		expect(fake.calls()).toHaveLength(2);
		await getContract(cli, settings(), root);
		expect(fake.calls()).toHaveLength(3);
	});
});

describe("withContract", () => {
	const ok = (text: string) => ({ ok: true as const, text });

	test("appends the contract as its own new block and never mutates or joins the input", () => {
		const input = ["system block A", "system block B"];
		const output = withContract(input, ok("CONTRACT TEXT"));
		expect(output).toEqual(["system block A", "system block B", "<kata_contract>\nCONTRACT TEXT\n</kata_contract>"]);
		expect(output).not.toBe(input);
		expect(input).toEqual(["system block A", "system block B"]);
	});

	test("an existing <kata_contract> in any block means no change", () => {
		expect(withContract(["a", "pre <kata_contract>\nold\n</kata_contract> post", "c"], ok("NEW"))).toBeUndefined();
		expect(withContract(["<kata_contract>"], { ok: false, reason: "timed out" })).toBeUndefined();
	});

	test("an empty or whitespace-only contract adds nothing", () => {
		expect(withContract(["a"], ok(""))).toBeUndefined();
		expect(withContract(["a"], ok("  \n\t "))).toBeUndefined();
	});

	test("a non-array system prompt is tolerated and yields just the contract block", () => {
		const expected = ["<kata_contract>\nC\n</kata_contract>"];
		expect(withContract(undefined, ok("C"))).toEqual(expected);
		expect(withContract(null, ok("C"))).toEqual(expected);
		expect(withContract({ not: "an array" }, ok("C"))).toEqual(expected);
	});

	test("a failed fetch becomes the exact unavailable stub", () => {
		expect(withContract(["a"], { ok: false, reason: "exit 3: kata: workspace broken" })).toEqual([
			"a",
			"<kata_contract>\nKata contract is unavailable (exit 3: kata: workspace broken). Run `kata quickstart --format contract` before using kata.\n</kata_contract>",
		]);
	});

	describe("with an addendum", () => {
		const STUB = "Kata contract is unavailable (timed out). Run `kata quickstart --format contract` before using kata.";

		test("an ok contract carries the addendum inside the block, after kata's text", () => {
			expect(contractBlock({ ok: true, text: "CONTRACT" }, "ADDENDUM")).toBe("<kata_contract>\nCONTRACT\nADDENDUM\n</kata_contract>");
			expect(withContract(["a"], { ok: true, text: "CONTRACT" }, "ADDENDUM")).toEqual([
				"a",
				"<kata_contract>\nCONTRACT\nADDENDUM\n</kata_contract>",
			]);
		});

		test("the failure stub carries the addendum after the stub text", () => {
			expect(contractBlock({ ok: false, reason: "timed out" }, "ADDENDUM")).toBe(`<kata_contract>\n${STUB}\nADDENDUM\n</kata_contract>`);
		});

		test("no addendum (or an empty one) leaves the block unchanged", () => {
			expect(contractBlock({ ok: true, text: "CONTRACT" })).toBe("<kata_contract>\nCONTRACT\n</kata_contract>");
			expect(contractBlock({ ok: true, text: "CONTRACT" }, "")).toBe("<kata_contract>\nCONTRACT\n</kata_contract>");
			expect(contractBlock({ ok: false, reason: "timed out" }, "")).toBe(`<kata_contract>\n${STUB}\n</kata_contract>`);
		});

		test("an empty contract is not injected just because there is an addendum", () => {
			expect(contractBlock({ ok: true, text: " \n" }, "ADDENDUM")).toBeUndefined();
			expect(withContract(["a"], { ok: true, text: "" }, "ADDENDUM")).toBeUndefined();
		});

		test("an already-tagged prompt is left alone", () => {
			expect(withContract(["x <kata_contract>old</kata_contract>"], { ok: true, text: "C" }, "ADDENDUM")).toBeUndefined();
			expect(withContract(["x <kata_contract>old</kata_contract>"], { ok: false, reason: "timed out" }, "ADDENDUM")).toBeUndefined();
		});
	});
});

describe("ompAddendum", () => {
	const RULE =
		"omp-kata: omp sets kata identity automatically for every agent in every bash command. Do NOT export KATA_AUTHOR, KATA_TEAMMATE or KATA_INBOX_USER yourself and do NOT put them in task assignments.";
	const ATTENTION = "Attention starts automatically on `kata claim` and ends when the session ends; inbox requests arrive as <kata_inbox> messages.\nKata refs (<project>#<id> or bare short ids) are tracker-local handles. NEVER write them into repository content: source, tests, docs, config, file or directory names, scratch paths, or commit messages. Describe the problem in words in the repo. Link the other way: record commit SHAs and doc paths on the issue (`kata comment`, `--evidence commit:<sha>`).";

	test("a main agent shows its teammate-less identity", () => {
		expect(ompAddendum({ actor: "adam", teammate: "", inboxUser: "adam" })).toBe(
			`${RULE}\nidentity: actor=adam teammate=(none) inbox=adam\n${ATTENTION}`,
		);
	});

	test("a subagent shows its teammate and actor/teammate inbox address", () => {
		expect(ompAddendum({ actor: "adam", teammate: "bob", inboxUser: "adam/bob" })).toBe(
			`${RULE}\nidentity: actor=adam teammate=bob inbox=adam/bob\n${ATTENTION}`,
		);
	});

	test("an unresolved identity omits the identity line", () => {
		expect(ompAddendum(undefined)).toBe(`${RULE}\n${ATTENTION}`);
	});

	test("is exactly 3 lines with an identity and 2 without", () => {
		expect(ompAddendum({ actor: "adam", teammate: "bob", inboxUser: "adam/bob" }).split("\n")).toHaveLength(4);
		expect(ompAddendum({ actor: "adam", teammate: "", inboxUser: "adam" }).split("\n")).toHaveLength(4);
		expect(ompAddendum(undefined).split("\n")).toHaveLength(3);
	});

	test("does not describe an export preamble or shell history", () => {
		for (const text of [ompAddendum({ actor: "adam", teammate: "bob", inboxUser: "adam/bob" }), ompAddendum(undefined)]) {
			expect(text).not.toContain("preamble");
			expect(text).not.toContain("history");
			expect(text).not.toContain("export KATA_AUTHOR=");
			expect(text).not.toContain("kata() {");
		}
	});
});

describe("getContract against real kata", () => {
	test(
		"returns the same text as `kata quickstart --format contract`, and --source replaces it",
		async () => {
			const rk = new RealKata();
			const saved = { KATA_HOME: process.env.KATA_HOME, KATA_AUTHOR: process.env.KATA_AUTHOR };
			Object.assign(process.env, rk.env());
			try {
				const cli = new KataCli(REAL_KATA);
				const quickstart = await rk.kata(["quickstart", "--format", "contract"]);
				expect(quickstart.code).toBe(0);

				const builtIn = await getContract(cli, settings(), rk.root);
				expect(builtIn.ok).toBe(true);
				if (builtIn.ok) {
					expect(builtIn.text).toStartWith("Kata is the system of record for intent");
					expect(builtIn.text).toBe(quickstart.stdout);
					expect(withContract([], builtIn)).toEqual([`<kata_contract>\n${quickstart.stdout}\n</kata_contract>`]);
				}

				const sourceFile = join(rk.base, "custom-contract.txt");
				writeFileSync(sourceFile, "hello contract");
				expect(await getContract(cli, settings(sourceFile), rk.root)).toEqual({ ok: true, text: "hello contract" });
			} finally {
				for (const [key, value] of Object.entries(saved)) {
					if (value === undefined) delete process.env[key];
					else process.env[key] = value;
				}
				await rk.cleanup();
			}
		},
		30_000,
	);
});
