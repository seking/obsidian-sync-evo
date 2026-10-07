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
import {
	differOnlyInSpelling,
	foldersTo,
	isDotPath,
	joinPath,
	lastOf,
	parentOf,
	pickSpelling,
	trashOptionOf,
	trashRoute,
} from "../src/core/vault-routes";

const NFC = "が.md".normalize("NFC");
const NFD = "が.md".normalize("NFD");

describe("isDotPath", () => {
	test.each([".github/a.yml", "notes/.x/a.md", ".hidden.md", "notes/.hidden.md", ".obsidian/app.json", ".a/.b"])(
		"%s goes through the adapter",
		(path) => {
			expect(isDotPath(path)).toBe(true);
		},
	);

	test.each(["a.md", "notes/a.md", "notes/a.b.md", "a./b.md", "notes/a.conflict-from-Mac-20261003-221500.md"])(
		"%s goes through the index",
		(path) => {
			expect(isDotPath(path)).toBe(false);
		},
	);
});

describe("the parts of a path", () => {
	test("parentOf", () => {
		expect(parentOf("a/b/c.md")).toBe("a/b");
		expect(parentOf("c.md")).toBe("");
	});

	test("lastOf", () => {
		expect(lastOf("a/b/c.md")).toBe("c.md");
		expect(lastOf("c.md")).toBe("c.md");
	});

	test("joinPath", () => {
		expect(joinPath("a/b", "c.md")).toBe("a/b/c.md");
		expect(joinPath("", "c.md")).toBe("c.md");
	});

	test("foldersTo lists the folders from the top down", () => {
		expect(foldersTo("a/b/c.md")).toEqual(["a", "a/b"]);
		expect(foldersTo("c.md")).toEqual([]);
		// A folder itself, written with the slash that ends it.
		expect(foldersTo("a/b/")).toEqual(["a", "a/b"]);
	});
});

describe("trashOptionOf", () => {
	test.each(["system", "local", "none"] as const)("%s is a setting", (value) => {
		expect(trashOptionOf(value)).toBe(value);
	});

	test.each([undefined, null, "", "trash", "System", 1, true, {}])("%j is not", (value) => {
		expect(trashOptionOf(value)).toBeNull();
	});
});

describe("trashRoute", () => {
	test("an ordinary deletion of a file of the index follows the setting through the app", () => {
		for (const option of ["system", "local", "none", null] as const) {
			expect(trashRoute("user-setting", true, option)).toBe("file-manager");
		}
	});

	test("an ordinary deletion of a path outside the index follows the setting through the adapter", () => {
		expect(trashRoute("user-setting", false, "system")).toBe("adapter-system");
		expect(trashRoute("user-setting", false, "local")).toBe("adapter-local");
		expect(trashRoute("user-setting", false, "none")).toBe("adapter-remove");
	});

	test("a setting that could not be read keeps the file in .trash/", () => {
		expect(trashRoute("user-setting", false, null)).toBe("adapter-local");
	});

	test("a file moved away to protect it goes to .trash/ whatever the setting", () => {
		for (const option of ["system", "local", "none", null] as const) {
			expect(trashRoute("vault-trash", true, option)).toBe("vault-local");
			expect(trashRoute("vault-trash", false, option)).toBe("adapter-local");
		}
	});
});

describe("pickSpelling", () => {
	test("the name as it was asked for", () => {
		expect(pickSpelling(["a.md", "Notes.md", "b.md"], "Notes.md")).toBe("Notes.md");
	});

	test("where the cases are told apart, the exact name wins over the other", () => {
		expect(pickSpelling(["notes.md", "Notes.md"], "Notes.md")).toBe("Notes.md");
		expect(pickSpelling(["Notes.md", "notes.md"], "notes.md")).toBe("notes.md");
	});

	test("a single name that differs in case is the file, where the disk found it under the wanted one", () => {
		expect(pickSpelling(["a.md", "notes.md"], "Notes.md")).toBe("notes.md");
	});

	test("a name in the other Unicode form is the same name, and comes back as the folder has it", () => {
		expect(pickSpelling([NFC], NFD)).toBe(NFC);
		expect(pickSpelling([NFD], NFC)).toBe(NFD);
	});

	test("the same name in the other Unicode form wins over a name that differs in case", () => {
		expect(pickSpelling(["É.md".normalize("NFC").toLowerCase(), "É.md".normalize("NFC")], "É.md".normalize("NFD"))).toBe(
			"É.md".normalize("NFC"),
		);
	});

	test("two names that differ in case from the wanted one are no answer", () => {
		expect(pickSpelling(["NOTES.md", "notes.md"], "Notes.md")).toBeNull();
	});

	test("nothing like it", () => {
		expect(pickSpelling(["a.md"], "b.md")).toBeNull();
		expect(pickSpelling([], "b.md")).toBeNull();
	});
});

describe("differOnlyInSpelling", () => {
	test("a change of case, of a file or of a folder on the way", () => {
		expect(differOnlyInSpelling("notes.md", "Notes.md")).toBe(true);
		expect(differOnlyInSpelling("notes/a.md", "Notes/a.md")).toBe(true);
	});

	test("a change of Unicode form", () => {
		expect(differOnlyInSpelling(NFC, NFD)).toBe(true);
	});

	test("another name", () => {
		expect(differOnlyInSpelling("a.md", "a.conflict-from-Mac-20261003-221500.md")).toBe(false);
		expect(differOnlyInSpelling("notes/a.md", "other/a.md")).toBe(false);
	});
});
