import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { clearWorkspaceCache, findWorkspaceRoot } from "../../src/workspace";
import { makeWorkspace, tempDir } from "./helpers";

interface Workspace {
	root: string;
	nested: string;
	outside: string;
	cleanup: () => void;
}

let ws: Workspace;

beforeEach(() => {
	clearWorkspaceCache();
	ws = makeWorkspace();
});

afterEach(() => {
	ws.cleanup();
	clearWorkspaceCache();
});

describe("findWorkspaceRoot", () => {
	test("cwd itself holding .kata.toml is the root", () => {
		expect(findWorkspaceRoot(ws.root)).toBe(ws.root);
	});

	test("nested directory resolves to the ancestor with .kata.toml", () => {
		expect(findWorkspaceRoot(ws.nested)).toBe(ws.root);
	});

	test("no .kata.toml anywhere above gives undefined", () => {
		expect(findWorkspaceRoot(ws.outside)).toBeUndefined();
	});

	test("the nearest ancestor wins over an outer workspace", () => {
		const inner = join(ws.nested, "inner");
		mkdirSync(join(inner, "deeper"), { recursive: true });
		writeFileSync(join(inner, ".kata.toml"), "version = 1\n");
		expect(findWorkspaceRoot(join(inner, "deeper"))).toBe(inner);
		expect(findWorkspaceRoot(ws.nested)).toBe(ws.root);
	});

	test("relative cwd is resolved against process.cwd()", () => {
		expect(findWorkspaceRoot(relative(process.cwd(), ws.nested))).toBe(ws.root);
	});

	test("files merely resembling .kata.toml do not count", () => {
		const base = tempDir();
		try {
			writeFileSync(join(base, "kata.toml"), "");
			writeFileSync(join(base, ".kata.toml.bak"), "");
			expect(findWorkspaceRoot(base)).toBeUndefined();
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	test("negative results are not cached: init after a miss is noticed", () => {
		expect(findWorkspaceRoot(ws.outside)).toBeUndefined();
		writeFileSync(join(ws.outside, ".kata.toml"), "version = 1\n");
		expect(findWorkspaceRoot(ws.outside)).toBe(ws.outside);
	});

	test("positive results are cached until clearWorkspaceCache", () => {
		expect(findWorkspaceRoot(ws.nested)).toBe(ws.root);
		rmSync(join(ws.root, ".kata.toml"));
		// stale hit proves the cache is used
		expect(findWorkspaceRoot(ws.nested)).toBe(ws.root);
		clearWorkspaceCache();
		expect(findWorkspaceRoot(ws.nested)).toBeUndefined();
	});

	test("clearWorkspaceCache lets a nearer workspace created later take over", () => {
		expect(findWorkspaceRoot(ws.nested)).toBe(ws.root);
		writeFileSync(join(ws.nested, ".kata.toml"), "version = 1\n");
		expect(findWorkspaceRoot(ws.nested)).toBe(ws.root);
		clearWorkspaceCache();
		expect(findWorkspaceRoot(ws.nested)).toBe(ws.nested);
	});
});
