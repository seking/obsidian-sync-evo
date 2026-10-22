/*
 * Sync Evo
 * Copyright (C) 2026 seking
 *
 * This file is part of the paid part of Sync Evo (the folder pro/), which is
 * licensed under the Elastic License 2.0, not the AGPL. You may not move,
 * change, disable, or circumvent the license key functionality in it. See
 * pro/LICENSE for the full text.
 *
 * Source: https://github.com/seking/obsidian-sync-evo
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { BackendError } from "../../src/core/backend";
import { NO_DEVICE_EXCLUSION } from "../../src/core/device-exclusion";
import { translatorFor } from "../../src/core/i18n";
import { DEFAULT_AUTO_SYNC, type DeviceSettings } from "../../src/core/settings";
import type { SyncHost } from "../../src/obsidian/sync-runner";
import { MemoryStateStore } from "../../tests/support/memory-state-store";
import type { GoogleClient } from "../src/core/gdrive/auth";
import { DAY_MS } from "../src/core/paid";
import { ACCOUNT_KEY, FIRST_SEEN_KEY, SINCE_KEY } from "../src/core/paid-gate";
import { connectionKey } from "../src/core/paid-guard";
import { paidGate } from "../src/obsidian/paid-plan";
import { stubLocalStorage } from "./support/paid";

// The paid plan with the check of the sync taken away (T084): a runner
// whose host gives no plan (`SyncHost.paid`), or whose code was changed to
// hand the backends other settings or another client, as one would be built
// from a changed copy of the rest of the plugin. The backends of Dropbox and
// Google Drive still refuse to upload, on the plan of the app (`app-gate.ts`).

// Long enough ago that the end of the free time is three months after the
// start of the count.
const ENABLED = vi.hoisted(() => Date.now() - 400 * 24 * 60 * 60 * 1000);

// The plan switched on, as in the version that switches it on.
vi.mock("../src/core/paid", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/core/paid")>()),
	PAID_ENABLED_AT: ENABLED,
}));

const app = vi.hoisted(() => ({
	/** Every request, as `METHOD url`, in order. */
	requests: [] as string[],
	/** Answers a request. */
	answer: (_params: { url: string; method?: string }): unknown => ({ status: 500, headers: {}, arrayBuffer: new ArrayBuffer(0) }),
	/**
	 * How the code that builds the backends was changed, if it was: other
	 * settings handed to them, another client of Google, or the start of
	 * the count never asked for by the sync.
	 */
	changed: null as null | "settings" | "client" | "no-learning",
}));

vi.mock("obsidian", () => {
	class Notice {
		readonly containerEl = { classList: { add: () => {} } };
		setMessage(): void {}
		hide(): void {}
	}
	class Empty {}
	return {
		Notice,
		Modal: Empty,
		ButtonComponent: Empty,
		TFile: Empty,
		TFolder: Empty,
		Platform: { isAndroidApp: false },
		requestUrl: async (params: { url: string; method?: string }) => {
			app.requests.push(`${params.method ?? "GET"} ${params.url}`);
			return app.answer(params);
		},
	};
});

// The first upload from this device asks before it sends: the user says yes.
vi.mock("../../src/obsidian/push-confirm", () => ({ confirmPushIn: () => async () => "proceed" }));

// Google, as far as the tokens go: it gives one for the client the
// connection was made with, Sync Evo's, and refuses any other client id.
vi.mock("../src/obsidian/google-tokens", () => ({
	googleTokens: (_refreshToken: string, client: GoogleClient) => ({
		get: async () => {
			if (client.own === true) throw new BackendError("unauthorized", "invalid_client");
			return "access";
		},
		refused: () => {},
	}),
}));

// The code that builds the backends, changed as the test says.
vi.mock("../src/obsidian/remotes", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/obsidian/remotes")>();
	type Remote = typeof original.dropboxRemote | typeof original.driveRemote;
	const changed = <F extends Remote>(make: F): F =>
		((settings: DeviceSettings, target: Parameters<F>[1], deps: Parameters<F>[2]) => {
			if (app.changed === "settings") {
				// No account, and GitHub, which the plan does not apply to.
				const other = { ...settings, backend: "github", dropboxAccount: null, gdriveAccount: null } as DeviceSettings;
				return (make as (...args: unknown[]) => unknown)(other, target, deps);
			}
			if (app.changed === "client") {
				// A client id of the user's own, which is free, for a connection made with Sync Evo's.
				const own = "own.apps.googleusercontent.com";
				return (make as (...args: unknown[]) => unknown)({ ...settings, gdriveClientId: own }, { ...target, clientId: own }, deps);
			}
			const made = (make as (...args: unknown[]) => { backend: unknown; learnSince: () => Promise<number | null> })(settings, target, deps);
			return app.changed === "no-learning" ? { ...made, learnSince: async () => null } : made;
		}) as F;
	return { ...original, dropboxRemote: changed(original.dropboxRemote), driveRemote: changed(original.driveRemote) };
});

const { SyncRunner } = await import("../../src/obsidian/sync-runner");

const json = (status: number, body: unknown) => ({ status, headers: {}, arrayBuffer: new TextEncoder().encode(JSON.stringify(body)).buffer });

/** A start of the count whose free time ended `daysAgo` days ago. */
function sinceEnded(daysAgo: number): number {
	const since = new Date(Date.now() - daysAgo * DAY_MS);
	since.setUTCMonth(since.getUTCMonth() - 3);
	return since.getTime();
}

type Service = "dropbox" | "gdrive";

/** The account of the connection, as each service names it. */
const ACCOUNT: Record<Service, string> = { dropbox: "dropbox:dbid:1", gdrive: "gdrive:perm1" };

/**
 * A runner for a vault with one note of its own, synced with `backend`.
 * `since`: when the count of the account started, as this device knows it,
 * or `null` for not known; the account of the connection is known with it.
 * `paid`: whether the host gives the plan of the app for its check.
 */
async function setup(backend: Service, since: number | null, paid = false, over: Partial<DeviceSettings> = {}) {
	const stored = stubLocalStorage();
	// A device that has run the plan since it was switched on: no days of a late install.
	stored.set(FIRST_SEEN_KEY, JSON.stringify({ enabledAt: ENABLED, at: ENABLED }));
	if (since !== null) {
		stored.set(ACCOUNT_KEY, JSON.stringify({ [await connectionKey("refresh")]: ACCOUNT[backend] }));
		stored.set(SINCE_KEY, JSON.stringify({ [ACCOUNT[backend]]: since }));
	}
	const store = new MemoryStateStore();
	const files: Record<string, string> = { "note.md": "mine" };
	const settings: DeviceSettings = {
		backend,
		repository: "",
		branch: "main",
		tokenSecret: "",
		dropboxFolder: "Vault",
		dropboxAccount: { id: "dbid:1", email: "a@example.com" },
		gdriveFolder: "Vault",
		gdriveAccount: { id: "perm1", email: "a@example.com" },
		gdriveFolderId: null,
		deviceName: "iPhone",
		autoSync: DEFAULT_AUTO_SYNC,
		onConflict: "copy",
		deviceExclusion: NO_DEVICE_EXCLUSION,
		exclusionChangeTold: true,
		...over,
	};
	const host = {
		app: {
			vault: {
				configDir: ".obsidian",
				adapter: {
					stat: async (path: string) => {
						if (path === ".obsidian") return { type: "folder", mtime: 0, size: 0 };
						const content = files[path];
						return content === undefined ? null : { type: "file", mtime: 1, size: content.length };
					},
					list: async (folder: string) =>
						folder === "/" ? { files: Object.keys(files), folders: [".obsidian"] } : { files: [], folders: [] },
					readBinary: async (path: string) => new TextEncoder().encode(files[path] ?? "").buffer,
					writeBinary: async () => {},
					mkdir: async () => {},
				},
				getFiles: () => [],
				getAbstractFileByPath: () => null,
			},
			workspace: { iterateAllLeaves: () => {}, getLeavesOfType: () => [] },
			fileManager: {},
		},
		manifest: { id: "sync-evo", dir: ".obsidian/plugins/sync-evo" },
		t: translatorFor("en", backend === "dropbox" ? "Dropbox" : "Google Drive"),
		deviceSettings: settings,
		syncState: { open: async () => ({ status: "ok", store }), close: () => {} },
		readToken: () => null,
		readDropboxToken: () => "refresh",
		dropboxTokens: () => ({ get: async () => "access", refused: () => {} }),
		readGdriveToken: () => "refresh",
		gdriveClientSecret: () => "own-secret",
		editing: { facts: () => [] },
		// The check before a sync, where the host gives it.
		...(paid ? { paid: paidGate() } : {}),
	};
	return { runner: new SyncRunner(host as unknown as SyncHost), stored };
}

/**
 * What was sent that writes to the remote: on Dropbox an upload, a commit, a
 * delete; on Google Drive anything but a read.
 */
const writes = (): string[] =>
	app.requests.filter((request) => /upload|finish_batch|delete|create_folder/.test(request) || /^(POST|PATCH) https:\/\/www\.googleapis/.test(request));

const lines = (): string[] => vi.mocked(console.debug).mock.calls.map(([message]) => String(message));

const refused = (): boolean => lines().some((line) => line.includes(": failed (") && line.includes("paid-plan"));

/** A start of the count long enough ago that nothing syncs any more. */
const LONG_AGO = Date.now() - 200 * DAY_MS;

/**
 * The services as they stand: the account of the connection, no folder of
 * the vault yet (the note would be its first file), and on Dropbox the
 * file of the start of the count, at `since`.
 */
function services(since: number = LONG_AGO) {
	return (params: { url: string }) => {
		const { url } = params;
		if (url.endsWith("/users/get_current_account")) return json(200, { account_id: "dbid:1", email: "a@example.com" });
		if (url.endsWith("/files/get_metadata")) return json(200, { name: ".sync-evo-since", server_modified: new Date(since).toISOString() });
		if (url.endsWith("/files/list_folder")) return json(409, { error_summary: "path/not_found/.." });
		if (url.includes("/drive/v3/about")) return json(200, { user: { permissionId: "perm1", emailAddress: "a@example.com" } });
		if (url.includes("/drive/v3/files/f1?")) return json(200, { id: "f1", mimeType: "application/vnd.google-apps.folder", trashed: false, parents: ["top1"] });
		if (url.includes("/drive/v3/files/top1?")) return json(200, { createdTime: new Date(since).toISOString() });
		if (url.includes("/drive/v3/files?")) return json(200, { files: [] });
		if (url.includes("/drive/v3/changes/startPageToken")) return json(200, { startPageToken: "1" });
		if (url.includes("/drive/v3/changes?")) return json(200, { changes: [], newStartPageToken: "1" });
		return json(500, {});
	};
}

beforeEach(() => {
	app.requests.length = 0;
	app.changed = null;
	app.answer = services();
	vi.stubGlobal("document", { visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} });
	vi.spyOn(console, "debug").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("after the free time, without the check of the sync", () => {
	test.each<[Service, "sync" | "push"]>([
		["dropbox", "sync"],
		["dropbox", "push"],
		["gdrive", "sync"],
		["gdrive", "push"],
	])("%s: a %s lists, and uploads nothing: the backend refuses", async (backend, mode) => {
		const { runner } = await setup(backend, sinceEnded(10));
		await runner.run(mode);
		expect(app.requests.length).toBeGreaterThan(0);
		expect(writes()).toEqual([]);
		expect(refused()).toBe(true);
	});

	test.each<Service>(["dropbox", "gdrive"])("%s: 30 days after, nothing is asked of the remote at all", async (backend) => {
		const { runner } = await setup(backend, sinceEnded(60));
		await runner.run("sync");
		expect(app.requests).toEqual([]);
		expect(refused()).toBe(true);
	});

	test("Dropbox: the account and the start of the count, not known, are asked by the backend first, kept, and nothing more is asked", async () => {
		const { runner, stored } = await setup("dropbox", null);
		await runner.run("sync");
		expect(app.requests).toEqual(["POST https://api.dropboxapi.com/2/users/get_current_account", "POST https://api.dropboxapi.com/2/files/get_metadata"]);
		expect(JSON.parse(stored.get(SINCE_KEY) ?? "{}")).toEqual({ [ACCOUNT.dropbox]: LONG_AGO });
	});
});

describe("with the code that builds the backends changed", () => {
	test.each<Service>(["dropbox", "gdrive"])("%s: settings without the account, and of GitHub, upload nothing after the free time", async (backend) => {
		const { runner } = await setup(backend, sinceEnded(10));
		app.changed = "settings";
		await runner.run("sync");
		expect(app.requests.length).toBeGreaterThan(0);
		expect(writes()).toEqual([]);
		expect(refused()).toBe(true);
	});

	test("Google Drive: a client id of the user's own, for a connection made with Sync Evo's, gets no token, and sends nothing", async () => {
		const { runner } = await setup("gdrive", sinceEnded(60));
		app.changed = "client";
		await runner.run("sync");
		expect(app.requests).toEqual([]);
		expect(lines().some((line) => line.includes(": failed (") && line.includes("unauthorized"))).toBe(true);
	});

	test.each<Service>(["dropbox", "gdrive"])(
		"%s: a sync that never asks when the count started, with the check before it, sends nothing once the free time is long over",
		async (backend) => {
			// The folder of the vault kept by its id: Google Drive tells the start of the count by it.
			const { runner, stored } = await setup(backend, null, true, backend === "gdrive" ? { gdriveFolderId: "f1" } : {});
			app.changed = "no-learning";
			await runner.run("sync");
			expect(writes()).toEqual([]);
			expect(refused()).toBe(true);
			// Learned by the backend, and kept for the next check before a sync.
			expect(JSON.parse(stored.get(SINCE_KEY) ?? "{}")).toEqual({ [ACCOUNT[backend]]: LONG_AGO });
		},
	);
});
