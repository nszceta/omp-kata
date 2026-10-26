/**
 * Keeps kata refs out of repository content. Pure analysis of tool-call inputs: which refs the session
 * has seen (kata arguments and listing output) and whether a write, edit, ast_edit or `git commit`
 * would put one into the workspace.
 */
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { gitCommitMessages, kataMentions, projectRefsIn } from "./refs";

export interface RefFinding {
	/** The matched text: a bare id or `<project>#<id>`. */
	ref: string;
	/** File path as the tool call gave it, or `commit message`. */
	where: string;
}

export function refFindingReason(finding: RefFinding): string {
	return `kata ref \`${finding.ref}\` in ${finding.where}: describe the change in words; record the cross-reference on the issue instead.`;
}

/** Subcommands whose output names issues the agent now knows about. */
const LISTING_SUBCOMMANDS: Record<string, true> = { claim: true, show: true, create: true, next: true, list: true, search: true };

/** Issue ids in kata output: JSON `short_id`, agent `issue=<id>` and `OK <cmd> <id>` / `Issue: <id>` lines, human `<id>  title` rows. */
const OUTPUT_ID_PATTERNS = [
	/"short_id"\s*:\s*"([a-z0-9]{4,12})"/g,
	/(?<![A-Za-z0-9_?&])issue=([a-z0-9]{4,12})(?![A-Za-z0-9_])/g,
	/^(?:OK [a-z-]+|Issue:) ([a-z0-9]{4,12})(?=\s|$)/gm,
	/^(?:[^\x00-\x7F]\s+)?([a-z0-9]{4,12}) {2,}\S/gm,
];

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const AST_EDIT_DEVICE = "xd://ast_edit";
/** Hashline edit file headers: `[PATH#TAG]` (legacy `¶PATH#TAG`). */
const EDIT_HEADER = /^(?:\[(.+)#[0-9A-Fa-f]{4}\]|¶(.+)#[0-9A-Fa-f]{4})\s*$/;

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

export class RefGuard {
	private readonly ids = new Set<string>();
	private readonly projects = new Set<string>();
	/** Matcher for the current sets; rebuilt lazily after they change (null = stale). */
	private matcher: RegExp | undefined | null = null;

	constructor(
		readonly root: string,
		boundProject: string | undefined,
		private readonly kataNames: readonly string[],
	) {
		if (boundProject) this.projects.add(boundProject);
	}

	/** Records a ref the session has been given (an argument, KATA_REF, kata output). */
	see(ref: string): void {
		const hash = ref.indexOf("#");
		if (hash === -1) this.addId(ref);
		else {
			this.addProject(ref.slice(0, hash));
			this.addId(ref.slice(hash + 1));
		}
	}

	private addId(id: string): void {
		if (!/^[a-z0-9]{4,12}$/.test(id) || this.ids.has(id)) return;
		this.ids.add(id);
		this.matcher = null;
	}

	private addProject(project: string): void {
		if (project === "" || this.projects.has(project)) return;
		this.projects.add(project);
		this.matcher = null;
	}

	/** Collects refs and `--project` names from a bash command's kata invocations. */
	observeCommand(command: string): void {
		const mentions = kataMentions(command, this.kataNames);
		for (const ref of mentions.refs) this.see(ref);
		for (const project of mentions.projects) this.addProject(project);
	}

	/** Collects issue ids from the output of a bash command that ran a listing kata subcommand. */
	observeOutput(command: string, output: string): void {
		if (!kataMentions(command, this.kataNames).subcommands.some(sub => Object.hasOwn(LISTING_SUBCOMMANDS, sub))) return;
		for (const pattern of OUTPUT_ID_PATTERNS) {
			for (const match of output.matchAll(pattern)) this.addId(match[1] as string);
		}
		for (const ref of projectRefsIn(output)) {
			this.addProject(ref.project);
			this.addId(ref.id);
		}
	}

	/** First kata ref in `text`: `<project>#<id>` for any known project, or a seen bare id, on word boundaries. */
	find(text: string): string | undefined {
		if (this.matcher === null) this.matcher = this.buildMatcher();
		return this.matcher?.exec(text)?.[0];
	}

	private buildMatcher(): RegExp | undefined {
		const byLength = (a: string, b: string) => b.length - a.length;
		const alternatives: string[] = [];
		if (this.projects.size > 0) {
			const names = [...this.projects].sort(byLength).map(escapeRegExp).join("|");
			alternatives.push(`(?<![A-Za-z0-9._-])(?:${names})#[a-z0-9]{4,12}(?![A-Za-z0-9_])`);
		}
		if (this.ids.size > 0) alternatives.push(`\\b(?:${[...this.ids].sort(byLength).join("|")})\\b`);
		return alternatives.length > 0 ? new RegExp(alternatives.join("|")) : undefined;
	}

	/** Whether `path` (relative to `cwd`) names a file inside the workspace; internal URLs never do. */
	private inWorkspace(path: string, cwd: string): boolean {
		if (SCHEME.test(path)) return false;
		const expanded = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
		const rel = relative(this.root, resolve(cwd, expanded));
		return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	}

	/** A ref the tool call would write into repository content, if any. Bash commands are also observed. */
	check(toolName: string, input: Record<string, unknown>, cwd: string): RefFinding | undefined {
		switch (toolName) {
			case "write":
				return this.checkWrite(input, cwd);
			case "edit":
				return this.checkEdit(input, cwd);
			case "ast_edit":
				return this.checkAstEdit(input, cwd);
			case "bash":
				return this.checkBash(input);
			default:
				return undefined;
		}
	}

	private checkWrite(input: Record<string, unknown>, cwd: string): RefFinding | undefined {
		const { path, content } = input;
		if (typeof path !== "string" || typeof content !== "string") return undefined;
		if (path === AST_EDIT_DEVICE) {
			let args: unknown;
			try {
				args = JSON.parse(content);
			} catch {
				return undefined;
			}
			return args && typeof args === "object" ? this.checkAstEdit(args as Record<string, unknown>, cwd) : undefined;
		}
		if (!this.inWorkspace(path, cwd)) return undefined;
		const ref = this.find(content);
		return ref === undefined ? undefined : { ref, where: path };
	}

	/** Hashline patches: only `+` body lines add text, each belonging to the latest `[PATH#TAG]` header. */
	private checkEdit(input: Record<string, unknown>, cwd: string): RefFinding | undefined {
		const patch = typeof input.input === "string" ? input.input : input._input;
		if (typeof patch !== "string") return undefined;
		let path: string | undefined;
		let checked = false;
		for (const line of patch.split("\n")) {
			const header = EDIT_HEADER.exec(line);
			if (header) {
				path = (header[1] ?? header[2]) as string;
				checked = this.inWorkspace(path, cwd);
				continue;
			}
			if (!checked || !line.startsWith("+")) continue;
			const ref = this.find(line.slice(1));
			if (ref !== undefined) return { ref, where: path as string };
		}
		return undefined;
	}

	/** ast_edit arguments `{ ops: [{ pat, out }], paths }`; replacement text counts when a target is in the workspace. */
	private checkAstEdit(input: Record<string, unknown>, cwd: string): RefFinding | undefined {
		const { ops, paths } = input;
		if (!Array.isArray(ops)) return undefined;
		const targets = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === "string") : [];
		const where = targets.length === 0 ? (this.inWorkspace(cwd, cwd) ? "." : undefined) : targets.find(p => this.inWorkspace(p, cwd));
		if (where === undefined) return undefined;
		for (const op of ops) {
			const out = op && typeof op === "object" ? (op as Record<string, unknown>).out : undefined;
			if (typeof out !== "string") continue;
			const ref = this.find(out);
			if (ref !== undefined) return { ref, where };
		}
		return undefined;
	}

	private checkBash(input: Record<string, unknown>): RefFinding | undefined {
		const { command } = input;
		if (typeof command !== "string") return undefined;
		this.observeCommand(command);
		for (const message of gitCommitMessages(command)) {
			const ref = this.find(message);
			if (ref !== undefined) return { ref, where: "commit message" };
		}
		return undefined;
	}
}
