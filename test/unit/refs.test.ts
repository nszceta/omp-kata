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
	test("follows ANSI-C, locale and double-quote backslash rules", () => {
		expect(tokenizeCommand("echo $'ab\\'cd'")).toEqual([["echo", "ab'cd"]]);
		expect(tokenizeCommand("echo $'a\\\\b\\tc'")).toEqual([["echo", "a\\b\tc"]]);
		expect(tokenizeCommand('echo $"x"')).toEqual([["echo", "x"]]);
		expect(tokenizeCommand('echo "a\\b"')).toEqual([["echo", "a\\b"]]);
		expect(tokenizeCommand('echo "a\\"b"')).toEqual([["echo", 'a"b']]);
		expect(tokenizeCommand("echo $$'\\' && kata claim abcd")).toEqual([["echo", "$$\\"], ["kata", "claim", "abcd"]]);
		expect(tokenizeCommand('echo $$"x"')).toEqual([["echo", "$$x"]]);
		expect(tokenizeCommand("echo $$'\\n'")).toEqual([["echo", "$$\\n"]]);
		expect(tokenizeCommand("echo $$$'x'")).toEqual([["echo", "$$x"]]);
		expect(tokenizeCommand("kata claim $'ab\\'cd' efgh")).toEqual([["kata", "claim", "ab'cd", "efgh"]]);
	});

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

	test("here-document bodies are opaque and not segments; following commands still tokenize", () => {
		expect(tokenizeCommand("cat > x.sh <<EOF\nkata claim wxyz\nEOF\nkata close abcd")).toEqual([
			["cat", ">", "x.sh"],
			["kata", "close", "abcd"],
		]);
		expect(tokenizeCommand("cat<<EOF;echo a\nbody; echo b\nEOF")).toEqual([["cat"], ["echo", "a"]]);
	});

	test("<<- strips leading tabs of the delimiter line only; plain << does not", () => {
		expect(tokenizeCommand("cat <<-EOF\n\tbody\n\t\tEOF\necho after")).toEqual([["cat"], ["echo", "after"]]);
		expect(tokenizeCommand("cat <<EOF\n\tEOF\nkata claim abcd\nEOF\necho after")).toEqual([["cat"], ["echo", "after"]]);
	});

	test("quoted delimiters, several heredocs on one line, and unterminated bodies", () => {
		expect(tokenizeCommand("cat <<'A' <<\"B\"\nx\nA\ny\nB\necho z")).toEqual([["cat"], ["echo", "z"]]);
		expect(tokenizeCommand("cat <<EOF\nkata claim abcd")).toEqual([["cat"]]);
	});

	test("here-strings and quoted << are not here-documents", () => {
		expect(tokenizeCommand("cat <<< word\necho a")).toEqual([["cat", "<<<", "word"], ["echo", "a"]]);
		expect(tokenizeCommand("echo 'x <<EOF'\nkata claim abcd\nEOF")).toEqual([
			["echo", "x <<EOF"],
			["kata", "claim", "abcd"],
			["EOF"],
		]);
	});

	test("CRLF line endings still end the here-document", () => {
		expect(tokenizeCommand("cat <<EOF > f\r\nx\r\nEOF\r\nkata claim abcd")).toEqual([["cat", ">", "f"], ["kata", "claim", "abcd"]]);
	});

	test("<< inside bare arithmetic is a shift, not a here-document", () => {
		expect(tokenizeCommand("(( x << 1 ))\nkata claim abcd")).toEqual([["kata", "claim", "abcd"]]);
		expect(tokenizeCommand("(( x <<= 1 ))\nkata claim abcd")).toEqual([["kata", "claim", "abcd"]]);
		expect(tokenizeCommand("for (( i = 1; i < 9; i <<= 1 )); do echo $i; done\nkata claim abcd")).toEqual([
			["for"],
			["do", "echo", "$i"],
			["done"],
			["kata", "claim", "abcd"],
		]);
		expect(tokenizeCommand("echo $((1<<2))\nkata claim abcd")).toEqual([["echo", "$((1<<2))"], ["kata", "claim", "abcd"]]);
	});

	test("nested subshells written with a space are still commands", () => {
		expect(tokenizeCommand("( (kata claim abcd) )")).toEqual([["kata", "claim", "abcd"]]);
		expect(tokenizeCommand("((kata claim abcd); true)")).toEqual([["kata", "claim", "abcd"], ["true"]]);
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

	test("kata commands written inside a here-document body are not claims", () => {
		expect(parseRefEvents("cat > x.sh <<EOF\nkata claim wxyz\nEOF")).toEqual([]);
		expect(parseRefEvents("cat <<'EOF' > x.sh\nkata close wxyz\nEOF\nkata claim abcd")).toEqual([{ action: "claim", ref: "abcd" }]);
	});

	test("CRLF input and arithmetic shifts do not hide later claims", () => {
		expect(parseRefEvents("cat <<EOF > notes.txt\r\nhello\r\nEOF\r\nkata claim abcd")).toEqual([{ action: "claim", ref: "abcd" }]);
		expect(parseRefEvents("(( x << 1 ))\nkata claim abcd")).toEqual([{ action: "claim", ref: "abcd" }]);
		expect(parseRefEvents("for (( i = 1; i < 9; i <<= 1 )); do echo $i; done\nkata claim abcd")).toEqual([{ action: "claim", ref: "abcd" }]);
		expect(parseRefEvents("( (kata claim abcd) )")).toEqual([{ action: "claim", ref: "abcd" }]);
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
		expect(parseCloseRefs("kata close --docbank abcd1234 --done abcd")).toEqual(["abcd"]);
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
	test("here-document bodies mention nothing", () => {
		expect(kataMentions("cat > x.sh <<EOF\nkata show build\nEOF")).toEqual({ refs: [], projects: [], subcommands: [] });
	});

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

	test("a quoted << is not a here-document, and non-stdin heredocs are ignored", () => {
		expect(gitCommitMessages("echo 'x <<EOF'\ngit commit -F -\nfoo\nEOF")).toEqual([]);
		expect(gitCommitMessages("git commit -F - <<< msg")).toEqual([]);
	});

	test("every here-document body counts when the message comes from stdin", () => {
		expect(gitCommitMessages("git commit -F - <<A <<B\none\nA\ntwo\nB")).toEqual(["one", "two"]);
	});

	test("CRLF input: the here-document ends at its delimiter line", () => {
		expect(gitCommitMessages('cat <<EOF > f\r\nx\r\nEOF\r\ngit commit -m "fix kata#abcd"')).toEqual(["fix kata#abcd"]);
		expect(gitCommitMessages("git commit -F - <<EOF\r\nsubject\r\nEOF\r\necho done")).toEqual(["subject\r"]);
	});

	test("arithmetic shifts do not swallow the following commit", () => {
		expect(gitCommitMessages('(( x << 1 ))\ngit commit -m "fix kata#abcd"')).toEqual(["fix kata#abcd"]);
	});

	test("here-documents inside command substitutions count for stdin messages", () => {
		expect(gitCommitMessages(`echo "$(cat <<'EOF'\nmsg kata#abcd\nEOF\n)" | git commit -F -`)).toEqual(["msg kata#abcd"]);
		expect(gitCommitMessages(`git commit -F - <<< "$(cat <<'EOF'\nmsg kata#abcd\nEOF\n)"`)).toEqual(["msg kata#abcd"]);
		expect(gitCommitMessages("echo `cat <<EOF\nmsg kata#abcd\nEOF\n` | git commit -F -")).toEqual(["msg kata#abcd"]);
		expect(gitCommitMessages("echo $(echo $(cat <<EOF\ndeep\nEOF\n)) | git commit -F -")).toEqual(["deep"]);
		expect(gitCommitMessages("echo $(cat <<EOF\nmsg\nEOF\n) | git commit -m x")).toEqual(["x"]);
	});

	test("a $(cat <<EOF ...) message keeps its body in the -m value", () => {
		const [message] = gitCommitMessages(`git commit -m "$(cat <<'EOF'\nsubject q7x2\nEOF\n)"`);
		expect(message).toContain("subject q7x2");
	});
});

describe("shell keywords and prefix options before kata", () => {
	const claims = [
		"if kata claim abcd; then echo ok; fi",
		"while true; do kata claim abcd; done",
		"if x; then :; else kata claim abcd; fi",
		"! kata claim abcd",
		"time -p kata claim abcd",
		"env -u FOO kata claim abcd",
		"env -i PATH=/usr/bin kata claim abcd",
		"env --unset=FOO -C /tmp -- kata claim abcd",
		"exec -a name kata claim abcd",
		"command -p kata claim abcd",
	];
	for (const c of claims) {
		test(c, () => {
			expect(parseRefEvents(c)).toEqual([{ action: "claim", ref: "abcd" }]);
			expect(kataMentions(c).refs).toEqual(["abcd"]);
		});
	}
	for (const c of ["while true; do kata close abcd --done; done", "! kata close abcd --done"]) {
		test(c, () => {
			expect(parseRefEvents(c)).toEqual([{ action: "close", ref: "abcd" }]);
			expect(kataMentions(c).refs).toEqual(["abcd"]);
		});
	}
	test("command -v/-V/-pv/-pV are lookups", () => {
		for (const c of ["command -v kata", "command -V kata claim abcd", "command -pv kata claim abcd", "command -pV kata claim abcd"]) {
			expect(parseRefEvents(c)).toEqual([]);
			expect(kataMentions(c).refs).toEqual([]);
		}
	});
	test("env split-string runs another command", () => {
		for (const c of [
			"env -S echo kata claim abcd",
			"env -Secho kata claim abcd",
			"env --split-string=echo kata claim abcd",
			"env --split-string echo kata claim abcd",
			"env -S python3 kata claim abcd",
		]) {
			expect(parseRefEvents(c)).toEqual([]);
		}
		expect(gitCommitMessages("env -S echo git commit -m bogus")).toEqual([]);
	});
	test("git commit after if", () => {
		expect(gitCommitMessages('if git commit -m "hello"; then echo; fi')).toEqual(["hello"]);
	});
});
