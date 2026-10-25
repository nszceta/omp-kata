/**
 * Shared unit-test scaffolding: temp kata workspaces, a controllable fake `kata` executable, a real
 * isolated kata (own KATA_HOME, daemon stopped on cleanup) and a hand-rolled omp ExtensionAPI/context.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createKataExtension, type KataExtensionOptions } from "../../src/index";

export const FAKE_KATA = resolve(import.meta.dir, "../fixtures/fake-kata");
export const REAL_KATA = process.env.KATA_BIN ?? join(process.env.HOME ?? "", ".local/bin/kata");

export function tempDir(prefix = "omp-kata-unit-"): string {
	return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** Temp directory containing `.kata.toml` (and a nested `sub/dir`), plus a sibling dir with none. */
export function makeWorkspace(): { root: string; nested: string; outside: string; cleanup: () => void } {
	const base = tempDir();
	const root = join(base, "ws");
	const nested = join(root, "sub", "dir");
	const outside = join(base, "plain");
	mkdirSync(nested, { recursive: true });
	mkdirSync(outside, { recursive: true });
	writeFileSync(join(root, ".kata.toml"), 'version = 1\n\n[project]\nname = "ws"\n');
	return { root, nested, outside, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

export interface FakeCall {
	args: string[];
	cwd: string;
	env: Record<string, string>;
}

export interface FakeReply {
	code?: number;
	stdout?: string;
	stderr?: string;
	sleepMs?: number;
}

/** Controls test/fixtures/fake-kata: scripted replies in, recorded invocations out. */
export class FakeKata {
	readonly dir = tempDir("omp-kata-fake-");
	readonly logPath = join(this.dir, "calls.jsonl");
	readonly responsesPath = join(this.dir, "responses.json");
	private responses: Record<string, FakeReply> = {};

	constructor() {
		writeFileSync(this.logPath, "");
		this.flush();
	}

	/** Env that makes the fake visible to KataCli: spread into process.env or pass as `env` option. */
	env(): Record<string, string> {
		return { FAKE_KATA_LOG: this.logPath, FAKE_KATA_RESPONSES: this.responsesPath };
	}

	reply(prefix: string, reply: FakeReply): this {
		this.responses[prefix] = reply;
		this.flush();
		return this;
	}

	clearReplies(): void {
		this.responses = {};
		this.flush();
	}

	private flush(): void {
		writeFileSync(this.responsesPath, JSON.stringify(this.responses));
	}

	calls(): FakeCall[] {
		return readFileSync(this.logPath, "utf8")
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as FakeCall);
	}

	/** Calls whose space-joined argv starts with `prefix`. */
	callsTo(prefix: string): FakeCall[] {
		return this.calls().filter(c => {
			const joined = c.args.join(" ");
			return joined === prefix || joined.startsWith(`${prefix} `);
		});
	}

	cleanup(): void {
		rmSync(this.dir, { recursive: true, force: true });
	}
}

/** Polls until `predicate` holds (for detached processes whose completion we cannot await). */
export async function waitFor(predicate: () => boolean, timeoutMs = 5000, what = "condition"): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(25);
	}
}

export interface KataResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Real kata in a private KATA_HOME with a bound git workspace. `cleanup()` stops the daemon it started. */
export class RealKata {
	readonly base = tempDir("omp-kata-real-");
	readonly home = join(this.base, "home");
	readonly root = join(this.base, "repo");
	readonly actor: string;
	private cleaned = false;

	constructor(actor = "unit-actor") {
		this.actor = actor;
		mkdirSync(this.root, { recursive: true });
	}

	/** Env additions for the system under test: isolates it from the user's real kata state. */
	env(): Record<string, string> {
		return { KATA_HOME: this.home, KATA_AUTHOR: this.actor };
	}

	async init(): Promise<void> {
		writeFileSync(join(this.base, ".gitconfig"), "[user]\n\tname = unit\n\temail = unit@example.invalid\n");
		for (const cmd of [["git", "init", "-q"]]) {
			const p = Bun.spawnSync(cmd, { cwd: this.root, env: { ...process.env, HOME: this.base } });
			if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed`);
		}
		const init = await this.kata(["init"]);
		if (init.code !== 0) throw new Error(`kata init failed: ${init.stdout}${init.stderr}`);
	}

	async kata(args: string[], extraEnv: Record<string, string> = {}): Promise<KataResult> {
		const proc = Bun.spawn([REAL_KATA, ...args], {
			cwd: this.root,
			env: { ...process.env, HOME: this.base, ...this.env(), ...extraEnv },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		return { code, stdout, stderr };
	}

	async createIssue(title: string): Promise<string> {
		const result = await this.kata(["create", title, "--force-new", "--json"]);
		if (result.code !== 0) throw new Error(`kata create failed: ${result.stdout}${result.stderr}`);
		return (JSON.parse(result.stdout) as { issue: { short_id: string } }).issue.short_id;
	}

	async meta(ref: string): Promise<Record<string, string>> {
		const result = await this.kata(["meta", "get", ref, "--json"]);
		return (JSON.parse(result.stdout) as { metadata: Record<string, string> }).metadata;
	}

	async cleanup(): Promise<void> {
		if (this.cleaned) return;
		this.cleaned = true;
		if (existsSync(this.home)) {
			const status = await this.kata(["daemon", "status"]);
			const socketDir = /unix:\/\/(\/\S+)\/daemon\.sock/.exec(status.stdout)?.[1];
			await this.kata(["daemon", "stop"]);
			if (socketDir) rmSync(socketDir, { recursive: true, force: true });
		}
		rmSync(this.base, { recursive: true, force: true });
	}
}

export type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;

export interface PromptResult {
	systemPrompt?: string[];
	message?: { customType: string; content: string; display: boolean };
}
export interface ToolCallResult {
	input?: { command: string };
}
export interface ToolResultResult {
	additionalContext?: string;
}

export interface AgentIdentityInit {
	kind: "main" | "sub";
	id: string;
	name?: string;
	depth?: number;
	parentId?: string;
}

export interface Notification {
	message: string;
	level: string;
}

export interface SentMessage {
	message: unknown;
	options: unknown;
}

export interface FakeCtxOptions {
	cwd: string;
	agent?: AgentIdentityInit;
	hasUI?: boolean;
	sessionId?: string;
	idle?: boolean;
}

interface Interval {
	callback: () => unknown;
	ms: number | undefined;
	cleared: boolean;
}

/** Stand-in for the per-session ExtensionContext, recording every UI/timer interaction. */
export class FakeCtx {
	readonly notifications: Notification[] = [];
	readonly statuses: { key: string; text: string | undefined }[] = [];
	readonly intervals: Interval[] = [];
	idle: boolean;
	sessionId: string;

	constructor(private readonly options: FakeCtxOptions) {
		this.idle = options.idle ?? true;
		this.sessionId = options.sessionId ?? "session-1";
	}

	/** The object handlers receive as `ctx`. */
	get ctx(): ExtensionContext {
		const self = this;
		return {
			cwd: self.options.cwd,
			hasUI: self.options.hasUI ?? false,
			mode: "print",
			agent: { depth: 0, name: "main", ...(self.options.agent ?? { kind: "main", id: "Main" }) },
			isIdle: () => self.idle,
			sessionManager: { getSessionId: () => self.sessionId },
			ui: {
				notify: (message: string, level: string) => void self.notifications.push({ message, level }),
				setStatus: (key: string, text: string | undefined) => void self.statuses.push({ key, text }),
			},
			setInterval: (callback: () => unknown, ms?: number) => {
				const interval: Interval = { callback, ms, cleared: false };
				self.intervals.push(interval);
				return interval;
			},
			clearTimer: (timer: Interval) => {
				timer.cleared = true;
			},
		} as unknown as ExtensionContext;
	}

	get lastStatus(): string | undefined {
		return this.statuses.at(-1)?.text;
	}

	/** Runs every live interval callback once, as the host timer would. */
	async tick(): Promise<void> {
		for (const interval of this.intervals.filter(i => !i.cleared)) await interval.callback();
	}

	get liveIntervals(): Interval[] {
		return this.intervals.filter(i => !i.cleared);
	}
}

/** Captures what the extension registers and lets tests fire events at it. */
export class FakeHost {
	readonly handlers = new Map<string, Handler[]>();
	readonly commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	readonly sent: SentMessage[] = [];

	get api(): ExtensionAPI {
		const self = this;
		return {
			on: (event: string, handler: Handler) => {
				self.handlers.set(event, [...(self.handlers.get(event) ?? []), handler]);
			},
			registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
				self.commands.set(name, options);
			},
			sendMessage: (message: unknown, options: unknown) => void self.sent.push({ message, options }),
		} as unknown as ExtensionAPI;
	}

	/** Fires `event` at every handler in registration order; returns each handler's result. */
	async emit(event: string, payload: Record<string, unknown>, fake: FakeCtx): Promise<unknown[]> {
		const results: unknown[] = [];
		for (const handler of this.handlers.get(event) ?? []) {
			results.push(await handler({ type: event, ...payload }, fake.ctx));
		}
		return results;
	}

	/** First non-undefined handler result, which is how omp consumes single-extension results. */
	async emitOne<T>(event: string, payload: Record<string, unknown>, fake: FakeCtx): Promise<T | undefined> {
		return (await this.emit(event, payload, fake)).find(r => r !== undefined) as T | undefined;
	}

	async runCommand(name: string, args: string, fake: FakeCtx): Promise<void> {
		const command = this.commands.get(name);
		if (!command) throw new Error(`command ${name} not registered`);
		await command.handler(args, fake.ctx);
	}
}

/** Loads the extension into a fresh FakeHost (one host = one omp session). */
export async function loadExtension(options: KataExtensionOptions = {}): Promise<FakeHost> {
	const host = new FakeHost();
	await createKataExtension(options)(host.api);
	return host;
}

export const bashCall = (command: string) => ({ toolName: "bash", toolCallId: "t1", input: { command } });
export const bashResult = (command: string, isError = false) => ({
	toolName: "bash",
	toolCallId: "t1",
	input: { command },
	isError,
	content: [{ type: "text", text: "" }],
	details: undefined,
});
