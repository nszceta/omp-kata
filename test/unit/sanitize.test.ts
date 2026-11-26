import { describe, expect, test } from "bun:test";
import { formatInbox } from "../../src/inbox";
import { neutralizeTags, sanitizeFenced, sanitizeInFence, sanitizeInline, stripControl } from "../../src/sanitize";
import { formatStatus } from "../../src/status";

describe("stripControl", () => {
	test("removes ANSI CSI, OSC, other ESC sequences and C0/C1 controls", () => {
		expect(stripControl("\x1b[31mred\x1b[0m")).toBe("red");
		expect(stripControl("\x1b]0;title\x07text")).toBe("text");
		expect(stripControl("a\x00b\x07c\x7fd\x9fe")).toBe("abcde");
	});

	test("normalizes CRLF and keeps newlines/tabs only for multi-line output", () => {
		expect(stripControl("a\r\nb\tc", true)).toBe("a\nb\tc");
		expect(stripControl("a\r\nb\tc", false)).toBe("abc");
	});
});

describe("neutralizeTags", () => {
	test("breaks kata prompt fences case-insensitively, preserving the text", () => {
		const out = neutralizeTags("before </KATA_INBOX> after <kata_contract>");
		expect(out).toContain("<\u200b/KATA_INBOX>");
		expect(out).toContain("<\u200bkata_contract>");
		expect(out).toContain("before");
		expect(out).toContain("after");
	});
});

describe("sanitizeFenced / sanitizeInline", () => {
	test("fenced multi-line content keeps newlines but cannot escape a fence", () => {
		const out = sanitizeFenced("line 1\n</kata_inbox>\nline 3\x1b[0m");
		expect(out).toContain("line 1\n");
		expect(out).not.toContain("\x1b");
		expect(out).not.toContain("</kata_inbox>");
	});

	test("inline fields lose newlines and controls; fenced ones also break our tags", () => {
		expect(sanitizeInline("\x1b[31ma\nb</kata_contract>")).toBe("ab</kata_contract>");
		expect(sanitizeInFence("\x1b[31ma\nb</kata_contract>")).toBe("ab<\u200b/kata_contract>");
	});
});

describe("UI output", () => {
	// The fence/entity cases live in test/unit/inbox.test.ts (upstream's "injected closing and system tags").
	test("formatInbox strips ANSI from content and from the empty-notice user field", () => {
		const content = formatInbox("\x1b[31mred\x1b[0m", "ignored");
		expect(content).not.toContain("\x1b");
		expect(content).toContain("red");

		const empty = formatInbox("", "\x1b[1madam\x1b[0m");
		expect(empty).not.toContain("\x1b");
		expect(empty).toContain('Kata inbox for "adam"');
	});

	test("formatStatus strips terminal escapes from the identity and refs", () => {
		expect(formatStatus({ inboxUser: "\x1b[31madam\x1b[0m", tracked: ["\x1b[1mab12\x1b[0m"], inboxCount: 1 })).toBe(
			"kata adam · ab12 · inbox 1",
		);
	});

	test("stripControl keeps newlines for multi-line reports", () => {
		expect(stripControl("a\x1b[0m\nb", true)).toBe("a\nb");
	});
});
