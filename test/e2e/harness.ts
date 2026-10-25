/**
 * e2e harness: real omp binary + real kata, fully isolated (HOME, PI_CODING_AGENT_DIR, KATA_HOME).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Script } from "../fixtures/e2e/fake-provider.ts";

export const REPO_ROOT = resolve(import.meta.dir, "../..");
export const FAKE_PROVIDER = join(REPO_ROOT, "test/fixtures/e2e/fake-provider.ts");
export const ACTOR = "e2e-actor";
export const OMP = process.env.OMP_BIN ?? join(process.env.HOME ?? "", ".local/bin/omp");
export const KATA = process.env.KATA_BIN ?? join(process.env.HOME ?? "", ".local/bin/kata");

export interface Exec {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

export interface RequestLog {
	seq: number;
	agent: string;
	index: number;
	step: Record<string, unknown>;
	systemPrompt: unknown;
	messages: any[];
}

export interface RunResult extends Exec {
	requests: RequestLog[];
}

export interface EnvOptions {
	/** create a kata workspace (git repo + `kata init`) as cwd. default true */
	workspace?: boolean;
	/** load the plugin via `omp plugin link` (true) or `-e <repo dir>` (false). default false */
	link?: boolean;
	/** plugin settings applied with `omp plugin config set omp-kata <k> <v>` (requires link) */
	settings?: Record<string, string | number | boolean>;
	/** write ~/.bashrc and ~/.zshrc (in the isolated HOME) that prepend a dir holding the REAL kata to PATH, like a user's rc would */
	rcPathKata?: boolean;
	/** extra env for omp runs (e.g. OMP_KATA_*) */
	env?: Record<string, string>;
}

const LEAK_VARS = ["KATA_REF", "KATA_TEAMMATE", "KATA_INBOX_USER", "KATA_SESSION_ID", "KATA_SERVER", "KATA_AUTH_TOKEN", "KATA_DB", "KATA_DSN", "KATA_AUTOSTART", "KATA_DAEMON"];

async function exec(cmd: string[], opts: { cwd: string; env: Record<string, string>; timeoutMs: number; stdin?: string }): Promise<Exec> {
	const proc = Bun.spawn(cmd, { cwd: opts.cwd, env: opts.env, stdout: "pipe", stderr: "pipe", stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]) });
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill("SIGKILL");
	}, opts.timeoutMs);
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const code = await proc.exited;
	clearTimeout(timer);
	return { code, stdout, stderr, timedOut };
}

export class E2EEnv {
	readonly root: string;
	readonly home: string;
	readonly agentDir: string;
	readonly kataHome: string;
	readonly repo: string;
	/** scratch dir shared with scripted bash as $E2E_DIR */
	readonly dir: string;
	readonly logPath: string;
	readonly scriptPath: string;
	private socketDir: string | undefined;
	private runs = 0;

	constructor(readonly opts: EnvOptions = {}) {
		// short path: kata derives its unix socket location from KATA_HOME
		this.root = mkdtempSync(join(tmpdir(), "ok-"));
		this.home = join(this.root, "h");
		this.agentDir = join(this.root, "a");
		this.kataHome = join(this.root, "k");
		this.repo = join(this.root, "repo");
		this.dir = join(this.root, "d");
		this.logPath = join(this.dir, "requests.jsonl");
		this.scriptPath = join(this.dir, "script.json");
		for (const d of [this.home, this.agentDir, this.kataHome, this.repo, this.dir]) mkdirSync(d, { recursive: true });
	}

	baseEnv(extra: Record<string, string> = {}): Record<string, string> {
		const env: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("OMP_KATA_") && !LEAK_VARS.includes(k)) env[k] = v;
		return {
			...env,
			HOME: this.home,
			PI_CODING_AGENT_DIR: this.agentDir,
			KATA_HOME: this.kataHome,
			KATA_AUTHOR: ACTOR,
			E2E_DIR: this.dir,
			OMP_FAKE_LOG: this.logPath,
			OMP_FAKE_SCRIPT: this.scriptPath,
			GIT_CONFIG_GLOBAL: join(this.home, ".gitconfig"),
			...extra,
		};
	}

	async setup(): Promise<void> {
		writeFileSync(join(this.home, ".gitconfig"), "[user]\n\tname = e2e\n\temail = e2e@example.invalid\n[init]\n\tdefaultBranch = main\n");
		if (this.opts.rcPathKata) {
			const bin = join(this.root, "realbin");
			mkdirSync(bin, { recursive: true });
			symlinkSync(KATA, join(bin, "kata"));
			const rc = `export PATH="${bin}:$PATH"\n`;
			writeFileSync(join(this.home, ".bashrc"), rc);
			writeFileSync(join(this.home, ".zshrc"), rc);
			writeFileSync(join(this.home, ".profile"), rc);
		}
		if (this.opts.workspace !== false) {
			await this.must(["git", "init", "-q"], this.repo);
			const init = await this.kata(["init"]);
			if (init.code !== 0) throw new Error(`kata init failed: ${init.stdout}${init.stderr}`);
		}
		if (this.opts.link) {
			const r = await this.omp(["plugin", "link", REPO_ROOT]);
			if (r.code !== 0) throw new Error(`omp plugin link failed: ${r.stdout}${r.stderr}`);
			for (const [k, v] of Object.entries(this.opts.settings ?? {})) {
				const s = await this.omp(["plugin", "config", "set", "omp-kata", k, String(v)]);
				if (s.code !== 0) throw new Error(`omp plugin config set ${k} failed: ${s.stdout}${s.stderr}`);
			}
		} else if (this.opts.settings && Object.keys(this.opts.settings).length) {
			throw new Error("settings require link:true (use opts.env OMP_KATA_* otherwise)");
		}
	}

	private async must(cmd: string[], cwd: string): Promise<void> {
		const r = await exec(cmd, { cwd, env: this.baseEnv(), timeoutMs: 30_000 });
		if (r.code !== 0) throw new Error(`${cmd.join(" ")} failed: ${r.stdout}${r.stderr}`);
	}

	async omp(args: string[], timeoutMs = 60_000): Promise<Exec> {
		return exec([OMP, ...args], { cwd: this.repo, env: this.baseEnv(), timeoutMs });
	}

	/** run real kata against this env's KATA_HOME / actor */
	async kata(args: string[], o: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<Exec> {
		return exec([KATA, ...args], { cwd: o.cwd ?? this.repo, env: this.baseEnv(o.env), timeoutMs: o.timeoutMs ?? 30_000 });
	}

	/** run `kata ... --json`; throws on non-zero exit; returns parsed envelope */
	async kataJson<T = any>(args: string[], o: { env?: Record<string, string> } = {}): Promise<T> {
		const r = await this.kata([...args, "--json"], o);
		if (r.code !== 0) throw new Error(`kata ${args.join(" ")} exited ${r.code}: ${r.stdout}${r.stderr}`);
		return JSON.parse(r.stdout) as T;
	}

	async meta(ref: string): Promise<Record<string, string>> {
		return (await this.kataJson<{ metadata: Record<string, string> }>(["meta", "get", ref])).metadata;
	}

	/** Polls `meta` until `done` holds: attention `end` runs detached and can land after omp exits. */
	async metaUntil(ref: string, done: (meta: Record<string, string>) => boolean, timeoutMs = 10_000): Promise<Record<string, string>> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const meta = await this.meta(ref);
			if (done(meta)) return meta;
			if (Date.now() > deadline) throw new Error(`metadata for ${ref} never settled: ${JSON.stringify(meta)}`);
			await Bun.sleep(100);
		}
	}

	async show(ref: string): Promise<any> {
		return this.kataJson(["show", ref]);
	}

	/** create an issue directly through kata (not via the agent); returns short id */
	async createIssue(title: string, extra: string[] = []): Promise<string> {
		const r = await this.kataJson<{ issue: { short_id: string } }>(["create", title, "--force-new", ...extra]);
		return r.issue.short_id;
	}

	/** run omp headless with the scripted model; returns request log */
	async run(script: Script, prompt: string, o: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; extraArgs?: string[] } = {}): Promise<RunResult> {
		writeFileSync(this.scriptPath, JSON.stringify(script));
		writeFileSync(this.logPath, "");
		const args = ["-p", "--no-session", "--no-title"];
		if (!this.opts.link) args.push("-e", REPO_ROOT);
		args.push("-e", FAKE_PROVIDER, "--model", "fake/scripted", ...(o.extraArgs ?? []), prompt);
		this.runs++;
		const r = await exec([OMP, ...args], {
			cwd: o.cwd ?? this.repo,
			env: this.baseEnv({ ...this.opts.env, ...o.env }),
			timeoutMs: o.timeoutMs ?? 120_000,
		});
		return { ...r, requests: this.readLog() };
	}

	/** start `omp --mode rpc` with the scripted model (stays alive until `close()`) */
	startRpc(script: Script, o: { cwd?: string; env?: Record<string, string> } = {}): RpcSession {
		writeFileSync(this.scriptPath, JSON.stringify(script));
		writeFileSync(this.logPath, "");
		const args = ["--mode", "rpc", "--no-session", "--no-title"];
		if (!this.opts.link) args.push("-e", REPO_ROOT);
		args.push("-e", FAKE_PROVIDER, "--model", "fake/scripted");
		return new RpcSession([OMP, ...args], o.cwd ?? this.repo, this.baseEnv({ ...this.opts.env, ...o.env }));
	}

	readLog(): RequestLog[] {
		if (!existsSync(this.logPath)) return [];
		return readFileSync(this.logPath, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l) as RequestLog);
	}

	file(name: string): string {
		return readFileSync(join(this.dir, name), "utf8").trim();
	}

	async cleanup(): Promise<void> {
		try {
			const st = await this.kata(["daemon", "status"], { timeoutMs: 10_000 });
			const m = /unix:\/\/(\/\S+)\/daemon\.sock/.exec(st.stdout);
			if (m) this.socketDir = m[1];
			await this.kata(["daemon", "stop"], { timeoutMs: 15_000 });
		} catch {}
		if (this.socketDir) {
			try {
				rmdirSync(this.socketDir);
			} catch {}
		}
		rmSync(this.root, { recursive: true, force: true });
	}
}

export async function createEnv(opts: EnvOptions = {}): Promise<E2EEnv> {
	const env = new E2EEnv(opts);
	try {
		await env.setup();
	} catch (e) {
		await env.cleanup();
		throw e;
	}
	return env;
}

// ---- request-log helpers ----

export function systemBlocks(req: RequestLog): string[] {
	const sp = req.systemPrompt;
	if (Array.isArray(sp)) return sp.map(b => (typeof b === "string" ? b : ((b as any)?.text ?? JSON.stringify(b))));
	return typeof sp === "string" ? [sp] : [];
}

export function messageText(m: any): string {
	return typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "");
}

/** all message text in a request, one string per message (incl. role tag) */
export function messageTexts(req: RequestLog): string[] {
	return req.messages.map(m => `${m.role}${m.customType ? `:${m.customType}` : ""}: ${messageText(m)}`);
}

export function agentRequests(res: RunResult, agent: string): RequestLog[] {
	return res.requests.filter(r => r.agent === agent);
}

/** whole request (system + messages + any extra fields) flattened for substring assertions */
export function fullText(req: RequestLog): string {
	return JSON.stringify({ s: req.systemPrompt, m: req.messages });
}

export function count(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

/** the toolResult text for the Nth tool result (0-based) in the last request of an agent */
export function toolResultText(req: RequestLog, n: number): string {
	const results = req.messages.filter(m => m.role === "toolResult");
	return messageText(results[n]);
}

/** run `fn` with a fresh isolated env; always tears down (daemon stop + rm) */
export async function withEnv<T>(opts: EnvOptions, fn: (env: E2EEnv) => Promise<T>): Promise<T> {
	const env = await createEnv(opts);
	try {
		return await fn(env);
	} finally {
		await env.cleanup();
	}
}

export const T = 180_000;

/** bash snippet: extract `.issue.short_id` from a kata create --json file into stdout */
export const SHORT_ID = `grep -o '"short_id":"[^"]*"' | head -1 | cut -d'"' -f4`;

/** system-prompt blocks that contain the contract tag */
export function contractBlocks(req: RequestLog): string[] {
	return systemBlocks(req).filter(b => b.includes("<kata_contract>"));
}

/** the child agent id (as omp named it) from the parent's `task` tool result */
export function spawnedAgentId(res: RunResult): string {
	const parent = res.requests.filter(r => r.agent === "main").at(-1);
	const text = (parent?.messages ?? []).filter(m => m.role === "toolResult" && m.toolName === "task").map(messageText).join("\n");
	const m = /Spawned agent `([^`]+)`/.exec(text);
	if (!m) throw new Error("no spawned agent id found in parent's task result");
	return m[1]!;
}

/** request messages only (excludes the system prompt, whose contract text mentions <kata_inbox>) */
export function messagesText(req: RequestLog): string {
	return JSON.stringify(req.messages);
}

/** every bash command the model issued, as recorded in the assistant toolCall history of the agent's last request */
export function issuedBashCommands(req: RequestLog): string[] {
	const out: string[] = [];
	for (const m of req.messages) {
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const b of m.content) if (b?.type === "toolCall" && b.name === "bash") out.push(String(b.arguments?.command ?? ""));
	}
	return out;
}

export type Frame = Record<string, any> & { type: string };

/** JSONL client for `omp --mode rpc`: every stdout frame is recorded; waiters poll the frame list */
export class RpcSession {
	readonly frames: Frame[] = [];
	private readonly proc: ReturnType<typeof Bun.spawn>;
	private readonly pump: Promise<void>;
	private nextId = 1;

	constructor(cmd: string[], cwd: string, env: Record<string, string>) {
		const proc = Bun.spawn(cmd, { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
		this.proc = proc;
		this.pump = (async () => {
			const dec = new TextDecoder();
			let buf = "";
			for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
				buf += dec.decode(chunk, { stream: true });
				let i: number;
				while ((i = buf.indexOf("\n")) >= 0) {
					const line = buf.slice(0, i).trim();
					buf = buf.slice(i + 1);
					if (!line) continue;
					try {
						this.frames.push(JSON.parse(line) as Frame);
					} catch {
						// non-protocol noise
					}
				}
			}
		})();
	}

	send(frame: Record<string, unknown>): string {
		const id = String(this.nextId++);
		const stdin = this.proc.stdin as { write(d: string): unknown; flush?(): unknown };
		stdin.write(`${JSON.stringify({ id, ...frame })}\n`);
		stdin.flush?.();
		return id;
	}

	/** wait until a frame at index >= from satisfies `match`; returns it. */
	async waitFrame(match: (f: Frame) => boolean, o: { from?: number; timeoutMs?: number; what?: string } = {}): Promise<Frame> {
		const deadline = Date.now() + (o.timeoutMs ?? 60_000);
		for (;;) {
			const f = this.frames.slice(o.from ?? 0).find(match);
			if (f) return f;
			if (Date.now() > deadline) throw new Error(`timed out waiting for frame: ${o.what ?? "?"}; frames: ${this.frames.map(x => x.type + (x.method ? `:${x.method}` : "")).join(", ")}`);
			await Bun.sleep(50);
		}
	}

	/** send a prompt and wait for its prompt_result (or a synchronous agentInvoked:false response); returns frame count afterwards */
	async prompt(message: string, timeoutMs = 60_000): Promise<void> {
		const from = this.frames.length;
		const id = this.send({ type: "prompt", message });
		await this.waitFrame(
			f => (f.type === "prompt_result" && f.id === id) || (f.type === "response" && f.id === id && (f.success === false || f.data?.agentInvoked === false)),
			{ from, timeoutMs, what: `prompt_result for "${message}"` },
		);
	}

	/** close stdin and wait for exit; kills after a grace period. returns exit code */
	async close(graceMs = 15_000): Promise<number | null> {
		try {
			(this.proc.stdin as { end(): unknown }).end();
		} catch {}
		const timer = setTimeout(() => this.proc.kill("SIGKILL"), graceMs);
		const code = await this.proc.exited;
		clearTimeout(timer);
		await this.pump.catch(() => {});
		return code;
	}
}
