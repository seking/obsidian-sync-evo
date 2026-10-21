/*
 * Sync Evo
 * Copyright (C) 2026 seking
 *
 * This file is free software, licensed under the GNU Affero General Public
 * License, version 3, as part of Sync Evo. It comes with ABSOLUTELY NO
 * WARRANTY. See LICENSE-AGPL for the full text, and LICENSE for the parts of
 * Sync Evo under other terms.
 *
 * Source: https://github.com/seking/obsidian-sync-evo
 */

import type { App } from "obsidian";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { folderStatsOf, phoneListingOf } from "../src/obsidian/folder-stats";

const platform = vi.hoisted(() => ({ isMobileApp: true }));
vi.mock("obsidian", () => ({ Platform: platform }));

interface Entry {
	readonly type: string;
	readonly name: string;
	readonly mtime?: number;
	readonly size?: number;
}

/** An adapter as on a phone: the listing of each folder by its full path, and the disk by vault path. */
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
	platform.isMobileApp = true;
});

describe("the stats of a folder from the listing on a phone", () => {
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

	test("nothing on a desktop, or where the adapter has no listing to read", () => {
		platform.isMobileApp = false;
		expect(folderStatsOf(appWith({}).app)).toBeUndefined();
		platform.isMobileApp = true;
		expect(folderStatsOf({ vault: { adapter: { stat: () => null } } } as unknown as App)).toBeUndefined();
	});
});


describe("the listing of a folder on a phone", () => {
	test("a folder whose names are all plain is listed from the read, and its stats come from that same read", async () => {
		const { app, asked } = appWith(
			{ "/vault/": [file("a.md", 10, 1), { type: "directory", name: ".obsidian" }, file(".gitignore", 5, 5)] },
			{ "a.md": { mtime: 10, size: 1 } },
		);
		const phone = phoneListingOf(app);

		expect(await phone?.list("/")).toEqual({ files: ["a.md", ".gitignore"], folders: [".obsidian"] });
		expect(await phone?.stats("/")).toEqual(
			new Map([
				["a.md", { mtime: 10, size: 1 }],
				[".gitignore", { mtime: 5, size: 5 }],
			]),
		);
		expect(asked).toEqual(["readdir /vault/", "stat a.md"]);
	});

	test("a folder with any other name is left to the app's listing, and its stats are read on their own", async () => {
		const { app, asked } = appWith(
			{ "/vault/n": [file("b.md", 20, 2), file("日本語.md", 30, 3)] },
			{ "n/b.md": { mtime: 20, size: 2 } },
		);
		const phone = phoneListingOf(app);

		expect(await phone?.list("n")).toBeNull();
		expect(await phone?.stats("n")).toEqual(
			new Map([
				["n/b.md", { mtime: 20, size: 2 }],
				["n/日本語.md", { mtime: 30, size: 3 }],
			]),
		);
		expect(asked).toEqual(["readdir /vault/n", "stat n/b.md"]);
	});

	test("names with a space at either end or a backslash, and listings in another form, are left to the app", async () => {
		const { app } = appWith({
			"/vault/a": [file(" a.md", 1, 1)],
			"/vault/b": [file("b.md ", 1, 1)],
			"/vault/e": [file("e\\f.md", 1, 1)],
			"/vault/c": [file("c.md", 1, 1), { type: "symlink", name: "l" }],
			"/vault/d": new Error("gone"),
		});
		const phone = phoneListingOf(app);

		for (const folder of ["a", "b", "c", "d", "e"]) expect(await phone?.list(folder)).toBeNull();
	});

	test("the read of one folder is used for the stats of that folder alone, once, and the root is one folder however it is spelled", async () => {
		const { app, asked } = appWith(
			{ "/vault/": [file("a.md", 10, 1)], "/vault/n": [file("b.md", 20, 2)] },
			{ "a.md": { mtime: 10, size: 1 }, "n/b.md": { mtime: 20, size: 2 } },
		);
		const phone = phoneListingOf(app);

		await phone?.list("");
		await phone?.stats("n");
		await phone?.stats("/");
		await phone?.stats("/");
		await phone?.list("n");
		await phone?.list("n");

		expect(asked).toEqual([
			"readdir /vault/",
			"readdir /vault/n",
			"stat n/b.md",
			"stat a.md",
			"readdir /vault/",
			"stat a.md",
			"readdir /vault/n",
			"readdir /vault/n",
		]);
	});

	test("once the listing is not trusted, its reads are kept for nothing", async () => {
		const { app, asked } = appWith(
			{ "/vault/": [file("a.md", 10, 1)], "/vault/n": [file("b.md", 20, 2)] },
			{ "a.md": { mtime: 11, size: 1 } },
		);
		const phone = phoneListingOf(app);

		expect(await phone?.stats("/")).toBeNull();
		expect(await phone?.list("n")).toEqual({ files: ["n/b.md"], folders: [] });
		expect(await phone?.stats("n")).toBeNull();
		expect(asked).toEqual(["readdir /vault/", "stat a.md", "readdir /vault/n"]);
	});
});
