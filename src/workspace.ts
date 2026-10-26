import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const found = new Map<string, string>();

/**
 * Nearest ancestor of `cwd` (inclusive) containing `.kata.toml`, or undefined.
 * Only hits are cached: a negative answer must be recomputed so a mid-session `kata init` is noticed.
 */
export function findWorkspaceRoot(cwd: string): string | undefined {
	const start = resolve(cwd);
	const cached = found.get(start);
	if (cached !== undefined) return cached;
	let dir = start;
	for (;;) {
		if (existsSync(join(dir, ".kata.toml"))) {
			found.set(start, dir);
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

export function clearWorkspaceCache(): void {
	found.clear();
}

/** `[project] name` of the workspace's `.kata.toml`, or undefined when missing or unreadable. */
export function readProjectName(root: string): string | undefined {
	let text: string;
	try {
		text = readFileSync(join(root, ".kata.toml"), "utf8");
	} catch {
		return undefined;
	}
	let section = "";
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		const header = /^\[\s*([^\]]+?)\s*\]/.exec(line);
		if (header) {
			section = header[1] as string;
			continue;
		}
		if (section !== "project") continue;
		const name = /^name\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(line);
		if (name) return (name[1] ?? name[2]) || undefined;
	}
	return undefined;
}
