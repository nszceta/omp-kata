import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { KataCli } from "../../src/kata";
import { FAKE_KATA, FakeKata, tempDir, waitFor } from "./helpers";

let fake: FakeKata;
let cwd: string;

beforeEach(() => {
	fake = new FakeKata();
	cwd = tempDir("omp-kata-cwd-");
});

afterEach(() => {
	fake.cleanup();
	rmSync(cwd, { recursive: true, force: true });
});

describe("KataCli.run", () => {
	test("captures stdout, stderr and exit code 0, and reports no timeout", async () => {
		fake.reply("probe", { stdout: "out text\n", stderr: "err text\n" });
		const result = await new KataCli(FAKE_KATA).run(["probe"], { cwd, env: fake.env() });
		expect(result).toEqual({ code: 0, stdout: "out text\n", stderr: "err text\n", timedOut: false });
	});

	test("a non-zero exit is returned with its output, not thrown", async () => {
		fake.reply("probe", { code: 7, stdout: "partial", stderr: "boom" });
		const result = await new KataCli(FAKE_KATA).run(["probe"], { cwd, env: fake.env() });
		expect(result).toEqual({ code: 7, stdout: "partial", stderr: "boom", timedOut: false });
	});

	test("arguments reach the child verbatim (no shell interpretation) and cwd is honoured", async () => {
		const args = ["probe", "a b;c", "$(touch pwned)", "--flag=x y", ""];
		await new KataCli(FAKE_KATA).run(args, { cwd, env: fake.env() });
		const calls = fake.calls();
		expect(calls).toHaveLength(1);
		expect(calls[0]?.args).toEqual(args);
		expect(calls[0]?.cwd).toBe(cwd);
	});

	test("timeoutMs kills the child and returns promptly with timedOut", async () => {
		fake.reply("slow", { sleepMs: 3000, stdout: "never seen" });
		const started = performance.now();
		const result = await new KataCli(FAKE_KATA).run(["slow"], { cwd, env: fake.env(), timeoutMs: 300 });
		const elapsed = performance.now() - started;
		expect(result).toEqual({ code: -1, stdout: "", stderr: "", timedOut: true });
		expect(elapsed).toBeLessThan(2000);
		// the process really started: the timeout fired on a running child
		expect(fake.callsTo("slow")).toHaveLength(1);
	});

	test("a nonexistent executable yields code -1 with a reason, never throws", async () => {
		const result = await new KataCli(join(cwd, "no-such-kata")).run(["whoami"], { cwd });
		expect(result.code).toBe(-1);
		expect(result.timedOut).toBe(false);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("ENOENT");
	});

	test("a nonexistent cwd yields code -1, never throws, and the child is not run", async () => {
		const result = await new KataCli(FAKE_KATA).run(["whoami"], { cwd: join(cwd, "missing", "dir"), env: fake.env() });
		expect(result.code).toBe(-1);
		expect(result.timedOut).toBe(false);
		expect(fake.calls()).toHaveLength(0);
	});

	describe("environment", () => {
		const AMBIENT = "KATA_UNIT_AMBIENT";
		let saved: string | undefined;

		beforeEach(() => {
			saved = process.env[AMBIENT];
			process.env[AMBIENT] = "ambient";
		});

		afterEach(() => {
			if (saved === undefined) delete process.env[AMBIENT];
			else process.env[AMBIENT] = saved;
		});

		const childEnv = async (override: Record<string, string | undefined> | undefined): Promise<Record<string, string>> => {
			await new KataCli(FAKE_KATA).run(["probe"], { cwd, env: { ...fake.env(), ...override } });
			const call = fake.calls().at(-1);
			if (!call) throw new Error("fake kata was not invoked");
			return call.env;
		};

		test("ambient variables are inherited when not overridden", async () => {
			expect((await childEnv(undefined))[AMBIENT]).toBe("ambient");
		});

		test("overrides replace ambient values and add new ones", async () => {
			const env = await childEnv({ [AMBIENT]: "overridden", KATA_UNIT_NEW: "added" });
			expect(env[AMBIENT]).toBe("overridden");
			expect(env.KATA_UNIT_NEW).toBe("added");
		});

		test("an undefined override removes the variable from the child", async () => {
			const env = await childEnv({ [AMBIENT]: undefined });
			expect(AMBIENT in env).toBe(false);
		});
	});
});

describe("KataCli.spawnDetached", () => {
	test("returns synchronously without waiting for the child, which still runs to completion", async () => {
		fake.reply("slow", { sleepMs: 1500 });
		const cli = new KataCli(FAKE_KATA);
		const started = performance.now();
		const returned = cli.spawnDetached(["slow", "--flag"], { cwd, env: { ...fake.env(), KATA_UNIT_DETACHED: "yes" } });
		const elapsed = performance.now() - started;
		expect(returned).toBeUndefined();
		expect(elapsed).toBeLessThan(500);

		await waitFor(() => fake.callsTo("slow").length === 1, 5000, "detached child to start");
		const call = fake.callsTo("slow")[0];
		expect(call?.args).toEqual(["slow", "--flag"]);
		expect(call?.cwd).toBe(cwd);
		expect(call?.env.KATA_UNIT_DETACHED).toBe("yes");
	});

	test("a missing executable or cwd never throws and does not crash the host asynchronously", async () => {
		const missingExecutable = new KataCli(join(cwd, "no-such-kata"));
		expect(() => missingExecutable.spawnDetached(["whoami"], { cwd })).not.toThrow();
		expect(() => new KataCli(FAKE_KATA).spawnDetached(["whoami"], { cwd: join(cwd, "missing"), env: fake.env() })).not.toThrow();
		// Real-process timing: node's child 'error' event fires on a later tick and spawnDetached exposes no
		// promise to await, so a short real wait is the only way to let an unhandled 'error' crash the run.
		await Bun.sleep(300);
		expect(fake.calls()).toHaveLength(0);
	});
});
