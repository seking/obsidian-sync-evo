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
import { type ListedStats, withListedStats } from "../src/core/listed-stats";
import type { FolderLister } from "../src/core/scan";

const lister: FolderLister = {
	list: (folder) =>
		Promise.resolve(
			folder === "/" ? { files: ["a.md", "Ü.md"], folders: ["n"] } : { files: ["n/b.md"], folders: [] },
		),
};

describe("the stats of the listing", () => {
	test("each file the lister lists gets what the listing of its folder says of it, by its key", async () => {
		const stats: ListedStats = (folder) =>
			Promise.resolve(
				folder === "/"
					? new Map([
							["a.md", { mtime: 1, size: 2 }],
							["Ü.md", { mtime: 3, size: 4 }],
							["gone.md", { mtime: 5, size: 6 }],
						])
					: null,
			);
		const listing = withListedStats(lister, stats);

		expect(await listing.list("/")).toEqual({ files: ["a.md", "Ü.md"], folders: ["n"] });
		await listing.list("n");

		// What the lister did not list is left out, and so is a folder the listing tells nothing of.
		expect(listing.indexed()).toEqual(
			new Map([
				["a.md", { mtime: 1, size: 2 }],
				["Ü.md".normalize("NFC"), { mtime: 3, size: 4 }],
			]),
		);
	});

	test("a lister that cannot tell links stays one, and one that can is still asked", async () => {
		expect(withListedStats(lister, () => Promise.resolve(null)).linksIn).toBeUndefined();
		const linking = withListedStats(
			{ ...lister, linksIn: (folder) => Promise.resolve([`${folder}link`]) },
			() => Promise.resolve(null),
		);
		expect(await linking.linksIn?.("n/")).toEqual(["n/link"]);
	});
});
