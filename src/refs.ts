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

/** Index of the kata executable word in a segment, skipping leading `VAR=x`, `env`, `command`, ... words. */
function findKataWord(words: string[], names: ReadonlySet<string>): number {
	for (let i = 0; i < words.length; i++) {
		const word = words[i] as string;
		const bare = word.replace(/^[({]+/, "");
		if (bare === "" || ASSIGNMENT.test(bare) || Object.hasOwn(PREFIX_COMMANDS, bare)) continue;
		return names.has(basename(bare)) ? i : -1;
	}
	return -1;
}

function parseSegment(words: string[], names: ReadonlySet<string>): RefEvent[] {
	let i = findKataWord(words, names);
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
