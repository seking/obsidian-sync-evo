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

import type { App } from "obsidian";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { folderStatsOf, folderStatsProbeOf } from "../src/obsidian/folder-stats";

const platform = vi.hoisted(() => ({ isAndroidApp: true, isIosApp: false }));
vi.mock("obsidian", () => ({ Platform: platform }));

interface Entry {
	readonly type: string;
	readonly name: string;
	readonly mtime?: number;
	readonly size?: number;
}

/** An adapter as on Android: the listing of each folder by its full path, and the disk by vault path. */
function appWith(
	listings: Record<string, readonly Entry[] | Error>,
	disk: Record<string, { mtime: number; size: number } | Error> = {},
): { app: App; asked: string[] } {
	const asked: string[] = [];
	const adapter = {
		fs: {
			readdir(path: string): Promise<readonly Entry[]> {
				asked.push(`readdir ${path}`);
				const listing = listings[path];
				if (listing === undefined) return Promise.reject(new Error(`nothing at ${path}`));
				return listing instanceof Error ? Promise.reject(listing) : Promise.resolve(listing);
			},
		},
		getFullPath: (path: string) => `/vault/${path}`,
		list(folder: string): Promise<{ files: string[]; folders: string[] }> {
			const listing = listings[`/vault/${folder === "/" ? "" : folder}`];
			const files = listing instanceof Error || listing === undefined ? [] : listing.filter((e) => e.type === "file");
			const prefix = folder === "/" ? "" : `${folder}/`;
			return Promise.resolve({ files: files.map((e) => `${prefix}${e.name}`), folders: [] });
		},
		stat(path: string): Promise<{ type: "file"; mtime: number; size: number } | null> {
			asked.push(`stat ${path}`);
			const stat = disk[path];
			if (stat instanceof Error) return Promise.reject(stat);
			return Promise.resolve(stat === undefined ? null : { type: "file", ...stat });
		},
	};
	return { app: { vault: { adapter } } as unknown as App, asked };
}

const file = (name: string, mtime: number, size: number): Entry => ({ type: "file", name, mtime, size });

beforeEach(() => {
	platform.isAndroidApp = true;
	platform.isIosApp = false;
});

describe("the stats of a folder from the listing on Android", () => {
	test("the files of a folder by their paths from the vault root, the root given as the lister gives it", async () => {
		const { app, asked } = appWith(
			{
				"/vault/": [file("a.md", 10, 1), { type: "directory", name: "n" }],
				"/vault/n": [file("b.md", 20, 2)],
			},
			{ "a.md": { mtime: 10, size: 1 }, "n/b.md": { mtime: 20, size: 2 } },
		);
		const stats = folderStatsOf(app);

		expect(await stats?.("/")).toEqual(new Map([["a.md", { mtime: 10, size: 1 }]]));
		expect(await stats?.("n")).toEqual(new Map([["n/b.md", { mtime: 20, size: 2 }]]));
		// One file of each folder is checked against the disk.
		expect(asked).toEqual(["readdir /vault/", "stat a.md", "readdir /vault/n", "stat n/b.md"]);
	});

	test("names are spelled as the app's listing spells them, and two that come out alike are both left out", async () => {
		const { app } = appWith(
			{
				"/vault/": [
					file("A B.md", 1, 1),
					file("café.md", 2, 2),
					file("x y.md", 3, 3),
					file("x y.md", 4, 4),
				],
			},
			{ "A B.md": { mtime: 1, size: 1 } },
		);

		expect(await folderStatsOf(app)?.("/")).toEqual(
			new Map([
				["A B.md", { mtime: 1, size: 1 }],
				["café.md".normalize("NFC"), { mtime: 2, size: 2 }],
			]),
		);
	});

	test("a listing the disk does not agree with is not used, in that folder or any after it", async () => {
		const { app, asked } = appWith(
			{ "/vault/": [file("a.md", 10, 1)], "/vault/n": [file("b.md", 20, 2)] },
			{ "a.md": { mtime: 11, size: 1 }, "n/b.md": { mtime: 20, size: 2 } },
		);
		const stats = folderStatsOf(app);

		expect(await stats?.("/")).toBeNull();
		expect(await stats?.("n")).toBeNull();
		expect(asked).toEqual(["readdir /vault/", "stat a.md"]);
	});

	test("a disk that fails to answer the check is taken as one that does not agree", async () => {
		const { app } = appWith({ "/vault/": [file("a.md", 10, 1)] }, { "a.md": new Error("busy") });

		expect(await folderStatsOf(app)?.("/")).toBeNull();
	});

	test("a listing in another form than expected, or one that fails, tells nothing of the folder", async () => {
		const { app } = appWith(
			{
				"/vault/odd": [file("a.md", 1, 1), { type: "symlink", name: "l" }],
				"/vault/nosize": [{ type: "file", name: "a.md", mtime: 1 }],
				"/vault/fraction": [file("a.md", 1.5, 1)],
				"/vault/failing": new Error("gone"),
			},
			{ "ok/a.md": { mtime: 1, size: 1 } },
		);
		const stats = folderStatsOf(app);

		expect(await stats?.("odd")).toBeNull();
		expect(await stats?.("nosize")).toBeNull();
		expect(await stats?.("fraction")).toBeNull();
		expect(await stats?.("failing")).toBeNull();
	});

	test("an empty folder tells that it holds no file, without asking the disk", async () => {
		const { app, asked } = appWith({ "/vault/e": [] });

		expect(await folderStatsOf(app)?.("e")).toEqual(new Map());
		expect(asked).toEqual(["readdir /vault/e"]);
	});

	test("nothing on another platform, or where the adapter has no listing to read", () => {
		platform.isAndroidApp = false;
		expect(folderStatsOf(appWith({}).app)).toBeUndefined();
		platform.isAndroidApp = true;
		expect(folderStatsOf({ vault: { adapter: { stat: () => null } } } as unknown as App)).toBeUndefined();
	});
});

describe("the check of the listing on iOS", () => {
	test("compares the listing with the disk, tells nothing to the sync, and writes what it found to the log", async () => {
		platform.isAndroidApp = false;
		platform.isIosApp = true;
		const { app } = appWith(
			{ "/vault/": [file("a.md", 10, 1), file("b.md", 20, 2)], "/vault/n": [file("c.md", 30, 3)] },
			{ "a.md": { mtime: 10, size: 1 }, "b.md": { mtime: 21, size: 2 }, "n/c.md": { mtime: 30, size: 3 } },
		);
		const lines: string[] = [];
		const probe = folderStatsProbeOf(app, (line) => lines.push(line));

		expect(folderStatsOf(app)).toBeUndefined();
		expect(await probe?.stats("/")).toBeNull();
		expect(await probe?.stats("n")).toBeNull();
		probe?.finish();

		expect(lines[0]).toMatch(/^listing probe: 2 folders, 0 not read, 0 files not in the listing, 3 compared, 1 differ, /);
		expect(lines.slice(1)).toEqual(["listing probe: b.md: listing 20/2, disk 21/2"]);
	});
});
