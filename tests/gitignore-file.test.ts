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
import { defaultSectionLines } from "../src/core/exclusion";
import {
	addDefaultSection,
	GITIGNORE_WRITE_KEY,
	isGitignoreAsRecorded,
	readRootGitignore,
	settleGitignoreWrite,
	writeRootGitignore,
} from "../src/core/gitignore-file";
import { findSection, SECTION_END, SECTION_START, withSection } from "../src/core/gitignore-section";
import { MemoryBackend } from "./support/memory-backend";
import { MemoryPullVault } from "./support/memory-pull-vault";
import { MemoryStateStore } from "./support/memory-state-store";

const paths = { configDir: ".obsidian", pluginDir: ".obsidian/plugins/sync-evo" };
const LIMIT = 1024 * 1024;

function setup(options: { caseSensitive?: boolean } = {}) {
	const vault = new MemoryPullVault({ caseSensitive: options.caseSensitive ?? false, now: () => 1_000 });
	const store = new MemoryStateStore();
	const backend = new MemoryBackend();
	return { vault, store, backend, deps: { vault, store, backend, paths, sizeLimit: LIMIT } };
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("reading the root .gitignore", () => {
	test("a vault without one", async () => {
		const { vault } = setup();
		vault.put("notes/.gitignore", "*.tmp\n");
		expect(await readRootGitignore(vault, LIMIT)).toEqual({ kind: "absent" });
	});

	test("the text, with every byte: a byte order mark is kept", async () => {
		const { vault } = setup();
		vault.put(".gitignore", "﻿*.log\r\n");
		const read = await readRootGitignore(vault, LIMIT);
		expect(read).toEqual({ kind: "text", text: "﻿*.log\r\n", content: utf8("﻿*.log\r\n") });
	});

	test("an empty file is a text, and not none", async () => {
		const { vault } = setup();
		vault.put(".gitignore", "");
		expect(await readRootGitignore(vault, LIMIT)).toMatchObject({ kind: "text", text: "" });
	});

	test.each<[string, (vault: MemoryPullVault) => void, string, number?]>([
		["a folder of that name", (vault) => vault.makeFolder(".gitignore"), "not-a-file"],
		["a file over the size limit", (vault) => vault.put(".gitignore", "*.log\n"), "too-large", 5],
		["a placeholder of a cloud drive", (vault) => vault.put("..gitignore.icloud", ""), "not-downloaded"],
		["another case", (vault) => vault.put(".GitIgnore", "*.log\n"), "respelled"],
		["bytes that are not UTF-8", (vault) => vault.put(".gitignore", new Uint8Array([0x2a, 0xff, 0x0a])), "not-text"],
		[
			"a file that cannot be read",
			(vault) => {
				vault.put(".gitignore", "*.log\n");
				vault.before = (op) => {
					if (op === "read") throw new Error("locked");
				};
			},
			"read-failed",
		],
		[
			"a root that cannot be listed",
			(vault) => {
				vault.before = (op) => {
					if (op === "list") throw new Error("busy");
				};
			},
			"read-failed",
		],
	])("there, and not read: %s", async (_name, arrange, reason, limit = LIMIT) => {
		const { vault } = setup();
		arrange(vault);
		expect(await readRootGitignore(vault, limit)).toEqual({ kind: "unreadable", reason });
	});

	test("two spellings on a device that tells the cases apart are not read either", async () => {
		const { vault } = setup({ caseSensitive: true });
		vault.putAll({ ".gitignore": "a\n", ".GITIGNORE": "b\n" });
		expect(await readRootGitignore(vault, LIMIT)).toEqual({ kind: "unreadable", reason: "respelled" });
	});

	test("a placeholder beside the file itself is nothing: the file is read", async () => {
		const { vault } = setup();
		vault.putAll({ ".gitignore": "*.log\n", "..gitignore.icloud": "" });
		expect(await readRootGitignore(vault, LIMIT)).toMatchObject({ kind: "text", text: "*.log\n" });
	});
});

describe("writing the root .gitignore", () => {
	const memory = (before: string | null, writing: string) => ({ before, writing });

	test("the write is remembered while the file is written, and forgotten after; no record and no marker is made", async () => {
		const { vault, store, deps } = setup();
		vault.put(".gitignore", "old\n");
		let during: unknown;
		vault.before = async (op) => {
			if (op === "write") during = await store.getMeta(GITIGNORE_WRITE_KEY);
		};

		expect(await writeRootGitignore(deps, "new\n", "old\n")).toBe("written");

		expect(during).toEqual(memory("old\n", "new\n"));
		expect(await store.getMeta(GITIGNORE_WRITE_KEY)).toBeUndefined();
		expect(await store.readMarkers()).toEqual([]);
		expect(await store.readRecords()).toEqual([]);
		expect(vault.text(".gitignore")).toBe("new\n");
	});

	test("a vault without the file gets it; what is remembered says there was none", async () => {
		const { vault, store, deps } = setup();
		let during: unknown;
		vault.before = async (op) => {
			if (op === "write") during = await store.getMeta(GITIGNORE_WRITE_KEY);
		};

		expect(await writeRootGitignore(deps, "new\n", null)).toBe("written");

		expect(during).toEqual(memory(null, "new\n"));
		expect(vault.text(".gitignore")).toBe("new\n");
	});

	test.each<[string, string | null, string | null]>([
		["edited since it was read", "edited\n", "old\n"],
		["gone since it was read", null, "old\n"],
		["there, where there was none", "appeared\n", null],
	])("a file that is not what the caller read is not written over: %s", async (_name, now, read) => {
		const { vault, store, deps } = setup();
		if (now !== null) vault.put(".gitignore", now);

		expect(await writeRootGitignore(deps, "new\n", read)).toBe("changed");

		expect(vault.text(".gitignore")).toBe(now ?? undefined);
		expect(vault.log).toEqual([]);
		expect(await store.getMeta(GITIGNORE_WRITE_KEY)).toBeUndefined();
	});

	test("a write the vault refuses, with the file as it was, leaves nothing remembered", async () => {
		const { vault, store, deps } = setup();
		vault.put(".gitignore", "old\n");
		vault.before = (op) => {
			if (op === "write") throw new Error("read-only");
		};

		expect(await writeRootGitignore(deps, "new\n", "old\n")).toBe("refused");

		expect(vault.text(".gitignore")).toBe("old\n");
		expect(await store.getMeta(GITIGNORE_WRITE_KEY)).toBeUndefined();
	});

	test("a write that fails halfway stays remembered", async () => {
		const { vault, store, deps } = setup();
		vault.put(".gitignore", "old\n");
		vault.before = (op) => {
			if (op !== "write") return;
			vault.put(".gitignore", "ne");
			throw new Error("disk full");
		};

		expect(await writeRootGitignore(deps, "new\n", "old\n")).toBe("unsettled");

		expect(await store.getMeta(GITIGNORE_WRITE_KEY)).toEqual(memory("old\n", "new\n"));
	});

	test("so does one after which the file cannot be looked at", async () => {
		const { vault, store, deps } = setup();
		vault.put(".gitignore", "old\n");
		let failing = false;
		vault.before = (op) => {
			if (op === "write") failing = true;
			if (failing) throw new Error("gone");
		};

		expect(await writeRootGitignore(deps, "new\n", "old\n")).toBe("unsettled");
		expect(await store.getMeta(GITIGNORE_WRITE_KEY)).toEqual(memory("old\n", "new\n"));
	});

	test("a write from before is settled first: half a file is finished, and is then not what the caller read", async () => {
		const { vault, store, deps } = setup();
		vault.put(".gitignore", "earl");
		await store.setMeta(GITIGNORE_WRITE_KEY, memory("old\n", "earlier\n"));

		expect(await writeRootGitignore(deps, "new\n", "old\n")).toBe("changed");
		expect(vault.text(".gitignore")).toBe("earlier\n");
		expect(await store.getMeta(GITIGNORE_WRITE_KEY)).toBeUndefined();
		// Read again, it is written.
		expect(await writeRootGitignore(deps, "new\n", "earlier\n")).toBe("written");
	});

	test("with a write from before that cannot be settled, nothing is written", async () => {
		const { vault, store, deps } = setup();
		vault.put("..gitignore.icloud", "");
		await store.setMeta(GITIGNORE_WRITE_KEY, memory("old\n", "earlier\n"));

		expect(await writeRootGitignore(deps, "new\n", "old\n")).toBe("unsettled");
		expect(vault.log).toEqual([]);
		expect(await store.getMeta(GITIGNORE_WRITE_KEY)).toEqual(memory("old\n", "earlier\n"));
	});

	test("a failure of the sync state is thrown, before anything is written", async () => {
		const { vault, store, deps } = setup();
		vault.put(".gitignore", "old\n");
		await store.close();

		await expect(writeRootGitignore(deps, "new\n", "old\n")).rejects.toThrow();
		expect(vault.text(".gitignore")).toBe("old\n");
	});
});

describe("settling a write of the root .gitignore that did not get to its end", () => {
	const writing = "# >>> top\n/.trash/\n# <<< end\nold\n";

	/** What becomes of a file that holds `now`, with a write of `writing` over `before` remembered. */
	async function settle(now: string | Uint8Array | null, before: string | null) {
		const { vault, store, deps } = setup();
		if (now !== null) vault.put(".gitignore", now);
		await store.setMeta(GITIGNORE_WRITE_KEY, { before, writing });
		const settled = await settleGitignoreWrite(deps);
		const text = vault.text(".gitignore");
		return { settled, text, log: vault.log, remembered: (await store.getMeta(GITIGNORE_WRITE_KEY)) !== undefined, store };
	}

	test("nothing remembered: nothing to do, and the file is not even looked at", async () => {
		const { vault, deps } = setup();
		vault.before = () => {
			throw new Error("not to be touched");
		};
		expect(await settleGitignoreWrite(deps)).toBe(true);
	});

	test("the file holds the text that was being written: the write was done", async () => {
		const done = await settle(writing, "old\n");
		expect(done).toMatchObject({ settled: true, text: writing, log: [], remembered: false });
		// No record says that the remote has this text.
		expect(await done.store.readRecords()).toEqual([]);
	});

	test.each<[string, string | null]>([
		["the text from before", "old\n"],
		["no file, as before", null],
		["an empty file, as before", ""],
	])("the file is as it was before the write: nothing was written (%s)", async (_name, before) => {
		expect(await settle(before, before)).toMatchObject({ settled: true, text: before ?? undefined, log: [], remembered: false });
	});

	test.each<[string, string | Uint8Array, string | null]>([
		["the start of the text", writing.slice(0, 12), "old\n"],
		["an empty file where there was a text", "", "old\n"],
		["an empty file where there was none", "", null],
		["cut in the middle of a character", new TextEncoder().encode("é/\n").slice(0, 1), null],
	])("the file holds half of the text: it is written again (%s)", async (_name, now, before) => {
		const { vault, store, deps } = setup();
		const whole = typeof now === "string" ? writing : "é/\n";
		vault.put(".gitignore", now);
		await store.setMeta(GITIGNORE_WRITE_KEY, { before, writing: whole });

		expect(await settleGitignoreWrite(deps)).toBe(true);

		expect(vault.text(".gitignore")).toBe(whole);
		expect(await store.getMeta(GITIGNORE_WRITE_KEY)).toBeUndefined();
		expect(await store.readRecords()).toEqual([]);
	});

	test("half a file that cannot be written again stays remembered, and is finished the next time", async () => {
		const { vault, store, deps } = setup();
		vault.put(".gitignore", writing.slice(0, 12));
		await store.setMeta(GITIGNORE_WRITE_KEY, { before: "old\n", writing });
		vault.before = (op) => {
			if (op === "write") throw new Error("disk full");
		};

		expect(await settleGitignoreWrite(deps)).toBe(false);
		expect(await store.getMeta(GITIGNORE_WRITE_KEY)).toEqual({ before: "old\n", writing });

		vault.before = undefined;
		expect(await settleGitignoreWrite(deps)).toBe(true);
		expect(vault.text(".gitignore")).toBe(writing);
	});

	test.each<[string, string | null, string | null]>([
		["another text", "mine now\n", "old\n"],
		["the text with something after it", `${writing}more\n`, "old\n"],
		["the text from before with something after it", "old\nmore\n", "old\n"],
		["no file where there was one", null, "old\n"],
		["a file that starts like the text from before, which starts like the text", "# >>> top\n/.tr", "# >>> top\n/.tr"],
	])("anything else is the user's, and is left as it is: %s", async (_name, now, before) => {
		expect(await settle(now, before)).toMatchObject({ settled: true, text: now ?? undefined, log: [], remembered: false });
	});

	test.each<[string, (vault: MemoryPullVault) => void]>([
		["a cloud drive has it", (vault) => vault.put("..gitignore.icloud", "")],
		["a folder has the name", (vault) => vault.makeFolder(".gitignore")],
		["the vault spells it in another case", (vault) => vault.put(".GITIGNORE", "x\n")],
		[
			"it cannot be read",
			(vault) => {
				vault.put(".gitignore", "ol");
				vault.before = (op) => {
					if (op === "read") throw new Error("locked");
				};
			},
		],
	])("a file that cannot be looked at stays remembered: %s", async (_name, arrange) => {
		const { vault, store, deps } = setup();
		arrange(vault);
		await store.setMeta(GITIGNORE_WRITE_KEY, { before: "old\n", writing });

		expect(await settleGitignoreWrite(deps)).toBe(false);

		expect(vault.log).toEqual([]);
		expect(await store.getMeta(GITIGNORE_WRITE_KEY)).toEqual({ before: "old\n", writing });
	});

	test("something stored that is no such memory is nothing remembered", async () => {
		const { vault, store, deps } = setup();
		vault.put(".gitignore", "ol");
		await store.setMeta(GITIGNORE_WRITE_KEY, { before: 1, writing: "old\n" });
		expect(await settleGitignoreWrite(deps)).toBe(true);
		expect(vault.text(".gitignore")).toBe("ol");
	});

	test("it goes with the sync state when that is discarded", async () => {
		const { store } = setup();
		await store.setMeta(GITIGNORE_WRITE_KEY, { before: null, writing });
		await store.startOver({ listing: { revision: null, entries: [] }, markers: [], meta: [] });
		expect(await store.getMeta(GITIGNORE_WRITE_KEY)).toBeUndefined();
		await store.setMeta(GITIGNORE_WRITE_KEY, { before: null, writing });
		store.clear();
		expect(await store.getMeta(GITIGNORE_WRITE_KEY)).toBeUndefined();
	});
});

describe("adding the default section", () => {
	const lines = defaultSectionLines(paths);
	const shown = [SECTION_START, ...lines, SECTION_END];

	test("at the top of a file without one, with what the file held after it, byte for byte", async () => {
		const { vault, deps } = setup();
		const held = "# mine\n*.log\n\n!keep.log";
		vault.put(".gitignore", held);

		const added = await addDefaultSection(deps);

		const text = `${shown.join("\n")}\n${held}`;
		expect(added).toEqual({ kind: "added", lines: shown, created: false, text });
		expect(vault.text(".gitignore")).toBe(text);
		expect(findSection(text)).toMatchObject({ kind: "found", lines });
	});

	test("a vault without the file gets one with the section alone", async () => {
		const { vault, store, deps } = setup();

		const added = await addDefaultSection(deps);

		expect(added).toMatchObject({ kind: "added", created: true });
		expect(vault.text(".gitignore")).toBe(withSection(null, lines));
		expect(await store.getMeta(GITIGNORE_WRITE_KEY)).toBeUndefined();
	});

	test("the lines follow the names of the configuration folder and of the plugin's folder", async () => {
		const { vault, deps } = setup();
		const other = { configDir: ".config", pluginDir: ".config/plugins/evo" };

		await addDefaultSection({ ...deps, paths: other });

		expect(vault.text(".gitignore")).toBe(withSection(null, defaultSectionLines(other)));
		expect(vault.text(".gitignore")).toContain("/.config/plugins/evo/\n");
	});

	test.each([
		["a section", withSection("*.log\n", ["/drafts/"]), "present"],
		["an empty section", withSection(null, []), "present"],
		["a section that is not at the top", `*.log\n${SECTION_START}\n${SECTION_END}\n`, "present"],
		["a start without an end", `${SECTION_START}\n*.log\n`, "broken"],
		["an end alone", `*.log\n${SECTION_END}\n`, "broken"],
	])("a file with %s is left as it is", async (_name, text, reason) => {
		const { vault, deps } = setup();
		vault.put(".gitignore", text);

		expect(await addDefaultSection(deps)).toEqual({ kind: "left", reason });

		expect(vault.text(".gitignore")).toBe(text);
		expect(vault.log).toEqual([]);
	});

	test("a file that is there and cannot be read is left, and none is made beside it", async () => {
		const { vault, deps } = setup();
		vault.put(".GITIGNORE", "*.log\n");

		expect(await addDefaultSection(deps)).toEqual({ kind: "left", reason: "respelled" });

		expect(vault.snapshot()).toEqual({ ".GITIGNORE": "*.log\n" });
	});

	test("a file that would be over the size limit with the section is left", async () => {
		const { vault, deps } = setup();
		vault.put(".gitignore", "*.log\n");

		expect(await addDefaultSection({ ...deps, sizeLimit: 50 })).toEqual({ kind: "left", reason: "over-limit" });
		expect(vault.text(".gitignore")).toBe("*.log\n");
	});

	test("a write that fails halfway is told apart from one that was not made", async () => {
		const { vault, deps } = setup();
		vault.put(".gitignore", "*.log\n");
		vault.before = (op) => {
			if (op === "write") throw new Error("read-only");
		};
		expect(await addDefaultSection(deps)).toEqual({ kind: "left", reason: "refused" });

		vault.before = (op) => {
			if (op !== "write") return;
			vault.put(".gitignore", "# >>> Syn");
			throw new Error("disk full");
		};
		expect(await addDefaultSection(deps)).toEqual({ kind: "unsettled" });
	});
});

describe("whether the remote's .gitignore is the one this device last synced", () => {
	const entry = (path: string, hash: string, kind: "file" | "symlink" = "file") => ({ path, kind, hash });

	test("neither side has one", () => {
		expect(isGitignoreAsRecorded([entry("a.md", "1"), entry("notes/.gitignore", "2")], [entry("a.md", "1")])).toBe(true);
	});

	test("the record has the hash the remote has", () => {
		expect(isGitignoreAsRecorded([entry(".gitignore", "1")], [entry(".gitignore", "1")])).toBe(true);
	});

	test.each([
		["the remote changed it", [entry(".gitignore", "2")], [entry(".gitignore", "1")]],
		["the remote has one this device never pulled", [entry(".gitignore", "1")], []],
		["the remote deleted it", [], [entry(".gitignore", "1")]],
		["the remote spells it in another case", [entry(".GITIGNORE", "1")], [entry(".GITIGNORE", "1")]],
		["the remote holds two spellings", [entry(".gitignore", "1"), entry(".Gitignore", "1")], [entry(".gitignore", "1")]],
		["it is a symlink", [entry(".gitignore", "1", "symlink")], [entry(".gitignore", "1", "symlink")]],
	])("not when %s", (_name, remote, records) => {
		expect(isGitignoreAsRecorded(remote, records)).toBe(false);
	});
});
