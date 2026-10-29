import { basename } from "node:path";
import { AttentionTracker } from "./attention";
import { type Env, type KataSettings, resolveSettings, type SettingsLoader } from "./config";
import { type ContractResult, getContract, ompAddendum, withContract } from "./contract";
import { type AgentIdentity, deriveIdentity, type Identity, lookupActor } from "./identity";
import { RefGuard, refFindingReason } from "./guard";
import { type IdleOutcome, InboxTracker } from "./inbox";
import { KataCli } from "./kata";
import type { ShimHost } from "./shim";
import type { StatusInfo } from "./status";
import { findWorkspaceRoot, readProjectName } from "./workspace";

export interface RuntimeDeps {
	env: Env;
	loadSettings?: SettingsLoader;
	now: () => number;
	hostPid: number;
	/** Delivers per-session identity to the PATH shim. */
	shim: ShimHost;
}

/** Retry cadence after `kata whoami` failed (daemon down, binary missing). */
const IDENTITY_RETRY_MS = 10_000;

/** Minimum spacing of unforced tracked-ref reconciliations (each runs one `kata status` per ref). */
const RECONCILE_INTERVAL_MS = 15_000;

/**
 * All kata behavior for one omp session inside one workspace. Handlers in index.ts only translate
 * omp events into calls on this class, which holds no omp types and is exercised directly in tests.
 */
export class KataRuntime {
	readonly cli: KataCli;
	readonly attention: AttentionTracker;
	inbox: InboxTracker | undefined;
	/** Result of the most recent contract fetch, for /kata status. */
	lastContract: ContractResult | undefined;
	contractWarned = false;
	private identityValue: Identity | undefined;
	private identityPending: Promise<Identity | undefined> | undefined;
	private identityRetryAt = 0;
	/** Session ids whose identity file is currently published. */
	private readonly published = new Set<string>();
	/** Absolute path of the real kata (never the shim). */
	readonly real: string;
	readonly refGuard: RefGuard;
	/** Ref-guard warnings (warn mode) waiting for their tool result, by tool call id. */
	private readonly refWarnings = new Map<string, string>();
	private reconcileAt = 0;
	private reconcilePending: Promise<boolean> | undefined;

	constructor(
		readonly root: string,
		readonly settings: KataSettings,
		readonly agent: AgentIdentity,
		private readonly deps: RuntimeDeps,
	) {
		this.real = deps.shim.resolveReal(settings.executable);
		this.cli = new KataCli(this.real, deps.env);
		this.attention = new AttentionTracker(this.cli, root, deps.hostPid);
		this.refGuard = new RefGuard(root, readProjectName(root), this.kataNames);
		if (deps.env.KATA_REF) this.refGuard.see(deps.env.KATA_REF);
	}

	/** Undefined when `cwd` is not inside a kata workspace: the whole plugin stays inert. */
	static async create(cwd: string, agent: AgentIdentity, deps: RuntimeDeps): Promise<KataRuntime | undefined> {
		const root = findWorkspaceRoot(cwd);
		if (root === undefined) return undefined;
		const settings = await resolveSettings(cwd, { env: deps.env, loader: deps.loadSettings });
		return new KataRuntime(root, settings, agent, deps);
	}

	/** Executable basenames recognised when scanning bash commands for claim/close. */
	get kataNames(): string[] {
		return [...new Set(["kata", basename(this.settings.executable)])];
	}

	identity(): Promise<Identity | undefined> {
		if (this.identityValue) return Promise.resolve(this.identityValue);
		if (this.deps.now() < this.identityRetryAt) return Promise.resolve(undefined);
		this.identityPending ??= this.resolveIdentity().finally(() => {
			this.identityPending = undefined;
		});
		return this.identityPending;
	}

	private async resolveIdentity(): Promise<Identity | undefined> {
		const actor = await lookupActor(this.cli, this.root, this.deps.env);
		if (actor === undefined) {
			this.identityRetryAt = this.deps.now() + IDENTITY_RETRY_MS;
			return undefined;
		}
		this.identityValue = deriveIdentity(this.agent, actor, this.deps.env);
		return this.identityValue;
	}

	forgetIdentity(): void {
		this.identityValue = undefined;
		this.identityRetryAt = 0;
		// Published files carry the old identity; the next sync rewrites them.
		this.published.clear();
	}

	/**
	 * Publishes this session's identity for the PATH shim (idempotent, a no-op until kata answered
	 * `whoami`). Must complete before the agent's first bash command; callers await it at prompt time
	 * and before every bash tool call.
	 */
	async syncIdentity(sessionId: string): Promise<void> {
		if (!this.settings.identity || this.published.has(sessionId)) return;
		if (sessionId === "" || /[\/\0]/.test(sessionId)) return;
		const identity = await this.identity();
		if (!identity || this.published.has(sessionId)) return;
		try {
			this.deps.shim.install(this.real);
			this.deps.shim.writeIdentity(sessionId, identity, this.real);
			this.published.add(sessionId);
		} catch {
			// no writable temp dir: identity stays unmanaged and kata falls back to its own defaults
		}
	}

	dropIdentity(sessionId: string): void {
		this.deps.shim.removeIdentity(sessionId);
		this.published.delete(sessionId);
	}

	dropAllIdentities(): void {
		for (const sessionId of [...this.published]) this.dropIdentity(sessionId);
	}

	/** New system prompt blocks carrying the contract, if any change is needed. */
	async contractPrompt(systemPrompt: unknown): Promise<{ systemPrompt?: string[]; failure?: string }> {
		if (!this.settings.contract) return {};
		// Identity first: the addendum states this agent's identity, and the block must be stable across prompts.
		const [result, identity] = await Promise.all([getContract(this.cli, this.settings, this.root), this.identity()]);
		this.lastContract = result;
		const next = withContract(systemPrompt, result, ompAddendum(identity, this.agent.kind === "main"));
		return { systemPrompt: next, failure: result.ok ? undefined : result.reason };
	}

	private async inboxTracker(): Promise<InboxTracker | undefined> {
		if (!this.settings.inbox) return undefined;
		const identity = await this.identity();
		if (!identity) return undefined;
		if (this.inbox?.user !== identity.inboxUser) {
			this.inbox = new InboxTracker(this.cli, this.root, identity.inboxUser, this.settings.inboxPollSeconds);
		}
		return this.inbox;
	}

	/** Payload to attach to a new prompt (always checks). */
	async inboxForPrompt(): Promise<string | undefined> {
		return (await this.inboxTracker())?.check(this.deps.now());
	}

	/** Payload to attach to a tool result, throttled by inboxPollSeconds. */
	async inboxForToolResult(): Promise<string | undefined> {
		const tracker = await this.inboxTracker();
		const now = this.deps.now();
		return tracker?.due(now) ? tracker.check(now) : undefined;
	}

	/** Idle-session poll: a wake payload or a notification, per wakeOnInbox. */
	async inboxIdlePoll(): Promise<IdleOutcome | undefined> {
		return (await this.inboxTracker())?.idlePoll(this.settings.wakeOnInbox);
	}

	async statusInfo(): Promise<StatusInfo | undefined> {
		const identity = await this.identity();
		if (!identity) return undefined;
		return { inboxUser: identity.inboxUser, tracked: this.attention.refs(), inboxCount: this.inbox?.count ?? 0 };
	}

	/** Main sessions launched with KATA_REF track that issue from the start (never closed ones). */
	async startEnvRef(sessionId: string): Promise<void> {
		if (!this.settings.attention || this.agent.kind !== "main") return;
		const ref = this.deps.env.KATA_REF;
		if (!ref || ref.startsWith("-")) return;
		if (await this.attention.isClosed(ref)) return;
		await this.attention.start(ref, sessionId);
	}

	async trackBash(command: unknown, sessionId: string): Promise<boolean> {
		if (!this.settings.attention || typeof command !== "string") return false;
		return this.attention.applyCommand(command, sessionId, this.kataNames);
	}

	/**
	 * Drops tracked refs that are no longer worked on (see AttentionTracker.reconcile). Unforced calls
	 * run at most every RECONCILE_INTERVAL_MS; concurrent calls share one run. Returns whether tracking changed.
	 */
	reconcileTracked(force = false): Promise<boolean> {
		if (this.reconcilePending) return this.reconcilePending;
		const now = this.deps.now();
		if (this.attention.refs().length === 0 || (!force && now < this.reconcileAt)) return Promise.resolve(false);
		this.reconcileAt = now + RECONCILE_INTERVAL_MS;
		this.reconcilePending = this.attention
			.reconcile()
			.then(evicted => evicted.length > 0)
			.finally(() => {
				this.reconcilePending = undefined;
			});
		return this.reconcilePending;
	}

	/**
	 * Block reason when the tool call would write a kata ref into repository content. In warn mode the
	 * call runs and the same text waits for its tool result (see takeRefWarning).
	 */
	guardToolCall(toolCallId: string, toolName: string, input: Record<string, unknown>, cwd: string): string | undefined {
		if (this.settings.refGuard === "off") return undefined;
		const finding = this.refGuard.check(toolName, input, cwd);
		if (!finding) return undefined;
		const reason = refFindingReason(finding);
		if (this.settings.refGuard === "block") return reason;
		this.refWarnings.set(toolCallId, reason);
		return undefined;
	}

	takeRefWarning(toolCallId: string): string | undefined {
		const warning = this.refWarnings.get(toolCallId);
		this.refWarnings.delete(toolCallId);
		return warning;
	}

	/** Learns the issue ids a successful kata listing command printed. */
	observeBashOutput(command: unknown, output: string): void {
		if (this.settings.refGuard === "off" || typeof command !== "string") return;
		this.refGuard.observeOutput(command, output);
	}
}
