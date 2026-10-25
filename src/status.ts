import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export const STATUS_KEY = "kata";

export interface StatusInfo {
	inboxUser: string;
	tracked: readonly string[];
	inboxCount: number;
}

export function formatStatus(info: StatusInfo): string {
	let text = `kata ${info.inboxUser}`;
	if (info.tracked.length > 0) text += ` · ${info.tracked.join(",")}`;
	if (info.inboxCount > 0) text += ` · inbox ${info.inboxCount}`;
	return text;
}

/** Sets or clears (info undefined) the footer status; a no-op without a UI. */
export function updateStatus(ctx: Pick<ExtensionContext, "hasUI" | "ui">, info: StatusInfo | undefined): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, info ? formatStatus(info) : undefined);
}
