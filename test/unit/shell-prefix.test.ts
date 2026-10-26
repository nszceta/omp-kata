import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Env } from "../../src/config";
import { composeShellPrefix, ShimHost, stripShellPrefix } from "../../src/shim";
import { tempDir } from "./helpers";

const cleanups: (() => void)[] = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
});

function decoyDir(): string {
	const dir = join(tempDir("omp-kata-decoy-"), "decoy");
	mkdirSync(dir);
	writeFileSync(join(dir, "kata"), "#!/bin/sh\necho DECOY\n");
	chmodSync(join(dir, "kata"), 0o755);
	return dir;
}

/** Runs `commands` in ONE bash process, each as omp does: `${PI_SHELL_PREFIX} ${command}`. */
function runAsOmp(prefix: string, startPath: string, commands: string[], shell = "bash"): string[] {
	const script = commands.map(c => `${prefix} ${c}`).join("\n");
	const result = Bun.spawnSync([shell, "-c", script], { env: { PATH: startPath, HOME: "/nonexistent" } });
	return result.stdout.toString().trimEnd().split("\n");
}

describe("composeShellPrefix in a real shell", () => {
	const shimDir = "/tmp/omp-kata-test-shim/bin";

	test("puts the shim dir first even when an rc-built PATH has a decoy kata in front", () => {
		const decoy = decoyDir();
		const shim = tempDir("omp-kata-shim-");
		writeFileSync(join(shim, "kata"), "#!/bin/sh\necho SHIM\n");
		chmodSync(join(shim, "kata"), 0o755);
		const prefix = composeShellPrefix(shim, undefined);
		const out = runAsOmp(prefix, `${decoy}:${shim}:/usr/bin:/bin`, ["kata", "kata", 'echo "${PATH%%:*}"']);
		expect(out).toEqual(["SHIM", "SHIM", shim]);
		cleanups.push(() => Bun.spawnSync(["rm", "-rf", dirname(decoy), shim]));
	});

	test("without any kata dir on PATH yet it is prepended; running twice in one shell never grows PATH", () => {
		const shim = tempDir("omp-kata-shim-");
		const prefix = composeShellPrefix(shim, undefined);
		const out = runAsOmp(prefix, "/usr/bin:/bin", ['echo "$PATH"', 'echo "$PATH"', 'echo "$PATH"']);
		expect(out).toEqual([`${shim}:/usr/bin:/bin`, `${shim}:/usr/bin:/bin`, `${shim}:/usr/bin:/bin`]);
		cleanups.push(() => Bun.spawnSync(["rm", "-rf", shim]));
	});

	test("works for shim dirs with spaces and quotes, in sh as well as bash", () => {
		const base = tempDir("omp-kata-odd-");
		const odd = join(base, "it's a dir*");
		mkdirSync(odd);
		const prefix = composeShellPrefix(odd, undefined);
		for (const shell of ["bash", "sh"]) {
			expect(runAsOmp(prefix, "/usr/bin:/bin", ['echo "${PATH%%:/usr/bin:/bin}"'], shell)).toEqual([odd]);
		}
		cleanups.push(() => Bun.spawnSync(["rm", "-rf", base]));
	});

	test("leaves no helper variable behind and keeps the exit status and cwd of the command", () => {
		const prefix = composeShellPrefix("/tmp/x-shim", undefined);
		const out = runAsOmp(prefix, "/usr/bin:/bin", ['echo "[${__omp_kata_d-unset}]"', "cd /tmp", "pwd"]);
		expect(out).toEqual(["[unset]", "/tmp"]);
		expect(Bun.spawnSync(["bash", "-c", `${prefix} exit 7`], { env: { PATH: "/usr/bin:/bin" } }).exitCode).toBe(7);
	});

	test("a user's own prefix is kept after ours and runs", () => {
		const prefix = composeShellPrefix("/tmp/x-shim", "env FOO=bar");
		expect(prefix.endsWith("unset __omp_kata_d; env FOO=bar")).toBe(true);
		expect(runAsOmp(prefix, "/usr/bin:/bin", ["sh -c 'echo $FOO'"])).toEqual(["bar"]);
	});
});

describe("prefix composition is applied exactly once", () => {
	test("strip removes only our part", () => {
		const composed = composeShellPrefix("/tmp/a", "strace -f");
		expect(stripShellPrefix(composed)).toBe("strace -f");
		expect(stripShellPrefix(composeShellPrefix("/tmp/a", undefined))).toBe("");
		expect(stripShellPrefix("strace -f")).toBe("strace -f");
		expect(stripShellPrefix(undefined)).toBe("");
	});

	test("re-composing over our own prefix (another dir, another host) replaces instead of stacking", () => {
		const first = composeShellPrefix("/tmp/a", "strace -f");
		const second = composeShellPrefix("/tmp/b", first);
		expect(second).toBe(composeShellPrefix("/tmp/b", "strace -f"));
		expect(second.split("__omp_kata_d=").length).toBe(2);
	});

	test("install sets PI_SHELL_PREFIX once, idempotently, preserving a user's PI_SHELL_PREFIX", () => {
		const tmp = tempDir("omp-kata-pfx-");
		cleanups.push(() => Bun.spawnSync(["rm", "-rf", tmp]));
		const env: Env = { PATH: "/usr/bin:/bin", PI_SHELL_PREFIX: "strace -f" };
		const host = new ShimHost(env, { tmpRoot: tmp });
		cleanups.push(() => host.dispose());
		host.install("/real/kata");
		const once = env.PI_SHELL_PREFIX;
		host.install("/real/kata");
		host.install("/real/kata");
		expect(env.PI_SHELL_PREFIX).toBe(once);
		expect(stripShellPrefix(env.PI_SHELL_PREFIX)).toBe("strace -f");
		expect(env.PI_SHELL_PREFIX?.startsWith(`__omp_kata_d=${env.PATH?.split(":")[0]};`)).toBe(true);
	});

	test("two hosts in one process (child sessions share process.env) do not stack prefixes", () => {
		const tmp = tempDir("omp-kata-pfx-");
		cleanups.push(() => Bun.spawnSync(["rm", "-rf", tmp]));
		const env: Env = { PATH: "/usr/bin:/bin" };
		const a = new ShimHost(env, { tmpRoot: tmp });
		const b = new ShimHost(env, { tmpRoot: tmp });
		cleanups.push(() => a.dispose());
		cleanups.push(() => b.dispose());
		a.install("/real/kata");
		b.install("/real/kata");
		expect(env.PI_SHELL_PREFIX?.split("__omp_kata_d=").length).toBe(2);
	});

	test("only CLAUDE_CODE_SHELL_PREFIX set: it is folded into PI_SHELL_PREFIX (omp prefers PI_SHELL_PREFIX)", () => {
		const tmp = tempDir("omp-kata-pfx-");
		cleanups.push(() => Bun.spawnSync(["rm", "-rf", tmp]));
		const env: Env = { PATH: "/usr/bin:/bin", CLAUDE_CODE_SHELL_PREFIX: "nice -n 5" };
		const host = new ShimHost(env, { tmpRoot: tmp });
		cleanups.push(() => host.dispose());
		host.install("/real/kata");
		expect(stripShellPrefix(env.PI_SHELL_PREFIX)).toBe("nice -n 5");
		expect(env.CLAUDE_CODE_SHELL_PREFIX).toBe("nice -n 5");
	});

	test("a ShimHost that never installs leaves the prefix alone", () => {
		const env: Env = { PATH: "/usr/bin:/bin", PI_SHELL_PREFIX: "strace -f" };
		const host = new ShimHost(env);
		host.resolveReal("sh");
		expect(env.PI_SHELL_PREFIX).toBe("strace -f");
	});
});

describe("an omp started from an omp bash command", () => {
	test("drops the enclosing process's shim, state and prefix but keeps the user's own", () => {
		const outer = "/tmp/omp-kata-111-aBc123/bin";
		const env: Env = {
			PATH: `${outer}:/usr/local/bin:/home/u/bin:/usr/bin`,
			OMP_KATA_STATE_DIR: "/tmp/omp-kata-111-aBc123",
			OMP_KATA_REAL: "/usr/local/bin/kata",
			PI_SHELL_PREFIX: composeShellPrefix(outer, "source ~/.venv"),
		};
		new ShimHost(env);
		expect(env).toEqual({ PATH: "/usr/local/bin:/home/u/bin:/usr/bin", PI_SHELL_PREFIX: "source ~/.venv" });
	});
});
