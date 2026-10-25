import { existsSync } from "node:fs";
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
