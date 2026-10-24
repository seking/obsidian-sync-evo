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
import type { RemoteEntry, RemoteListing } from "../src/core/backend";
import { createExclusion, type Exclusion } from "../src/core/exclusion";
import { lightCheckLine, type LightScanResult, scanLightly } from "../src/core/light-scan";
import { type LocalRead, readLocal } from "../src/core/local-read";
import type { SyncRecord } from "../src/core/plan";
import { planPull } from "../src/core/pull-plan";
import { planPush } from "../src/core/push-plan";
import { type ScanResult, scanVault } from "../src/core/scan";
import { makeRecord, type StoredRecord } from "../src/core/state";
import { blobHash, MemoryBackend } from "./support/memory-backend";
import { MemoryIndex } from "./support/memory-index";
import { MemoryPullVault, type VaultOp } from "./support/memory-pull-vault";
import { MemoryStateStore } from "./support/memory-state-store";

const ownFolder = ".obsidian/plugins/sync-evo";
const START = Date.UTC(2026, 9, 3, 12, 0, 0);
/** Long enough before the check that the time of a file is trusted. */
const BEFORE = START - 3_600_000;
const SIZE_LIMIT = 50 * 1024 * 1024;

function rules(gitignore: string | null = null): Exclusion {
	return createExclusion({ configDir: ".obsidian", pluginDir: ownFolder, gitignore });
}

interface Setup {
	readonly vault: MemoryPullVault;
	readonly index: MemoryIndex;
	/** Every call that reached the disk, in order. */
	readonly ops: string[];
}

/** A vault with these files, all written long ago, and an index that follows it. */
function setup(files: Record<string, string>, options: { caseSensitive?: boolean } = {}): Setup {
	const vault = new MemoryPullVault({ caseSensitive: options.caseSensitive ?? false, now: () => START });
	vault.putAll(files, BEFORE);
	const ops: string[] = [];
	vault.before = (op: VaultOp, path: string) => {
		ops.push(`${op} ${path}`);
	};
	return { vault, index: new MemoryIndex(vault), ops };
}

interface Sides {
	gitignore?: string | null;
	/** Files the remote holds. */
	remote?: readonly string[];
	/** Files that have a record. */
	recorded?: readonly string[];
	/** Paths the records hold as symlinks. */
	symlinks?: readonly string[];
}

const anyHash = blobHash("content");

function sides(options: Sides): { exclusion: Exclusion; remote: RemoteEntry[]; records: SyncRecord[] } {
	return {
		exclusion: rules(options.gitignore ?? null),
		remote: (options.remote ?? []).map((path) => ({ path, kind: "file", hash: anyHash })),
		records: [
			...(options.recorded ?? []).map((path) => ({ path, kind: "file" as const, hash: anyHash })),
			...(options.symlinks ?? []).map((path) => ({ path, kind: "symlink" as const, hash: anyHash })),
		],
	};
}

function light(s: Setup, options: Sides = {}): Promise<LightScanResult> {
	return scanLightly({ index: s.index, vault: s.vault, ...sides(options) });
}

function full(s: Setup, options: Sides = {}): Promise<ScanResult> {
	return scanVault({ lister: s.vault, ...sides(options) });
}

function found(result: ScanResult): string[] {
	return result.paths.map((entry) => entry.path).sort();
}

function sorted(result: ScanResult): ScanResult["paths"] {
	return [...result.paths].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

describe("what the light check lists from the index", () => {
	test("every file the index holds, without a look at the disk but for the root .git", async () => {
		const s = setup({ "a.md": "A", "notes/b.md": "B", "notes/deep/er/c.md": "C" });

		const result = await light(s);

		expect(found(result)).toEqual(["a.md", "notes/b.md", "notes/deep/er/c.md"]);
		expect(result.paths.every((entry) => entry.state === "present")).toBe(true);
		expect(s.ops).toEqual(["stat .git"]);
		expect(result.asked).toBe(0);
		expect(s.index.asked).toBe(1);
	});

	test("with the time and the size the index has of each, by key", async () => {
		const nfd = "ガイド/が.md".normalize("NFD");
		const s = setup({ [nfd]: "12345" });
		s.index.set(nfd, 111, 222);

		const result = await light(s);

		expect(result.paths).toEqual([{ path: nfd, key: nfd.normalize("NFC"), state: "present" }]);
		expect([...result.indexed]).toEqual([[nfd.normalize("NFC"), { mtime: 111, size: 222 }]]);
	});

	test("no folder is listed, however many there are", async () => {
		const files = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}/g${i}/n.md`, "x"]));
		const s = setup(files);

		expect((await light(s, { recorded: Object.keys(files) })).paths).toHaveLength(40);

		expect(s.ops.filter((op) => op.startsWith("list"))).toEqual([]);
	});

	test.each<[string, Record<string, string>, Sides]>([
		["nothing excluded", { "a.md": "A", "notes/b.md": "B" }, {}],
		["a file a rule matches", { "a.md": "A", "debug.log": "L", "notes/x.log": "L" }, { gitignore: "*.log\n" }],
		["a folder a rule matches", { "a.md": "A", "drafts/a.md": "D", "drafts/deep/b.md": "D" }, { gitignore: "/drafts/\n" }],
		[
			"a known file below a folder a rule matches, beside one that is not known",
			{ "drafts/kept.md": "K", "drafts/new.md": "N", "drafts/deep/c.md": "C" },
			{ gitignore: "/drafts/\n", remote: ["drafts/kept.md"] },
		],
		[
			"a recorded file a rule matches",
			{ "a.log": "L", "b.log": "L" },
			{ gitignore: "*.log\n", recorded: ["a.log"] },
		],
		[
			"a rule that takes one file back",
			{ "logs/a.log": "L", "logs/keep.log": "K" },
			{ gitignore: "*.log\n!keep.log\n" },
		],
		[
			"a file that cannot be taken back from a folder that is excluded",
			{ "build/out.md": "O", "build/keep.md": "K" },
			{ gitignore: "/build/\n!/build/keep.md\n" },
		],
		[
			"the copy of a conflict of a file a rule matches",
			{ "img.png": "I", "img (conflict iPhone 2026-10-03 120000).png": "mine", "new.png": "N" },
			{ gitignore: "*.png\n", remote: ["img.png"] },
		],
		["a folder spelled in another case than what is known below it", { "Drafts/a.md": "A" }, { gitignore: "/drafts/\n", remote: ["drafts/a.md"] }],
	])("the same files as the scan: %s", async (_name, files, options) => {
		const s = setup(files);
		expect(sorted(await light(s, options))).toEqual(sorted(await full(s, options)));
	});

	test("the copies in the folder of the conflict copies are listed though a rule matches the folder, as by the scan", async () => {
		const s = setup({
			"_conflicts/2026-10-11 a (iPhone).md": "mine",
			"_conflicts/notes.md": "N",
			"_conflicts/sub/2026-10-11 b (iPhone).md": "S",
			"a.md": "A",
		});
		const options = { gitignore: "_conflicts/\n" };

		const result = await light(s, options);

		expect(found(result)).toEqual(["_conflicts/2026-10-11 a (iPhone).md", "a.md"]);
		expect(sorted(result)).toEqual(sorted(await full(s, options)));
	});

	test("what lies below a path a record holds as a symlink is not listed", async () => {
		// On a desktop the index lists the content of the folder a symlink points to.
		const s = setup({ "a.md": "A", "link/inside.md": "I", "link/deep/er.md": "E", "linked.md": "L" });
		const options = { symlinks: ["link"] };

		const result = await light(s, options);

		expect(found(result)).toEqual(["a.md", "linked.md"]);
		expect(sorted(result)).toEqual(sorted(await full(s, options)));
	});

	test("a symlink is found without regard to case, and below another folder", async () => {
		const s = setup({ "Notes/Link/x.md": "X", "Notes/y.md": "Y" });
		expect(found(await light(s, { symlinks: ["notes/link"] }))).toEqual(["Notes/y.md"]);
	});

	test("two files that differ only in case are both listed, where the disk tells them apart", async () => {
		const s = setup({ "a.md": "1", "A.md": "2" }, { caseSensitive: true });
		expect(found(await light(s))).toEqual(["A.md", "a.md"]);
	});
});

describe("the paths the index does not hold", () => {
	const dotFiles = {
		".gitignore": "x\n",
		".github/workflows/ci.yml": "ci",
		"notes/.hidden.md": "H",
		"notes/.x/d.md": "D",
		".obsidian/app.json": "{}",
	};

	test("a path with a . name is listed when a record knows it, and looked for on the disk", async () => {
		const s = setup({ "a.md": "A", ...dotFiles });

		const result = await light(s, { recorded: [".gitignore", "notes/.x/d.md"] });

		expect(found(result)).toEqual([".gitignore", "a.md", "notes/.x/d.md"]);
		expect(result.asked).toBe(2);
		expect(s.ops).toEqual(["stat .gitignore", "stat notes/.x/d.md", "stat .git"]);
	});

	test("one that neither a record nor the remote knows is not found", async () => {
		const s = setup({ "a.md": "A", ...dotFiles });
		expect(found(await light(s))).toEqual(["a.md"]);
		// The scan finds them all: that is what it is for.
		expect(found(await full(s))).toEqual(["a.md", ...Object.keys(dotFiles)].sort());
	});

	test("one only the remote knows is listed when the vault has a file there", async () => {
		const s = setup({ "a.md": "A", ".github/workflows/ci.yml": "mine" });

		const result = await light(s, { remote: [".github/workflows/ci.yml", ".github/other.yml"] });

		expect(found(result)).toEqual([".github/workflows/ci.yml", "a.md"]);
		expect(result.asked).toBe(2);
	});

	test("with every . path known, the list is the scan's", async () => {
		const s = setup({ "a.md": "A", "notes/b.md": "B", ...dotFiles });
		const options = { recorded: [".gitignore", ".obsidian/app.json"], remote: Object.keys(dotFiles) };
		expect(sorted(await light(s, options))).toEqual(sorted(await full(s, options)));
	});

	test("a known path the exclusion leaves out is not looked for", async () => {
		const s = setup({ ".git/HEAD": "ref", [`${ownFolder}/main.js`]: "js", "link/.x": "X" });

		const result = await light(s, {
			recorded: [".git/HEAD", `${ownFolder}/main.js`, "link/.x"],
			symlinks: ["link"],
		});

		expect(found(result)).toEqual([]);
		// The symlink itself is asked about, like any path that has a record.
		expect(s.ops).toEqual(["stat link", "stat .git"]);
	});

	test("a recorded file the index does not list is asked of the disk before it counts as gone", async () => {
		const s = setup({ "a.md": "A", "late.md": "L" });
		s.index.drop("late.md");

		const result = await light(s, { recorded: ["a.md", "late.md", "gone.md"] });

		expect(found(result)).toEqual(["a.md", "late.md"]);
		expect(result.asked).toBe(2);
		expect(s.ops).toEqual(["stat late.md", "stat gone.md", "stat .gone.md.icloud", "stat .git"]);
		// Nothing of the index is handed on for a file it does not list.
		expect(result.indexed.has("late.md")).toBe(false);
	});

	test("a recorded file a cloud drive has taken off the device is a placeholder, as in the scan", async () => {
		const s = setup({ "a.md": "A", "notes/.big.pdf.icloud": "stub", ".x/.c.md.icloud": "stub" });
		const options = { recorded: ["a.md", "notes/big.pdf", ".x/c.md"] };

		const result = await light(s, options);

		expect(sorted(result)).toEqual([
			{ path: ".x/c.md", key: ".x/c.md", state: "placeholder" },
			{ path: "a.md", key: "a.md", state: "present" },
			{ path: "notes/big.pdf", key: "notes/big.pdf", state: "placeholder" },
		]);
		expect(sorted(result)).toEqual(sorted(await full(s, options)));
	});

	test("a placeholder of a file a rule excludes is not listed", async () => {
		const s = setup({ "notes/.big.pdf.icloud": "stub" });
		expect(found(await light(s, { gitignore: "*.pdf\n" }))).toEqual([]);
	});

	test("a file the index spells in another case than its record is not looked for", async () => {
		const s = setup({ "Notes/A.md": "A" });

		const result = await light(s, { recorded: ["notes/a.md"] });

		expect(found(result)).toEqual(["Notes/A.md"]);
		expect(result.asked).toBe(0);
	});

	test("a path that both a record and the remote know is asked about once, as the record spells it", async () => {
		const s = setup({ ".x/A.md": "A" });

		const result = await light(s, { recorded: [".x/A.md"], remote: [".x/a.md"] });

		expect(result.paths).toEqual([{ path: ".x/A.md", key: ".x/A.md", state: "present" }]);
		expect(result.asked).toBe(1);
	});

	test("a folder at a known path is no file there", async () => {
		const s = setup({ "was-a-file/now.md": "N" });
		expect(found(await light(s, { recorded: ["was-a-file"] }))).toEqual(["was-a-file/now.md"]);
	});

	test("a path of the remote that is no path is passed over", async () => {
		const s = setup({ "a.md": "A" });
		const result = await light(s, { remote: ["", "/abs.md", "x/../y.md", "a//b.md", "./c.md"] });
		expect(found(result)).toEqual(["a.md"]);
		expect(result.asked).toBe(0);
	});

	test("a disk that cannot answer fails the check instead of reading as a deletion", async () => {
		const s = setup({ "a.md": "A", ".x/c.md": "C" });
		s.vault.before = (op, path) => {
			if (op === "stat" && path === ".x/c.md") throw new Error("EIO");
		};
		await expect(light(s, { recorded: [".x/c.md"] })).rejects.toThrow("EIO");
	});
});

describe("a disk that tells NFC from NFD", () => {
	const nfc = ".x/ガイド.md";
	const nfd = nfc.normalize("NFD");

	/** Answers only for the very spellings it was given, as Linux and Android do. */
	function strictDisk(files: readonly string[]) {
		const asked: string[] = [];
		const stat = async (path: string) => {
			asked.push(path);
			return files.includes(path) ? ({ type: "file", mtime: BEFORE, size: 1 } as const) : null;
		};
		const list = (): never => {
			throw new Error("not listed");
		};
		return { asked, vault: { stat, list } };
	}
	const none = { indexedFiles: () => [] };

	test("a record spelled NFC whose file is NFD is found, and listed as the disk spells it", async () => {
		const disk = strictDisk([nfd]);

		const result = await scanLightly({ index: none, vault: disk.vault, ...sides({ recorded: [nfc] }) });

		expect(result.paths).toEqual([{ path: nfd, key: nfc, state: "present" }]);
		expect(disk.asked).toEqual([nfc, nfd, ".git"]);
	});

	test("a record spelled NFD whose file is NFC is found too", async () => {
		const disk = strictDisk([nfc]);

		const result = await scanLightly({ index: none, vault: disk.vault, ...sides({ recorded: [nfd] }) });

		expect(result.paths).toEqual([{ path: nfc, key: nfc, state: "present" }]);
	});

	test("a file that is there as recorded costs one question", async () => {
		const disk = strictDisk([nfc]);
		await scanLightly({ index: none, vault: disk.vault, ...sides({ recorded: [nfc] }) });
		expect(disk.asked).toEqual([nfc, ".git"]);
	});

	test("the placeholder of a cloud drive is looked for under both spellings as well", async () => {
		const disk = strictDisk([".x/.ガイド.md.icloud".normalize("NFD")]);

		const result = await scanLightly({ index: none, vault: disk.vault, ...sides({ recorded: [nfc] }) });

		expect(result.paths).toEqual([{ path: nfd, key: nfc, state: "placeholder" }]);
	});

	test("a file that is gone under both is not listed, and a name in ASCII is asked for once", async () => {
		const disk = strictDisk([]);

		const result = await scanLightly({ index: none, vault: disk.vault, ...sides({ recorded: [nfc, ".x/plain.md"] }) });

		expect(result.paths).toEqual([]);
		expect(disk.asked.filter((path) => path.includes("plain"))).toEqual([".x/plain.md", ".x/.plain.md.icloud"]);
	});
});

describe("a name a rename went through", () => {
	test("is told apart by both, each name once and as a file or a folder, and its files are left out", async () => {
		const s = setup({
			"a.md": "A",
			"Tools.sync-evo-renaming/b.md": "B",
			"Tools.sync-evo-renaming/sub/c.md": "C",
			"notes/Notes.md.sync-evo-renaming": "N",
		});
		for (const result of [await light(s), await full(s)]) {
			expect(result.paths.map((entry) => entry.path)).toEqual(["a.md"]);
			expect([...result.renaming].sort((a, b) => (a.path < b.path ? -1 : 1))).toEqual([
				{ path: "Tools.sync-evo-renaming", type: "folder" },
				{ path: "notes/Notes.md.sync-evo-renaming", type: "file" },
			]);
		}
	});
});

describe("a path the index has in two cases", () => {
	// As Android's index can be after a change of case alone: the old
	// spelling put back beside the new one.
	test("is listed as the disk spells it, and the old spelling is left out", async () => {
		const s = setup({ "notes/Todo.md": "T", "a.md": "A" });
		s.index.set("notes/todo.md", BEFORE, 1);

		const result = await light(s, { recorded: ["notes/todo.md"] });

		expect(found(result)).toEqual(["a.md", "notes/Todo.md"]);
		expect(s.ops.filter((op) => op.startsWith("list"))).toEqual(["list notes"]);
		expect(result.notOnDisk).toBe(1);
	});

	test("so is a folder on the way, with every file below the old spelling", async () => {
		const s = setup({ "Tools/also-exec.sh": "X", "Tools/run.sh": "R" });
		s.index.set("tools/also-exec.sh", BEFORE, 1);
		s.index.set("tools/old.sh", BEFORE, 1);

		const result = await light(s);

		expect(found(result)).toEqual(["Tools/also-exec.sh", "Tools/run.sh"]);
		expect(s.ops.filter((op) => op.startsWith("list"))).toEqual(["list /", "list Tools"]);
		expect(result.notOnDisk).toBe(2);
	});

	test("on a disk that tells the cases apart and has both, both are listed", async () => {
		const files = { "notes/Todo.md": "T", "notes/todo.md": "t", "Tools/a.sh": "A", "tools/b.sh": "B" };
		const s = setup(files, { caseSensitive: true });

		const result = await light(s);

		expect(found(result)).toEqual(["Tools/a.sh", "notes/Todo.md", "notes/todo.md", "tools/b.sh"]);
		expect(result.notOnDisk).toBe(0);
	});

	test("the disk is not listed where no two paths differ in case alone", async () => {
		const s = setup({ "notes/Todo.md": "T", "Notes.md": "N", "tools/a.sh": "A" });

		await light(s);

		expect(s.ops.filter((op) => op.startsWith("list"))).toEqual([]);
	});

	test("two spellings that differ in NFC and NFD alone are no two cases: nothing is left out, and the disk is not listed", async () => {
		const nfc = "notes/ガイド.md";
		const nfd = nfc.normalize("NFD");
		const s = setup({ [nfc]: "G" });
		s.index.drop(nfc);
		s.index.set(nfd, BEFORE, 1);

		const result = await light(s);

		expect(result.paths).toEqual([{ path: nfd, key: nfc, state: "present" }]);
		expect(s.ops.filter((op) => op.startsWith("list"))).toEqual([]);
		expect(result.notOnDisk).toBe(0);
	});

	test("a path the index holds twice, in NFC and in NFD, is listed once", async () => {
		const nfc = "notes/ガイド.md";
		const s = setup({ [nfc]: "G" });
		s.index.set(nfc.normalize("NFD"), BEFORE, 1);

		const result = await light(s);

		expect(result.paths).toEqual([{ path: nfc, key: nfc, state: "present" }]);
		expect(result.notOnDisk).toBe(0);
	});

	// The old spelling left in the index, and the remote's case taken back:
	// the app can then hold two of its objects at the one spelling.
	test("a path the index holds twice in one spelling is listed once, beside an old spelling left out", async () => {
		const s = setup({ "notes/todo.md": "t" });
		const at = (path: string) => ({ path, mtime: BEFORE, size: 1 });
		const index = { indexedFiles: () => [at("notes/todo.md"), at("notes/Todo.md"), at("notes/todo.md")] };

		const result = await scanLightly({ index, vault: s.vault, ...sides({}) });

		expect(found(result)).toEqual(["notes/todo.md"]);
		expect(result.notOnDisk).toBe(1);
	});
});

describe("a .git at the vault root", () => {
	test.each<[string, Record<string, string>, boolean]>([
		["a folder", { "a.md": "A", ".git/HEAD": "ref" }, true],
		["a file, as in a worktree", { "a.md": "A", ".git": "gitdir: elsewhere" }, true],
		["none", { "a.md": "A", "notes/.git/HEAD": "ref" }, false],
	])("%s", async (_name, files, expected) => {
		const s = setup(files);
		expect((await light(s)).rootHasGit).toBe(expected);
		expect((await full(s)).rootHasGit).toBe(expected);
	});
});

describe("the sync decision after a light check", () => {
	/** The three sides of a vault that was in sync on `files`, each recorded as the disk has it. */
	function inSync(files: Record<string, string>): { listing: RemoteListing; records: StoredRecord[] } {
		const entries = Object.entries(files).map(
			([path, content]): RemoteEntry => ({ path, kind: "file", hash: blobHash(content), size: content.length }),
		);
		const records = entries.map((entry) =>
			makeRecord({ path: entry.path, kind: "file", hash: entry.hash }, { mtime: BEFORE, size: entry.size ?? 0 }, START),
		);
		return { listing: { revision: "r1", entries }, records };
	}

	async function read(
		s: Setup,
		scan: ScanResult | LightScanResult,
		records: readonly StoredRecord[],
		listing: RemoteListing,
	): Promise<LocalRead> {
		const local = await readLocal(
			{
				vault: s.vault,
				backend: new MemoryBackend(),
				store: new MemoryStateStore(),
				now: () => START,
				startedAt: START,
				sizeLimit: SIZE_LIMIT,
				held: new Set(),
				aborted: () => false,
				onProgress: () => {},
				...("indexed" in scan ? { indexed: scan.indexed } : {}),
			},
			scan,
			records,
			listing,
		);
		if (local === null) throw new Error("stopped");
		return local;
	}

	const byPath = <T extends { path: string }>(entries: readonly T[]): T[] =>
		[...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

	test("a record with no file is a deletion to send, by the same plan as after a scan", async () => {
		const files = { "a.md": "A", "gone.md": "G", ".x/gone.yml": "Y", "notes/kept.md": "K" };
		const { listing, records } = inSync(files);
		const s = setup({ "a.md": "A", "notes/kept.md": "K" });
		const exclusion = rules();
		const input = { exclusion, remote: listing.entries, records };

		const lightScan = await scanLightly({ ...input, index: s.index, vault: s.vault });
		const fullScan = await scanVault({ ...input, lister: s.vault });
		const lightLocal = await read(s, lightScan, records, listing);
		const fullLocal = await read(s, fullScan, records, listing);

		expect(byPath(lightLocal.entries)).toEqual(byPath(fullLocal.entries));
		const plan = (local: LocalRead) =>
			planPush({ ...input, local: byPath(local.entries), sizeLimit: SIZE_LIMIT, held: new Set() });
		expect(plan(lightLocal)).toEqual(plan(fullLocal));
		expect(plan(lightLocal).deletes.map((entry) => entry.remote.path).sort()).toEqual([".x/gone.yml", "gone.md"]);
	});

	test("a file a cloud drive took away is no deletion, by the same plan as after a scan", async () => {
		const files = { "a.md": "A", "big.pdf": "PDF" };
		const { listing, records } = inSync(files);
		const s = setup({ "a.md": "A", ".big.pdf.icloud": "stub" });
		const input = { exclusion: rules(), remote: listing.entries, records };

		const lightLocal = await read(s, await scanLightly({ ...input, index: s.index, vault: s.vault }), records, listing);
		const fullLocal = await read(s, await scanVault({ ...input, lister: s.vault }), records, listing);

		expect(lightLocal.placeholders).toEqual(["big.pdf"]);
		expect(byPath(lightLocal.entries)).toEqual(byPath(fullLocal.entries));
		const held = new Set(["big.pdf"]);
		const plan = (local: LocalRead) => planPush({ ...input, local: byPath(local.entries), sizeLimit: SIZE_LIMIT, held });
		expect(plan(lightLocal)).toEqual(plan(fullLocal));
		expect(plan(lightLocal).deletes).toEqual([]);
	});

	test("the plan of a pull is the same one too", async () => {
		const files = { "a.md": "A", "b.md": "B", ".github/ci.yml": "ci", "notes/c.md": "C" };
		const { listing, records } = inSync(files);
		// The remote has changed one file, deleted one, and got a new one.
		const remote: RemoteEntry[] = [
			...listing.entries.filter((entry) => entry.path !== "b.md" && entry.path !== "a.md"),
			{ path: "a.md", kind: "file", hash: blobHash("A2"), size: 2 },
			{ path: ".x/new.yml", kind: "file", hash: blobHash("theirs"), size: 6 },
		];
		const s = setup({ ...files, ".x/new.yml": "mine", "notes/c.md": "C edited" });
		const input = { exclusion: rules(), remote, records };
		const now = { revision: "r2", entries: remote };

		const lightLocal = await read(s, await scanLightly({ ...input, index: s.index, vault: s.vault }), records, now);
		const fullLocal = await read(s, await scanVault({ ...input, lister: s.vault }), records, now);

		const plan = (local: LocalRead) => planPull({ ...input, local: byPath(local.entries), sizeLimit: SIZE_LIMIT });
		expect(plan(lightLocal)).toEqual(plan(fullLocal));
		expect(lightLocal.seen).toEqual(fullLocal.seen);
	});
});

describe("the line a light check logs", () => {
	test("counts the files, what the index did not settle, and the time", () => {
		const scan = { paths: [{ path: "a", key: "a", state: "present" as const }], asked: 3, notOnDisk: 0 };
		expect(lightCheckLine(scan, { statted: 4, hashed: 2 }, 17)).toBe(
			"light check: 1 files, 3 not in the index, 4 asked of the disk, 2 hashed, 17 ms",
		);
	});

	test("and the files of the index left out at a spelling the disk does not have, where there are any", () => {
		const scan = { paths: [{ path: "a", key: "a", state: "present" as const }], asked: 3, notOnDisk: 2 };
		expect(lightCheckLine(scan, { statted: 4, hashed: 2 }, 17)).toBe(
			"light check: 1 files, 3 not in the index, 2 not on disk, 4 asked of the disk, 2 hashed, 17 ms",
		);
	});
});

describe("links of the vault", () => {
	test("what the index holds below a link is left out, and so is a known path that is a link", async () => {
		const s = setup({ "a.md": "A", "Ext/x.md": "X", "Ext/deep/y.md": "Y", ".hidden.md": "H" });
		s.vault.links = new Set(["Ext", ".hidden.md"]);
		const result = await light(s, { recorded: [".hidden.md"] });
		expect(result.paths.map((entry) => entry.path).sort()).toEqual(["a.md"]);
		expect([...result.links].sort()).toEqual([".hidden.md", "Ext"]);
	});

	test("a known path below a link the index leaves out is not asked into", async () => {
		const s = setup({ "a.md": "A", "Inner/p.md": "P" });
		s.vault.links = new Set(["Inner"]);
		// The app leaves out of its index what is below a link to a folder of the vault.
		const index = { indexedFiles: () => s.index.indexedFiles().filter((file) => !file.path.startsWith("Inner/")) };
		const result = await scanLightly({ index, vault: s.vault, ...sides({ recorded: ["Inner/p.md"] }) });
		expect(result.paths.map((entry) => entry.path)).toEqual(["a.md"]);
		expect(result.links).toEqual(["Inner"]);
	});

	test("a known path that is a link whose target is gone is told as a link, and not as gone", async () => {
		const s = setup({ "a.md": "A" });
		// The disk has nothing to stat at a link that points nowhere.
		s.vault.links = new Set(["note.md"]);
		const result = await light(s, { recorded: ["note.md"] });
		expect(found(result)).toEqual(["a.md"]);
		expect(result.links).toEqual(["note.md"]);
	});
});
