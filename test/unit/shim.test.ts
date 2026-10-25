import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Env } from "../../src/config";
import type { Identity } from "../../src/identity";
import { renderIdentityFile, SHIM_SOURCE, ShimHost } from "../../src/shim";
import { REAL_KATA, RealKata, tempDir } from "./helpers";

const MAIN_ID: Identity = { actor: "adam", teammate: "", inboxUser: "adam" };
const BOB_ID: Identity = { actor: "adam", teammate: "bob", inboxUser: "adam/bob" };
const SH = Bun.which("sh") ?? "/bin/sh";
const MODEL_OVERRIDE = "export KATA_AUTHOR=evil KATA_INBOX_USER=evil/w KATA_TEAMMATE=evil; ";

interface Shell {
	name: string;
	path: string;
}

/** sh, bash and dash where installed, one entry per distinct binary. */
function availableShells(): Shell[] {
	const seen = new Set<string>();
	const shells: Shell[] = [];
	for (const name of ["sh", "bash", "dash"]) {
		const path = Bun.which(name);
		if (!path) continue;
		const real = realpathSync(path);
		if (seen.has(real)) continue;
		seen.add(real);
		shells.push({ name, path });
	}
	return shells;
}

interface RunOptions {
	cwd?: string;
	env: Record<string, string>;
}

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

function run(shell: Shell, command: string, options: RunOptions): RunResult {
	const proc = Bun.spawnSync([shell.path, "-c", command], { cwd: options.cwd, env: options.env, timeout: 20_000 });
	return { code: proc.exitCode ?? -1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

/** A fake kata that reports who it is, the identity variables it received and its argv. */
function writeFake(dir: string, id: string): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "kata");
	writeFileSync(
		path,
		`#!/bin/sh
if [ "$1" = "--stdin" ]; then printf '%s:stdin=%s' '${id}' "$(cat)"; exit 0; fi
printf '%s:%s|%s|%s' '${id}' "$KATA_AUTHOR" "\${KATA_TEAMMATE-UNSET}" "$KATA_INBOX_USER"
for a in "$@"; do printf '|<%s>' "$a"; done
exit "\${FAKE_EXIT:-0}"
`,
	);
	chmodSync(path, 0o755);
	return path;
}

/** Expected fake output: `<id>:<author>|<teammate or UNSET>|<inbox>|<arg>...` */
function seen(id: string, author: string, teammate: string, inbox: string, ...args: string[]): string {
	return `${id}:${author}|${teammate}|${inbox}${args.map(a => `|<${a}>`).join("")}`;
}

function mode(path: string): number {
	return statSync(path).mode & 0o777;
}

const base = tempDir("omp-kata-shim-");
const toolDir = join(base, "tools");
const fakeA = writeFake(join(base, "fake-a"), "A");
const fakeB = writeFake(join(base, "fake-b"), "B");
const fakeADir = join(base, "fake-a");

function linkTool(name: string): void {
	const found = Bun.which(name);
	if (!found) throw new Error(`${name} not found`);
	symlinkSync(found, join(toolDir, name));
}

mkdirSync(toolDir, { recursive: true });
linkTool("dirname");
linkTool("cat");

afterAll(() => {
	rmSync(base, { recursive: true, force: true });
});

describe("bin/kata shim in real shells", () => {
	const hostEnv: Env = { PATH: toolDir };
	const host = new ShimHost(hostEnv, { tmpRoot: base });
	const stateDir = host.install(fakeA);
	const shimBin = join(stateDir, "bin");

	host.writeIdentity("main", MAIN_ID, undefined);
	host.writeIdentity("sub", BOB_ID, undefined);
	host.writeIdentity("withreal", MAIN_ID, fakeA);

	afterAll(() => host.dispose());

	/** The environment omp's bash tool would hand the shim: a PATH of only the dirs given plus PI_SESSION_ID. */
	function envFor(pathDirs: string[], extra: Record<string, string | undefined> = {}): Record<string, string> {
		const env: Record<string, string | undefined> = {
			PATH: pathDirs.join(":"),
			PI_SESSION_ID: "main",
			OMP_KATA_STATE_DIR: stateDir,
			...extra,
		};
		return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));
	}

	const standard = (extra: Record<string, string | undefined> = {}) => envFor([shimBin, fakeADir, toolDir], extra);

	for (const shell of availableShells()) {
		describe(shell.name, () => {
			test("state file present: the session identity is applied", () => {
				expect(run(shell, "kata claim x", { env: standard() })).toEqual({
					code: 0,
					stdout: seen("A", "adam", "UNSET", "adam", "claim", "x"),
					stderr: "",
				});
				expect(run(shell, "kata claim x", { env: standard({ PI_SESSION_ID: "sub" }) }).stdout).toBe(
					seen("A", "adam", "bob", "adam/bob", "claim", "x"),
				);
			});

			test("state file absent: pass-through, ambient identity untouched", () => {
				const env = standard({ PI_SESSION_ID: "nobody", KATA_AUTHOR: "ambient", KATA_TEAMMATE: "amb", KATA_INBOX_USER: "ambu" });
				expect(run(shell, "kata x", { env }).stdout).toBe(seen("A", "ambient", "amb", "ambu", "x"));
			});

			test("empty or unset PI_SESSION_ID, or no state dir: pass-through (even if `.env` exists)", () => {
				writeFileSync(join(stateDir, ".env"), "KATA_AUTHOR=wrong; export KATA_AUTHOR\n");
				try {
					const ambient = { KATA_AUTHOR: "ambient", KATA_TEAMMATE: "amb", KATA_INBOX_USER: "ambu" };
					const expected = seen("A", "ambient", "amb", "ambu", "x");
					expect(run(shell, "kata x", { env: standard({ ...ambient, PI_SESSION_ID: "" }) }).stdout).toBe(expected);
					expect(run(shell, "kata x", { env: standard({ ...ambient, PI_SESSION_ID: undefined }) }).stdout).toBe(expected);
					expect(run(shell, "kata x", { env: standard({ ...ambient, OMP_KATA_STATE_DIR: undefined }) }).stdout).toBe(expected);
				} finally {
					rmSync(join(stateDir, ".env"), { force: true });
				}
			});

			test("a PI_SESSION_ID containing '/' never reads outside (or below) the state dir", () => {
				const evil = "KATA_AUTHOR=evil; export KATA_AUTHOR\n";
				writeFileSync(join(base, "x.env"), evil);
				mkdirSync(join(stateDir, "a"), { recursive: true });
				writeFileSync(join(stateDir, "a", "b.env"), evil);
				try {
					const ambient = { KATA_AUTHOR: "ambient", KATA_TEAMMATE: "amb", KATA_INBOX_USER: "ambu" };
					for (const id of ["../x", "a/b", `${stateDir}/../x`]) {
						// `<base>/x.env` and `<state>/a/b.env` do exist and would set KATA_AUTHOR=evil
						expect(run(shell, "kata x", { env: standard({ ...ambient, PI_SESSION_ID: id }) }).stdout).toBe(
							seen("A", "ambient", "amb", "ambu", "x"),
						);
					}
				} finally {
					rmSync(join(base, "x.env"), { force: true });
					rmSync(join(stateDir, "a"), { recursive: true, force: true });
				}
			});

			test("two session ids in one state dir get two identities", () => {
				const command = "kata one";
				const mainOut = run(shell, command, { env: standard({ PI_SESSION_ID: "main" }) }).stdout;
				const subOut = run(shell, command, { env: standard({ PI_SESSION_ID: "sub" }) }).stdout;
				expect([mainOut, subOut]).toEqual([seen("A", "adam", "UNSET", "adam", "one"), seen("A", "adam", "bob", "adam/bob", "one")]);
			});

			test("a model-authored export cannot override the session identity", () => {
				const command = `${MODEL_OVERRIDE}kata claim x`;
				expect(run(shell, command, { env: standard() }).stdout).toBe(seen("A", "adam", "UNSET", "adam", "claim", "x"));
				expect(run(shell, command, { env: standard({ PI_SESSION_ID: "sub" }) }).stdout).toBe(
					seen("A", "adam", "bob", "adam/bob", "claim", "x"),
				);
			});

			test("a teammate-less identity unsets an inherited KATA_TEAMMATE", () => {
				const env = standard({ KATA_TEAMMATE: "leaked", KATA_AUTHOR: "stale", KATA_INBOX_USER: "stale" });
				expect(run(shell, "kata x", { env }).stdout).toBe(seen("A", "adam", "UNSET", "adam", "x"));
			});

			test("shim first on PATH, real kata later: no self recursion", () => {
				const result = run(shell, "kata x", { env: standard() });
				expect(result.code).toBe(0);
				expect(result.stdout.startsWith("A:")).toBe(true);
			});

			test("no recursion with relative '.' or empty PATH entries", () => {
				// cwd is the shim's own directory, reached through `.`
				const dot = envFor([".", fakeADir, toolDir]);
				expect(run(shell, "kata x", { cwd: shimBin, env: dot }).stdout).toBe(seen("A", "adam", "UNSET", "adam", "x"));
				// an empty entry also means the current directory
				const empty = envFor(["", fakeADir, toolDir]);
				expect(run(shell, "kata x", { cwd: shimBin, env: empty }).stdout).toBe(seen("A", "adam", "UNSET", "adam", "x"));
				// `.` after the shim dir, in a directory without kata
				const later = envFor([shimBin, ".", fakeADir, toolDir]);
				expect(run(shell, "kata x", { cwd: base, env: later }).stdout).toBe(seen("A", "adam", "UNSET", "adam", "x"));
			});

			test("shim reached through a symlinked directory is still skipped by the PATH scan", () => {
				const link = join(base, `shim-link-${shell.name}`);
				symlinkSync(shimBin, link);
				try {
					const env = envFor([link, fakeADir, toolDir]);
					expect(run(shell, "kata x", { env }).stdout).toBe(seen("A", "adam", "UNSET", "adam", "x"));
				} finally {
					rmSync(link, { force: true });
				}
			});

			test("OMP_KATA_REAL is honored over the PATH", () => {
				expect(run(shell, "kata x", { env: standard({ OMP_KATA_REAL: fakeB }) }).stdout).toBe(seen("B", "adam", "UNSET", "adam", "x"));
			});

			test("OMP_KATA_REAL from the identity file wins over the environment's", () => {
				const env = standard({ PI_SESSION_ID: "withreal", OMP_KATA_REAL: fakeB });
				expect(run(shell, "kata x", { env }).stdout).toBe(seen("A", "adam", "UNSET", "adam", "x"));
			});

			test("OMP_KATA_REAL missing, non-executable or a directory falls back to the PATH search", () => {
				const plain = join(base, "not-executable");
				writeFileSync(plain, "#!/bin/sh\necho wrong\n");
				chmodSync(plain, 0o644);
				for (const bad of [join(base, "does-not-exist"), plain, fakeADir]) {
					expect({ bad, out: run(shell, "kata x", { env: standard({ OMP_KATA_REAL: bad }) }).stdout }).toEqual({
						bad,
						out: seen("A", "adam", "UNSET", "adam", "x"),
					});
				}
			});

			test("no real kata anywhere: exit 127 with the explanatory message", () => {
				const env = envFor([shimBin, toolDir]);
				expect(run(shell, "kata x", { env })).toEqual({
					code: 127,
					stdout: "",
					stderr: "kata: omp-kata shim could not find the real kata executable on PATH\n",
				});
			});

			test("arguments survive byte-exact (spaces, quotes, empty strings, flags, globs, expansions)", () => {
				const command = `kata 'a b' "it's" '' -m --flag='x y' '$HOME' '*' '-' 'a\\b'`;
				expect(run(shell, command, { env: standard() }).stdout).toBe(
					seen("A", "adam", "UNSET", "adam", "a b", "it's", "", "-m", "--flag=x y", "$HOME", "*", "-", "a\\b"),
				);
			});

			test("exit codes pass through", () => {
				for (const code of [0, 3, 8]) {
					expect({ code, got: run(shell, "kata x", { env: standard({ FAKE_EXIT: String(code) }) }).code }).toEqual({ code, got: code });
				}
			});

			test("stdin passes through", () => {
				expect(run(shell, "echo hi | kata --stdin", { env: standard() }).stdout).toBe("A:stdin=hi");
			});
		});
	}
});

describe("ShimHost", () => {
	const hosts: ShimHost[] = [];
	const roots: string[] = [];

	function newHost(env: Env, shimSource?: string): { host: ShimHost; tmpRoot: string } {
		const tmpRoot = tempDir("omp-kata-hostroot-");
		roots.push(tmpRoot);
		const host = new ShimHost(env, { tmpRoot, shimSource });
		hosts.push(host);
		return { host, tmpRoot };
	}

	afterEach(() => {
		for (const host of hosts.splice(0)) host.dispose();
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	test("install creates a 0700 state dir with a 0700 bin dir holding a 0755 copy of the shim", () => {
		const env: Env = { PATH: "/a:/b" };
		const { host, tmpRoot } = newHost(env);
		const stateDir = host.install("/real/kata");
		expect(readdirSync(tmpRoot)).toEqual([stateDir.slice(tmpRoot.length + 1)]);
		expect(stateDir.slice(tmpRoot.length + 1).startsWith("omp-kata-")).toBe(true);
		expect(mode(stateDir)).toBe(0o700);
		expect(mode(join(stateDir, "bin"))).toBe(0o700);
		expect(mode(join(stateDir, "bin", "kata"))).toBe(0o755);
		expect(readFileSync(join(stateDir, "bin", "kata"), "utf8")).toBe(readFileSync(SHIM_SOURCE, "utf8"));
	});

	test("install exports OMP_KATA_STATE_DIR and OMP_KATA_REAL into the given env only", () => {
		const env: Env = { PATH: "/a" };
		const before = { state: process.env.OMP_KATA_STATE_DIR, real: process.env.OMP_KATA_REAL, path: process.env.PATH };
		const { host } = newHost(env);
		const stateDir = host.install("/real/kata");
		expect(env.OMP_KATA_STATE_DIR).toBe(stateDir);
		expect(env.OMP_KATA_REAL).toBe("/real/kata");
		expect({ state: process.env.OMP_KATA_STATE_DIR, real: process.env.OMP_KATA_REAL, path: process.env.PATH }).toEqual(before);
	});

	test("install is idempotent: three installs put the shim dir on PATH exactly once, others kept in order", () => {
		const env: Env = { PATH: "/a:/b:/c" };
		const { host } = newHost(env);
		const first = host.install("/real/kata");
		host.install("/real/kata");
		const third = host.install("/other/kata");
		expect(third).toBe(first);
		expect((env.PATH ?? "").split(":")).toEqual([join(first, "bin"), "/a", "/b", "/c"]);
		expect(env.OMP_KATA_REAL).toBe("/other/kata");
	});

	test("a custom shimSource is what gets copied", () => {
		const srcDir = tempDir("omp-kata-src-");
		roots.push(srcDir);
		const source = join(srcDir, "custom-shim");
		writeFileSync(source, "#!/bin/sh\necho custom\n");
		const { host } = newHost({ PATH: "" }, source);
		const stateDir = host.install("/real/kata");
		expect(readFileSync(join(stateDir, "bin", "kata"), "utf8")).toBe("#!/bin/sh\necho custom\n");
	});

	describe("resolveReal", () => {
		test("a path containing a slash is returned unchanged, even if it does not exist", () => {
			const { host } = newHost({ PATH: "/a" });
			for (const exe of ["/opt/k/kata", "./kata", "rel/kata", "/does/not/exist"]) expect(host.resolveReal(exe)).toBe(exe);
		});

		test("a bare name is found on PATH but never inside the shim dir", () => {
			const realDir = join(base, "resolve-real");
			const real = writeFake(realDir, "R");
			const env: Env = { PATH: `${realDir}::${toolDir}` };
			const { host } = newHost(env);
			host.install(real);
			// the shim dir is first on PATH and holds a `kata` of its own; it must be skipped
			expect(host.resolveReal("kata")).toBe(real);
		});

		test("when only the shim provides kata, the bare name comes back unresolved", () => {
			const env: Env = { PATH: toolDir };
			const { host } = newHost(env);
			host.install("kata");
			expect(host.resolveReal("kata")).toBe("kata");
		});
	});

	describe("identity files", () => {
		const nasty: Identity = { actor: "o'brien $x", teammate: "line1\nline2 `id` $(y) \"q\"", inboxUser: "o'brien $x/t" };

		test("renderIdentityFile: exact text for teammate-less, teammate and no real executable", () => {
			expect(renderIdentityFile(MAIN_ID, "/opt/k/kata")).toBe(
				"KATA_AUTHOR=adam; export KATA_AUTHOR\nunset KATA_TEAMMATE\nKATA_INBOX_USER=adam; export KATA_INBOX_USER\nOMP_KATA_REAL=/opt/k/kata; export OMP_KATA_REAL\n",
			);
			expect(renderIdentityFile(BOB_ID, undefined)).toBe(
				"KATA_AUTHOR=adam; export KATA_AUTHOR\nKATA_TEAMMATE=bob; export KATA_TEAMMATE\nKATA_INBOX_USER=adam/bob; export KATA_INBOX_USER\n",
			);
			expect(renderIdentityFile(MAIN_ID, "/opt/my k/kata")).toContain("OMP_KATA_REAL='/opt/my k/kata'; export OMP_KATA_REAL\n");
		});

		test("rendered files sourced by a real sh reproduce nasty values byte-exact", () => {
			const { host } = newHost({ PATH: toolDir });
			host.install("kata");
			host.writeIdentity("nasty", nasty, "/opt/my k/ka'ta");
			const file = host.identityPath("nasty") as string;
			const sourced = Bun.spawnSync(
				[SH, "-c", '. "$1"; printf "%s|%s|%s|%s" "$KATA_AUTHOR" "$KATA_TEAMMATE" "$KATA_INBOX_USER" "$OMP_KATA_REAL"', "sh", file],
				{ env: { PATH: toolDir } },
			);
			expect(sourced.stdout.toString()).toBe(`${nasty.actor}|${nasty.teammate}|${nasty.inboxUser}|/opt/my k/ka'ta`);
		});

		test("a teammate-less file unsets KATA_TEAMMATE when sourced", () => {
			const { host } = newHost({ PATH: toolDir });
			host.install("kata");
			host.writeIdentity("m", MAIN_ID, undefined);
			const sourced = Bun.spawnSync([SH, "-c", '. "$1"; printf "%s" "${KATA_TEAMMATE-unset}"', "sh", host.identityPath("m") as string], {
				env: { PATH: toolDir, KATA_TEAMMATE: "inherited" },
			});
			expect(sourced.stdout.toString()).toBe("unset");
		});

		test("writeIdentity writes the exact rendered text with mode 0600 into <state>/<id>.env", () => {
			const { host } = newHost({ PATH: toolDir });
			const stateDir = host.install("/real/kata");
			host.writeIdentity("s1", BOB_ID, "/real/kata");
			const file = join(stateDir, "s1.env");
			expect(host.identityPath("s1")).toBe(file);
			expect(readFileSync(file, "utf8")).toBe(renderIdentityFile(BOB_ID, "/real/kata"));
			expect(mode(file)).toBe(0o600);
		});

		test("writeIdentity overwrites in place and leaves no temp files behind", () => {
			const { host } = newHost({ PATH: toolDir });
			const stateDir = host.install("/real/kata");
			host.writeIdentity("s1", MAIN_ID, undefined);
			host.writeIdentity("s1", BOB_ID, undefined);
			host.writeIdentity("s2", MAIN_ID, undefined);
			expect(readFileSync(join(stateDir, "s1.env"), "utf8")).toBe(renderIdentityFile(BOB_ID, undefined));
			expect(readdirSync(stateDir).sort()).toEqual(["bin", "s1.env", "s2.env"]);
		});

		test("writeIdentity before install creates the state dir lazily", () => {
			const { host, tmpRoot } = newHost({ PATH: toolDir });
			expect(host.identityPath("s1")).toBeUndefined();
			host.writeIdentity("s1", MAIN_ID, undefined);
			expect(readdirSync(tmpRoot)).toHaveLength(1);
			expect(existsSync(host.identityPath("s1") as string)).toBe(true);
		});

		test("removeIdentity deletes only that session's file and tolerates unknown ids", () => {
			const { host } = newHost({ PATH: toolDir });
			host.removeIdentity("before-anything");
			host.install("/real/kata");
			host.writeIdentity("s1", MAIN_ID, undefined);
			host.writeIdentity("s2", BOB_ID, undefined);
			host.removeIdentity("s1");
			host.removeIdentity("never-existed");
			expect(existsSync(host.identityPath("s1") as string)).toBe(false);
			expect(existsSync(host.identityPath("s2") as string)).toBe(true);
		});
	});

	test("dispose removes the state dir, the shim and every identity file; a second dispose is harmless", () => {
		const { host, tmpRoot } = newHost({ PATH: toolDir });
		const stateDir = host.install("/real/kata");
		host.writeIdentity("s1", MAIN_ID, undefined);
		host.dispose();
		expect(existsSync(stateDir)).toBe(false);
		expect(readdirSync(tmpRoot)).toEqual([]);
		host.dispose();
	});
});

describe("shim with real kata", () => {
	const rk = new RealKata("unit-actor");
	const hostEnv: Env = { PATH: toolDir };
	const host = new ShimHost(hostEnv, { tmpRoot: base });
	const actorId: Identity = { actor: "unit-actor", teammate: "", inboxUser: "unit-actor" };
	const bobId: Identity = { actor: "unit-actor", teammate: "bob", inboxUser: "unit-actor/bob" };
	let ref = "";
	let stateDir = "";

	beforeAll(async () => {
		await rk.init();
		ref = await rk.createIssue("shim identity");
		stateDir = host.install(REAL_KATA);
		host.writeIdentity("with-bob", bobId, REAL_KATA);
		host.writeIdentity("no-teammate", actorId, REAL_KATA);
	}, 60_000);

	afterAll(async () => {
		host.dispose();
		await rk.cleanup();
	}, 60_000);

	interface CommentJson {
		comment: { author: string; teammate?: string; body: string };
	}

	/** Shim dir first on PATH, real kata reachable only through OMP_KATA_REAL (as the extension sets it). */
	function comment(shell: Shell, sessionId: string, prefix: string, ambient: Record<string, string> = {}): CommentJson {
		const env: Record<string, string> = {
			PATH: `${join(stateDir, "bin")}:${toolDir}`,
			HOME: rk.base,
			KATA_HOME: rk.home,
			PI_SESSION_ID: sessionId,
			OMP_KATA_STATE_DIR: stateDir,
			...ambient,
		};
		const result = run(shell, `${prefix}kata comment ${ref} -m x --json`, { cwd: rk.root, env });
		expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
		return JSON.parse(result.stdout) as CommentJson;
	}

	for (const shell of availableShells()) {
		test(`${shell.name}: a teammate session records the comment as that teammate, even after a model-authored export`, () => {
			const { comment: recorded } = comment(shell, "with-bob", MODEL_OVERRIDE);
			expect({ author: recorded.author, teammate: recorded.teammate, body: recorded.body }).toEqual({
				author: "unit-actor",
				teammate: "bob",
				body: "x",
			});
		}, 30_000);

		test(`${shell.name}: a teammate-less session records no teammate, even with an inherited KATA_TEAMMATE and a model-authored export`, () => {
			const { comment: recorded } = comment(shell, "no-teammate", MODEL_OVERRIDE, { KATA_TEAMMATE: "leaked" });
			expect(recorded.author).toBe("unit-actor");
			expect(recorded.teammate).toBeUndefined();
		}, 30_000);
	}
});
