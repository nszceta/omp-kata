import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	DEFAULT_SETTINGS,
	ENV_NAMES,
	type Env,
	type KataSettings,
	loadPluginSettings,
	parseBoolean,
	parseNonNegativeNumber,
	resolveSettings,
	type SettingsLoader,
} from "../../src/config";

const loaderOf =
	(stored: Record<string, unknown>): SettingsLoader =>
	async () =>
		stored;

const resolveWith = (env: Env, stored: Record<string, unknown> = {}): Promise<KataSettings> =>
	resolveSettings("/cwd", { env, loader: loaderOf(stored) });

describe("defaults and names", () => {
	test("nothing configured yields exactly the defaults", async () => {
		expect(await resolveWith({})).toEqual({
			executable: "kata",
			contract: true,
			contractSource: "",
			inbox: true,
			inboxPollSeconds: 15,
			wakeOnInbox: false,
			attention: true,
			identity: true,
		});
	});

	test("ENV_NAMES are exactly the documented OMP_KATA_* variables", () => {
		expect(ENV_NAMES).toEqual({
			executable: "OMP_KATA_EXECUTABLE",
			contract: "OMP_KATA_CONTRACT",
			contractSource: "OMP_KATA_CONTRACT_SOURCE",
			inbox: "OMP_KATA_INBOX",
			inboxPollSeconds: "OMP_KATA_INBOX_POLL_SECONDS",
			wakeOnInbox: "OMP_KATA_WAKE_ON_INBOX",
			attention: "OMP_KATA_ATTENTION",
			identity: "OMP_KATA_IDENTITY",
		});
	});

	test("every env var is actually read under its documented name", async () => {
		const env: Env = {
			OMP_KATA_EXECUTABLE: "/e/kata",
			OMP_KATA_CONTRACT: "false",
			OMP_KATA_CONTRACT_SOURCE: "c.md",
			OMP_KATA_INBOX: "false",
			OMP_KATA_INBOX_POLL_SECONDS: "3",
			OMP_KATA_WAKE_ON_INBOX: "true",
			OMP_KATA_ATTENTION: "false",
			OMP_KATA_IDENTITY: "false",
		};
		expect(await resolveWith(env)).toEqual({
			executable: "/e/kata",
			contract: false,
			contractSource: "c.md",
			inbox: false,
			inboxPollSeconds: 3,
			wakeOnInbox: true,
			attention: false,
			identity: false,
		});
	});
});

describe("precedence env > plugin settings > defaults", () => {
	const stored: Record<string, unknown> = {
		executable: "/p/kata",
		contract: false,
		contractSource: "p.md",
		inbox: false,
		inboxPollSeconds: 7,
		wakeOnInbox: true,
		attention: false,
		identity: false,
	};

	test("plugin settings override defaults", async () => {
		const result = Object.fromEntries(Object.entries(await resolveWith({}, stored)));
		expect(result).toEqual(stored);
	});

	test("env overrides plugin settings key by key", async () => {
		const result = await resolveWith(
			{
				OMP_KATA_EXECUTABLE: "/e/kata",
				OMP_KATA_CONTRACT: "true",
				OMP_KATA_CONTRACT_SOURCE: "e.md",
				OMP_KATA_INBOX: "1",
				OMP_KATA_INBOX_POLL_SECONDS: "0",
				OMP_KATA_WAKE_ON_INBOX: "0",
				OMP_KATA_ATTENTION: "true",
				OMP_KATA_IDENTITY: "true",
			},
			stored,
		);
		expect(result).toEqual({
			executable: "/e/kata",
			contract: true,
			contractSource: "e.md",
			inbox: true,
			inboxPollSeconds: 0,
			wakeOnInbox: false,
			attention: true,
			identity: true,
		});
	});

	test("a key set in only one source does not disturb the others", async () => {
		const result = await resolveWith({ OMP_KATA_INBOX: "false" }, { inboxPollSeconds: 40 });
		expect(result).toEqual({ ...DEFAULT_SETTINGS, inbox: false, inboxPollSeconds: 40 });
	});
});

describe("boolean coercion", () => {
	test("parseBoolean accepts true/false/1/0 case-insensitively with whitespace", () => {
		for (const raw of ["true", "TRUE", "True", "1", " true ", true, 1]) expect(parseBoolean(raw)).toBe(true);
		for (const raw of ["false", "FALSE", "False", "0", " 0\n", false, 0]) expect(parseBoolean(raw)).toBe(false);
	});

	test("parseBoolean rejects everything else", () => {
		for (const raw of ["yes", "no", "", "2", "on", 2, -1, null, undefined, {}, []]) expect(parseBoolean(raw)).toBeUndefined();
	});

	test("env value drives resolveSettings", async () => {
		expect((await resolveWith({ OMP_KATA_CONTRACT: "FALSE" })).contract).toBe(false);
		expect((await resolveWith({ OMP_KATA_WAKE_ON_INBOX: "1" })).wakeOnInbox).toBe(true);
	});

	test("an invalid env value falls through to the plugin setting, not the default", async () => {
		expect((await resolveWith({ OMP_KATA_CONTRACT: "maybe" }, { contract: false })).contract).toBe(false);
		expect((await resolveWith({ OMP_KATA_WAKE_ON_INBOX: "" }, { wakeOnInbox: true })).wakeOnInbox).toBe(true);
	});

	test("an invalid plugin value falls through to the default", async () => {
		expect((await resolveWith({}, { contract: "maybe" })).contract).toBe(true);
		expect((await resolveWith({}, { wakeOnInbox: { x: 1 } })).wakeOnInbox).toBe(false);
		expect((await resolveWith({ OMP_KATA_ATTENTION: "nope" }, { attention: 7 })).attention).toBe(true);
	});

	test("the plugin value may be the string \"false\" (CLI-stored settings)", async () => {
		const result = await resolveWith({}, { contract: "false", inbox: "0", wakeOnInbox: "true", attention: "FALSE" });
		expect(result.contract).toBe(false);
		expect(result.inbox).toBe(false);
		expect(result.wakeOnInbox).toBe(true);
		expect(result.attention).toBe(false);
	});
});

describe("inboxPollSeconds", () => {
	test("parseNonNegativeNumber: valid values", () => {
		expect(parseNonNegativeNumber(0)).toBe(0);
		expect(parseNonNegativeNumber("0")).toBe(0);
		expect(parseNonNegativeNumber(2.5)).toBe(2.5);
		expect(parseNonNegativeNumber(" 30 ")).toBe(30);
		expect(parseNonNegativeNumber("1e2")).toBe(100);
	});

	test("parseNonNegativeNumber: negative, NaN, infinite, blank and non-numbers are rejected", () => {
		for (const raw of [-1, "-5", Number.NaN, "NaN", "abc", "Infinity", Number.POSITIVE_INFINITY, "", "  ", true, null, undefined, {}, []]) {
			expect(parseNonNegativeNumber(raw)).toBeUndefined();
		}
	});

	test("numeric env string is used; 0 is a valid explicit value", async () => {
		expect((await resolveWith({ OMP_KATA_INBOX_POLL_SECONDS: "30" })).inboxPollSeconds).toBe(30);
		expect((await resolveWith({ OMP_KATA_INBOX_POLL_SECONDS: "0" }, { inboxPollSeconds: 9 })).inboxPollSeconds).toBe(0);
		expect((await resolveWith({}, { inboxPollSeconds: 0 })).inboxPollSeconds).toBe(0);
	});

	test("negative or NaN env falls through to plugin, then default", async () => {
		expect((await resolveWith({ OMP_KATA_INBOX_POLL_SECONDS: "-5" }, { inboxPollSeconds: 9 })).inboxPollSeconds).toBe(9);
		expect((await resolveWith({ OMP_KATA_INBOX_POLL_SECONDS: "NaN" })).inboxPollSeconds).toBe(15);
		expect((await resolveWith({ OMP_KATA_INBOX_POLL_SECONDS: "" })).inboxPollSeconds).toBe(15);
	});

	test("invalid plugin values fall to the default", async () => {
		for (const bad of [-1, "abc", true, null, Number.NaN, {}]) {
			expect((await resolveWith({}, { inboxPollSeconds: bad })).inboxPollSeconds).toBe(15);
		}
	});

	test("plugin value may be a numeric string", async () => {
		expect((await resolveWith({}, { inboxPollSeconds: "12" })).inboxPollSeconds).toBe(12);
	});
});

describe("identity setting", () => {
	test("defaults to true and is switched off by env or plugin setting", async () => {
		expect((await resolveWith({})).identity).toBe(true);
		expect((await resolveWith({ OMP_KATA_IDENTITY: "false" })).identity).toBe(false);
		expect((await resolveWith({}, { identity: "0" })).identity).toBe(false);
	});

	test("env beats the plugin setting; an unparsable env value falls through to it", async () => {
		expect((await resolveWith({ OMP_KATA_IDENTITY: "1" }, { identity: false })).identity).toBe(true);
		expect((await resolveWith({ OMP_KATA_IDENTITY: "off" }, { identity: false })).identity).toBe(false);
		expect((await resolveWith({}, { identity: "off" })).identity).toBe(true);
	});
});

describe("string settings", () => {
	test("blank executable falls through; value is trimmed", async () => {
		expect((await resolveWith({ OMP_KATA_EXECUTABLE: "   " }, { executable: "/p/kata" })).executable).toBe("/p/kata");
		expect((await resolveWith({ OMP_KATA_EXECUTABLE: " /opt/kata " })).executable).toBe("/opt/kata");
		expect((await resolveWith({}, { executable: "  " })).executable).toBe("kata");
		expect((await resolveWith({}, { executable: 5 })).executable).toBe("kata");
	});

	test("an empty contractSource env var is an explicit value that overrides the plugin setting", async () => {
		expect((await resolveWith({ OMP_KATA_CONTRACT_SOURCE: "" }, { contractSource: "p.md" })).contractSource).toBe("");
	});

	test("contractSource is trimmed; a non-string plugin value falls to the default", async () => {
		expect((await resolveWith({ OMP_KATA_CONTRACT_SOURCE: "  c.md  " })).contractSource).toBe("c.md");
		expect((await resolveWith({}, { contractSource: 3 })).contractSource).toBe("");
	});
});

describe("settings loader", () => {
	test("a loader that rejects yields defaults (env still applies)", async () => {
		const loader: SettingsLoader = async () => {
			throw new Error("storage unreadable");
		};
		expect(await resolveSettings("/cwd", { env: {}, loader })).toEqual({ ...DEFAULT_SETTINGS });
		expect(await resolveSettings("/cwd", { env: { OMP_KATA_INBOX: "false" }, loader })).toEqual({
			...DEFAULT_SETTINGS,
			inbox: false,
		});
	});

	test("a loader returning garbage yields defaults", async () => {
		const nullish: SettingsLoader = async () => null as unknown as Record<string, unknown>;
		const text: SettingsLoader = async () => "garbage" as unknown as Record<string, unknown>;
		const list: SettingsLoader = async () => [1, 2] as unknown as Record<string, unknown>;
		for (const loader of [nullish, text, list]) {
			expect(await resolveSettings("/cwd", { env: {}, loader })).toEqual({ ...DEFAULT_SETTINGS });
		}
	});

	test("unknown stored keys are ignored", async () => {
		expect(await resolveWith({}, { bogus: 1, inbox: false })).toEqual({ ...DEFAULT_SETTINGS, inbox: false });
	});

	test("the loader receives the cwd", async () => {
		const seen: string[] = [];
		await resolveSettings("/some/where", {
			env: {},
			loader: async cwd => {
				seen.push(cwd);
				return {};
			},
		});
		expect(seen).toEqual(["/some/where"]);
	});

	describe("process.env default", () => {
		const saved = process.env.OMP_KATA_INBOX_POLL_SECONDS;
		afterEach(() => {
			if (saved === undefined) delete process.env.OMP_KATA_INBOX_POLL_SECONDS;
			else process.env.OMP_KATA_INBOX_POLL_SECONDS = saved;
		});

		test("without options.env the process environment is consulted", async () => {
			process.env.OMP_KATA_INBOX_POLL_SECONDS = "3";
			expect((await resolveSettings("/cwd", { loader: loaderOf({}) })).inboxPollSeconds).toBe(3);
		});
	});

	test("the real loadPluginSettings never throws and resolves to a plain object", async () => {
		const settings = await loadPluginSettings(process.cwd());
		expect(typeof settings).toBe("object");
		expect(settings).not.toBeNull();
		expect(Array.isArray(settings)).toBe(false);
	});
});

interface ManifestSetting {
	type: string;
	default: unknown;
	description?: string;
	min?: number;
}

const root = resolve(import.meta.dir, "../..");

function manifestSettings(): Record<string, ManifestSetting> {
	const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { omp: { settings: Record<string, ManifestSetting> } };
	return pkg.omp.settings;
}

describe("package.json omp.settings stays in sync with config.ts", () => {
	test("declares exactly the keys of DEFAULT_SETTINGS", () => {
		expect(Object.keys(manifestSettings()).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
	});

	test("defaults match", () => {
		const manifest = manifestSettings();
		for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof KataSettings)[]) {
			expect({ key, default: manifest[key]?.default }).toEqual({ key, default: DEFAULT_SETTINGS[key] });
		}
	});

	test("types match (min 0 for inboxPollSeconds)", () => {
		const manifest = manifestSettings();
		for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof KataSettings)[]) {
			expect({ key, type: manifest[key]?.type }).toEqual({ key, type: typeof DEFAULT_SETTINGS[key] });
		}
		expect(manifest.inboxPollSeconds?.min).toBe(0);
	});

	test("every setting has a description", () => {
		for (const [key, setting] of Object.entries(manifestSettings())) {
			expect({ key, described: (setting.description ?? "").length > 0 }).toEqual({ key, described: true });
		}
	});
});

describe("README settings table stays in sync with config.ts", () => {
	const rows = [...readFileSync(resolve(root, "README.md"), "utf8").matchAll(/^\| `(\w+)` \| `(OMP_KATA_\w+)` \|(?:[^|\\]|\\\|)*\| (`[^`]*`) \|/gm)].map(m => ({
		key: m[1] as string,
		env: m[2] as string,
		defaultText: m[3] as string,
	}));

	test("documents every setting with its env var name", () => {
		expect(Object.fromEntries(rows.map(r => [r.key, r.env]))).toEqual({ ...ENV_NAMES });
	});

	test("documented defaults equal the real defaults", () => {
		const documented = Object.fromEntries(rows.map(r => [r.key, r.defaultText.replaceAll("`", "")]));
		const actual = Object.fromEntries(Object.entries(DEFAULT_SETTINGS).map(([k, v]) => [k, typeof v === "string" && v === "" ? '""' : String(v)]));
		// the README writes the empty string as `""`
		expect(documented).toEqual(actual);
	});
});
