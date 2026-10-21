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

import { describe, expect, test } from "vitest";
import {
	MERGED_FOLDER,
	conflictCopyPath,
	isConflictFolder,
	isCopyInConflictFolder,
	mergedCopyPath,
	originalPathOfConflictCopy,
	dayEndOfConflictCopy,
} from "../src/core/conflict-name";
import { earlierCopyPath } from "./support/earlier-copy-name";

// Local time, like the clock of the device: the name is the same in every
// time zone the tests run in.
const at = new Date(2026, 9, 11, 22, 15, 0);

describe("making the name", () => {
	test("the copy goes to the folder of the copies, with the time first and the device last", () => {
		expect(conflictCopyPath("notes/a.md", "iPhone", at)).toBe("_conflicts/2026-10-11 a (iPhone).md");
	});

	test("the folders of the file are not kept, at any depth", () => {
		expect(conflictCopyPath("a.md", "iPhone", at)).toBe("_conflicts/2026-10-11 a (iPhone).md");
		expect(conflictCopyPath("a/b/c/d.md", "iPhone", at)).toBe("_conflicts/2026-10-11 d (iPhone).md");
		expect(conflictCopyPath("_conflicts/sub/d.md", "iPhone", at)).toBe("_conflicts/2026-10-11 d (iPhone).md");
	});

	test("only the last extension is kept at the end", () => {
		expect(conflictCopyPath("a.tar.gz", "Mac", at)).toBe("_conflicts/2026-10-11 a.tar (Mac).gz");
	});

	test("a leading dot does not start an extension", () => {
		expect(conflictCopyPath(".gitignore", "iPhone", at)).toBe("_conflicts/2026-10-11 .gitignore (iPhone)");
		expect(conflictCopyPath("sub/.env.local", "iPhone", at)).toBe("_conflicts/2026-10-11 .env (iPhone).local");
	});

	test("a name without an extension gets it all at the end", () => {
		expect(conflictCopyPath("LICENSE", "iPhone", at)).toBe("_conflicts/2026-10-11 LICENSE (iPhone)");
	});

	test("a dot in a folder name is not an extension", () => {
		expect(conflictCopyPath("v1.2/README", "iPhone", at)).toBe("_conflicts/2026-10-11 README (iPhone)");
	});

	test("the time of day is not in the name: two copies of one day have one name", () => {
		const morning = conflictCopyPath("notes/a.md", "iPhone", new Date(2026, 9, 11, 0, 0, 0));
		const night = conflictCopyPath("notes/a.md", "iPhone", new Date(2026, 9, 11, 23, 59, 59));
		expect(morning).toBe("_conflicts/2026-10-11 a (iPhone).md");
		expect(night).toBe(morning);
		// The number tells them apart, and the day after has its own name.
		expect(conflictCopyPath("notes/a.md", "iPhone", at, 2)).toBe("_conflicts/2026-10-11 a (iPhone) (1).md");
		expect(conflictCopyPath("notes/a.md", "iPhone", new Date(2026, 9, 12, 0, 0, 0))).toBe(
			"_conflicts/2026-10-12 a (iPhone).md",
		);
	});

	test("every part of the date has its full width", () => {
		expect(conflictCopyPath("a.md", "iPhone", new Date(2026, 0, 2, 3, 4, 5))).toBe(
			"_conflicts/2026-01-02 a (iPhone).md",
		);
	});

	test("from the second attempt on, a number goes before the extension", () => {
		expect(conflictCopyPath("a.md", "iPhone", at, 1)).toBe("_conflicts/2026-10-11 a (iPhone).md");
		expect(conflictCopyPath("a.md", "iPhone", at, 2)).toBe("_conflicts/2026-10-11 a (iPhone) (1).md");
		expect(conflictCopyPath("LICENSE", "iPhone", at, 3)).toBe("_conflicts/2026-10-11 LICENSE (iPhone) (2)");
	});

	test("the folder is spelled as it is handed in", () => {
		expect(conflictCopyPath("notes/a.md", "iPhone", at, 1, "_Conflicts")).toBe(
			"_Conflicts/2026-10-11 a (iPhone).md",
		);
	});

	test("a file name over 255 bytes is shortened at the end of the name, between characters", () => {
		const bytes = (text: string): number => new TextEncoder().encode(text).length;
		// Three bytes each, and one of four made of two code units.
		const long = `${"あ".repeat(90)}𠮷`;
		const copy = conflictCopyPath(`notes/${long}.md`, "iPhone", at);
		const fileName = copy.slice("_conflicts/".length);
		expect(bytes(fileName)).toBeLessThanOrEqual(255);
		expect(bytes(fileName)).toBeGreaterThan(255 - 3);
		expect(fileName).toMatch(/^2026-10-11 あ+ \(iPhone\)\.md$/);
		// With a number, the name gives way for it.
		const second = conflictCopyPath(`notes/${long}.md`, "iPhone", at, 12).slice("_conflicts/".length);
		expect(bytes(second)).toBeLessThanOrEqual(255);
		expect(second).toMatch(/^2026-10-11 あ+ \(iPhone\) \(11\)\.md$/);
	});

	test("a name that fits is not shortened", () => {
		const name = "a".repeat(255 - "2026-10-11  (iPhone).md".length);
		expect(conflictCopyPath(`${name}.md`, "iPhone", at)).toBe(`_conflicts/2026-10-11 ${name} (iPhone).md`);
	});

	test("the copy of a copy is a copy like any other: no number is added to the name it has", () => {
		const first = conflictCopyPath("notes/a.md", "iPhone", at);
		expect(conflictCopyPath(first, "Mac", new Date(2026, 9, 12, 8, 0, 0))).toBe(
			"_conflicts/2026-10-12 2026-10-11 a (iPhone) (Mac).md",
		);
		const earlier = earlierCopyPath("notes/a.md", "iPhone", at);
		expect(conflictCopyPath(earlier, "Mac", new Date(2026, 9, 12, 8, 0, 0))).toBe(
			"_conflicts/2026-10-12 a.conflict-from-iPhone-20261011-221500 (Mac).md",
		);
	});
});

describe("the name of the content from before a merge", () => {
	const inFolder = (path: string): string => path.slice(`${MERGED_FOLDER}/`.length);

	test("it goes to a folder of its own in the .trash/, with the day first and no device", () => {
		expect(MERGED_FOLDER).toBe(".trash/.sync-evo-merged");
		expect(mergedCopyPath("notes/a.md", at)).toBe(".trash/.sync-evo-merged/2026-10-11 a.md");
	});

	test("the folders of the file are not kept", () => {
		expect(mergedCopyPath("a.md", at)).toBe(".trash/.sync-evo-merged/2026-10-11 a.md");
		expect(mergedCopyPath("a/b/c/d.md", at)).toBe(".trash/.sync-evo-merged/2026-10-11 d.md");
	});

	test("the day is the one of the device's clock, and nothing of the time of day", () => {
		expect(mergedCopyPath("a.md", new Date(2026, 9, 11, 0, 0, 0))).toBe(mergedCopyPath("a.md", new Date(2026, 9, 11, 23, 59, 59)));
		expect(mergedCopyPath("a.md", new Date(2026, 0, 2, 3, 4, 5))).toBe(".trash/.sync-evo-merged/2026-01-02 a.md");
	});

	test("a second one of a day gets a number before the extension, counted from 1", () => {
		expect(mergedCopyPath("notes/a.md", at, 1)).toBe(".trash/.sync-evo-merged/2026-10-11 a.md");
		expect(mergedCopyPath("notes/a.md", at, 2)).toBe(".trash/.sync-evo-merged/2026-10-11 a (1).md");
		expect(mergedCopyPath("notes/a.md", at, 3)).toBe(".trash/.sync-evo-merged/2026-10-11 a (2).md");
		expect(mergedCopyPath("a.tar.gz", at, 2)).toBe(".trash/.sync-evo-merged/2026-10-11 a.tar (1).gz");
	});

	test("a name without an extension gets none, and the number at its end", () => {
		expect(mergedCopyPath("LICENSE", at)).toBe(".trash/.sync-evo-merged/2026-10-11 LICENSE");
		expect(mergedCopyPath("v1.2/README", at, 2)).toBe(".trash/.sync-evo-merged/2026-10-11 README (1)");
	});

	test("a leading dot does not start an extension", () => {
		expect(mergedCopyPath(".gitignore", at)).toBe(".trash/.sync-evo-merged/2026-10-11 .gitignore");
		expect(mergedCopyPath(".gitignore", at, 2)).toBe(".trash/.sync-evo-merged/2026-10-11 .gitignore (1)");
		expect(mergedCopyPath("sub/.env.local", at)).toBe(".trash/.sync-evo-merged/2026-10-11 .env.local");
		expect(mergedCopyPath("sub/.env.local", at, 2)).toBe(".trash/.sync-evo-merged/2026-10-11 .env (1).local");
	});

	test("a name of characters of several bytes is kept as it is", () => {
		expect(mergedCopyPath("日記/今日のメモ 𠮷.md", at)).toBe(".trash/.sync-evo-merged/2026-10-11 今日のメモ 𠮷.md");
		expect(mergedCopyPath("日記/今日のメモ 𠮷.md", at, 2)).toBe(".trash/.sync-evo-merged/2026-10-11 今日のメモ 𠮷 (1).md");
	});

	test("a file name over 255 bytes is shortened at the end of the name, between characters", () => {
		const bytes = (text: string): number => new TextEncoder().encode(text).length;
		// Three bytes each, and one of four made of two code units.
		const long = `${"あ".repeat(90)}𠮷`;
		const fileName = inFolder(mergedCopyPath(`notes/${long}.md`, at));
		expect(bytes(fileName)).toBeLessThanOrEqual(255);
		expect(bytes(fileName)).toBeGreaterThan(255 - 3);
		expect(fileName).toMatch(/^2026-10-11 あ+\.md$/);
		// With a number, the name gives way for it.
		const second = inFolder(mergedCopyPath(`notes/${long}.md`, at, 12));
		expect(bytes(second)).toBeLessThanOrEqual(255);
		expect(second).toMatch(/^2026-10-11 あ+ \(11\)\.md$/);
		// One byte each, with nothing to cut between.
		const plain = inFolder(mergedCopyPath(`${"a".repeat(300)}.md`, at));
		expect(plain).toBe(`2026-10-11 ${"a".repeat(255 - "2026-10-11 .md".length)}.md`);
	});

	test("a name that fits is not shortened", () => {
		const name = "a".repeat(255 - "2026-10-11 .md".length);
		expect(mergedCopyPath(`${name}.md`, at)).toBe(`.trash/.sync-evo-merged/2026-10-11 ${name}.md`);
	});
});

describe("telling a copy in the folder of the copies", () => {
	test("every name that is made is told, under any device name", () => {
		const paths = ["a.md", "notes/a.md", "a.tar.gz", ".gitignore", "LICENSE", "下書き/メモ.md", "img 1.PNG", "a."];
		const devices = ["iPhone", "Mac", "my-phone-2", "Pixel 9", "My.Phone", "20261003-221500", "電話"];
		for (const path of paths) {
			for (const device of devices) {
				for (const attempt of [1, 2, 13]) {
					expect(isCopyInConflictFolder(conflictCopyPath(path, device, at, attempt))).toBe(true);
				}
			}
		}
	});

	test("only the start of the name counts: a date with its hyphens, and a space", () => {
		expect(isCopyInConflictFolder("_conflicts/2026-10-11 a (iPhone).md")).toBe(true);
		expect(isCopyInConflictFolder("_conflicts/2026-10-11 anything at all")).toBe(true);
		expect(isCopyInConflictFolder("_conflicts/2026-10-11 ")).toBe(true);
		// Digits that are no date are a copy all the same: it is never tidied.
		expect(isCopyInConflictFolder("_conflicts/9999-99-99 a.md")).toBe(true);
		expect(isCopyInConflictFolder("_conflicts/2026-10-11 a (iPhone) (1).md")).toBe(true);
	});

	test.each(["_conflicts/20261012 a (iPhone).md", "_conflicts/20261012-001421 a (iPhone).md"])(
		"%j, as a beta once named its copies, is no copy: a file like any other",
		(path) => {
			expect(isCopyInConflictFolder(path)).toBe(false);
			expect(dayEndOfConflictCopy(path)).toBeNull();
			// Not one of the earlier form either.
			expect(originalPathOfConflictCopy(path)).toBeNull();
		},
	);

	test.each([
		"_conflicts/a.md",
		"_conflicts/2026-10-11",
		"_conflicts/2026-10-11a.md",
		"_conflicts/2026-10-11_a.md",
		"_conflicts/2026-10-11-a.md",
		"_conflicts/2026-10-1 a.md",
		"_conflicts/2026-10-111 a.md",
		"_conflicts/26-10-11 a.md",
		"_conflicts/2026/10/11 a.md",
		"_conflicts/2026.10.11 a.md",
		"_conflicts/2026-1011 a.md",
		"_conflicts/ 2026-10-11 a.md",
		"_conflicts/x2026-10-11 a.md",
		"_conflicts/２０２６-１０-１１ a.md",
		"_conflicts/2026-10-11\u00a0a.md",
	])("%j is not a copy", (path) => {
		expect(isCopyInConflictFolder(path)).toBe(false);
	});

	test("only directly in the folder, and only in that folder at the root", () => {
		expect(isCopyInConflictFolder("_conflicts/sub/2026-10-11 a (iPhone).md")).toBe(false);
		expect(isCopyInConflictFolder("notes/_conflicts/2026-10-11 a (iPhone).md")).toBe(false);
		expect(isCopyInConflictFolder("conflicts/2026-10-11 a (iPhone).md")).toBe(false);
		expect(isCopyInConflictFolder("_conflicts2/2026-10-11 a (iPhone).md")).toBe(false);
		expect(isCopyInConflictFolder("2026-10-11 a (iPhone).md")).toBe(false);
		expect(isCopyInConflictFolder("_conflicts")).toBe(false);
	});

	test("the folder is told without the cases", () => {
		expect(isConflictFolder("_conflicts")).toBe(true);
		expect(isConflictFolder("_Conflicts")).toBe(true);
		expect(isConflictFolder("_CONFLICTS")).toBe(true);
		expect(isConflictFolder("conflicts")).toBe(false);
		expect(isConflictFolder("_conflicts/sub")).toBe(false);
		expect(isCopyInConflictFolder("_Conflicts/2026-10-11 a (iPhone).md")).toBe(true);
	});
});

describe("reading the day of a copy", () => {
	test("the end of the day in the name, read as UTC: the start of the day after", () => {
		expect(dayEndOfConflictCopy(conflictCopyPath("notes/a.md", "iPhone", at))).toBe(Date.UTC(2026, 9, 12));
		expect(dayEndOfConflictCopy("_Conflicts/2026-01-02 a.md")).toBe(Date.UTC(2026, 0, 3));
		// Over the end of a month, of a year, and of a February with 29 days.
		expect(dayEndOfConflictCopy("_conflicts/2026-10-31 a.md")).toBe(Date.UTC(2026, 10, 1));
		expect(dayEndOfConflictCopy("_conflicts/2026-12-31 a.md")).toBe(Date.UTC(2027, 0, 1));
		expect(dayEndOfConflictCopy("_conflicts/2028-02-29 a.md")).toBe(Date.UTC(2028, 2, 1));
	});

	test("never long before the moment the copy was made, in whatever zone it was named", () => {
		// Off by the offset of the zone at most: nothing against 30 days.
		const end = dayEndOfConflictCopy(conflictCopyPath("a.md", "iPhone", at)) ?? 0;
		expect(end - at.getTime()).toBeGreaterThan(-14 * 60 * 60 * 1000);
		expect(end - at.getTime()).toBeLessThanOrEqual((24 + 14) * 60 * 60 * 1000);
	});

	test.each([
		"_conflicts/2026-13-11 a.md",
		"_conflicts/2026-10-00 a.md",
		"_conflicts/2026-02-30 a.md",
		"_conflicts/2027-02-29 a.md",
		"_conflicts/2026-10-32 a.md",
		"_conflicts/0000-00-00 a.md",
		"_conflicts/0050-01-01 a.md",
		"_conflicts/9999-99-99 a.md",
	])("%j holds no date", (path) => {
		expect(isCopyInConflictFolder(path)).toBe(true);
		expect(dayEndOfConflictCopy(path)).toBeNull();
	});

	test("a path that is no copy in the folder has none", () => {
		expect(dayEndOfConflictCopy("notes/2026-10-11 a.md")).toBeNull();
		expect(dayEndOfConflictCopy("_conflicts/a.md")).toBeNull();
		expect(dayEndOfConflictCopy(earlierCopyPath("notes/a.md", "iPhone", at))).toBeNull();
	});
});

describe("reading the name of the earlier form back", () => {
	const paths = [
		"a.md",
		"notes/a.md",
		"a.tar.gz",
		".gitignore",
		"sub/.env.local",
		"LICENSE",
		"v1.2/README",
		"下書き/メモ.md",
		"img 1.PNG",
		"a.",
	];
	const devices = ["iPhone", "Mac", "my-phone-2", "Pixel 9", "My.Phone", "20261003-221500", "電話"];

	test.each(paths)("the copy of %j gives the path back, under any device name", (path) => {
		for (const device of devices) {
			for (const attempt of [1, 2, 13]) {
				expect(originalPathOfConflictCopy(earlierCopyPath(path, device, at, attempt))).toBe(path);
			}
		}
	});

	test.each([
		"a.md",
		"notes/a.conflict.md",
		"a.conflict-from-iPhone.md",
		"a.conflict-from-iPhone-2026100-221500.md",
		"a.conflict-from-iPhone-20261003-22150.md",
		"a.conflict-from-iPhone-20261003-221500-.md",
		"a.conflict-from-iPhone-20261003-221500-x.md",
		"a.conflict-from--20261003-221500.md",
		".conflict-from-iPhone-20261003-221500.md",
		"conflict-from-iPhone-20261003-221500.md",
		"a.conflict-from-iPhone-20261003-221500/b.md",
	])("%j is not a copy", (path) => {
		expect(originalPathOfConflictCopy(path)).toBeNull();
	});

	test("a copy of a copy gives the copy it was made of", () => {
		const first = earlierCopyPath("notes/a.md", "iPhone", at);
		const second = earlierCopyPath(first, "Mac", new Date(2026, 9, 4, 8, 0, 0));
		expect(originalPathOfConflictCopy(second)).toBe(first);
	});

	test("the folder is left as it is", () => {
		expect(originalPathOfConflictCopy("a.b/c.d/x.conflict-from-Mac-20261003-221500-2.md")).toBe("a.b/c.d/x.md");
	});

	test("a copy in the folder of the copies is never one of the earlier form, whatever its end", () => {
		// What a device with an older version makes of a copy in the folder.
		const made = earlierCopyPath(conflictCopyPath("notes/a.md", "iPhone", at), "Mac", at);
		expect(made).toBe("_conflicts/2026-10-11 a (iPhone).conflict-from-Mac-20261011-221500.md");
		expect(isCopyInConflictFolder(made)).toBe(true);
		expect(originalPathOfConflictCopy(made)).toBeNull();
		// Not so for a file in the folder that is no copy there, or below it.
		expect(originalPathOfConflictCopy("_conflicts/a.conflict-from-Mac-20261011-221500.md")).toBe("_conflicts/a.md");
		expect(originalPathOfConflictCopy("_conflicts/sub/2026-10-11 a.conflict-from-Mac-20261011-221500.md")).toBe(
			"_conflicts/sub/2026-10-11 a.md",
		);
	});
});
