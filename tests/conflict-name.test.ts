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
import { conflictCopyPath, originalPathOfConflictCopy } from "../src/core/conflict-name";

// Local time, like the clock of the device: the name is the same in every
// time zone the tests run in.
const at = new Date(2026, 9, 3, 22, 15, 0);

describe("making the name", () => {
	test("the device and the time go before the extension", () => {
		expect(conflictCopyPath("notes/a.md", "iPhone", at)).toBe("notes/a.conflict-from-iPhone-20261003-221500.md");
	});

	test("only the last extension is kept at the end", () => {
		expect(conflictCopyPath("a.tar.gz", "Mac", at)).toBe("a.tar.conflict-from-Mac-20261003-221500.gz");
	});

	test("a leading dot does not start an extension", () => {
		expect(conflictCopyPath(".gitignore", "iPhone", at)).toBe(".gitignore.conflict-from-iPhone-20261003-221500");
		expect(conflictCopyPath("sub/.env.local", "iPhone", at)).toBe(
			"sub/.env.conflict-from-iPhone-20261003-221500.local",
		);
	});

	test("a name without an extension gets it all at the end", () => {
		expect(conflictCopyPath("LICENSE", "iPhone", at)).toBe("LICENSE.conflict-from-iPhone-20261003-221500");
	});

	test("a dot in a folder name is not an extension", () => {
		expect(conflictCopyPath("v1.2/README", "iPhone", at)).toBe("v1.2/README.conflict-from-iPhone-20261003-221500");
	});

	test("every part of the date and the time has its full width", () => {
		expect(conflictCopyPath("a.md", "iPhone", new Date(2026, 0, 2, 3, 4, 5))).toBe(
			"a.conflict-from-iPhone-20260102-030405.md",
		);
	});

	test("from the second attempt on, a number goes before the extension", () => {
		expect(conflictCopyPath("a.md", "iPhone", at, 1)).toBe("a.conflict-from-iPhone-20261003-221500.md");
		expect(conflictCopyPath("a.md", "iPhone", at, 2)).toBe("a.conflict-from-iPhone-20261003-221500-2.md");
		expect(conflictCopyPath("LICENSE", "iPhone", at, 3)).toBe("LICENSE.conflict-from-iPhone-20261003-221500-3");
	});

	test("a file name over 255 bytes is shortened at the end of the name, between characters", () => {
		const bytes = (text: string): number => new TextEncoder().encode(text).length;
		// Three bytes each, and one of four made of two code units.
		const long = `${"あ".repeat(90)}𠮷`;
		const copy = conflictCopyPath(`notes/${long}.md`, "iPhone", at);
		const fileName = copy.slice("notes/".length);
		expect(bytes(fileName)).toBeLessThanOrEqual(255);
		expect(bytes(fileName)).toBeGreaterThan(255 - 3);
		expect(fileName).toMatch(/^あ+\.conflict-from-iPhone-20261003-221500\.md$/);
		expect(originalPathOfConflictCopy(copy)).toMatch(/^notes\/あ+\.md$/);
	});

	test("a name that fits is not shortened", () => {
		const name = "a".repeat(255 - ".conflict-from-iPhone-20261003-221500.md".length);
		expect(conflictCopyPath(`${name}.md`, "iPhone", at)).toBe(`${name}.conflict-from-iPhone-20261003-221500.md`);
	});
});

describe("reading the name back", () => {
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
				expect(originalPathOfConflictCopy(conflictCopyPath(path, device, at, attempt))).toBe(path);
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
		const first = conflictCopyPath("notes/a.md", "iPhone", at);
		const second = conflictCopyPath(first, "Mac", new Date(2026, 9, 4, 8, 0, 0));
		expect(originalPathOfConflictCopy(second)).toBe(first);
	});

	test("the folder is left as it is", () => {
		expect(originalPathOfConflictCopy("a.b/c.d/x.conflict-from-Mac-20261003-221500-2.md")).toBe("a.b/c.d/x.md");
	});
});
