import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Env } from "../../src/config";
import type { FakeCtx, FakeHost, ToolResultResult } from "./helpers";
import { Rig } from "./extension-harness";

/** The workspace's `.kata.toml` binds project `ws`; contract and inbox are off so only the guard speaks. */
const QUIET: Env = { OMP_KATA_CONTRACT: "0", OMP_KATA_INBOX: "0" };

interface CallVerdict {
	block?: boolean;
	reason?: string;
}

const reasonFor = (ref: string, where: string) =>
	`kata ref \`${ref}\` in ${where}: describe the change in words; record the cross-reference on the issue instead.`;

let rig: Rig;
let host: FakeHost;
let ctx: FakeCtx;
let seq = 0;

async function load(env: Env = {}): Promise<void> {
	host = await rig.load({ ...QUIET, ...env });
	ctx = rig.session();
}

beforeEach(async () => {
	rig = new Rig();
	await load();
});
afterEach(() => rig.dispose());

function call(toolName: string, input: Record<string, unknown>, id = `c${++seq}`): Promise<CallVerdict | undefined> {
	return host.emitOne<CallVerdict>("tool_call", { toolName, toolCallId: id, input }, ctx);
}

function result(toolName: string, input: Record<string, unknown>, id: string, output = ""): Promise<ToolResultResult | undefined> {
	return host.emitOne<ToolResultResult>(
		"tool_result",
		{ toolName, toolCallId: id, input, isError: false, content: [{ type: "text", text: output }], details: undefined },
		ctx,
	);
}

/** Runs a bash command through tool_call and tool_result, as omp would, with `output` as its stdout. */
async function bash(command: string, output = ""): Promise<void> {
	const id = `c${++seq}`;
	await call("bash", { command }, id);
	await result("bash", { command }, id, output);
}

const write = (path: string, content: string) => call("write", { path, content });

describe("write", () => {
	test("a bare id seen in kata args is blocked", async () => {
		await bash("kata show q7x2 --json");
		expect(await write("src/a.ts", "// fixes q7x2\n")).toEqual({ block: true, reason: reasonFor("q7x2", "src/a.ts") });
	});

	test("ids printed by kata listing commands are seen (JSON short_id, agent and human rows)", async () => {
		await bash("kata list --json", '{"issues":[{"short_id":"m3k9","title":"t"}]}');
		await bash("kata search auth --agent", "OK search count=1\n- issue=r5t6 score=1 title=\"x\"");
		await bash("kata list", "✓ h2j4        Some title (unowned)");
		for (const id of ["m3k9", "r5t6", "h2j4"]) {
			expect(await write("notes.md", `see ${id}`)).toEqual({ block: true, reason: reasonFor(id, "notes.md") });
		}
	});

	test("output of non-listing commands and of failed calls teaches nothing", async () => {
		await bash("echo hi", '{"short_id":"m3k9"}');
		await host.emit(
			"tool_result",
			{ toolName: "bash", toolCallId: "x", input: { command: "kata list --json" }, isError: true, content: [{ type: "text", text: '{"short_id":"r5t6"}' }] },
			ctx,
		);
		expect(await write("a.md", "m3k9 r5t6")).toBeUndefined();
	});

	test("an unseen 4-char token passes; seen ids match on word boundaries only", async () => {
		await bash("kata show q7x2");
		expect(await write("a.md", "w4n8 and xq7x2 and q7x2y")).toBeUndefined();
	});

	test("<project>#<id> for the bound project is blocked even when the id is unseen", async () => {
		expect(await write("a.md", "tracked as ws#w4n8")).toEqual({ block: true, reason: reasonFor("ws#w4n8", "a.md") });
	});

	test("project names seen in kata args or output count like the bound one", async () => {
		await bash("kata show q7x2 --project other", "OK show other#q7x2");
		expect(await write("a.md", "see other#z8y7")).toEqual({ block: true, reason: reasonFor("other#z8y7", "a.md") });
		expect(await write("a.md", "see unknown#z8y7")).toBeUndefined();
	});

	test("KATA_REF is seen from the start", async () => {
		await load({ KATA_REF: "k2k2" });
		expect(await write("a.md", "k2k2")).toEqual({ block: true, reason: reasonFor("k2k2", "a.md") });
	});

	test("internal URLs and paths outside the workspace pass; nested relative paths are checked", async () => {
		await bash("kata show q7x2");
		expect(await write("local://plan.md", "q7x2")).toBeUndefined();
		expect(await write("agent://Peer", "q7x2")).toBeUndefined();
		expect(await write("xd://mcp__x", "q7x2")).toBeUndefined();
		expect(await write(join(rig.ws.outside, "f.md"), "q7x2")).toBeUndefined();
		expect(await write("../plain/f.md", "q7x2")).toBeUndefined();
		expect(await write(join(rig.ws.root, "sub", "f.md"), "q7x2")).toEqual({
			block: true,
			reason: reasonFor("q7x2", join(rig.ws.root, "sub", "f.md")),
		});
	});
});

describe("edit", () => {
	test("only + body lines count, under the file of the latest header", async () => {
		await bash("kata show q7x2");
		const context = "[src/a.ts#1A2B]\nPUT 3.=3:\n+const ok = 1;\nCUT 9.=10 q7x2\n";
		expect(await call("edit", { input: context })).toBeUndefined();
		expect(await call("edit", { input: `${context}[src/b.ts#3C4D]\nPUT >1:\n+// see q7x2` })).toEqual({
			block: true,
			reason: reasonFor("q7x2", "src/b.ts"),
		});
	});

	test("edits to files outside the workspace pass", async () => {
		await bash("kata show q7x2");
		expect(await call("edit", { input: `[${join(rig.ws.outside, "x.ts")}#1A2B]\nPUT 1.=1:\n+q7x2` })).toBeUndefined();
	});
});

describe("ast_edit", () => {
	const ops = [{ pat: "old()", out: "fixed() // q7x2" }];

	test("replacement text is checked when a target path is in the workspace (device write or direct call)", async () => {
		await bash("kata show q7x2");
		expect(await write("xd://ast_edit", JSON.stringify({ ops, paths: ["src"] }))).toEqual({
			block: true,
			reason: reasonFor("q7x2", "src"),
		});
		expect(await call("ast_edit", { ops, paths: ["src/**/*.ts"] })).toEqual({
			block: true,
			reason: reasonFor("q7x2", "src/**/*.ts"),
		});
	});

	test("targets outside the workspace pass", async () => {
		await bash("kata show q7x2");
		expect(await write("xd://ast_edit", JSON.stringify({ ops, paths: [rig.ws.outside] }))).toBeUndefined();
	});
});

describe("git commit", () => {
	test("-m messages with a ref are blocked", async () => {
		expect(await call("bash", { command: 'git add -A && git commit -m "Fix pockets (ws#w4n8)"' })).toEqual({
			block: true,
			reason: reasonFor("ws#w4n8", "commit message"),
		});
	});

	test("ids named by kata earlier in the same command count; -F- heredoc bodies are scanned", async () => {
		expect(await call("bash", { command: 'kata comment q7x2 -m "done" && git commit -am "fix q7x2"' })).toEqual({
			block: true,
			reason: reasonFor("q7x2", "commit message"),
		});
		expect(await call("bash", { command: "git commit -F- <<'EOF'\nFix pockets\n\nSee q7x2.\nEOF" })).toEqual({
			block: true,
			reason: reasonFor("q7x2", "commit message"),
		});
	});

	test("clean messages and other commands pass", async () => {
		await bash("kata show q7x2");
		expect(await call("bash", { command: 'git commit -m "Fix pockets across the tile gap"' })).toBeUndefined();
		expect(await call("bash", { command: "echo q7x2 > /dev/null" })).toBeUndefined();
	});
});

describe("modes", () => {
	test("warn lets the call run and attaches the reason to its tool result", async () => {
		await load({ OMP_KATA_REF_GUARD: "warn" });
		await bash("kata show q7x2");
		const input = { path: "a.md", content: "q7x2" };
		expect(await call("write", input, "w1")).toBeUndefined();
		expect(await result("write", input, "w1")).toEqual({ additionalContext: reasonFor("q7x2", "a.md") });
		expect(await result("write", input, "w1")).toBeUndefined();
	});

	test("off disables the guard (plugin setting)", async () => {
		host = await rig.load(QUIET, { settings: { refGuard: "off" } });
		await bash("kata show q7x2");
		expect(await write("a.md", "q7x2 ws#w4n8")).toBeUndefined();
		expect(await call("bash", { command: 'git commit -m "ws#w4n8"' })).toBeUndefined();
	});

	test("outside a kata workspace nothing is guarded", async () => {
		ctx = rig.session({ cwd: rig.ws.outside });
		expect(await write("a.md", "ws#w4n8")).toBeUndefined();
	});
});
