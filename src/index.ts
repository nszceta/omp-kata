import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import { type Env, resolveSettings, type SettingsLoader } from "./config";
import { registerKataCommand } from "./commands";
import { KataRuntime, type RuntimeDeps } from "./session";
import { type ShimHost, sharedShimHost } from "./shim";
import { updateStatus } from "./status";
import { findWorkspaceRoot } from "./workspace";
import type { AgentIdentity } from "./identity";

export interface KataExtensionOptions {
	/** Environment consulted for OMP_KATA_*, KATA_TEAMMATE, KATA_INBOX_USER, KATA_REF. Defaults to process.env. */
	env?: Env;
	/** Plugin settings source. Defaults to omp's getPluginSettings. */
	loadSettings?: SettingsLoader;
	now?: () => number;
	hostPid?: number;
	/** Identity delivery host. Defaults to the process-wide shim host (mutates process.env.PATH). */
	shim?: ShimHost;
}

const MIN_IDLE_POLL_SECONDS = 5;

function agentOf(ctx: ExtensionContext): AgentIdentity {
	return ctx.agent ?? { kind: "main", id: "Main" };
}

/**
 * Builds the extension factory. omp runs the factory once per session (subagents included), so the
 * closure below is the per-session state; only caches that are safe to share (contract, actor)
 * live at module level.
 */
export function createKataExtension(options: KataExtensionOptions = {}): ExtensionFactory {
	const deps: RuntimeDeps = {
		env: options.env ?? process.env,
		loadSettings: options.loadSettings,
		now: options.now ?? Date.now,
		hostPid: options.hostPid ?? process.pid,
		shim: options.shim ?? sharedShimHost(),
	};

	return function ompKata(pi: ExtensionAPI): void {
		let current: { cwd: string; runtime: Promise<KataRuntime | undefined> } | undefined;
		let watcher: { ctx: ExtensionContext; timer: Timer } | undefined;

		const runtimeFor = (ctx: ExtensionContext): Promise<KataRuntime | undefined> => {
			if (!current || current.cwd !== ctx.cwd) {
				current = { cwd: ctx.cwd, runtime: KataRuntime.create(ctx.cwd, agentOf(ctx), deps) };
			}
			return current.runtime;
		};
		const resetRuntime = (ctx: ExtensionContext): Promise<KataRuntime | undefined> => {
			current = undefined;
			return runtimeFor(ctx);
		};
		const sessionId = (ctx: ExtensionContext): string => ctx.sessionManager.getSessionId();

		const refreshStatus = async (ctx: ExtensionContext, rt: KataRuntime | undefined): Promise<void> => {
			updateStatus(ctx, rt ? await rt.statusInfo() : undefined);
		};

		const stopWatcher = (): void => {
			if (!watcher) return;
			try {
				watcher.ctx.clearTimer(watcher.timer);
			} catch {
				// the old context may already be torn down
			}
			watcher = undefined;
		};

		const idleTick = async (ctx: ExtensionContext, rt: KataRuntime): Promise<void> => {
			if (!ctx.isIdle()) return;
			const outcome = await rt.inboxIdlePoll();
			if (!outcome) return;
			if (outcome.kind === "wake") {
				pi.sendMessage({ customType: "kata-inbox", content: outcome.payload, display: true }, { triggerTurn: true });
			} else {
				ctx.ui.notify(outcome.message, "info");
			}
			await refreshStatus(ctx, rt);
		};

		const startWatcher = (ctx: ExtensionContext, rt: KataRuntime): void => {
			stopWatcher();
			if (rt.agent.kind !== "main" || !rt.settings.inbox) return;
			const ms = Math.max(rt.settings.inboxPollSeconds, MIN_IDLE_POLL_SECONDS) * 1000;
			watcher = { ctx, timer: ctx.setInterval(() => idleTick(ctx, rt), ms) };
		};

		const beginSession = async (ctx: ExtensionContext, rt: KataRuntime | undefined): Promise<void> => {
			if (!rt) {
				updateStatus(ctx, undefined);
				return;
			}
			startWatcher(ctx, rt);
			void rt.syncIdentity(sessionId(ctx)).then(() => refreshStatus(ctx, rt));
			await rt.startEnvRef(sessionId(ctx));
			await refreshStatus(ctx, rt);
		};

		pi.on("session_start", async (_event, ctx) => {
			await beginSession(ctx, await resetRuntime(ctx));
		});

		pi.on("session_switch", async (_event, ctx) => {
			const previous = await current?.runtime;
			previous?.dropAllIdentities();
			previous?.attention.endAll();
			await beginSession(ctx, await resetRuntime(ctx));
		});

		pi.on("session_shutdown", async (_event, ctx) => {
			stopWatcher();
			const rt = await current?.runtime;
			rt?.dropAllIdentities();
			rt?.attention.endAll();
			updateStatus(ctx, undefined);
		});

		pi.on("before_agent_start", async (event, ctx) => {
			const rt = await runtimeFor(ctx);
			if (!rt) return undefined;
			const [contract, inbox] = await Promise.all([
				rt.contractPrompt(event.systemPrompt),
				rt.inboxForPrompt(),
				rt.syncIdentity(sessionId(ctx)),
			]).then(([c, i]) => [c, i] as const);
			if (contract.failure !== undefined && !rt.contractWarned) {
				rt.contractWarned = true;
				ctx.ui.notify(`kata contract unavailable: ${contract.failure}`, "warning");
			}
			await refreshStatus(ctx, rt);
			if (!contract.systemPrompt && inbox === undefined) return undefined;
			return {
				...(contract.systemPrompt ? { systemPrompt: contract.systemPrompt } : {}),
				...(inbox !== undefined ? { message: { customType: "kata-inbox", content: inbox, display: true } } : {}),
			};
		});

		// Identity reaches kata through the PATH shim, not through the command text. This only makes sure
		// the session's identity file exists before the first command runs (it can be missing when
		// `kata whoami` failed earlier or the session id changed). The ref guard then vets every call.
		pi.on("tool_call", async (event, ctx) => {
			const rt = await runtimeFor(ctx);
			if (!rt) return undefined;
			if (event.toolName === "bash") await rt.syncIdentity(sessionId(ctx));
			// Tool inputs are plain JSON objects; the guard reads only the fields it knows per tool.
			const reason = rt.guardToolCall(event.toolCallId, event.toolName, event.input as Record<string, unknown>, ctx.cwd);
			return reason === undefined ? undefined : { block: true, reason };
		});

		pi.on("tool_result", async (event, ctx) => {
			const rt = await runtimeFor(ctx);
			if (!rt) return undefined;
			if (event.toolName === "bash" && !event.isError) {
				const output = event.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
				rt.observeBashOutput(event.input.command, output);
				if (await rt.trackBash(event.input.command, sessionId(ctx))) await refreshStatus(ctx, rt);
			}
			const warning = rt.takeRefWarning(event.toolCallId);
			const inbox = await rt.inboxForToolResult();
			if (inbox !== undefined) await refreshStatus(ctx, rt);
			const context = [warning, inbox].filter((text): text is string => text !== undefined);
			return context.length === 0 ? undefined : { additionalContext: context.join("\n\n") };
		});

		registerKataCommand(
			pi,
			{
				runtime: runtimeFor,
				settings: ctx => resolveSettings(ctx.cwd, { env: deps.env, loader: deps.loadSettings }),
				workspaceRoot: findWorkspaceRoot,
			},
			() => {
				void current?.runtime.then(rt => rt?.forgetIdentity());
			},
		);
	};
}

export default createKataExtension();
