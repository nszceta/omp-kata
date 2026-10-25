import { describe, expect, test } from "bun:test";
import { ACTOR, messagesText, type RpcSession, T, withEnv } from "./harness.ts";

const ECHO = { main: [{ text: "ok" }] };
const isNotify = (f: { type: string; method?: string }) => f.type === "extension_ui_request" && f.method === "notify";

async function finish(rpc: RpcSession): Promise<void> {
	const code = await rpc.close();
	expect(code).toBe(0);
}

describe("omp --mode rpc: idle inbox + /kata command", () => {
	test("wakeOnInbox=true: idle session starts its own turn when inbox gets a request", async () => {
		await withEnv({ link: true, settings: { wakeOnInbox: true, inboxPollSeconds: 5 } }, async env => {
			const ref = await env.createIssue("Idle wake probe issue");
			const rpc = env.startRpc(ECHO);
			try {
				await rpc.prompt("first");
				const before = env.readLog().length;
				expect(before).toBe(1);
				expect((await env.kata(["notify", ref, "--to", ACTOR, "--message", "wake probe"])).code).toBe(0);
				const deadline = Date.now() + 40_000;
				while (env.readLog().length === before && Date.now() < deadline) await Bun.sleep(100);
				const reqs = env.readLog();
				expect(reqs.length).toBeGreaterThan(before);
				const woke = reqs[before]!;
				expect(messagesText(woke)).toContain("<kata_inbox>");
				expect(messagesText(woke)).toContain("wake probe");
				// the wake turn is a real agent run, not just a request
				await rpc.waitFrame(f => f.type === "agent_end", { from: rpc.frames.findIndex(f => f.type === "agent_end") + 1, timeoutMs: 20_000, what: "second agent_end" });
			} finally {
				await finish(rpc);
			}
		});
	}, T);

	test("wakeOnInbox=false: idle session notifies, no turn; next prompt carries the inbox message", async () => {
		await withEnv({ env: { OMP_KATA_INBOX_POLL_SECONDS: "5" } }, async env => {
			const ref = await env.createIssue("Idle notify probe issue");
			const rpc = env.startRpc(ECHO);
			try {
				await rpc.prompt("first");
				const before = env.readLog().length;
				expect((await env.kata(["notify", ref, "--to", ACTOR, "--message", "notify probe"])).code).toBe(0);
				const n = await rpc.waitFrame(f => isNotify(f) && /inbox request/.test(f.message), { timeoutMs: 40_000, what: "inbox notify" });
				expect(n.message).toContain(`kata: 1 inbox request(s) for ${ACTOR}`);
				await Bun.sleep(1500); // negative assertion: give a (wrongly) triggered turn time to reach the provider
				expect(env.readLog().length).toBe(before);

				await rpc.prompt("second");
				const reqs = env.readLog();
				expect(reqs.length).toBe(before + 1);
				expect(messagesText(reqs[before]!)).toContain("<kata_inbox>");
				expect(messagesText(reqs[before]!)).toContain("notify probe");
			} finally {
				await finish(rpc);
			}
		});
	}, T);

	test("/kata status and /kata inbox report through UI frames; status line is set", async () => {
		await withEnv({}, async env => {
			const ref = await env.createIssue("Slash command probe issue");
			expect((await env.kata(["notify", ref, "--to", ACTOR, "--message", "status probe"])).code).toBe(0);
			const rpc = env.startRpc(ECHO);
			try {
				await rpc.prompt("first"); // consumes the inbox request at the prompt boundary
				const status = await rpc.waitFrame(f => f.type === "extension_ui_request" && f.method === "setStatus" && f.statusKey === "kata" && !!f.statusText, { what: "setStatus kata" });
				expect(status.statusText).toContain(ACTOR);

				const from = rpc.frames.length;
				await rpc.prompt("/kata status");
				const st = await rpc.waitFrame(f => isNotify(f) && f.message.includes("inbox"), { from, what: "/kata status notify" });
				expect(st.message).toContain(env.repo);
				expect(st.message).toContain(ACTOR);

				const from2 = rpc.frames.length;
				await rpc.prompt("/kata inbox");
				const ib = await rpc.waitFrame(isNotify, { from: from2, what: "/kata inbox notify" });
				expect(ib.message).toContain("status probe");
				expect(ib.message).toContain(ref);
				// slash commands never reach the model
				expect(env.readLog().length).toBe(1);
			} finally {
				await finish(rpc);
			}
		});
	}, T);
});
