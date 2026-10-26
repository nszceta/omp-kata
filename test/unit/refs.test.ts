import { describe, expect, test } from "bun:test";
import {
	gitCommitMessages,
	isIssueRef,
	kataMentions,
	parseClaimRefs,
	parseCloseRefs,
	parseRefEvents,
	projectRefsIn,
	tokenizeCommand,
} from "../../src/refs";

const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

describe("tokenizeCommand", () => {
	test("splits on && || ; | and newline into simple-command segments", () => {
		expect(tokenizeCommand("echo a && echo b; echo c | cat\necho d || echo e")).toEqual([
			["echo", "a"],
			["echo", "b"],
			["echo", "c"],
			["cat"],
			["echo", "d"],
			["echo", "e"],
		]);
	});

	test("quotes group words and are stripped; empty quotes yield an empty word", () => {
		expect(tokenizeCommand(`kata claim "ab cd" 'x y' ''`)).toEqual([["kata", "claim", "ab cd", "x y", ""]]);
	});

	test("backslash escapes join words and line continuations vanish", () => {
		expect(tokenizeCommand("echo a\\ b")).toEqual([["echo", "a b"]]);
		expect(tokenizeCommand("kata claim \\\nabcd")).toEqual([["kata", "claim", "abcd"]]);
	});

	test("a # starting a word comments out the rest of the line only", () => {
		expect(tokenizeCommand("kata claim abcd # note\nkata close abcd")).toEqual([
			["kata", "claim", "abcd"],
			["kata", "close", "abcd"],
		]);
		expect(tokenizeCommand("kata claim proj#abcd")).toEqual([["kata", "claim", "proj#abcd"]]);
	});

	test("unterminated quotes and trailing backslash do not throw and keep the text", () => {
		expect(tokenizeCommand("kata claim 'abcd")).toEqual([["kata", "claim", "abcd"]]);
		expect(tokenizeCommand('kata claim "abcd')).toEqual([["kata", "claim", "abcd"]]);
		expect(tokenizeCommand("kata claim abcd\\")).toEqual([["kata", "claim", "abcd"]]);
		expect(tokenizeCommand('kata claim "abcd\\')).toEqual([["kata", "claim", "abcd\\"]]);
	});

	test("empty and operator-only input yields no segments", () => {
		expect(tokenizeCommand("")).toEqual([]);
		expect(tokenizeCommand(" ; && | \n")).toEqual([]);
	});
});

describe("isIssueRef", () => {
	test("accepts short id, project#id and 26-char ULID", () => {
		expect(isIssueRef("abcd")).toBe(true);
		expect(isIssueRef("4nmg")).toBe(true);
		expect(isIssueRef("my-proj.x#abcd")).toBe(true);
		expect(isIssueRef(ULID)).toBe(true);
	});

	test("rejects too short, too long, uppercase short ids and shell expansions", () => {
		for (const token of ["abc", "ab", "", "abcdefghijklm", "ABCD", "$ID", "$(x)", "`x`", "a_b_c", "--", "proj#ab", "#abcd", ULID.slice(1)]) {
			expect(isIssueRef(token)).toBe(false);
		}
	});
});

describe("claim parsing", () => {
	test("short ref, project#ref and ULID are all accepted", () => {
		expect(parseClaimRefs("kata claim abcd")).toEqual(["abcd"]);
		expect(parseClaimRefs("kata claim proj#abcd")).toEqual(["proj#abcd"]);
		expect(parseClaimRefs(`kata claim ${ULID}`)).toEqual([ULID]);
	});

	test("claim takes several refs in order", () => {
		expect(parseClaimRefs(`kata claim abcd proj#efgh ${ULID}`)).toEqual(["abcd", "proj#efgh", ULID]);
	});

	test("$VAR, quoted expansions and too-short tokens are ignored while real refs survive", () => {
		expect(parseClaimRefs("kata claim $ID")).toEqual([]);
		expect(parseClaimRefs('kata claim "$(kata create x)"')).toEqual([]);
		expect(parseClaimRefs("kata claim 12 ab")).toEqual([]);
		expect(parseClaimRefs("kata claim $ID abcd")).toEqual(["abcd"]);
		expect(parseClaimRefs("kata claim")).toEqual([]);
	});

	test("quoted refs are unquoted", () => {
		expect(parseClaimRefs(`kata claim "abcd" 'efgh'`)).toEqual(["abcd", "efgh"]);
	});

	test("chained commands: &&, ;, |, newline, ||, background &", () => {
		expect(parseClaimRefs("cd x && kata claim abcd")).toEqual(["abcd"]);
		expect(parseClaimRefs("make; kata claim abcd")).toEqual(["abcd"]);
		expect(parseClaimRefs("echo x | kata claim abcd")).toEqual(["abcd"]);
		expect(parseClaimRefs("kata claim abcd | tee out")).toEqual(["abcd"]);
		expect(parseClaimRefs("true\nkata claim abcd\nfalse")).toEqual(["abcd"]);
		expect(parseClaimRefs("false || kata claim abcd")).toEqual(["abcd"]);
		expect(parseClaimRefs("kata claim abcd &")).toEqual(["abcd"]);
	});

	test("global flags before the subcommand are skipped, including value flags", () => {
		expect(parseClaimRefs("kata --agent claim abcd")).toEqual(["abcd"]);
		expect(parseClaimRefs("kata --json claim abcd")).toEqual(["abcd"]);
		expect(parseClaimRefs("kata --as bob --project p claim abcd")).toEqual(["abcd"]);
		expect(parseClaimRefs("kata --as=bob claim abcd")).toEqual(["abcd"]);
		// the value of --as must not be mistaken for the subcommand
		expect(parseClaimRefs("kata --as claim claim abcd")).toEqual(["abcd"]);
	});

	test("the first flag after a ref terminates the ref list", () => {
		expect(parseClaimRefs("kata claim abcd --comment 'x y'")).toEqual(["abcd"]);
		expect(parseClaimRefs("kata claim abcd efgh --ttl 30m ijkl")).toEqual(["abcd", "efgh"]);
		expect(parseClaimRefs("kata claim abcd --agent efgh")).toEqual(["abcd"]);
	});

	test("flags before the first ref are skipped together with their values", () => {
		expect(parseClaimRefs("kata claim --comment 'working on it' abcd")).toEqual(["abcd"]);
		expect(parseClaimRefs("kata claim --ttl 30m abcd")).toEqual(["abcd"]);
		expect(parseClaimRefs("kata claim --comment=wip abcd")).toEqual(["abcd"]);
	});

	test("path-qualified executable", () => {
		expect(parseClaimRefs("/usr/bin/kata claim abcd")).toEqual(["abcd"]);
		expect(parseClaimRefs("~/.local/bin/kata claim abcd")).toEqual(["abcd"]);
	});

	test("VAR=x, env, command and similar prefixes are skipped", () => {
		expect(parseClaimRefs("FOO=bar kata claim abcd")).toEqual(["abcd"]);
		expect(parseClaimRefs("A=1 B='x y' kata claim abcd")).toEqual(["abcd"]);
		expect(parseClaimRefs("env FOO=bar kata claim abcd")).toEqual(["abcd"]);
		expect(parseClaimRefs("command kata claim abcd")).toEqual(["abcd"]);
		expect(parseClaimRefs("time nohup kata claim abcd")).toEqual(["abcd"]);
	});

	test("`export A=b; kata claim abcd` parses", () => {
		expect(parseClaimRefs("export A=b; kata claim abcd")).toEqual(["abcd"]);
	});

	test("subshell and brace group openers are skipped", () => {
		expect(parseClaimRefs("(kata claim abcd ; true")).toEqual(["abcd"]);
		expect(parseClaimRefs("{ kata claim abcd; }")).toEqual(["abcd"]);
	});

	test("commands that merely mention kata yield nothing", () => {
		expect(parseRefEvents("echo kata claim abcd")).toEqual([]);
		expect(parseRefEvents("kata-foo claim abcd")).toEqual([]);
		expect(parseRefEvents("omp-kata claim abcd")).toEqual([]);
		expect(parseRefEvents("xkata claim abcd")).toEqual([]);
		expect(parseRefEvents("git claim abcd")).toEqual([]);
		expect(parseRefEvents("cat .kata.toml claim abcd")).toEqual([]);
	});

	test("other kata subcommands do not claim", () => {
		expect(parseRefEvents("kata show abcd")).toEqual([]);
		expect(parseRefEvents("kata list claim abcd")).toEqual([]);
		expect(parseRefEvents("kata reopen abcd")).toEqual([]);
	});

	test("text after # is a comment", () => {
		expect(parseClaimRefs("kata claim abcd # kata claim efgh")).toEqual(["abcd"]);
		expect(parseClaimRefs("# kata claim abcd")).toEqual([]);
	});

	test("duplicates are removed, first-seen order kept", () => {
		expect(parseClaimRefs("kata claim abcd abcd; kata claim efgh abcd")).toEqual(["abcd", "efgh"]);
	});

	test("escapes and unterminated quotes never throw", () => {
		expect(parseClaimRefs("kata claim ab\\cd")).toEqual(["abcd"]);
		expect(parseClaimRefs("kata claim 'abcd")).toEqual(["abcd"]);
		expect(parseClaimRefs('kata claim "abcd')).toEqual(["abcd"]);
		expect(parseClaimRefs("kata claim abcd\\")).toEqual(["abcd"]);
	});

	test("custom executable names via `names`", () => {
		expect(parseRefEvents("mykata claim abcd", ["mykata"])).toEqual([{ action: "claim", ref: "abcd" }]);
		expect(parseRefEvents("/opt/bin/mykata close abcd", ["mykata"])).toEqual([{ action: "close", ref: "abcd" }]);
		// the default name is no longer recognised once names is overridden
		expect(parseRefEvents("kata claim abcd", ["mykata"])).toEqual([]);
		expect(parseRefEvents("mykata claim abcd")).toEqual([]);
		expect(parseClaimRefs("kata claim abcd; mykata claim efgh", ["kata", "mykata"])).toEqual(["abcd", "efgh"]);
	});
});

describe("close parsing", () => {
	test("takes exactly one ref", () => {
		expect(parseCloseRefs("kata close abcd")).toEqual(["abcd"]);
		expect(parseCloseRefs("kata close abcd efgh")).toEqual(["abcd"]);
		expect(parseCloseRefs("kata close proj#abcd --done")).toEqual(["proj#abcd"]);
		expect(parseCloseRefs(`kata close ${ULID}`)).toEqual([ULID]);
	});

	test("value flags before the ref do not leak their values as refs", () => {
		expect(parseCloseRefs("kata close -m 'msg here' --done abcd")).toEqual(["abcd"]);
		expect(parseCloseRefs("kata close --commit abc1234 --done abcd")).toEqual(["abcd"]);
		expect(parseCloseRefs("kata close --done --message 'long enough message text' abcd")).toEqual(["abcd"]);
	});

	test("value flags after the ref are consumed", () => {
		expect(parseCloseRefs("kata close abcd --done -m 'a b c' --commit abc1234")).toEqual(["abcd"]);
		// `--dry` as the value of -m is text, not the flag
		expect(parseCloseRefs("kata close abcd -m --dry")).toEqual(["abcd"]);
	});

	test("--dry is ignored wherever it appears", () => {
		expect(parseCloseRefs("kata close abcd --dry")).toEqual([]);
		expect(parseCloseRefs("kata close --dry abcd")).toEqual([]);
		expect(parseCloseRefs("kata close abcd --done --dry -m 'x'")).toEqual([]);
	});

	test("claim refs and close refs are separated", () => {
		expect(parseClaimRefs("kata close abcd")).toEqual([]);
		expect(parseCloseRefs("kata claim abcd")).toEqual([]);
	});
});

describe("event order", () => {
	test("kata claim a1b2 && kata close a1b2 keeps command order", () => {
		expect(parseRefEvents("kata claim a1b2 && kata close a1b2")).toEqual([
			{ action: "claim", ref: "a1b2" },
			{ action: "close", ref: "a1b2" },
		]);
	});

	test("reversed commands give reversed events", () => {
		expect(parseRefEvents("kata close a1b2 --done; kata claim a1b2")).toEqual([
			{ action: "close", ref: "a1b2" },
			{ action: "claim", ref: "a1b2" },
		]);
	});

	test("parseRefEvents does not dedupe", () => {
		expect(parseRefEvents("kata claim abcd; kata claim abcd")).toHaveLength(2);
	});
});

describe("shell constructs that must not leak words into the outer command", () => {
	test("words inside an unquoted $(...) are not claimed", () => {
		expect(parseClaimRefs("kata claim $(kata create thing)")).toEqual([]);
	});

	test("a closing paren of a subshell does not hide the last ref", () => {
		expect(parseClaimRefs("(cd x && kata claim abcd)")).toEqual(["abcd"]);
	});
});

describe("kataMentions", () => {
	test("ref positionals per subcommand; subcommand and action words are never refs", () => {
		expect(kataMentions("kata show q7x2 --json && kata claim a1b2 c3d4 --agent && kata label add e5f6 needs-review")).toEqual({
			subcommands: ["show", "claim", "label"],
			refs: ["q7x2", "a1b2", "c3d4", "e5f6"],
			projects: [],
		});
	});

	test("meta values, search queries and create titles are not refs", () => {
		expect(kataMentions('kata meta set q7x2 someday true && kata search "auth" && kata create "fix" --body "text"').refs).toEqual(["q7x2"]);
	});

	test("ref-valued flags, --project names and <project>#<id> anywhere in kata args", () => {
		expect(
			kataMentions('kata --project other create "x" --parent a1b2 --blocked-by=c3d4,e5f6 && kata comment g7h8 -m "dup of ws#j9k1"'),
		).toEqual({
			subcommands: ["create", "comment"],
			refs: ["a1b2", "c3d4", "e5f6", "g7h8", "ws#j9k1"],
			projects: ["other"],
		});
	});

	test("non-kata commands contribute nothing", () => {
		expect(kataMentions("git show q7x2 && echo ws#j9k1")).toEqual({ subcommands: [], refs: [], projects: [] });
	});
});

describe("projectRefsIn", () => {
	test("finds <project>#<id> in text but not URL fragments or key=a#b values", () => {
		expect(projectRefsIn("see ws#q7x2, other.proj#a1b2; http://h/kata?issue=01AB#direct=1 x=y#abcd1")).toEqual([
			{ project: "ws", id: "q7x2" },
			{ project: "other.proj", id: "a1b2" },
		]);
	});
});

describe("gitCommitMessages", () => {
	test("-m, --message, attached and clustered forms, --trailer", () => {
		expect(gitCommitMessages('git commit -m "one" --message=two -mthree -am four --trailer "Refs: five" --author "A <a@b>"')).toEqual([
			"one",
			"two",
			"three",
			"four",
			"Refs: five",
		]);
	});

	test("git global options before commit; other subcommands are ignored", () => {
		expect(gitCommitMessages('git -C repo -c a=b commit -m msg && git tag -m nope v1 && git log -m')).toEqual(["msg"]);
	});

	test("heredoc bodies count only when the message comes from stdin", () => {
		const stdin = "git commit -F- <<'EOF'\nsubject\n\nbody line\nEOF\necho done";
		expect(gitCommitMessages(stdin)).toEqual(["subject\n\nbody line"]);
		expect(gitCommitMessages("git commit --file=- <<-EOF\n\tsubject\n\tEOF")).toEqual(["\tsubject"]);
		expect(gitCommitMessages("cat <<'EOF' > f\nsubject\nEOF\ngit commit -m x")).toEqual(["x"]);
	});

	test("a $(cat <<EOF ...) message keeps its body in the -m value", () => {
		const [message] = gitCommitMessages(`git commit -m "$(cat <<'EOF'\nsubject q7x2\nEOF\n)"`);
		expect(message).toContain("subject q7x2");
	});
});
