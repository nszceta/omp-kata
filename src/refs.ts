/**
 * Extract the issue refs a bash command claims or closes. Pure string analysis: the command may be a
 * chain (`&&`, `||`, `;`, `|`, newline) and kata may be invoked via path, env prefixes or `export`.
 */

export interface RefEvent {
	action: "claim" | "close";
	ref: string;
}

/** Index just past the parenthesis that closes the one at `open` (or the end of input). */
function balancedEnd(command: string, open: number): number {
	let depth = 0;
	for (let j = open; j < command.length; j++) {
		const ch = command[j];
		if (ch === "(") depth++;
		else if (ch === ")" && --depth === 0) return j + 1;
		else if (ch === "'" || ch === '"') {
			const close = command.indexOf(ch, j + 1);
			if (close === -1) return command.length;
			j = close;
		}
	}
	return command.length;
}

/** Characters whose ANSI-C escape yields the character itself. */
const ANSI_C_PLAIN = `'"\\?`;

/** Characters that end an unquoted here-document delimiter word. */
const DELIMITER_END = new Set([" ", "\t", "\r", "\n", ";", "|", "&", "(", ")", "<", ">"]);

/** Reads the here-document delimiter word starting at `from`; its quoting is removed. `end` is the index just past it. */
function readDelimiter(command: string, from: number): { word: string; end: number } {
	let i = from;
	while (command[i] === " " || command[i] === "\t") i++;
	let word = "";
	while (i < command.length && !DELIMITER_END.has(command[i] as string)) {
		const ch = command[i] as string;
		if (ch === "'" || ch === '"') {
			const close = command.indexOf(ch, i + 1);
			const end = close === -1 ? command.length : close;
			word += command.slice(i + 1, end);
			i = end + 1;
		} else if (ch === "\\" && i + 1 < command.length) {
			word += command[i + 1];
			i += 2;
		} else {
			word += ch;
			i++;
		}
	}
	return { word, end: Math.min(i, command.length) };
}

/** Whether the `((` at `open` closes with an adjacent `))`, i.e. is arithmetic rather than nested subshells. */
function isArithmetic(command: string, open: number): boolean {
	const inner = balancedEnd(command, open + 1);
	return command[inner - 1] === ")" && command[inner] === ")" && balancedEnd(command, open) === inner + 1;
}

/** A command's simple-command segments plus the bodies of its here-documents, which are not commands. */
export interface ScannedCommand {
	segments: string[][];
	/** Here-document bodies in source order, delimiter line excluded; `<<-` bodies keep their leading tabs. */
	heredocs: string[];
}

/** Splits a command into simple-command segments of unquoted words. Shell expansions are left as raw text. */
export function tokenizeCommand(command: string): string[][] {
	return scanCommand(command).segments;
}

/** One pass over a command: segments as in {@link tokenizeCommand}, with here-document bodies skipped and returned apart. */
export function scanCommand(command: string): ScannedCommand {
	const segments: string[][] = [];
	const heredocs: string[] = [];
	const pending: { delimiter: string; strip: boolean }[] = [];
	let words: string[] = [];
	let word = "";
	let inWord = false;
	let i = 0;

	const endWord = () => {
		if (inWord) words.push(word);
		word = "";
		inWord = false;
	};
	const endSegment = () => {
		endWord();
		if (words.length > 0) segments.push(words);
		words = [];
	};

	while (i < command.length) {
		const ch = command[i] as string;
		if (ch === "'") {
			const close = command.indexOf("'", i + 1);
			const end = close === -1 ? command.length : close;
			word += command.slice(i + 1, end);
			inWord = true;
			i = end + 1;
		} else if (ch === '"') {
			i++;
			inWord = true;
			while (i < command.length && command[i] !== '"') {
				if (command[i] === "\\" && i + 1 < command.length) {
					const next = command[i + 1] as string;
					if (next === "\n") {
						i += 2;
						continue;
					}
					// POSIX: backslash is removed only before $ ` " \ and newline.
					if (next === "$" || next === "`" || next === '"' || next === "\\") i++;
				}
				word += command[i];
				i++;
			}
			i++;
		} else if (ch === "$" && command[i + 1] === "$") {
			// `$$` is the PID parameter; a following quote is an ordinary quote.
			word += "$$";
			inWord = true;
			i += 2;
		} else if (ch === "$" && command[i + 1] === '"') {
			// Locale quoting: same as a double-quoted string without the `$`.
			i++;
		} else if (ch === "$" && command[i + 1] === "'") {
			i += 2;
			inWord = true;
			while (i < command.length && command[i] !== "'") {
				if (command[i] === "\\" && i + 1 < command.length) {
					const esc = command[i + 1] as string;
					i += 2;
					if (esc === "n") word += "\n";
					else if (esc === "t") word += "\t";
					else if (esc === "r") word += "\r";
					else word += ANSI_C_PLAIN.includes(esc) ? esc : `\\${esc}`;
				} else {
					word += command[i];
					i++;
				}
			}
			i++;
		} else if (ch === "$" && command[i + 1] === "(") {
			// Command substitution is opaque text: its words are not part of the enclosing command.
			const end = balancedEnd(command, i + 1);
			word += command.slice(i, end);
			inWord = true;
			i = end;
		} else if (ch === "`") {
			const close = command.indexOf("`", i + 1);
			const end = close === -1 ? command.length : close + 1;
			word += command.slice(i, end);
			inWord = true;
			i = end;
		} else if (ch === "\\") {
			if (command[i + 1] === "\n") {
				i += 2;
				continue;
			}
			if (i + 1 < command.length) {
				word += command[i + 1];
				inWord = true;
			}
			i += 2;
		} else if (ch === "<" && command[i + 1] === "<" && command[i + 2] === "<") {
			// Here-string: its word is data, not a delimiter.
			word += "<<<";
			inWord = true;
			i += 3;
		} else if (ch === "<" && command[i + 1] === "<") {
			// Here-document: the delimiter is consumed now, the body at the next newline.
			endWord();
			const strip = command[i + 2] === "-";
			const { word: delimiter, end } = readDelimiter(command, i + (strip ? 3 : 2));
			if (end > i + 2) pending.push({ delimiter, strip });
			i = Math.max(end, i + 2);
		} else if (ch === "\n") {
			endSegment();
			i++;
			while (pending.length > 0 && i < command.length) {
				const { delimiter, strip } = pending.shift() as { delimiter: string; strip: boolean };
				const body: string[] = [];
				while (i < command.length) {
					const eol = command.indexOf("\n", i);
					const line = command.slice(i, eol === -1 ? command.length : eol);
					i = eol === -1 ? command.length : eol + 1;
					const text = line.endsWith("\r") ? line.slice(0, -1) : line;
					if ((strip ? text.replace(/^\t+/, "") : text) === delimiter) break;
					body.push(line);
				}
				heredocs.push(body.join("\n"));
			}
			pending.length = 0;
		} else if (ch === "(" && command[i + 1] === "(" && !inWord && isArithmetic(command, i)) {
			// Bare `(( ... ))` / `for (( ... ))`: arithmetic, where `<<` is a shift rather than a here-document.
			endSegment();
			i = balancedEnd(command, i);
		} else if (ch === ";" || ch === "|" || ch === "&" || ch === "(" || ch === ")") {
			endSegment();
			i++;
		} else if (ch === " " || ch === "\t" || ch === "\r") {
			endWord();
			i++;
		} else if (ch === "#" && !inWord) {
			while (i < command.length && command[i] !== "\n") i++;
		} else {
			word += ch;
			inWord = true;
			i++;
		}
	}
	endSegment();
	return { segments, heredocs };
}

/** Global flags (and claim/close flags) that consume the following word as their value. */
const VALUE_FLAGS: Record<string, true> = {
	"--as": true,
	"--daemon": true,
	"--format": true,
	"--project": true,
	"--teammate": true,
	"--workspace": true,
	"--comment": true,
	"--ttl": true,
	"-m": true,
	"--message": true,
	"--reason": true,
	"--commit": true,
	"--pr": true,
	"--test": true,
	"--reviewed": true,
	"--evidence": true,
	"--docbank": true,
	"--duplicate-of": true,
	"--superseded-by": true,
	"--idempotency-key": true,
	"--if-match": true,
};

function takesValue(word: string): boolean {
	return !word.includes("=") && Object.hasOwn(VALUE_FLAGS, word);
}

const PREFIX_COMMANDS: Record<string, true> = { env: true, command: true, exec: true, time: true, nohup: true, builtin: true };
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHORT_REF = /^[a-z0-9]{4,12}$/;
const PROJECT_REF = /^[A-Za-z0-9][A-Za-z0-9._-]*#[a-z0-9]{4,12}$/;
const ULID_REF = /^[0-9A-Za-z]{26}$/;

export function isIssueRef(token: string): boolean {
	return SHORT_REF.test(token) || PROJECT_REF.test(token) || ULID_REF.test(token);
}

function basename(token: string): string {
	const slash = token.lastIndexOf("/");
	return slash === -1 ? token : token.slice(slash + 1);
}

const RESERVED_PREFIX = new Set(["if", "then", "elif", "else", "do", "while", "until", "!", "{"]);
/** Options of prefix commands that consume the next word; short flags match exactly, long flags only without `=`. */
const PREFIX_VALUE_OPTIONS: Record<string, ReadonlySet<string>> = {
	env: new Set(["-u", "--unset", "-C", "--chdir"]),
	exec: new Set(["-a"]),
};

/** Index of the executable word in a segment if its basename is in `names`, skipping leading `VAR=x`, reserved words, and prefix commands with their options. */
function findCommandWord(words: string[], names: ReadonlySet<string>): number {
	let prefix: string | undefined;
	for (let i = 0; i < words.length; i++) {
		const word = words[i] as string;
		const bare = prefix === undefined ? word.replace(/^[({]+/, "") : word;
		if (bare === "" || ASSIGNMENT.test(bare)) continue;
		if (prefix === undefined) {
			if (RESERVED_PREFIX.has(bare)) continue;
			if (Object.hasOwn(PREFIX_COMMANDS, bare)) {
				prefix = bare;
				continue;
			}
			return names.has(basename(bare)) ? i : -1;
		}
		if (word === "--") {
			prefix = undefined;
			continue;
		}
		if (word.startsWith("-") && word.length > 1) {
			if (prefix === "env" && /^(?:-[0iv]*S|--split-string(?:=|$))/.test(word)) return -1;
			if (prefix === "command" && /^-[pvV]*[vV]/.test(word)) return -1;
			if (PREFIX_VALUE_OPTIONS[prefix]?.has(word)) i++;
			continue;
		}
		prefix = undefined;
		i--;
	}
	return -1;
}

/**
 * Subcommands whose leading positional arguments are issue refs. `skip` positionals (an action word
 * such as `label add`, `meta set`) come first; `many` takes refs until the first flag or non-ref.
 */
const REF_POSITIONALS: Record<string, { skip: number; many: boolean }> = {
	assign: { skip: 0, many: false },
	claim: { skip: 0, many: true },
	close: { skip: 0, many: false },
	comment: { skip: 0, many: false },
	deadline: { skip: 0, many: false },
	edit: { skip: 0, many: false },
	label: { skip: 1, many: false },
	meta: { skip: 1, many: false },
	move: { skip: 0, many: false },
	notify: { skip: 0, many: false },
	reopen: { skip: 0, many: false },
	schedule: { skip: 0, many: false },
	show: { skip: 0, many: false },
	status: { skip: 0, many: false },
	unassign: { skip: 0, many: false },
	wait: { skip: 0, many: true },
};

/** Flags whose value is one or more (comma-separated) issue refs. */
const REF_VALUE_FLAGS: Record<string, true> = {
	"--parent": true,
	"--blocks": true,
	"--blocked-by": true,
	"--related": true,
	"--duplicate-of": true,
	"--superseded-by": true,
};

interface Invocation {
	sub: string | undefined;
	/** Refs in argument order: ref positionals and ref-valued flags. */
	refs: { ref: string; positional: boolean }[];
	projects: string[];
	dry: boolean;
}

/**
 * The one reader of a kata invocation's words after the executable (`from` is the first of them):
 * global flags (value flags consume the next word), the subcommand, the ref positionals named by
 * REF_POSITIONALS, ref-valued flags, `--project` and `--dry`.
 *
 * Rule for non-ref words: multi-ref commands skip non-refs before the first ref (an unexpanded `$ID`
 * may hide it); positional refs then run until the first flag or non-ref word. Kata itself rejects `claim <ref> <other> <ref>` ("accepts 1 arg(s), received 3"), so
 * no later word can name a claimed ref and detection stops at the first non-ref. Flags and `--dry`
 * are still read to the end of the invocation.
 */
function walkInvocation(words: string[], from: number, isRef: (word: string) => boolean): Invocation {
	const out: Invocation = { sub: undefined, refs: [], projects: [], dry: false };
	let rule: { skip: number; many: boolean } | undefined;
	let skipped = 0;
	let taken = 0;
	for (let i = from; i < words.length; i++) {
		const word = words[i] as string;
		if (word.startsWith("-")) {
			const eq = word.indexOf("=");
			const flag = eq === -1 ? word : word.slice(0, eq);
			const value = eq === -1 ? words[i + 1] : word.slice(eq + 1);
			const refFlag = Object.hasOwn(REF_VALUE_FLAGS, flag);
			if (word === "--dry") out.dry = true;
			if (refFlag) {
				for (const ref of (value ?? "").split(",")) if (isRef(ref)) out.refs.push({ ref, positional: false });
			} else if (flag === "--project" && value) out.projects.push(value);
			if (eq === -1 && (refFlag || takesValue(word))) i++;
			if (taken > 0) rule = undefined;
			continue;
		}
		if (out.sub === undefined) {
			out.sub = word;
			rule = Object.hasOwn(REF_POSITIONALS, word) ? REF_POSITIONALS[word] : undefined;
			continue;
		}
		if (!rule) continue;
		if (skipped < rule.skip) {
			skipped++;
			continue;
		}
		if (!isRef(word)) {
			// Multi-ref commands skip leading non-refs (an unexpanded `$ID`); everything else gives up.
			if (taken > 0 || !rule.many) rule = undefined;
			continue;
		}
		out.refs.push({ ref: word, positional: true });
		taken++;
		if (!rule.many) rule = undefined;
	}
	return out;
}

function parseSegment(words: string[], names: ReadonlySet<string>): RefEvent[] {
	const at = findCommandWord(words, names);
	if (at === -1) return [];
	const inv = walkInvocation(words, at + 1, isIssueRef);
	if (inv.dry || (inv.sub !== "claim" && inv.sub !== "close")) return [];
	const action = inv.sub;
	return inv.refs.filter(r => r.positional).map(r => ({ action, ref: r.ref }));
}

/** claim/close events in command order. `names` are the executable basenames to recognise. */
export function parseRefEvents(command: string, names: readonly string[] = ["kata"]): RefEvent[] {
	const nameSet = new Set(names);
	const events: RefEvent[] = [];
	for (const words of tokenizeCommand(command)) events.push(...parseSegment(words, nameSet));
	return events;
}

export function parseClaimRefs(command: string, names?: readonly string[]): string[] {
	return unique(parseRefEvents(command, names).filter(e => e.action === "claim").map(e => e.ref));
}

export function parseCloseRefs(command: string, names?: readonly string[]): string[] {
	return unique(parseRefEvents(command, names).filter(e => e.action === "close").map(e => e.ref));
}

function unique(items: string[]): string[] {
	return [...new Set(items)];
}

/** `<project>#<id>` inside free text; the lookarounds keep URL fragments and `key=a#b` values out. */
const PROJECT_REF_IN_TEXT = /(?<![A-Za-z0-9._\-/?=&#@])([A-Za-z0-9][A-Za-z0-9._-]*)#([a-z0-9]{4,12})(?![A-Za-z0-9_=-])/g;

export interface ProjectRef {
	project: string;
	id: string;
}

export function projectRefsIn(text: string): ProjectRef[] {
	return [...text.matchAll(PROJECT_REF_IN_TEXT)].map(m => ({ project: m[1] as string, id: m[2] as string }));
}

export interface KataMentions {
	/** Subcommand of every kata invocation, in command order. */
	subcommands: string[];
	/** Issue refs passed as arguments: bare short ids and `<project>#<id>`. */
	refs: string[];
	/** Project names passed with `--project`. */
	projects: string[];
}

function isShortOrProjectRef(token: string): boolean {
	return SHORT_REF.test(token) || PROJECT_REF.test(token);
}

function collectMentions(words: string[], names: ReadonlySet<string>, out: KataMentions): void {
	const at = findCommandWord(words, names);
	if (at === -1) return;
	const inv = walkInvocation(words, at + 1, isShortOrProjectRef);
	if (inv.sub !== undefined) out.subcommands.push(inv.sub);
	for (const { ref } of inv.refs) out.refs.push(ref);
	out.projects.push(...inv.projects);
	// `<project>#<id>` counts in any argument, flag values and message text included.
	for (const word of words.slice(at + 1)) {
		for (const ref of projectRefsIn(word)) out.refs.push(`${ref.project}#${ref.id}`);
	}
}

/** Subcommands, ref arguments and `--project` names of every kata invocation in a bash command. */
export function kataMentions(command: string, names: readonly string[] = ["kata"]): KataMentions {
	const nameSet = new Set(names);
	const out: KataMentions = { subcommands: [], refs: [], projects: [] };
	for (const words of tokenizeCommand(command)) collectMentions(words, nameSet, out);
	return { ...out, refs: unique(out.refs) };
}

const GIT = new Set(["git"]);
/** git global options that consume the following word. */
const GIT_VALUE_OPTIONS: Record<string, true> = {
	"-C": true,
	"-c": true,
	"--git-dir": true,
	"--work-tree": true,
	"--namespace": true,
	"--config-env": true,
	"--super-prefix": true,
};
/** `git commit` long options that consume the following word (when not written as `--opt=value`). */
const COMMIT_VALUE_OPTIONS: Record<string, true> = {
	"--author": true,
	"--cleanup": true,
	"--date": true,
	"--file": true,
	"--fixup": true,
	"--message": true,
	"--pathspec-from-file": true,
	"--reedit-message": true,
	"--reuse-message": true,
	"--squash": true,
	"--template": true,
	"--trailer": true,
};
/** `git commit` short options taking a value, attached (`-mmsg`) or as the next word; they may end a cluster (`-am`). */
const COMMIT_SHORT_VALUE: Record<string, string> = { m: "--message", F: "--file", C: "--reuse-message", c: "--reedit-message", t: "--template" };

/** Message parts of one `git commit` segment; `stdin` is set when the message is read from standard input. */
function commitSegment(words: string[], state: { messages: string[]; stdin: boolean }): void {
	let i = findCommandWord(words, GIT);
	if (i === -1) return;
	for (i++; i < words.length; i++) {
		const word = words[i] as string;
		if (!word.startsWith("-")) break;
		if (Object.hasOwn(GIT_VALUE_OPTIONS, word)) i++;
	}
	if (words[i] !== "commit") return;
	const apply = (option: string, value: string | undefined) => {
		if (value === undefined) return;
		if (option === "--message" || option === "--trailer") state.messages.push(value);
		else if (option === "--file" && (value === "-" || value === "/dev/stdin")) state.stdin = true;
	};
	for (i++; i < words.length; i++) {
		const word = words[i] as string;
		if (word === "--") break;
		if (word.startsWith("--")) {
			const eq = word.indexOf("=");
			const option = eq === -1 ? word : word.slice(0, eq);
			if (!Object.hasOwn(COMMIT_VALUE_OPTIONS, option)) continue;
			if (eq !== -1) apply(option, word.slice(eq + 1));
			else apply(option, words[++i]);
		} else if (word.startsWith("-")) {
			for (let j = 1; j < word.length; j++) {
				const option = COMMIT_SHORT_VALUE[word[j] as string];
				if (option === undefined) continue;
				const attached = word.slice(j + 1);
				apply(option, attached !== "" ? attached : words[++i]);
				break;
			}
		}
	}
}

/** Bodies of the here-documents inside `$(...)` and backtick substitutions of `segments`' words, at any depth. */
function substitutionHeredocs(segments: string[][], out: string[]): void {
	for (const words of segments) {
		for (const word of words) {
			for (let i = 0; i < word.length; i++) {
				let inner: string;
				if (word.startsWith("$(", i) && word[i + 2] !== "(") {
					const end = balancedEnd(word, i + 1);
					inner = word.slice(i + 2, word[end - 1] === ")" ? end - 1 : end);
					i = end - 1;
				} else if (word[i] === "`") {
					const close = word.indexOf("`", i + 1);
					inner = word.slice(i + 1, close === -1 ? word.length : close);
					i = close === -1 ? word.length : close;
				} else continue;
				const scanned = scanCommand(inner);
				out.push(...scanned.heredocs);
				substitutionHeredocs(scanned.segments, out);
			}
		}
	}
}

/**
 * Commit message text a bash command hands to `git commit`: `-m`/`--message` and `--trailer` values,
 * plus the command's here-document bodies (also those inside command substitutions) when the message is read from stdin (`-F-`, `--file=-`).
 */
export function gitCommitMessages(command: string): string[] {
	const state = { messages: [] as string[], stdin: false };
	const { segments, heredocs } = scanCommand(command);
	for (const words of segments) commitSegment(words, state);
	if (!state.stdin) return state.messages;
	substitutionHeredocs(segments, heredocs);
	return [...state.messages, ...heredocs];
}
