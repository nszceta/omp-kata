/**
 * Cleanup for text from outside the plugin (kata output, issue fields, identities, contract text) before
 * it reaches the terminal or a prompt. ANSI/control sequences are removed here.
 *
 * Inbox text is framed and entity-escaped by `escapeInbox` in inbox.ts; this module only strips its
 * controls first, because escaping `&<>` does not remove terminal sequences. Text that goes inside the
 * plugin's own fences, and the markdown contract, is instead given a zero-width space in
 * `<kata_inbox>`/`<kata_contract>`: `&lt;` would be inserted literally into a prompt that is not rendered
 * as HTML, and the contract contains code and `<project>#<id>` refs.
 */

/** ANSI OSC (`ESC ] ... BEL` or `ESC ] ... ST`). */
const OSC = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
/** ANSI CSI (`ESC [ params intermediates final`). */
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
/** Any other two-character ESC sequence. */
const OTHER_ESC = /\x1b[@-_]/g;
/** C0/C1 controls except TAB, LF, CR (normalized to LF first). */
const CONTROL_MULTILINE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;
/** All C0/C1 controls, for single-line fields. */
const CONTROL_SINGLE = /[\x00-\x1f\x7f-\x9f]/g;

/** Removes ANSI escape sequences and control characters; preserves newlines/tabs only when `multiline`. */
export function stripControl(text: string, multiline = false): string {
	const plain = text
		.replace(/\r\n?/g, "\n")
		.replace(OSC, "")
		.replace(CSI, "")
		.replace(OTHER_ESC, "");
	return plain.replace(multiline ? CONTROL_MULTILINE : CONTROL_SINGLE, "");
}

/** Breaks the plugin's own fences with a ZWSP; for markdown and inline fields, not entity-escaped text. */
export function neutralizeTags(text: string): string {
	return text.replace(/<(\/?)(kata_(?:inbox|contract))/gi, "<\u200b$1$2");
}

/** Multi-line text inserted inside a plugin fence (the contract block): no controls, fence cannot be closed. */
export function sanitizeFenced(text: string): string {
	return neutralizeTags(stripControl(text, true));
}

/** Single-line field for terminal display or an unfenced prompt fragment: no controls, no newlines. */
export function sanitizeInline(text: string): string {
	return stripControl(text, false);
}

/** Single-line value inserted inside `<kata_contract>`/`<kata_inbox>`: also breaks our fence names. */
export function sanitizeInFence(text: string): string {
	return neutralizeTags(sanitizeInline(text));
}
