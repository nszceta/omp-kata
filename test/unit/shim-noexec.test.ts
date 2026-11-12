import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { ShimHost, ShimUnavailableError } from "../../src/shim";
import { bashCall, loadExtension, tempDir } from "./helpers";
import { HOST_PID, prompt, Rig } from "./extension-harness";

/** Probe that reports every shim under a root in `blocked` as non-executable, like a noexec mount. */
const noexecUnder =
	(...blocked: string[]) =>
	(path: string) =>
		!blocked.some(root => path.startsWith(`${root}/`));

describe("ShimHost root selection", () => {
	const hosts: ShimHost[] = [];
	const roots: string[] = [];
	const newRoot = (): string => {
		const root = tempDir("omp-kata-noexec-");
		roots.push(root);
		return root;
	};
	const newHost = (env: Record<string, string | undefined>, options: ConstructorParameters<typeof ShimHost>[1]): ShimHost => {
		const host = new ShimHost(env, options);
		hosts.push(host);
		return host;
	};

	afterEach(() => {
		for (const host of hosts.splice(0)) host.dispose();
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	test("a first root where the shim cannot execute is cleaned up and the second root is used", () => {
		const first = newRoot();
		const second = newRoot();
		const env = { PATH: "/usr/bin" };
		const host = newHost(env, { tmpRoot: [first, second], canExecute: noexecUnder(first) });

		const stateDir = host.install("/real/kata");

		expect(stateDir.startsWith(`${second}/omp-kata-${process.pid}-`)).toBe(true);
		expect(readdirSync(first)).toEqual([]);
		expect(statSync(join(stateDir, "bin", "kata")).isFile()).toBe(true);
		expect(env.PATH.split(":")[0]).toBe(join(stateDir, "bin"));
		host.writeIdentity("s1", { actor: "adam", teammate: "", inboxUser: "adam" }, "/real/kata");
		expect(existsSync(join(stateDir, "s1.env"))).toBe(true);
		expect(host.takeFailureNotice()).toBeUndefined();
	});

	test("the first root wins when its shim can execute, and the second is never touched", () => {
		const first = newRoot();
		const second = newRoot();
		const host = newHost({ PATH: "/usr/bin" }, { tmpRoot: [first, second] });

		const stateDir = host.install("/real/kata");

		expect(stateDir.startsWith(`${first}/`)).toBe(true);
		expect(readdirSync(second)).toEqual([]);
	});

	test("stale state dirs are swept in the root actually used, not in a rejected one", () => {
		const first = newRoot();
		const second = newRoot();
		// pid 2^22+ is above Linux's default pid_max, so these cannot belong to a live process.
		const stale = "omp-kata-4194303-abcdef";
		for (const root of [first, second]) mkdirSync(join(root, stale));
		const host = newHost({ PATH: "/usr/bin" }, { tmpRoot: [first, second], canExecute: noexecUnder(first) });

		host.install("/real/kata");

		expect(existsSync(join(first, stale))).toBe(true);
		expect(existsSync(join(second, stale))).toBe(false);
	});

	test("no root passes the probe: install throws, nothing is left behind, PATH and prefix stay untouched", () => {
		const first = newRoot();
		const second = newRoot();
		const env: Record<string, string | undefined> = { PATH: "/usr/bin" };
		const host = newHost(env, { tmpRoot: [first, second], canExecute: () => false });

		expect(() => host.install("/real/kata")).toThrow(ShimUnavailableError);
		expect(() => host.writeIdentity("s1", { actor: "a", teammate: "", inboxUser: "a" }, undefined)).toThrow(ShimUnavailableError);

		expect(readdirSync(first)).toEqual([]);
		expect(readdirSync(second)).toEqual([]);
		expect(env).toEqual({ PATH: "/usr/bin" });
	});

	test("the failure notice names every root tried and is handed out exactly once", () => {
		const first = newRoot();
		const second = newRoot();
		const host = newHost({ PATH: "/usr/bin" }, { tmpRoot: [first, second], canExecute: () => false });

		expect(host.takeFailureNotice()).toBeUndefined();
		expect(() => host.install("/real/kata")).toThrow();
		expect(() => host.install("/real/kata")).toThrow();

		const notice = host.takeFailureNotice();
		expect(notice).toContain("identity disabled");
		expect(notice).toContain(first);
		expect(notice).toContain(second);
		expect(host.takeFailureNotice()).toBeUndefined();
	});

	test("XDG_RUNTIME_DIR is tried before the OS temp dir", () => {
		const runtime = newRoot();
		const host = newHost({ PATH: "/usr/bin", XDG_RUNTIME_DIR: runtime }, {});

		const stateDir = host.install("/real/kata");

		expect(stateDir.startsWith(`${runtime}/omp-kata-`)).toBe(true);
	});

	test("a runtime dir open to group or others is skipped for the OS temp dir", () => {
		const runtime = newRoot();
		const tmp = newRoot();
		const original = process.env.TMPDIR;
		process.env.TMPDIR = tmp;
		try {
			for (const mode of [0o770, 0o707, 0o755, 0o777]) {
				chmodSync(runtime, mode);
				const host = newHost({ PATH: "/usr/bin", XDG_RUNTIME_DIR: runtime }, {});
				expect(host.install("/real/kata").startsWith(`${tmp}/`)).toBe(true);
				expect(readdirSync(runtime)).toEqual([]);
				host.dispose();
			}
		} finally {
			if (original === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = original;
		}
	});

	test("a symlinked or missing runtime dir is skipped for the OS temp dir", () => {
		const real = newRoot();
		const tmp = newRoot();
		const link = join(tmp, "run-link");
		symlinkSync(real, link);
		const original = process.env.TMPDIR;
		process.env.TMPDIR = tmp;
		try {
			for (const runtime of [link, `${link}/`, join(tmp, "missing")]) {
				const host = newHost({ PATH: "/usr/bin", XDG_RUNTIME_DIR: runtime }, {});
				expect(host.install("/real/kata").startsWith(`${tmp}/omp-kata-`)).toBe(true);
				host.dispose();
			}
			expect(readdirSync(real)).toEqual([]);
		} finally {
			if (original === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = original;
		}
	});

	test("a relative XDG_RUNTIME_DIR is ignored", () => {
		const host = newHost({ PATH: "/usr/bin", XDG_RUNTIME_DIR: "relative/run" }, {});

		const stateDir = host.install("/real/kata");

		expect(stateDir.startsWith("relative/")).toBe(false);
	});

	test("a root that cannot be written to is skipped like a noexec one", () => {
		const second = newRoot();
		const host = newHost({ PATH: "/usr/bin" }, { tmpRoot: ["/nonexistent/omp-kata-root", second] });

		expect(host.install("/real/kata").startsWith(`${second}/`)).toBe(true);
	});
});

describe("identity disabled warning in a session", () => {
	let rig: Rig;
	beforeEach(() => {
		rig = new Rig();
	});
	afterEach(() => rig.dispose());

	test("a session without a UI hitting the failure does not consume the warning", async () => {
		const root = tempDir("omp-kata-noexec-");
		const shim = new ShimHost({ PATH: process.env.PATH }, { tmpRoot: root, canExecute: () => false });
		try {
			const deps = { env: rig.env(), loadSettings: async () => ({}), now: () => rig.time, hostPid: HOST_PID, shim };
			const sub = await loadExtension(deps);
			const subCtx = rig.session({ hasUI: false });
			await sub.emit("session_start", {}, subCtx);
			await prompt(sub, subCtx);
			expect(subCtx.notifications).toEqual([]);

			const main = await loadExtension(deps);
			const mainCtx = rig.session({ hasUI: true });
			await main.emit("session_start", {}, mainCtx);
			await prompt(main, mainCtx);
			expect(mainCtx.notifications.filter(n => n.level === "warning" && n.message.includes("identity disabled"))).toHaveLength(1);
		} finally {
			shim.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("one warning in total across prompts and bash calls, and commands still run", async () => {
		const root = tempDir("omp-kata-noexec-");
		const env: Record<string, string | undefined> = { PATH: process.env.PATH };
		const shim = new ShimHost(env, { tmpRoot: root, canExecute: () => false });
		try {
			const host = await loadExtension({
				env: rig.env(),
				loadSettings: async () => ({}),
				now: () => rig.time,
				hostPid: HOST_PID,
				shim,
			});
			const ctx = rig.session({ hasUI: true });
			await host.emit("session_start", {}, ctx);
			await prompt(host, ctx);
			expect(await host.emitOne("tool_call", bashCall("kata list"), ctx)).toBeUndefined();
			await prompt(host, ctx);
			expect(await host.emitOne("tool_call", bashCall("kata list"), ctx)).toBeUndefined();

			const warnings = ctx.notifications.filter(n => n.level === "warning" && n.message.includes("identity disabled"));
			expect(warnings).toHaveLength(1);
			expect(env.PI_SHELL_PREFIX).toBeUndefined();
			expect(env.OMP_KATA_STATE_DIR).toBeUndefined();
			expect(readdirSync(root)).toEqual([]);
		} finally {
			shim.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
