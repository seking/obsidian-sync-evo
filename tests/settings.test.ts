/*
 * Sync Evo
 * Copyright (C) 2026 seking
 *
 * This file is part of Sync Evo, which is free software licensed under the
 * GNU Affero General Public License, version 3. It comes with ABSOLUTELY NO
 * WARRANTY. See the LICENSE file for the full text.
 *
 * Source: https://github.com/seking/obsidian-sync-evo
 */

import { describe, expect, test } from "vitest";
import { NO_DEVICE_EXCLUSION } from "../src/core/device-exclusion";
import {
	type AutoSyncSettings,
	clampInterval,
	type Connection,
	connectionChange,
	connectionOf,
	DEFAULT_AUTO_SYNC,
	defaultDeviceName,
	defaultSettings,
	type DeviceSettings,
	intervalToStore,
	minIntervalMinutes,
	withSendsChanges,
	deviceNameProblem,
	normalizeRepository,
	repositoryToStore,
	branchToStore,
	parseRepository,
	parseSettings,
	type PlatformKind,
	serializeSettings,
} from "../src/core/settings";

const settings = (over: Partial<DeviceSettings> = {}): DeviceSettings => ({
	backend: "github",
	repository: "octo/notes",
	branch: "main",
	tokenSecret: "github-token",
	dropboxFolder: "",
	dropboxAccount: null,
	gdriveFolder: "",
	gdriveAccount: null,
	gdriveFolderId: null,
	deviceName: "Mac",
	autoSync: DEFAULT_AUTO_SYNC,
	onConflict: "copy",
	deviceExclusion: NO_DEVICE_EXCLUSION,
	exclusionChangeTold: true,
	...over,
});

describe("the default settings", () => {
	test("have no connection, the branch main, and the given device name", () => {
		expect(defaultSettings("iPhone")).toEqual({
			backend: "github",
			repository: "",
			branch: "main",
			tokenSecret: "",
			dropboxFolder: "",
			dropboxAccount: null,
			gdriveFolder: "",
			gdriveAccount: null,
			gdriveFolderId: null,
			deviceName: "iPhone",
			autoSync: { onStartup: false, atInterval: false, intervalMinutes: 15, sendsChanges: false },
			onConflict: "merge",
			deviceExclusion: { kinds: [], folders: [], sectionChecked: false },
			exclusionChangeTold: true,
		});
		expect(connectionOf(defaultSettings("iPhone"))).toBeNull();
	});
});

describe("reading stored settings", () => {
	test.each([null, undefined])("%j, nothing stored, gives the defaults", (raw) => {
		expect(parseSettings(raw, "Mac")).toEqual({ status: "ok", settings: defaultSettings("Mac") });
	});

	test("what was saved is read back the same", () => {
		const saved = settings({ repository: "Octo/My.Notes", branch: "feature/x", deviceName: "仕事の Mac" });
		expect(parseSettings(serializeSettings(saved), "Linux")).toEqual({ status: "ok", settings: saved });
		// As the app stores it: through JSON.
		expect(parseSettings(JSON.parse(JSON.stringify(serializeSettings(saved))), "Linux")).toEqual({
			status: "ok",
			settings: saved,
		});
	});

	test("the stored form carries the version and only the known fields", () => {
		const withExtra = { ...settings(), token: "github_pat_SECRET" } as DeviceSettings;
		expect(serializeSettings(withExtra)).toEqual({
			version: 1,
			backend: "github",
			repository: "octo/notes",
			branch: "main",
			tokenSecret: "github-token",
			dropboxFolder: "",
			dropboxAccount: null,
			gdriveFolder: "",
			gdriveAccount: null,
			gdriveFolderId: null,
			deviceName: "Mac",
			autoSync: { onStartup: false, atInterval: false, intervalMinutes: 15, sendsChanges: false },
			onConflict: "copy",
			deviceExclusion: { kinds: [], folders: [], sectionChecked: false },
			exclusionChangeTold: true,
		});
	});

	test("what this device alone does not sync is read back, and what is not known in it is dropped", () => {
		const device = { kinds: ["image", "video"], folders: ["Attachments", "日記/写真"], sectionChecked: true } as const;
		const saved = settings({ deviceExclusion: device });
		expect(parseSettings(JSON.parse(JSON.stringify(serializeSettings(saved))), "Mac")).toEqual({
			status: "ok",
			settings: saved,
		});
		const read = (deviceExclusion: unknown): unknown => {
			const parsed = parseSettings({ ...serializeSettings(settings()), deviceExclusion }, "Mac");
			return parsed.status === "ok" ? parsed.settings.deviceExclusion : parsed.status;
		};
		// A kind that is not known, a folder that is no path from the root,
		// each once and the kinds in their order.
		expect(read({ kinds: ["pdf", "photo", "image", "pdf"], folders: ["a", "/b", "a", "c/", "d", 3], sectionChecked: 1 })).toEqual({
			kinds: ["image", "pdf"],
			folders: ["a", "d"],
			sectionChecked: false,
		});
		// Stored by a version from before it, or damaged: nothing is left out.
		for (const bad of [undefined, null, "image", ["image"], 1]) {
			expect(read(bad)).toEqual({ kinds: [], folders: [], sectionChecked: false });
		}
	});

	test("changing what this device alone does not sync is no change of the connection: the sync state stays", () => {
		const before = settings();
		const after = settings({ deviceExclusion: { kinds: ["image"], folders: ["Attachments"], sectionChecked: true } });
		expect(connectionChange(connectionOf(before), connectionOf(after))).toBe("none");
	});

	test("settings a version from before stored were not told of the change of what an exclusion does", () => {
		const { exclusionChangeTold: _, ...before } = serializeSettings(settings());
		const parsed = parseSettings(before, "Mac");
		expect(parsed.status === "ok" && parsed.settings.exclusionChangeTold).toBe(false);
		const told = parseSettings(serializeSettings(settings({ exclusionChangeTold: true })), "Mac");
		expect(told.status === "ok" && told.settings.exclusionChangeTold).toBe(true);
		const not = parseSettings(serializeSettings(settings({ exclusionChangeTold: false })), "Mac");
		expect(not.status === "ok" && not.settings.exclusionChangeTold).toBe(false);
	});

	test("what to do on a conflict is read back, and anything that is neither of the two is the default: a merge", () => {
		const read = (onConflict: unknown): unknown => {
			const parsed = parseSettings({ ...serializeSettings(settings()), onConflict }, "Mac");
			return parsed.status === "ok" ? parsed.settings.onConflict : parsed.status;
		};
		expect(serializeSettings(settings({ onConflict: "merge" })).onConflict).toBe("merge");
		expect(read("merge")).toBe("merge");
		expect(read("copy")).toBe("copy");
		for (const bad of [undefined, null, "", "Merge", "auto", true, 1, {}, ["merge"]]) expect(read(bad)).toBe("merge");
		// Stored by a version from before the setting: no field at all.
		const { onConflict: _dropped, ...older } = serializeSettings(settings({ onConflict: "copy" }));
		expect(parseSettings(older, "Mac")).toEqual({ status: "ok", settings: settings({ onConflict: "merge" }) });
	});

	test.each<[string, unknown]>([
		["the version after Google Drive", { ...serializeSettings(settings()), version: 4 }],
		["a far newer version", { version: 100 }],
		["a version between this and the next", { ...serializeSettings(settings()), version: 1.5 }],
	])("%s is a newer version", (_what, raw) => {
		expect(parseSettings(raw, "Mac")).toEqual({ status: "newer-version" });
	});

	test.each<[string, unknown]>([
		["version 0", { ...serializeSettings(settings()), version: 0 }],
		["a version that is text", { ...serializeSettings(settings()), version: "2" }],
		["a version that is not a number", { ...serializeSettings(settings()), version: Number.NaN }],
		["no version", { repository: "octo/notes", branch: "main" }],
		["an empty object", {}],
		["a list", [1]],
		["text", "octo/notes"],
		["a number", 2],
		["true", true],
	])("%s, which no version writes, gives the defaults and nothing of what was stored", (_what, raw) => {
		expect(parseSettings(raw, "Mac")).toEqual({ status: "ok", settings: defaultSettings("Mac") });
	});

	test.each<[string, Record<string, unknown>, Partial<DeviceSettings>]>([
		["a repository that is a number", { repository: 5 }, { repository: "" }],
		["a repository that is null", { repository: null }, { repository: "" }],
		["a branch that is a list", { branch: ["main"] }, { branch: "main" }],
		["a token secret that is an object", { tokenSecret: { name: "x" } }, { tokenSecret: "" }],
		["a device name that is a number", { deviceName: 7 }, { deviceName: "iPad" }],
		["an empty device name", { deviceName: "" }, { deviceName: "iPad" }],
		["a device name of spaces", { deviceName: "  " }, { deviceName: "iPad" }],
		["a device name with a slash", { deviceName: "my/phone" }, { deviceName: "iPad" }],
		["a device name with a line break", { deviceName: "my\nphone" }, { deviceName: "iPad" }],
		["a backend that is not known", { backend: "onedrive" }, { backend: "github" }],
		["a backend that is a number", { backend: 3 }, { backend: "github" }],
	])("%s falls back to the default of that field alone", (_what, broken, expected) => {
		const raw = { ...serializeSettings(settings({ branch: "work" })), ...broken };
		expect(parseSettings(raw, "iPad")).toEqual({
			status: "ok",
			settings: { ...settings({ branch: "work" }), ...("branch" in broken ? { branch: "main" } : {}), ...expected },
		});
	});

	test("missing fields are filled from the defaults", () => {
		// But for the change of what an exclusion does: stored without the
		// field, by a version from before, it was not told.
		expect(parseSettings({ version: 1 }, "Windows")).toEqual({
			status: "ok",
			settings: { ...defaultSettings("Windows"), exclusionChangeTold: false },
		});
	});

	test("a stored device name is trimmed", () => {
		const raw = { ...serializeSettings(settings()), deviceName: "  phone  " };
		expect(parseSettings(raw, "Mac")).toEqual({ status: "ok", settings: settings({ deviceName: "phone" }) });
	});

	test("a stored repository that is not in the form owner/name is dropped, and there is no connection", () => {
		const parsed = parseSettings({ ...serializeSettings(settings()), repository: "octo" }, "Mac");
		expect(parsed).toEqual({ status: "ok", settings: settings({ repository: "" }) });
		expect(parsed.status === "ok" && connectionOf(parsed.settings)).toBeNull();
	});

	test("a stored repository is read in its form", () => {
		const parsed = parseSettings({ ...serializeSettings(settings()), repository: "https://github.com/octo/notes" }, "Mac");
		expect(parsed).toEqual({ status: "ok", settings: settings({ repository: "octo/notes" }) });
	});

	test("Dropbox, its folder, and its account are read back", () => {
		const saved = settings({ backend: "dropbox", dropboxFolder: "Vault", dropboxAccount: { id: "dbid:1", email: "a@example.com" } });
		expect(parseSettings(JSON.parse(JSON.stringify(serializeSettings(saved))), "Mac")).toEqual({ status: "ok", settings: saved });
	});

	test.each(["", "  ", "a/b", "a\\b", ".", "..", 3, null])("a stored Dropbox folder of %j is stored as none", (dropboxFolder) => {
		const parsed = parseSettings({ ...serializeSettings(settings()), dropboxFolder }, "Mac");
		expect(parsed.status === "ok" && parsed.settings.dropboxFolder).toBe("");
	});

	test.each<[string, unknown]>([
		["nothing", undefined],
		["text", "dbid:1"],
		["no id", { email: "a@example.com" }],
		["an empty id", { id: "", email: "a@example.com" }],
		["an id that is a number", { id: 1, email: "a@example.com" }],
		["no email", { id: "dbid:1" }],
		["a list", ["dbid:1", "a@example.com"]],
	])("a stored Dropbox account with %s is none", (_what, dropboxAccount) => {
		const parsed = parseSettings({ ...serializeSettings(settings()), dropboxAccount }, "Mac");
		expect(parsed.status === "ok" && parsed.settings.dropboxAccount).toBeNull();
	});

	test("an object with accessors that throw does not make the read throw", () => {
		const hostile = Object.create(null) as Record<string, unknown>;
		hostile.version = 1;
		hostile.repository = { toString: () => { throw new Error("no"); } };
		expect(parseSettings(hostile, "Mac").status).toBe("ok");
	});
});

describe("reading a repository", () => {
	test.each<[string, string, string]>([
		["octo/notes", "octo", "notes"],
		["  octo/notes  ", "octo", "notes"],
		["Octo-Cat/My.Notes_2", "Octo-Cat", "My.Notes_2"],
		["octo/.github", "octo", ".github"],
		["octo/notes.git", "octo", "notes"],
		["octo/notes/", "octo", "notes"],
		["https://github.com/octo/notes", "octo", "notes"],
		["https://github.com/octo/notes/", "octo", "notes"],
		["https://github.com/octo/notes.git", "octo", "notes"],
		["https://github.com/octo/notes.git/", "octo", "notes"],
		["HTTPS://GitHub.com/Octo/Notes", "Octo", "Notes"],
		["http://github.com/octo/notes", "octo", "notes"],
		["https://www.github.com/octo/notes", "octo", "notes"],
		[" https://github.com/octo/notes\n", "octo", "notes"],
	])("%j is %s/%s", (text, owner, repo) => {
		expect(parseRepository(text)).toEqual({ owner, repo });
		expect(normalizeRepository(text)).toBe(`${owner}/${repo}`);
	});

	test.each([
		"",
		"   ",
		"octo",
		"octo/",
		"/notes",
		"/",
		"octo//notes",
		"octo/notes/extra",
		"octo / notes",
		"octo/my notes",
		"oc to/notes",
		"octo/notes?tab=readme",
		"octo/notes#readme",
		"octo/no:tes",
		"octo/日記",
		"octo\\notes",
		"octo/.",
		"octo/..",
		"./notes",
		"../notes",
		"octo/.git",
		"https://github.com/octo",
		"https://github.com/octo/notes/tree/main",
		"https://github.com/",
		"https://gitlab.com/octo/notes",
		"https://github.com.evil.example/octo/notes",
		"https://example.com/github.com/octo/notes",
		"git@github.com:octo/notes.git",
		"github.com/octo/notes",
	])("%j is not a repository", (text) => {
		expect(parseRepository(text)).toBeNull();
		expect(normalizeRepository(text)).toBeNull();
	});
});

describe("what is stored for the repository field", () => {
	test("a repository is stored in its form", () => {
		expect(repositoryToStore(" https://github.com/octo/notes.git ")).toBe("octo/notes");
	});

	test.each(["", "   "])("an emptied field (%j) removes the repository", (typed) => {
		expect(repositoryToStore(typed)).toBe("");
	});

	test.each(["octo/", "octo", "octo/notes/extra", "octo notes"])("%j is not stored", (typed) => {
		expect(repositoryToStore(typed)).toBeNull();
	});
});

describe("what is stored for the branch field", () => {
	test("a branch is stored trimmed and otherwise as typed", () => {
		expect(branchToStore("  feature/x ")).toBe("feature/x");
	});

	test.each(["", "   "])("an emptied field (%j) is not stored", (typed) => {
		expect(branchToStore(typed)).toBeNull();
	});
});

describe("the device name", () => {
	test.each(["iPhone", "Mac", "仕事の Mac", "my-phone_2", "Père's (old) phone!", "a.b", "📱", "100%"])(
		"%j is fine",
		(name) => {
			expect(deviceNameProblem(name)).toBeNull();
		},
	);

	test.each(["", " ", "\t", "\n", " \r\n ", "\u3000"])("%j is empty", (name) => {
		expect(deviceNameProblem(name)).toBe("empty");
	});

	// Each one inside a name, since at the ends a space or line break is trimmed away.
	test.each([
		"\n",
		"\r",
		"\t",
		"\u0000",
		"\u001f",
		"\u007f",
		"\u0085",
		"\u2028",
		"\u2029",
		"*",
		'"',
		"\\",
		"/",
		"<",
		">",
		":",
		"|",
		"?",
		"#",
		"^",
		"[",
		"]",
	])("%j is not accepted in a name", (character) => {
		expect(deviceNameProblem(`my${character}phone`)).toBe("invalid-character");
	});

	test("a rejected character is found wherever it is", () => {
		expect(deviceNameProblem("#phone")).toBe("invalid-character");
		expect(deviceNameProblem("phone]")).toBe("invalid-character");
		expect(deviceNameProblem("  phone:  ")).toBe("invalid-character");
	});

	test("spaces and line breaks around a name do not count, as the name is stored trimmed", () => {
		expect(deviceNameProblem("  phone \n")).toBeNull();
	});
});

describe("the default device name", () => {
	const none: PlatformKind = {
		isIosApp: false,
		isAndroidApp: false,
		isPhone: false,
		isTablet: false,
		isMacOS: false,
		isWin: false,
		isLinux: false,
	};

	test.each<[string, Partial<PlatformKind>, string]>([
		// As measured on an iPhone: it also says it is macOS.
		["an iPhone, which also reports macOS", { isIosApp: true, isPhone: true, isMacOS: true }, "iPhone"],
		["an iPhone", { isIosApp: true, isPhone: true }, "iPhone"],
		["an iPad, which also reports macOS", { isIosApp: true, isTablet: true, isMacOS: true }, "iPad"],
		["the iOS app with neither size", { isIosApp: true, isMacOS: true }, "iPad"],
		["an Android phone", { isAndroidApp: true, isPhone: true, isLinux: true }, "Android"],
		["an Android tablet", { isAndroidApp: true, isTablet: true }, "Android"],
		["a Mac", { isMacOS: true }, "Mac"],
		["a Mac emulating a phone", { isMacOS: true, isPhone: true }, "Mac"],
		["Windows", { isWin: true }, "Windows"],
		["Windows emulating a tablet", { isWin: true, isTablet: true }, "Windows"],
		["Linux", { isLinux: true }, "Linux"],
		["nothing known", {}, "Linux"],
	])("%s is %j", (_what, platform, expected) => {
		expect(defaultDeviceName({ ...none, ...platform })).toBe(expected);
	});

	test("every default is itself an acceptable name", () => {
		for (const name of ["iPhone", "iPad", "Android", "Mac", "Windows", "Linux"]) {
			expect(deviceNameProblem(name)).toBeNull();
		}
	});
});

describe("the connection of the settings", () => {
	test("is the backend, the repository, and the branch", () => {
		expect(connectionOf(settings())).toEqual({ backend: "github", repository: "octo/notes", branch: "main" });
	});

	test("is normalised, however the repository and branch were stored", () => {
		expect(connectionOf(settings({ repository: " https://github.com/octo/notes.git ", branch: " main " }))).toEqual({
			backend: "github",
			repository: "octo/notes",
			branch: "main",
		});
	});

	test.each<[string, Partial<DeviceSettings>]>([
		["no repository", { repository: "" }],
		["a repository without an owner", { repository: "notes" }],
		["a repository with a space", { repository: "octo/my notes" }],
		["no branch", { branch: "" }],
		["a branch of spaces", { branch: "  " }],
	])("there is none with %s", (_what, over) => {
		expect(connectionOf(settings(over))).toBeNull();
	});

	test("with Dropbox, is the account and the folder, and needs both", () => {
		const account = { id: "dbid:1", email: "a@example.com" };
		expect(connectionOf(settings({ backend: "dropbox", dropboxFolder: " Vault ", dropboxAccount: account }))).toEqual({
			backend: "dropbox",
			account: "dbid:1",
			folder: "Vault",
		});
		expect(connectionOf(settings({ backend: "dropbox", dropboxFolder: "Vault", dropboxAccount: null }))).toBeNull();
		expect(connectionOf(settings({ backend: "dropbox", dropboxFolder: "", dropboxAccount: account }))).toBeNull();
		expect(connectionOf(settings({ backend: "dropbox", dropboxFolder: "a/b", dropboxAccount: account }))).toBeNull();
	});

	test("there is one without a token secret or with any device name", () => {
		expect(connectionOf(settings({ tokenSecret: "" }))).not.toBeNull();
	});
});

describe("a change of the connection", () => {
	const a: Connection = { backend: "github", repository: "octo/notes", branch: "main" };

	test.each<[string, Connection | null, Connection | null, string]>([
		["nothing before or after", null, null, "none"],
		["the same connection", a, { ...a }, "none"],
		["a connection where there was none", null, a, "set"],
		["the connection removed", a, null, "cleared"],
		["another repository", a, { ...a, repository: "octo/other" }, "changed"],
		["another owner", a, { ...a, repository: "cat/notes" }, "changed"],
		["another branch", a, { ...a, branch: "work" }, "changed"],
		["a branch that differs in case only", a, { ...a, branch: "Main" }, "changed"],
		["a repository that differs in case only", a, { ...a, repository: "Octo/Notes" }, "none"],
		["an owner that differs in case only", a, { ...a, repository: "OCTO/notes" }, "none"],
	])("%s is %j", (_what, before, after, expected) => {
		expect(connectionChange(before, after)).toBe(expected);
	});

	const box: Connection = { backend: "dropbox", account: "dbid:1", folder: "Vault" };

	test.each<[string, Connection | null, Connection | null, string]>([
		["the same Dropbox account and a folder that differs in case only", box, { ...box, folder: "vault" }, "none"],
		["another Dropbox account", box, { ...box, account: "dbid:2" }, "changed"],
		["another Dropbox folder", box, { ...box, folder: "Other" }, "changed"],
		["GitHub to Dropbox", a, box, "changed"],
		["Dropbox to GitHub", box, a, "changed"],
	])("%s is %j", (_what, before, after, expected) => {
		expect(connectionChange(before, after)).toBe(expected);
	});

	const change = (before: DeviceSettings, after: DeviceSettings) =>
		connectionChange(connectionOf(before), connectionOf(after));

	test("another token secret or device name is no change", () => {
		expect(change(settings(), settings({ tokenSecret: "other-token" }))).toBe("none");
		expect(change(settings(), settings({ tokenSecret: "" }))).toBe("none");
		expect(change(settings(), settings({ deviceName: "iPhone" }))).toBe("none");
	});

	test("the same repository written another way is no change", () => {
		expect(change(settings(), settings({ repository: "https://github.com/Octo/notes.git" }))).toBe("none");
		expect(change(settings(), settings({ branch: " main " }))).toBe("none");
	});

	test("entering the same connection again after it was removed is a new connection", () => {
		const without = settings({ repository: "" });
		expect(change(settings(), without)).toBe("cleared");
		expect(change(without, settings())).toBe("set");
	});

	test("a repository that is stored out of its form counts as no connection", () => {
		const broken = settings({ repository: "octo/" });
		expect(change(settings(), broken)).toBe("cleared");
		expect(change(broken, settings())).toBe("set");
	});

	test("filling in the defaults one field at a time sets the connection once", () => {
		const start = defaultSettings("Mac");
		const withRepository = { ...start, repository: "octo/notes" };
		const withToken = { ...withRepository, tokenSecret: "github-token" };
		expect(change(start, withRepository)).toBe("set");
		expect(change(withRepository, withToken)).toBe("none");
	});
});

describe("the settings of automatic sync", () => {
	const auto = (over: Partial<AutoSyncSettings> = {}): AutoSyncSettings => ({ ...DEFAULT_AUTO_SYNC, ...over });
	const stored = (autoSync: unknown): unknown => ({ ...serializeSettings(settings()), autoSync });
	const read = (autoSync: unknown): AutoSyncSettings => {
		const parsed = parseSettings(stored(autoSync), "Mac");
		if (parsed.status !== "ok") throw new Error("not read");
		return parsed.settings.autoSync;
	};

	test("everything is off by default, and the interval is 15 minutes", () => {
		expect(DEFAULT_AUTO_SYNC).toEqual({ onStartup: false, atInterval: false, intervalMinutes: 15, sendsChanges: false });
	});

	test("what was saved is read back the same, also through JSON", () => {
		const saved = settings({ autoSync: { onStartup: true, atInterval: true, intervalMinutes: 30, sendsChanges: true } });
		expect(parseSettings(JSON.parse(JSON.stringify(serializeSettings(saved))), "Mac")).toEqual({
			status: "ok",
			settings: saved,
		});
	});

	test("the stored form carries only the known fields", () => {
		const withExtra = { ...auto({ onStartup: true }), secret: "x" } as AutoSyncSettings;
		expect(serializeSettings(settings({ autoSync: withExtra })).autoSync).toEqual({
			onStartup: true,
			atInterval: false,
			intervalMinutes: 15,
			sendsChanges: false,
		});
	});

	test("settings stored before there was automatic sync have it off", () => {
		const { autoSync: _dropped, ...older } = serializeSettings(settings());
		expect(parseSettings(older, "Mac")).toEqual({ status: "ok", settings: settings() });
	});

	test.each<[string, unknown]>([
		["nothing", undefined],
		["null", null],
		["a list", [true, true]],
		["text", "on"],
	])("%s in its place is everything off", (_name, raw) => {
		expect(read(raw)).toEqual(DEFAULT_AUTO_SYNC);
	});

	test("a switch is on only when it was stored as on", () => {
		expect(read({ onStartup: 1, atInterval: "true", sendsChanges: {}, intervalMinutes: 20 })).toEqual(
			auto({ intervalMinutes: 20 }),
		);
		expect(read({ onStartup: true })).toEqual(auto({ onStartup: true }));
	});

	test.each<[unknown, boolean, number]>([
		[0, false, 1],
		[-5, false, 1],
		[1, false, 1],
		[1, true, 5],
		[4, true, 5],
		[5, true, 5],
		[1440, false, 1440],
		[100_000, true, 1440],
		[7.4, false, 7],
		["20", false, 15],
		[null, false, 15],
		[Number.NaN, false, 15],
		[Number.POSITIVE_INFINITY, false, 15],
	])("a stored interval of %j, sending %j, is read as %j", (minutes, sendsChanges, expected) => {
		expect(read({ atInterval: true, sendsChanges, intervalMinutes: minutes }).intervalMinutes).toBe(expected);
	});

	test("the lower bound is 5 minutes when sending and 1 minute when not", () => {
		expect(minIntervalMinutes(true)).toBe(5);
		expect(minIntervalMinutes(false)).toBe(1);
		expect(clampInterval(3, true)).toBe(5);
		expect(clampInterval(3, false)).toBe(3);
		expect(clampInterval(2000, false)).toBe(1440);
	});

	test("switching sending on raises an interval below 5 minutes to 5", () => {
		expect(withSendsChanges(auto({ intervalMinutes: 2 }), true)).toEqual(auto({ intervalMinutes: 5, sendsChanges: true }));
		expect(withSendsChanges(auto({ intervalMinutes: 30 }), true).intervalMinutes).toBe(30);
	});

	test("switching sending off leaves the interval as it is", () => {
		expect(withSendsChanges(auto({ intervalMinutes: 5, sendsChanges: true }), false)).toEqual(auto({ intervalMinutes: 5 }));
	});

	test.each<[string, boolean, number | null]>([
		["15", false, 15],
		[" 15 ", false, 15],
		["1", false, 1],
		["1", true, null],
		["4", true, null],
		["5", true, 5],
		["1440", true, 1440],
		["1441", false, null],
		["0", false, null],
		["", false, null],
		["-3", false, null],
		["1.5", false, null],
		["ten", false, null],
		["1e2", false, null],
	])("typed %j, sending %j, is stored as %j", (typed, sendsChanges, expected) => {
		expect(intervalToStore(typed, sendsChanges)).toBe(expected);
	});

	test("changing them is no change of the connection", () => {
		const before = settings();
		const after = settings({ autoSync: { onStartup: true, atInterval: true, intervalMinutes: 5, sendsChanges: true } });
		expect(connectionChange(connectionOf(before), connectionOf(after))).toBe("none");
	});
});

describe("the version settings are stored as", () => {
	test("with GitHub chosen, the one before Dropbox; with Dropbox, the next, which an older version reads as newer", () => {
		expect(serializeSettings(settings()).version).toBe(1);
		const dropbox: DeviceSettings = { ...settings(), backend: "dropbox", dropboxFolder: "Vault", dropboxAccount: { id: "dbid:1", email: "a@example.com" } };
		const stored = serializeSettings(dropbox);
		expect(stored.version).toBe(2);
		expect(parseSettings(JSON.parse(JSON.stringify(stored)), "Mac")).toEqual({ status: "ok", settings: dropbox });
		expect(parseSettings({ ...stored, version: 4 }, "Mac")).toEqual({ status: "newer-version" });
	});

	test("with Google Drive chosen, the one after Dropbox, which a version that knows Dropbox alone reads as newer", () => {
		const drive: DeviceSettings = {
			...settings(),
			backend: "gdrive",
			gdriveFolder: "Vault",
			gdriveAccount: { id: "perm1", email: "a@example.com" },
			gdriveFolderId: "folder1",
		};
		const stored = serializeSettings(drive);
		expect(stored.version).toBe(3);
		expect(parseSettings(JSON.parse(JSON.stringify(stored)), "Mac")).toEqual({ status: "ok", settings: drive });
		// What a version that knows Dropbox alone does with it.
		expect(stored.version > 1 && stored.version !== 2).toBe(true);
	});
});

describe("Google Drive in the settings", () => {
	const account = { id: "perm1", email: "a@example.com" };
	const drive = (over: Partial<DeviceSettings> = {}): DeviceSettings =>
		settings({ backend: "gdrive", gdriveFolder: "Vault", gdriveAccount: account, gdriveFolderId: null, ...over });

	test("the client id is left out unless one is set, and kept when it is", () => {
		expect("gdriveClientId" in serializeSettings(drive())).toBe(false);
		const own = drive({ gdriveClientId: "own.apps.googleusercontent.com" });
		const parsed = parseSettings(JSON.parse(JSON.stringify(serializeSettings(own))), "Mac");
		expect(parsed).toEqual({ status: "ok", settings: own });
	});

	test.each(["", "a/b", 3, null])("a stored folder of %j is stored as none", (gdriveFolder) => {
		const parsed = parseSettings({ ...serializeSettings(drive()), gdriveFolder }, "Mac");
		expect(parsed.status === "ok" && parsed.settings.gdriveFolder).toBe("");
	});

	test.each(["", 3, null])("a stored folder id of %j is none", (gdriveFolderId) => {
		const parsed = parseSettings({ ...serializeSettings(drive({ gdriveFolderId: "f1" })), gdriveFolderId }, "Mac");
		expect(parsed.status === "ok" && parsed.settings.gdriveFolderId).toBeNull();
	});

	test("the connection is the account, the folder and its id, and needs the account and the folder", () => {
		expect(connectionOf(drive({ gdriveFolder: " Vault ", gdriveFolderId: "f1" }))).toEqual({
			backend: "gdrive",
			account: "perm1",
			folder: "Vault",
			folderId: "f1",
		});
		expect(connectionOf(drive({ gdriveAccount: null }))).toBeNull();
		expect(connectionOf(drive({ gdriveFolder: "" }))).toBeNull();
	});

	test.each<[string, Partial<DeviceSettings>, Partial<DeviceSettings>, string]>([
		["the id found by a sync", { gdriveFolderId: null }, { gdriveFolderId: "f1" }, "none"],
		["the same id", { gdriveFolderId: "f1" }, { gdriveFolderId: "f1" }, "none"],
		["the id let go of, the folder being gone", { gdriveFolderId: "f1" }, { gdriveFolderId: null }, "changed"],
		["another id", { gdriveFolderId: "f1" }, { gdriveFolderId: "f2" }, "changed"],
		["a folder that differs in case only, which Drive tells apart", {}, { gdriveFolder: "vault" }, "changed"],
		["another account", {}, { gdriveAccount: { id: "perm2", email: "b@example.com" } }, "changed"],
		["Dropbox to Google Drive", { backend: "dropbox", dropboxFolder: "Vault", dropboxAccount: { id: "perm1", email: "" } }, {}, "changed"],
	])("%s", (_what, before, after, expected) => {
		expect(connectionChange(connectionOf(drive(before)), connectionOf(drive(after)))).toBe(expected);
	});
});

