import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ShimHost, sweepStaleStateDirs } from "../../src/shim";
import { tempDir } from "./helpers";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function newRoot(): string {
	const root = tempDir("omp-kata-sweep-");
	roots.push(root);
	return root;
}

/** A pid that existed and is now gone. */
async function deadPid(): Promise<number> {
	const child = Bun.spawn(["true"]);
	await child.exited;
	return child.pid;
}

function populate(root: string, name: string): string {
	const dir = join(root, name);
	mkdirSync(join(dir, "bin"), { recursive: true });
	writeFileSync(join(dir, "bin", "kata"), "x");
	writeFileSync(join(dir, "s.env"), "x");
	return dir;
}

describe("stale state dir sweep", () => {
	test("removes dirs of dead pids, keeps live pids, our own pid and non-matching names", async () => {
		const root = newRoot();
		const dead = populate(root, `omp-kata-${await deadPid()}-aB3dE9`);
		const live = Bun.spawn(["sleep", "30"]);
		try {
			const alive = populate(root, `omp-kata-${live.pid}-aB3dE9`);
			const own = populate(root, `omp-kata-${process.pid}-zzzzzz`);
			const keep = [
				populate(root, "omp-kata-abc123"), // legacy name without pid
				populate(root, `omp-kata-${live.pid}-short`),
				populate(root, `omp-kata-99999999-aB3dE9x`), // wrong suffix length
				populate(root, `x-omp-kata-99999999-aB3dE9`),
				populate(root, "omp-kata-unit-q1w2e3"),
			];
			expect(sweepStaleStateDirs(root)).toEqual([dead.slice(root.length + 1)]);
			expect(existsSync(dead)).toBe(false);
			for (const dir of [alive, own, ...keep]) expect(existsSync(dir)).toBe(true);
		} finally {
			live.kill();
		}
	});

	test("never follows a matching name that is a symlink or a file", async () => {
		const root = newRoot();
		const target = populate(root, "precious");
		const pid = await deadPid();
		symlinkSync(target, join(root, `omp-kata-${pid}-link01`));
		writeFileSync(join(root, `omp-kata-${pid}-file01`), "x");
		expect(sweepStaleStateDirs(root)).toEqual([]);
		expect(existsSync(join(target, "bin", "kata"))).toBe(true);
		expect(existsSync(join(root, `omp-kata-${pid}-file01`))).toBe(true);
	});

	test("a missing root is not an error", () => {
		expect(sweepStaleStateDirs(join(newRoot(), "nope"))).toEqual([]);
	});

	test("install sweeps leftovers of dead processes and names its own dir omp-kata-<pid>-XXXXXX", async () => {
		const root = newRoot();
		const stale = populate(root, `omp-kata-${await deadPid()}-aB3dE9`);
		const host = new ShimHost({ PATH: "/usr/bin" }, { tmpRoot: root });
		try {
			const stateDir = host.install("/real/kata");
			expect(stateDir.slice(root.length + 1)).toMatch(new RegExp(`^omp-kata-${process.pid}-[A-Za-z0-9]{6}$`));
			expect(existsSync(stale)).toBe(false);
			expect(existsSync(join(stateDir, "bin", "kata"))).toBe(true);
		} finally {
			host.dispose();
		}
	});

	test("a host that never installs sweeps nothing", async () => {
		const root = newRoot();
		const stale = populate(root, `omp-kata-${await deadPid()}-aB3dE9`);
		new ShimHost({ PATH: "/usr/bin" }, { tmpRoot: root }).resolveReal("sh");
		expect(existsSync(stale)).toBe(true);
	});
});
