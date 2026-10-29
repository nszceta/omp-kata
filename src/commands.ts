import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { KataSettings } from "./config";
import { clearContractCache } from "./contract";
import { clearActorCache } from "./identity";
import { InboxTracker } from "./inbox";
import type { KataRuntime } from "./session";

export interface CommandHost {
	runtime(ctx: ExtensionCommandContext): Promise<KataRuntime | undefined>;
	settings(ctx: ExtensionCommandContext): Promise<KataSettings>;
	workspaceRoot(cwd: string): string | undefined;
}

export const USAGE = "usage: /kata [status | inbox | refresh]";

function describeContract(rt: KataRuntime): string {
	const result = rt.lastContract;
	if (!rt.settings.contract) return "disabled";
	if (!result) return "not fetched yet";
	return result.ok ? `${Buffer.byteLength(result.text)} bytes` : `unavailable (${result.reason})`;
}

export async function statusReport(host: CommandHost, ctx: ExtensionCommandContext): Promise<string> {
	const rt = await host.runtime(ctx);
	const settings = await host.settings(ctx);
	const lines: string[] = [];
	if (!rt) {
		lines.push(`kata: not a kata workspace (no .kata.toml at or above ${ctx.cwd})`);
	} else {
		const identity = await rt.identity();
		lines.push(`kata workspace: ${rt.root}`);
		lines.push(`actor: ${identity?.actor ?? "unknown (kata whoami failed)"}`);
		lines.push(`teammate: ${identity?.teammate || "(none)"}`);
		lines.push(`inbox user: ${identity?.inboxUser ?? "unknown"}`);
		await rt.reconcileTracked(true);
		lines.push(`tracked refs: ${rt.attention.refs().join(", ") || "(none)"}`);
		lines.push(`contract: ${describeContract(rt)}`);
		lines.push(`inbox: ${rt.inbox ? `${rt.inbox.count} request(s)` : "not checked yet"}`);
	}
	lines.push(`settings: ${JSON.stringify(settings)}`);
	return lines.join("\n");
}

export async function inboxReport(host: CommandHost, ctx: ExtensionCommandContext): Promise<string> {
	const rt = await host.runtime(ctx);
	if (!rt) return "kata: not a kata workspace";
	const identity = await rt.identity();
	if (!identity) return "kata: could not resolve the kata actor (kata whoami failed)";
	const tracker = rt.inbox ?? new InboxTracker(rt.cli, rt.root, identity.inboxUser, rt.settings.inboxPollSeconds);
	const text = await tracker.fetch();
	if (text === undefined) return `kata: could not read the inbox for ${identity.inboxUser}`;
	return text === "" ? "kata inbox empty" : text;
}

export function registerKataCommand(pi: ExtensionAPI, host: CommandHost, onRefresh: (ctx: ExtensionCommandContext) => void): void {
	pi.registerCommand("kata", {
		description: "kata integration: status | inbox | refresh",
		async handler(args, ctx) {
			const sub = args.trim().split(/\s+/)[0] ?? "";
			if (sub === "" || sub === "status") {
				ctx.ui.notify(await statusReport(host, ctx), "info");
			} else if (sub === "inbox") {
				ctx.ui.notify(await inboxReport(host, ctx), "info");
			} else if (sub === "refresh") {
				const root = host.workspaceRoot(ctx.cwd);
				clearContractCache(root);
				clearActorCache(root);
				onRefresh(ctx);
				ctx.ui.notify("kata: contract and identity caches cleared", "info");
			} else {
				ctx.ui.notify(USAGE, "warning");
			}
		},
	});
}
