import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { AttentionTracker } from "../../src/attention";
import { KataCli } from "../../src/kata";
import { FAKE_KATA, type FakeCall, FakeKata, REAL_KATA, RealKata, tempDir, waitFor } from "./helpers";

const START = "agent-hook attention-native pi start";
const END = "agent-hook attention-native pi end";
const CLOSE_MESSAGE = "Finished the attention probe and verified the outcome.";
const closeCommand = (ref: string): string => `kata close ${ref} --done -m "${CLOSE_MESSAGE}" --commit abc1234`;

/** argv a start/end call must carry. */
const hookArgs = (action: "start" | "end", sessionId: string, hostPid: number, ref: string, root: string): string[] => [
	"agent-hook",
	"attention-native",
	"pi",
	action,
	"--session",
	sessionId,
	"--host-pid",
	String(hostPid),
	"--ref",
	ref,
	"--workspace",
	root,
];

const refOf = (call: FakeCall): string | undefined => call.args[call.args.indexOf("--ref") + 1];

describe("AttentionTracker (fake kata)", () => {
	const HOST_PID = 424242;
	let fake: FakeKata;
	let root: string;
	let savedEnv: Record<string, string | undefined>;
	let tracker: AttentionTracker;
	const cli = new KataCli(FAKE_KATA);

	const endRefs = (): Array<string | undefined> => fake.callsTo(END).map(refOf);

	beforeEach(() => {
		fake = new FakeKata();
		root = tempDir("omp-kata-attention-");
		tracker = new AttentionTracker(cli, root, HOST_PID);
		// the tracker spawns through KataCli with the ambient environment (plus KATA_SESSION_ID)
		savedEnv = {};
		for (const [key, value] of Object.entries(fake.env())) {
			savedEnv[key] = process.env[key];
			process.env[key] = value;
		}
	});

	afterEach(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		fake.cleanup();
		rmSync(root, { recursive: true, force: true });
	});

	describe("start", () => {
		test("runs the exact attention-native argv in the root with KATA_SESSION_ID=omp-<session> and tracks the ref", async () => {
			expect(await tracker.start("ab12", "sess-1")).toBe(true);

			const calls = fake.calls();
			expect(calls).toHaveLength(1);
			expect(calls[0]?.args).toEqual(hookArgs("start", "sess-1", HOST_PID, "ab12", root));
			expect(calls[0]?.cwd).toBe(root);
			expect(calls[0]?.env.KATA_SESSION_ID).toBe("omp-sess-1");
			expect(tracker.has("ab12")).toBe(true);
			expect(tracker.refs()).toEqual(["ab12"]);
		});

		test("a second start of the same ref in the same session is a no-op", async () => {
			await tracker.start("ab12", "sess-1");
			expect(await tracker.start("ab12", "sess-1")).toBe(true);
			expect(fake.callsTo(START)).toHaveLength(1);
		});

		test("a failed start (exit 1) is reported but the ref stays tracked, since the claim happened", async () => {
			fake.reply("agent-hook attention-native", { code: 1, stderr: "kata: native attention start: issue lookup unavailable" });
			expect(await tracker.start("ab12", "sess-1")).toBe(false);
			expect(tracker.has("ab12")).toBe(true);
			expect(tracker.endAll()).toEqual(["ab12"]);
			await waitFor(() => fake.callsTo(END).length === 1, 5000, "end for the ref whose start failed");
		});
	});

	describe("applyCommand", () => {
		const SESSION = "sess-1";
		const apply = (command: string, names: readonly string[] = ["kata"]): Promise<boolean> => tracker.applyCommand(command, SESSION, names);

		/** Ends everything still tracked and waits for those `end` calls, so absences can be asserted afterwards. */
		const endAndSettle = async (expected: string[]): Promise<void> => {
			expect(tracker.endAll()).toEqual(expected);
			await waitFor(() => fake.callsTo(END).length >= expected.length, 5000, "end calls");
		};

		test("claim starts and tracks every new ref, once", async () => {
			expect(await apply("kata claim ab12 cd34 --agent")).toBe(true);
			expect(fake.callsTo(START).map(refOf)).toEqual(["ab12", "cd34"]);
			expect(tracker.refs()).toEqual(["ab12", "cd34"]);

			expect(await apply("kata claim ab12 cd34 --agent")).toBe(false);
			expect(fake.callsTo(START)).toHaveLength(2);
		});

		test("close untracks the ref without calling `end`", async () => {
			await apply("kata claim ab12 cd34");
			expect(await apply(closeCommand("ab12"))).toBe(true);
			expect(tracker.refs()).toEqual(["cd34"]);
			expect(fake.callsTo(END)).toHaveLength(0);

			// shutdown ends only what is still open
			await endAndSettle(["cd34"]);
			expect(endRefs()).toEqual(["cd34"]);
		});

		test("claim then close in one command leaves nothing tracked and never ends the ref", async () => {
			expect(await apply(`kata claim ab12 && ${closeCommand("ab12")}`)).toBe(true);
			expect(fake.callsTo(START).map(refOf)).toEqual(["ab12"]);
			expect(tracker.refs()).toEqual([]);

			// a sentinel proves endAll really spawned (and only spawned) what was still tracked
			await apply("kata claim ef56");
			await endAndSettle(["ef56"]);
			expect(endRefs()).toEqual(["ef56"]);
		});

		test("closing a ref that was never tracked changes nothing", async () => {
			expect(await apply(closeCommand("ab12"))).toBe(false);
			expect(tracker.refs()).toEqual([]);
		});

		test("--dry claim and --dry close are ignored", async () => {
			expect(await apply("kata claim ab12 --dry --agent")).toBe(false);
			expect(fake.calls()).toHaveLength(0);
			expect(tracker.refs()).toEqual([]);

			await apply("kata claim ab12");
			expect(await apply(`${closeCommand("ab12")} --dry`)).toBe(false);
			expect(tracker.has("ab12")).toBe(true);
		});

		test("commands for other executables are ignored; `names` selects which basenames count", async () => {
			expect(await apply("othertool claim ab12")).toBe(false);
			expect(await apply("echo kata claim ab12")).toBe(false);
			expect(await apply("/opt/bin/mykata claim ab12")).toBe(false);
			expect(fake.calls()).toHaveLength(0);

			expect(await apply("/opt/bin/mykata claim ab12", ["kata", "mykata"])).toBe(true);
			expect(tracker.refs()).toEqual(["ab12"]);
			expect(fake.callsTo(START).map(refOf)).toEqual(["ab12"]);
		});
	});

	describe("endAll", () => {
		test("spawns a detached `end` per tracked ref under the session it was started with, then clears tracking", async () => {
			await tracker.start("ab12", "sess-A");
			await tracker.start("cd34", "sess-B");
			// re-claimed in another session: only the latest session may be ended
			await tracker.start("ef56", "sess-A");
			await tracker.start("ef56", "sess-B");

			expect(tracker.endAll()).toEqual(["ab12", "cd34", "ef56"]);
			expect(tracker.refs()).toEqual([]);

			await waitFor(() => fake.callsTo(END).length === 3, 5000, "three detached end calls");
			const ends = fake.callsTo(END).sort((a, b) => (refOf(a) ?? "").localeCompare(refOf(b) ?? ""));
			expect(ends.map(c => c.args)).toEqual([
				hookArgs("end", "sess-A", HOST_PID, "ab12", root),
				hookArgs("end", "sess-B", HOST_PID, "cd34", root),
				hookArgs("end", "sess-B", HOST_PID, "ef56", root),
			]);
			expect(ends.map(c => c.env.KATA_SESSION_ID)).toEqual(["omp-sess-A", "omp-sess-B", "omp-sess-B"]);
			for (const call of ends) expect(call.cwd).toBe(root);
		});

		test("a second endAll returns nothing and spawns nothing", async () => {
			await tracker.start("ab12", "sess-1");
			expect(tracker.endAll()).toEqual(["ab12"]);
			expect(tracker.endAll()).toEqual([]);

			// sentinel: tracked after the second endAll, ended by a third; ab12 must not be ended again
			await tracker.start("cd34", "sess-1");
			expect(tracker.endAll()).toEqual(["cd34"]);
			await waitFor(() => fake.callsTo(END).length >= 2, 5000, "end calls");
			expect(endRefs().sort()).toEqual(["ab12", "cd34"]);
		});
	});

	describe("isClosed", () => {
		const showJson = (status: string): string => JSON.stringify({ kata_api_version: 1, issue: { short_id: "ab12", status } });

		test("asks `show <ref> --json` in the root and reads issue.status", async () => {
			fake.reply("show", { stdout: showJson("closed") });
			expect(await tracker.isClosed("ab12")).toBe(true);
			const calls = fake.callsTo("show");
			expect(calls).toHaveLength(1);
			expect(calls[0]?.args).toEqual(["show", "ab12", "--json"]);
			expect(calls[0]?.cwd).toBe(root);

			fake.reply("show", { stdout: showJson("open") });
			expect(await tracker.isClosed("ab12")).toBe(false);
		});

		test("any failure to find out counts as not closed", async () => {
			fake.reply("show", { code: 4, stdout: showJson("closed"), stderr: "kata: not found" });
			expect(await tracker.isClosed("ab12")).toBe(false);
			fake.reply("show", { stdout: "not json" });
			expect(await tracker.isClosed("ab12")).toBe(false);
			fake.reply("show", { stdout: "{}" });
			expect(await tracker.isClosed("ab12")).toBe(false);
		});
	});

	describe("reconcile", () => {
		const status = (fields: Record<string, string>): { stdout: string } => ({
			stdout: JSON.stringify({ kata_api_version: 1, actor: "adam", ...fields }),
		});

		test("evicts closed, deleted and foreign-owned refs without ending them; keeps owned, unowned and unreadable", async () => {
			const refs = ["clos", "gone", "othr", "mine", "free", "fail", "junk"];
			for (const ref of refs) await tracker.start(ref, "sess-1");
			fake.reply("status clos", status({ issue_status: "closed", owner: "adam" }));
			fake.reply("status gone", { code: 4, stderr: "issue not found" });
			fake.reply("status othr", status({ issue_status: "open", owner: "bob" }));
			fake.reply("status mine", status({ issue_status: "open", owner: "adam" }));
			fake.reply("status free", status({ issue_status: "open" }));
			fake.reply("status fail", { code: 7, stdout: JSON.stringify({ issue_status: "closed" }) });
			fake.reply("status junk", { stdout: "not json" });

			expect((await tracker.reconcile()).sort()).toEqual(["clos", "gone", "othr"]);
			expect(tracker.refs().sort()).toEqual(["fail", "free", "junk", "mine"]);
			const calls = fake.callsTo("status");
			expect(calls.map(c => c.args).sort()).toEqual(refs.sort().map(ref => ["status", ref, "--json"]));
			for (const call of calls) expect(call.cwd).toBe(root);

			expect(tracker.endAll().sort()).toEqual(["fail", "free", "junk", "mine"]);
			await waitFor(() => fake.callsTo(END).length === 4, 5000, "four end calls");
			expect(endRefs().sort()).toEqual(["fail", "free", "junk", "mine"]);
		});

		test("a re-claim under another session during the check keeps the ref", async () => {
			await tracker.start("ab12", "sess-1");
			// the reply delay only has to outlast the re-claim's own fake-kata call
			fake.reply("status ab12", { ...status({ issue_status: "closed" }), sleepMs: 1000 });
			const pending = tracker.reconcile();
			await waitFor(() => fake.callsTo("status").length === 1, 5000, "status call in flight");
			await tracker.start("ab12", "sess-2");
			expect(await pending).toEqual([]);
			expect(tracker.refs()).toEqual(["ab12"]);
		});
	});
});

/** Polls real kata metadata until `predicate` holds; the detached `end` process offers nothing to await. */
async function metaUntil(rk: RealKata, ref: string, predicate: (meta: Record<string, string>) => boolean): Promise<Record<string, string>> {
	const deadline = Date.now() + 20_000;
	for (;;) {
		const meta = await rk.meta(ref);
		if (predicate(meta)) return meta;
		if (Date.now() > deadline) throw new Error(`timed out waiting for metadata of ${ref}; last seen ${JSON.stringify(meta)}`);
		await Bun.sleep(100);
	}
}

describe("AttentionTracker against real kata", () => {
	let rk: RealKata;
	let saved: Record<string, string | undefined>;
	const cli = new KataCli(REAL_KATA);

	beforeAll(async () => {
		rk = new RealKata("unit-attention");
		await rk.init();
		saved = { KATA_HOME: process.env.KATA_HOME, KATA_AUTHOR: process.env.KATA_AUTHOR };
		Object.assign(process.env, rk.env());
	}, 30_000);

	afterAll(async () => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rk.cleanup();
	}, 30_000);

	test(
		"start sets attention ok; a detached end after the host process died still hands off as needs-human",
		async () => {
			const ref = await rk.createIssue("Attention dead host probe");
			const host = Bun.spawn(["sleep", "300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
			try {
				const tracker = new AttentionTracker(cli, rk.root, host.pid);
				expect(await tracker.start(ref, "sess-dead-host")).toBe(true);
				const started = await rk.meta(ref);
				expect(started["work.attention"]).toBe("ok");
				expect(started["work.attention_session"]).toMatch(/^[0-9a-f]{64}$/);

				host.kill();
				await host.exited;
				expect(() => process.kill(host.pid, 0)).toThrow();

				expect(tracker.endAll()).toEqual([ref]);
				const ended = await metaUntil(rk, ref, meta => meta["work.attention"] === "needs-human");
				expect(ended["work.attention_msg"]).toBe("session ended without hand-off");
				expect(ended["work.attention_session"]).toStartWith("ended:");
			} finally {
				host.kill();
			}
		},
		60_000,
	);

	test(
		"a closed issue keeps its attention state when endAll runs while it is still tracked",
		async () => {
			const closedRef = await rk.createIssue("Attention closed probe");
			const sentinelRef = await rk.createIssue("Attention sentinel probe");
			const tracker = new AttentionTracker(cli, rk.root, process.pid);
			expect(await tracker.start(closedRef, "sess-closed")).toBe(true);
			expect(await tracker.start(sentinelRef, "sess-closed")).toBe(true);
			expect(await tracker.isClosed(closedRef)).toBe(false);

			const close = await rk.kata(["close", closedRef, "--done", "-m", CLOSE_MESSAGE, "--commit", "abc1234"]);
			expect(close.code).toBe(0);
			expect(await tracker.isClosed(closedRef)).toBe(true);
			expect(await tracker.isClosed(sentinelRef)).toBe(false);
			const before = await rk.meta(closedRef);
			expect(before["work.attention"]).toBe("ok");

			expect(tracker.endAll()).toEqual([closedRef, sentinelRef]);
			await metaUntil(rk, sentinelRef, meta => meta["work.attention"] === "needs-human");
			// The closed issue's `end` was spawned first; give it ample time to have changed something.
			await Bun.sleep(750);
			expect(await rk.meta(closedRef)).toEqual(before);
		},
		60_000,
	);
});
