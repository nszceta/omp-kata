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

/** Splits a command into simple-command segments of unquoted words. Shell expansions are left as raw text. */
export function tokenizeCommand(command: string): string[][] {
	const segments: string[][] = [];
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
				if (command[i] === "\\" && i + 1 < command.length) i++;
				word += command[i];
				i++;
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
		} else if (ch === "\n" || ch === ";" || ch === "|" || ch === "&" || ch === "(" || ch === ")") {
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
	return segments;
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

/** Index of the executable word in a segment if its basename is in `names`, skipping leading `VAR=x`, `env`, `command`, ... words. */
function findCommandWord(words: string[], names: ReadonlySet<string>): number {
	for (let i = 0; i < words.length; i++) {
		const word = words[i] as string;
		const bare = word.replace(/^[({]+/, "");
		if (bare === "" || ASSIGNMENT.test(bare) || Object.hasOwn(PREFIX_COMMANDS, bare)) continue;
		return names.has(basename(bare)) ? i : -1;
	}
	return -1;
}

function parseSegment(words: string[], names: ReadonlySet<string>): RefEvent[] {
	let i = findCommandWord(words, names);
	if (i === -1) return [];
	i++;
	// Global flags precede the subcommand.
	let sub: string | undefined;
	for (; i < words.length; i++) {
		const word = words[i] as string;
		if (!word.startsWith("-")) {
			sub = word;
			i++;
			break;
		}
		if (takesValue(word)) i++;
	}
	if (sub !== "claim" && sub !== "close") return [];

	const refs: string[] = [];
	let dry = false;
	for (; i < words.length; i++) {
		const word = words[i] as string;
		if (word.startsWith("-")) {
			if (word === "--dry") dry = true;
			// design: refs run until the first flag once at least one ref was seen.
			if (refs.length > 0 && sub === "claim") break;
			if (takesValue(word)) i++;
			continue;
		}
		if (isIssueRef(word)) {
			refs.push(word);
			// close takes exactly one ref; flags may follow it, so keep scanning only for --dry.
			if (sub === "close") {
				for (i++; i < words.length; i++) {
					const rest = words[i] as string;
					if (rest === "--dry") dry = true;
					else if (takesValue(rest)) i++;
				}
				break;
			}
		}
	}
	if (dry) return [];
	return refs.map(ref => ({ action: sub as "claim" | "close", ref }));
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
	let i = findCommandWord(words, names);
	if (i === -1) return;
	const start = i + 1;
	let sub: string | undefined;
	let rule: { skip: number; many: boolean } | undefined;
	let skipped = 0;
	let taken = 0;
	for (i++; i < words.length; i++) {
		const word = words[i] as string;
		if (word.startsWith("-")) {
			const eq = word.indexOf("=");
			const flag = eq === -1 ? word : word.slice(0, eq);
			const value = eq === -1 ? words[i + 1] : word.slice(eq + 1);
			const refFlag = Object.hasOwn(REF_VALUE_FLAGS, flag);
			if (refFlag) out.refs.push(...(value ?? "").split(",").filter(isShortOrProjectRef));
			else if (flag === "--project" && value) out.projects.push(value);
			if (eq === -1 && (refFlag || takesValue(word))) i++;
			if (taken > 0) rule = undefined;
			continue;
		}
		if (sub === undefined) {
			sub = word;
			out.subcommands.push(sub);
			rule = Object.hasOwn(REF_POSITIONALS, sub) ? REF_POSITIONALS[sub] : undefined;
			continue;
		}
		if (!rule) continue;
		if (skipped < rule.skip) {
			skipped++;
			continue;
		}
		if (!isShortOrProjectRef(word)) {
			rule = undefined;
			continue;
		}
		out.refs.push(word);
		taken++;
		if (!rule.many) rule = undefined;
	}
	// `<project>#<id>` counts in any argument, flag values and message text included.
	for (const word of words.slice(start)) {
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

const HEREDOC = /(?<!<)<<(?!<)(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/g;

/** Bodies of the here-documents in a command (`<<EOF`, `<<-'EOF'`, ...). */
function heredocBodies(command: string): string[] {
	const bodies: string[] = [];
	for (const match of command.matchAll(HEREDOC)) {
		const start = command.indexOf("\n", (match.index ?? 0) + match[0].length);
		if (start === -1) continue;
		const body: string[] = [];
		for (const line of command.slice(start + 1).split("\n")) {
			if ((match[1] ? line.replace(/^\t+/, "") : line) === match[3]) break;
			body.push(line);
		}
		bodies.push(body.join("\n"));
	}
	return bodies;
}

/**
 * Commit message text a bash command hands to `git commit`: `-m`/`--message` and `--trailer` values,
 * plus the command's here-document bodies when the message is read from stdin (`-F-`, `--file=-`).
 */
export function gitCommitMessages(command: string): string[] {
	const state = { messages: [] as string[], stdin: false };
	for (const words of tokenizeCommand(command)) commitSegment(words, state);
	return state.stdin ? [...state.messages, ...heredocBodies(command)] : state.messages;
}
