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

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { RemoteListing } from "../src/core/backend";
import { NO_DEVICE_EXCLUSION } from "../src/core/device-exclusion";
import { translatorFor } from "../src/core/i18n";
import type { PullDeps, PullResult } from "../src/core/pull";
import { DEFAULT_AUTO_SYNC, type DeviceSettings } from "../src/core/settings";
import { writeBaseRevision } from "../src/core/state";
import type { SyncHost } from "../src/obsidian/sync-runner";
import { MemoryStateStore } from "./support/memory-state-store";

// What the runner tells, once, of the files on the remote that an exclusion
// no longer syncs (`tellExclusionChange`). The pull is stood in for: it
// leaves the listing of the remote, and the base revision where it got to.
// How the files are counted is tested in the core (`exclusion-settings.test.ts`).
const app = vi.hoisted(() => ({
	notices: [] as string[],
	/** What the stand-in pull leaves: the listing, and whether it got to its head. */
	listing: null as unknown,
	reachesHead: true,
}));

vi.mock("obsidian", () => {
	class Notice {
		constructor(text: string) {
			app.notices.push(text);
		}
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
		requestUrl: () => Promise.reject(new Error("offline")),
	};
});

const HEAD = "a".repeat(40);

const pulled: PullResult = {
	outcome: "completed",
	revision: HEAD,
	remoteEmpty: false,
	rewritten: false,
	counts: { fetched: 0, deleted: 0, renamed: 0, conflicts: 0 },
	conflicts: [],
	merged: [],
	replacedSettings: [],
	trashed: [],
	halfWritten: [],
	halfMerged: [],
	halfCopies: [],
	deferred: [],
	unwritable: [],
	keptLocal: [],
	tidiedCopies: [],
	newSymlinks: [],
	notices: [],
	closedViews: false,
	refetched: 0,
};

vi.mock("../src/core/pull", async (original) => ({
	...(await original<typeof import("../src/core/pull")>()),
	runPull: async (deps: PullDeps): Promise<PullResult> => {
		const listing = app.listing as RemoteListing;
		await deps.store.putListing(listing);
		if (app.reachesHead && listing.revision !== null) await writeBaseRevision(deps.store, listing.revision);
		return pulled;
	},
}));

const { SyncRunner } = await import("../src/obsidian/sync-runner");

const file = (path: string) => ({ path, kind: "file" as const, hash: "0".repeat(40) });

/** A vault with a root `.gitignore` of `gitignore`, and nothing else a sync is asked of here. */
function setup(gitignore: string) {
	const store = new MemoryStateStore();
	const files: Record<string, string> = { ".gitignore": gitignore };
	const told = { times: 0 };
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
				},
				getFiles: () => [],
				getAbstractFileByPath: () => null,
			},
			workspace: { iterateAllLeaves: () => {}, getLeavesOfType: () => [] },
			fileManager: {},
		},
		manifest: { id: "sync-evo", dir: ".obsidian/plugins/sync-evo" },
		t: translatorFor("en"),
		deviceSettings: {
			backend: "github",
			repository: "octo/notes",
			branch: "main",
			tokenSecret: "github-token",
			dropboxFolder: "",
			dropboxAccount: null,
			gdriveFolder: "",
			gdriveAccount: null,
			gdriveFolderId: null,
			deviceName: "iPhone",
			autoSync: { ...DEFAULT_AUTO_SYNC },
			onConflict: "copy",
			deviceExclusion: NO_DEVICE_EXCLUSION,
			exclusionChangeTold: false,
		} as DeviceSettings,
		syncState: { open: async () => ({ status: "ok", store }), close: () => {} },
		readToken: () => "github_pat_SECRET",
		editing: { facts: () => [] },
		// As the plugin does: saved with the other settings of the device.
		exclusionChangeTold(): void {
			told.times += 1;
			host.deviceSettings = { ...host.deviceSettings, exclusionChangeTold: true };
		},
	};
	const runner = new SyncRunner(host as unknown as SyncHost);
	return { runner, host, told };
}

const toldNotices = () => app.notices.filter((text) => text.startsWith("From this version of Sync Evo on,"));

beforeEach(() => {
	app.notices.length = 0;
	app.listing = { revision: HEAD, entries: [file("note.md"), file("cache/a.bin")] };
	app.reachesHead = true;
	vi.stubGlobal("window", { setTimeout, clearTimeout });
	vi.stubGlobal("document", { visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} });
	vi.stubGlobal("navigator", {});
	vi.spyOn(console, "info").mockImplementation(() => {});
	vi.spyOn(console, "debug").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("the files on the remote an exclusion no longer syncs", () => {
	test("are told once after a sync, and that they were is saved", async () => {
		const { runner, host, told } = setup("cache/\n");

		await runner.run("pull");

		expect(toldNotices()).toEqual([translatorFor("en")("notice.exclusionChange", { count: 1 })]);
		expect(told.times).toBe(1);
		expect(host.deviceSettings.exclusionChangeTold).toBe(true);
	});

	test("are not told again by the next sync", async () => {
		const { runner, told } = setup("cache/\n");
		await runner.run("pull");
		app.notices.length = 0;

		await runner.run("pull");

		expect(toldNotices()).toEqual([]);
		expect(told.times).toBe(1);
	});

	test("none: nothing is told, and it counts as told all the same", async () => {
		const { runner, host, told } = setup("other/\n");

		await runner.run("pull");

		expect(toldNotices()).toEqual([]);
		expect(told.times).toBe(1);
		expect(host.deviceSettings.exclusionChangeTold).toBe(true);
	});

	test("a pull that did not get to the head tells nothing and leaves it to be told later", async () => {
		app.reachesHead = false;
		const { runner, host, told } = setup("cache/\n");

		await runner.run("pull");

		expect(toldNotices()).toEqual([]);
		expect(told.times).toBe(0);
		expect(host.deviceSettings.exclusionChangeTold).toBe(false);
	});
});
