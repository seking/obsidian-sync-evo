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
import { conflictCopyPath } from "../src/core/conflict-name";
import {
	COPY_KEPT_MS,
	forgetTidiedCopies,
	isCopyDue,
	readTidiedCopies,
	TIDIED_COPIES_KEY,
	type TidyDeps,
	tidyConflictCopies,
} from "../src/core/conflict-tidy";
import { makeMarker } from "../src/core/state";
import { earlierCopyPath } from "./support/earlier-copy-name";
import { blobHash } from "./support/memory-backend";
import { MemoryIndex } from "./support/memory-index";
import { MemoryPullVault } from "./support/memory-pull-vault";
import { MemoryStateStore } from "./support/memory-state-store";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 15, 12, 0, 0);

/**
 * The copy of `name.md` whose name says it was made this long ago. The time
 * of a name is read as UTC, so the name is made on a clock that shows UTC:
 * the edge of the 30 days is then the same in every zone the tests run in.
 */
function copyFrom(ago: number, name = "a", device = "iPhone"): string {
	const at = new Date(NOW - ago);
	const shown = new Date(
		at.getUTCFullYear(),
		at.getUTCMonth(),
		at.getUTCDate(),
		at.getUTCHours(),
		at.getUTCMinutes(),
		at.getUTCSeconds(),
	);
	return conflictCopyPath(`notes/${name}.md`, device, shown);
}

interface Setup {
	readonly vault: MemoryPullVault;
	readonly store: MemoryStateStore;
	readonly ops: string[];
	tidy(overrides?: Partial<TidyDeps>): Promise<string[]>;
}

function setup(files: Record<string, string>, options: { caseSensitive?: boolean } = {}): Setup {
	const vault = new MemoryPullVault({ caseSensitive: options.caseSensitive ?? false, now: () => NOW });
	vault.putAll({ ".obsidian/app.json": "{}", ...files });
	const store = new MemoryStateStore();
	const ops: string[] = [];
	vault.before = (op, path) => {
		ops.push(`${op} ${path}`);
	};
	return { vault, store, ops, tidy: (overrides = {}) => tidyConflictCopies({ store, vault, now: () => NOW, ...overrides }) };
}

describe("when a copy has had its time", () => {
	test("30 days of 24 hours from the time in its name, to the second", () => {
		expect(COPY_KEPT_MS).toBe(30 * DAY);
		expect(isCopyDue(copyFrom(30 * DAY), NOW)).toBe(true);
		expect(isCopyDue(copyFrom(30 * DAY + 1000), NOW)).toBe(true);
		expect(isCopyDue(copyFrom(30 * DAY - 1000), NOW)).toBe(false);
		expect(isCopyDue(copyFrom(0), NOW)).toBe(false);
		expect(isCopyDue(copyFrom(400 * DAY), NOW)).toBe(true);
	});

	test("never a time that is yet to come, or digits that are no date", () => {
		expect(isCopyDue(copyFrom(-DAY), NOW)).toBe(false);
		expect(isCopyDue(copyFrom(-400 * DAY), NOW)).toBe(false);
		expect(isCopyDue("_conflicts/20251340-120000 a (iPhone).md", NOW)).toBe(false);
		expect(isCopyDue("_conflicts/00000000-000000 a (iPhone).md", NOW)).toBe(false);
	});

	test("never a file that is no copy in the folder: one of the earlier form, one in a folder below, one elsewhere", () => {
		const old = new Date(NOW - 400 * DAY);
		expect(isCopyDue(earlierCopyPath("notes/a.md", "iPhone", old), NOW)).toBe(false);
		expect(isCopyDue(copyFrom(400 * DAY).replace("_conflicts/", "_conflicts/sub/"), NOW)).toBe(false);
		expect(isCopyDue(copyFrom(400 * DAY).replace("_conflicts/", "notes/"), NOW)).toBe(false);
		expect(isCopyDue("_conflicts/notes from 2020.md", NOW)).toBe(false);
	});
});

describe("tidying the folder of the copies", () => {
	test("a copy of 30 days goes to the .trash/ of the vault; a younger one, and everything that is no copy, stays", async () => {
		const due = copyFrom(30 * DAY);
		const older = copyFrom(90 * DAY, "b", "Mac");
		const young = copyFrom(30 * DAY - 1000, "c");
		const earlier = earlierCopyPath("notes/a.md", "iPhone", new Date(NOW - 90 * DAY));
		const below = copyFrom(90 * DAY, "d").replace("_conflicts/", "_conflicts/sub/");
		const s = setup({
			[due]: "one",
			[older]: "two",
			[young]: "three",
			[earlier]: "four",
			[below]: "five",
			"_conflicts/my notes.md": "six",
			"_conflicts/20250101 a.md": "seven",
			"notes/a.md": "A",
		});

		const tidied = await s.tidy();

		expect(tidied.sort()).toEqual([due, older].sort());
		expect(s.vault.trashed.map(({ path, mode, content }) => `${mode} ${path} ${content}`).sort()).toEqual(
			[`vault-trash ${due} one`, `vault-trash ${older} two`].sort(),
		);
		expect(s.vault.paths().sort()).toEqual(
			[".obsidian/app.json", young, earlier, below, "_conflicts/my notes.md", "_conflicts/20250101 a.md", "notes/a.md"].sort(),
		);
		// Remembered, for the push that deletes them on the remote.
		expect((await readTidiedCopies(s.store)).sort()).toEqual([due, older].sort());
		// The root and the folder, and nothing else of the vault.
		expect(s.ops.filter((op) => op.startsWith("list"))).toEqual(["list /", "list _conflicts"]);
	});

	test("a copy that was renamed, or moved out of the folder, is kept", async () => {
		const s = setup({
			"_conflicts/keep 20250101-120000 a (iPhone).md": "renamed",
			"kept/20250101-120000 a (iPhone).md": "moved",
		});
		expect(await s.tidy()).toEqual([]);
		expect(s.vault.trashed).toEqual([]);
		expect(await s.store.getMeta(TIDIED_COPIES_KEY)).toBeUndefined();
	});

	test("with no folder, or nothing due, nothing is done and nothing is remembered", async () => {
		const none = setup({ "a.md": "A" });
		expect(await none.tidy()).toEqual([]);
		expect(none.ops).toEqual(["list /"]);
		const young = setup({ [copyFrom(DAY)]: "mine" });
		expect(await young.tidy()).toEqual([]);
		expect(await young.store.getMeta(TIDIED_COPIES_KEY)).toBeUndefined();
		expect(young.ops.filter((op) => !op.startsWith("list"))).toEqual([]);
	});

	test("a file named like the folder is no folder: nothing is listed in it, and nothing is moved", async () => {
		const s = setup({ _conflicts: "a file of the user's" });
		expect(await s.tidy()).toEqual([]);
		expect(s.ops).toEqual(["list /"]);
		expect(s.vault.text("_conflicts")).toBe("a file of the user's");
	});

	test.each([true, false])("a folder the vault spells otherwise is tidied as it is spelled (case-sensitive: %s)", async (caseSensitive) => {
		const copy = copyFrom(40 * DAY).replace("_conflicts/", "_Conflicts/");
		const s = setup({ [copy]: "mine" }, { caseSensitive });
		expect(await s.tidy()).toEqual([copy]);
		expect(s.vault.trashed.map((file) => file.path)).toEqual([copy]);
	});

	test("a copy with a marker left, and the copy a marked copy is of, wait for the pull that settles them", async () => {
		const half = copyFrom(40 * DAY, "a");
		const inConflict = copyFrom(50 * DAY, "b");
		const free = copyFrom(60 * DAY, "c");
		const s = setup({ [half]: "mi", [inConflict]: "mine", [free]: "mine" });
		await s.store.putMarker(makeMarker(half, null, blobHash("mine"), true, "notes/a.md"));
		// A copy that was itself in conflict when the pull stopped.
		await s.store.putMarker(makeMarker(copyFrom(0, "x"), null, blobHash("mine"), true, inConflict));

		expect(await s.tidy()).toEqual([free]);
		expect(s.vault.text(half)).toBe("mi");
		expect(s.vault.text(inConflict)).toBe("mine");
		expect(await readTidiedCopies(s.store)).toEqual([free]);
	});

	test("what the pull left alone is left alone, without regard to how it is asked", async () => {
		const putOff = copyFrom(40 * DAY, "a");
		const free = copyFrom(40 * DAY, "b");
		const s = setup({ [putOff]: "mine", [free]: "mine" });
		expect(await s.tidy({ leaveAlone: (path) => path === putOff })).toEqual([free]);
		expect(s.vault.text(putOff)).toBe("mine");
	});

	test("a copy that is being typed in stays, in a sync that started by itself; the next sync takes it", async () => {
		const typed = copyFrom(40 * DAY, "a");
		const free = copyFrom(40 * DAY, "b");
		const s = setup({ [typed]: "mine", [free]: "mine" });
		s.vault.open(typed, "mine, and more");

		expect(await s.tidy({ beingEdited: (path) => path === typed })).toEqual([free]);
		// Not even asked to save.
		expect(s.vault.text(typed)).toBe("mine");
		expect(s.ops).not.toContain(`save ${typed}`);

		expect(await s.tidy({ beingEdited: () => false })).toEqual([typed]);
	});

	test("typing that begins while the copies are moved is seen too", async () => {
		const first = copyFrom(41 * DAY, "a");
		const second = copyFrom(40 * DAY, "b");
		const s = setup({ [first]: "one", [second]: "two" });
		let typing = false;
		s.vault.before = (op) => {
			if (op === "trash") typing = true;
		};
		const tidied = await s.tidy({ beingEdited: () => typing });
		expect(tidied).toHaveLength(1);
		expect(s.vault.paths().filter((path) => path.startsWith("_conflicts/"))).toHaveLength(1);
	});

	test("a copy that is open in an editor is moved all the same, with what was typed saved first", async () => {
		const copy = copyFrom(40 * DAY);
		const s = setup({ [copy]: "mine" });
		s.vault.open(copy, "mine, and more");

		expect(await s.tidy()).toEqual([copy]);
		expect(s.vault.trashed).toEqual([{ path: copy, mode: "vault-trash", content: "mine, and more" }]);
	});

	test("an editor that cannot save keeps its copy; a file that cannot be moved stays; the others go", async () => {
		const unsaved = copyFrom(40 * DAY, "a");
		const stuck = copyFrom(40 * DAY, "b");
		const free = copyFrom(40 * DAY, "c");
		const s = setup({ [unsaved]: "one", [stuck]: "two", [free]: "three" });
		s.vault.openFailing(unsaved);
		s.vault.before = (op, path) => {
			if (op === "trash" && path === stuck) throw new Error("the trash is full");
		};

		expect(await s.tidy()).toEqual([free]);
		expect(s.vault.paths().filter((path) => path.startsWith("_conflicts/")).sort()).toEqual([unsaved, stuck].sort());
	});

	test("a folder that cannot be listed is not tidied, and fails nothing", async () => {
		const copy = copyFrom(40 * DAY);
		const s = setup({ [copy]: "mine" });
		const lines: string[] = [];
		s.vault.before = (op, path) => {
			if (op === "list" && path === "_conflicts") throw new Error("the disk does not answer");
		};
		expect(await s.tidy({ log: (line) => lines.push(line) })).toEqual([]);
		expect(s.vault.text(copy)).toBe("mine");
		expect(lines).toEqual(["conflict copies: the folder could not be listed (the disk does not answer)"]);
	});

	test("stopped between two copies: what was moved is answered, and the rest stays", async () => {
		const copies = [copyFrom(40 * DAY, "a"), copyFrom(40 * DAY, "b"), copyFrom(40 * DAY, "c")];
		const s = setup(Object.fromEntries(copies.map((copy) => [copy, "mine"])));
		const stop = new AbortController();
		s.vault.before = (op) => {
			if (op === "trash") stop.abort();
		};
		const tidied = await s.tidy({ signal: stop.signal });
		expect(tidied).toHaveLength(1);
		expect(s.vault.trashed.map((file) => file.path)).toEqual(tidied);
		// All three are remembered: the two that stayed are forgotten by the push.
		expect((await readTidiedCopies(s.store)).sort()).toEqual([...copies].sort());
	});

	test("with the index of the app, no folder is listed", async () => {
		const due = copyFrom(40 * DAY);
		const young = copyFrom(DAY, "b");
		const s = setup({ [due]: "mine", [young]: "mine", "_conflicts/notes.md": "N" });
		const index = new MemoryIndex(s.vault);

		expect(await s.tidy({ index })).toEqual([due]);
		expect(s.ops.filter((op) => op.startsWith("list"))).toEqual([]);
		expect(s.vault.paths().sort()).toEqual([".obsidian/app.json", young, "_conflicts/notes.md"].sort());

		// A file the index still lists and the disk no longer has is passed over.
		index.set(copyFrom(50 * DAY, "gone"), NOW, 1);
		expect(await s.tidy({ index })).toEqual([]);
	});

	test("what was tidied before and not sent yet stays remembered beside the new ones", async () => {
		const before = copyFrom(45 * DAY, "a");
		const now = copyFrom(40 * DAY, "b");
		const s = setup({ [now]: "mine" });
		await s.store.setMeta(TIDIED_COPIES_KEY, [before]);
		expect(await s.tidy()).toEqual([now]);
		expect(await readTidiedCopies(s.store)).toEqual([before, now]);
	});
});

describe("what is remembered of the copies that were tidied", () => {
	test("anything that is no list of paths reads as nothing", async () => {
		const store = new MemoryStateStore();
		expect(await readTidiedCopies(store)).toEqual([]);
		await store.setMeta(TIDIED_COPIES_KEY, { paths: ["a"] });
		expect(await readTidiedCopies(store)).toEqual([]);
		await store.setMeta(TIDIED_COPIES_KEY, ["a", 1, null, "b"]);
		expect(await readTidiedCopies(store)).toEqual(["a", "b"]);
	});

	test("the ones that are no deletion to send any more are forgotten, and the value goes with the last", async () => {
		const store = new MemoryStateStore();
		await store.setMeta(TIDIED_COPIES_KEY, ["a", "b", "c"]);
		await forgetTidiedCopies(store, (path) => path !== "b");
		expect(await readTidiedCopies(store)).toEqual(["a", "c"]);
		await forgetTidiedCopies(store, () => false);
		expect(await store.getMeta(TIDIED_COPIES_KEY)).toBeUndefined();
	});
});
