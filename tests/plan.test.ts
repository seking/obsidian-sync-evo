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
import type { RemoteEntry } from "../src/core/backend";
import { conflictCopyPath } from "../src/core/conflict-name";
import { createExclusion, type Exclusion } from "../src/core/exclusion";
import { planSync, type LocalEntry, type PlanInput, type SyncPlan, type SyncRecord } from "../src/core/plan";
import { blobHash, MemoryBackend } from "./support/memory-backend";

const ownFolder = ".obsidian/plugins/sync-evo";

/** The exclusion of a vault whose `.gitignore` has this text. */
function rules(gitignore: string | null): Exclusion {
	return createExclusion({ configDir: ".obsidian", pluginDir: ownFolder, gitignore });
}

// A vault without a `.gitignore`, for the tests that are not about what is
// left out. The two fixed exclusions and the default lines still apply; no
// path of those tests comes near them.
const noRules = rules(null);

function planOf(input: Omit<PlanInput, "exclusion"> & { exclusion?: Exclusion }): SyncPlan {
	return planSync({ ...input, exclusion: input.exclusion ?? noRules });
}

interface Scenario {
	/** Files that were on both sides, with a record, at the last sync. */
	synced?: Record<string, string>;
	/** What another device did to the remote since then (`null` deletes). */
	remote?: Record<string, string | null>;
	/** What happened in the vault since then (`null` deletes). */
	local?: Record<string, string | null>;
	/** What is left out of the sync; `noRules` when absent. */
	exclusion?: Exclusion;
}

async function planFor(scenario: Scenario): Promise<SyncPlan> {
	const backend = new MemoryBackend();
	const vault = new Map<string, string>();
	let records: SyncRecord[] = [];

	if (scenario.synced !== undefined) {
		backend.commit(scenario.synced);
		for (const [path, content] of Object.entries(scenario.synced)) vault.set(path, content);
		records = (await listRemote(backend)).map(({ path, kind, hash }) => ({ path, kind, hash }));
	}
	if (scenario.remote !== undefined) backend.commit(scenario.remote);
	for (const [path, content] of Object.entries(scenario.local ?? {})) {
		if (content === null) vault.delete(path);
		else vault.set(path, content);
	}

	const local: LocalEntry[] = [...vault].map(([path, content]) => ({ path, hash: blobHash(content) }));
	return planOf({ remote: await listRemote(backend), local, records, exclusion: scenario.exclusion });
}

async function listRemote(backend: MemoryBackend): Promise<readonly RemoteEntry[]> {
	const result = await backend.list(null);
	if (!result.changed) throw new Error("expected a listing");
	return result.listing.entries;
}

function summary(plan: SyncPlan): string[] {
	return plan.actions.map((action) => `${action.type} ${action.key}`);
}

function skips(plan: SyncPlan): string[] {
	return plan.skipped.map((skip) => `${skip.reason} ${skip.key}`);
}

describe("paths without a record", () => {
	test("a file only on the remote is downloaded, never deleted there", async () => {
		const plan = await planFor({ remote: { "a.md": "A" } });
		expect(summary(plan)).toEqual(["download a.md"]);
	});

	test("a file only in the vault is uploaded, never deleted there", async () => {
		const plan = await planFor({ local: { "a.md": "A" } });
		expect(summary(plan)).toEqual(["upload a.md"]);
	});

	test("the same content on both sides only needs a record", async () => {
		const plan = await planFor({ remote: { "a.md": "A" }, local: { "a.md": "A" } });
		expect(summary(plan)).toEqual(["update-record a.md"]);
	});

	test("different content on both sides is a conflict, not an overwrite", async () => {
		const plan = await planFor({ remote: { "a.md": "theirs" }, local: { "a.md": "mine" } });
		expect(summary(plan)).toEqual(["conflict a.md"]);
	});

	test("a first sync into a vault that has notes takes the remote and deletes nothing", async () => {
		const plan = await planFor({
			remote: { "same.md": "S", "differs.md": "theirs", "remote-only.md": "R" },
			local: { "same.md": "S", "differs.md": "mine", "local-only.md": "L" },
		});
		expect(summary(plan)).toEqual([
			"conflict differs.md",
			"upload local-only.md",
			"download remote-only.md",
			"update-record same.md",
		]);
	});

	test("an empty remote sends everything and deletes nothing", async () => {
		const plan = await planFor({ local: { "a.md": "A", "b.md": "B" } });
		expect(summary(plan)).toEqual(["upload a.md", "upload b.md"]);
	});

	test("when the records are lost, files that still match are not fetched again", async () => {
		const files = { "a.md": "A", "b.md": "B", "c.md": "C" };
		const plan = await planFor({ remote: files, local: files });
		expect(plan.actions.map((action) => action.type)).toEqual([
			"update-record",
			"update-record",
			"update-record",
		]);
	});
});

describe("paths with a record", () => {
	test("nothing changed: nothing to do", async () => {
		const plan = await planFor({ synced: { "a.md": "A", "b.md": "B" } });
		expect(plan).toEqual({ actions: [], skipped: [] });
	});

	test("changed only on the remote: download", async () => {
		const plan = await planFor({ synced: { "a.md": "A" }, remote: { "a.md": "A2" } });
		expect(summary(plan)).toEqual(["download a.md"]);
	});

	test("changed only in the vault: upload", async () => {
		const plan = await planFor({ synced: { "a.md": "A" }, local: { "a.md": "A2" } });
		expect(summary(plan)).toEqual(["upload a.md"]);
	});

	test("changed on both sides to different content: conflict", async () => {
		const plan = await planFor({
			synced: { "a.md": "A" },
			remote: { "a.md": "theirs" },
			local: { "a.md": "mine" },
		});
		expect(summary(plan)).toEqual(["conflict a.md"]);
	});

	test("changed on both sides to the same content: no conflict, only the record moves", async () => {
		const plan = await planFor({
			synced: { "a.md": "A" },
			remote: { "a.md": "A2" },
			local: { "a.md": "A2" },
		});
		expect(summary(plan)).toEqual(["update-record a.md"]);
		expect(plan.actions[0]?.remote?.hash).toBe(blobHash("A2"));
	});

	test("deleted on the remote, untouched in the vault: delete in the vault", async () => {
		const plan = await planFor({ synced: { "a.md": "A" }, remote: { "a.md": null } });
		expect(summary(plan)).toEqual(["delete-local a.md"]);
	});

	test("deleted in the vault, untouched on the remote: delete on the remote", async () => {
		const plan = await planFor({ synced: { "a.md": "A" }, local: { "a.md": null } });
		expect(summary(plan)).toEqual(["delete-remote a.md"]);
	});

	test("deleted on both sides: only the record is dropped", async () => {
		const plan = await planFor({
			synced: { "a.md": "A" },
			remote: { "a.md": null },
			local: { "a.md": null },
		});
		expect(summary(plan)).toEqual(["drop-record a.md"]);
	});

	test("deleted on the remote but edited in the vault: the edit is kept and sent back", async () => {
		const plan = await planFor({
			synced: { "a.md": "A" },
			remote: { "a.md": null },
			local: { "a.md": "edited" },
		});
		expect(summary(plan)).toEqual(["upload a.md"]);
	});

	test("deleted in the vault but edited on the remote: the edit is fetched", async () => {
		const plan = await planFor({
			synced: { "a.md": "A" },
			remote: { "a.md": "edited" },
			local: { "a.md": null },
		});
		expect(summary(plan)).toEqual(["download a.md"]);
	});

	test("each path gets at most one action, in path order", async () => {
		const plan = await planFor({
			synced: { "b.md": "B", "c.md": "C", "d.md": "D" },
			remote: { "c.md": "C2", "a.md": "A" },
			local: { "d.md": null, "e.md": "E" },
		});
		expect(summary(plan)).toEqual(["download a.md", "download c.md", "delete-remote d.md", "upload e.md"]);
	});
});

describe("spelling of paths", () => {
	const nfc = "notes/が.md";
	const nfd = "notes/が.md";

	test("the same name in NFC on the remote and NFD in the vault is one file", async () => {
		const plan = await planFor({ synced: { [nfc]: "A" }, local: { [nfc]: null, [nfd]: "A" } });
		expect(plan).toEqual({ actions: [], skipped: [] });
	});

	test("the same name in NFD on the remote and NFC in the vault is one file", async () => {
		const plan = await planFor({ synced: { [nfd]: "A" }, local: { [nfd]: null, [nfc]: "A" } });
		expect(plan).toEqual({ actions: [], skipped: [] });
	});

	test("an edit to a file whose spelling differs is one upload, not a delete and an add", async () => {
		const plan = await planFor({ synced: { [nfd]: "A" }, local: { [nfd]: null, [nfc]: "A2" } });
		expect(summary(plan)).toEqual([`upload ${nfc}`]);
		expect(plan.actions[0]?.remote?.path).toBe(nfd);
	});

	test("when only the spelling changes on the remote, the record follows and the vault is left alone", async () => {
		const plan = await planFor({ synced: { [nfd]: "A" }, remote: { [nfd]: null, [nfc]: "A" } });
		expect(summary(plan)).toEqual([`update-record ${nfc}`]);
		expect(plan.actions[0]?.remote?.path).toBe(nfc);
		expect(plan.actions[0]?.local?.path).toBe(nfd);
	});

	test("two remote paths that differ only in normalization are left alone on every side", async () => {
		const plan = await planFor({ remote: { [nfc]: "one", [nfd]: "two" }, local: { [nfc]: "mine" } });
		expect(plan.actions).toEqual([]);
		expect(skips(plan)).toEqual([`duplicate-path ${nfc}`]);
		expect(plan.skipped[0]?.remote.map((entry) => entry.path).sort()).toEqual([nfc, nfd].sort());
		expect(plan.skipped[0]?.local.map((entry) => entry.path)).toEqual([nfc]);
		expect(plan.skipped[0]?.records).toEqual([]);
	});

	test("two vault paths that differ only in normalization are left alone on every side", async () => {
		const backend = new MemoryBackend();
		backend.commit({ [nfc]: "A" });
		const remote = await listRemote(backend);
		const local: LocalEntry[] = [
			{ path: nfc, hash: blobHash("A") },
			{ path: nfd, hash: blobHash("edited") },
		];
		const plan = planOf({ remote, local, records: remote });
		expect(plan.actions).toEqual([]);
		expect(skips(plan)).toEqual([`duplicate-path ${nfc}`]);
		expect(plan.skipped[0]?.local).toEqual(local);
		expect(plan.skipped[0]?.remote).toEqual(remote);
		expect(plan.skipped[0]?.records).toEqual(remote);
	});
});

describe("remote paths that differ only in case", () => {
	test("neither is fetched, and the one missing from the vault is not deleted on the remote", async () => {
		const backend = new MemoryBackend();
		backend.commit({ "a.md": "one", "A.md": "two" });
		const remote = await listRemote(backend);
		// What a device that does not tell the cases apart is left with
		// after writing both: one file, and a record for each.
		const plan = planOf({ remote, local: [{ path: "A.md", hash: blobHash("two") }], records: remote });
		expect(plan.actions).toEqual([]);
		expect(skips(plan)).toEqual(["case-collision A.md", "case-collision a.md"]);
	});

	test("a folder spelled two ways shields every path below both, on every side", () => {
		const x = blobHash("X");
		const plan = planOf({
			remote: [
				{ path: "notes/a.md", kind: "file", hash: x },
				{ path: "Notes/b.md", kind: "file", hash: x },
				{ path: "other/c.md", kind: "file", hash: x },
			],
			local: [{ path: "notes/mine.md", hash: x }],
			records: [{ path: "Notes/gone.md", kind: "file", hash: x }],
		});
		expect(summary(plan)).toEqual(["download other/c.md"]);
		expect(skips(plan)).toEqual([
			"case-collision Notes/b.md",
			"case-collision Notes/gone.md",
			"case-collision notes/a.md",
			"case-collision notes/mine.md",
		]);
	});

	test("one spelling on the remote and another in the vault is no collision", async () => {
		const plan = await planFor({ remote: { "Notes/a.md": "A" }, local: { "notes/a.md": "A" } });
		expect(plan.skipped).toEqual([]);
	});
});

describe("files over the size limit", () => {
	const small = blobHash("small");

	test("a remote file over the limit is not fetched, and a vault file there is not sent over it", () => {
		const remote: RemoteEntry[] = [{ path: "big.bin", kind: "file", hash: blobHash("big"), size: 11 }];
		const withFile = planOf({ remote, local: [{ path: "big.bin", hash: small, size: 5 }], records: [], sizeLimit: 10 });
		expect(withFile.actions).toEqual([]);
		expect(skips(withFile)).toEqual(["too-large big.bin"]);
		expect(skips(planOf({ remote, local: [], records: [], sizeLimit: 10 }))).toEqual(["too-large big.bin"]);
	});

	test("a vault file over the limit is not sent, and not deleted when the remote deleted it", () => {
		const local: LocalEntry[] = [{ path: "big.bin", hash: small, size: 11 }];
		expect(planOf({ remote: [], local, records: [], sizeLimit: 10 }).actions).toEqual([]);
		const record: SyncRecord = { path: "big.bin", kind: "file", hash: small };
		expect(planOf({ remote: [], local, records: [record], sizeLimit: 10 }).actions).toEqual([]);
	});

	test("the limit is 50 MB unless given, and a file of exactly that size is synced", () => {
		const at = (size: number): RemoteEntry[] => [{ path: "big.bin", kind: "file", hash: small, size }];
		expect(summary(planOf({ remote: at(50 * 1024 * 1024), local: [], records: [] }))).toEqual(["download big.bin"]);
		expect(skips(planOf({ remote: at(50 * 1024 * 1024 + 1), local: [], records: [] }))).toEqual(["too-large big.bin"]);
	});
});

describe("across every combination of the three sides", () => {
	const contents = [undefined, "A", "B"] as const;
	const remote: RemoteEntry[] = [];
	const local: LocalEntry[] = [];
	const records: SyncRecord[] = [];
	const unrecorded = new Set<string>();

	// One path per combination: recorded or not, and on each side absent or
	// holding one of two contents.
	for (const recorded of contents.slice(0, 2)) {
		for (const theirs of contents) {
			for (const mine of contents) {
				const path = `${recorded ?? "none"}/${theirs ?? "none"}-${mine ?? "none"}.md`;
				if (recorded === undefined) unrecorded.add(path);
				else records.push({ path, kind: "file", hash: blobHash(recorded) });
				if (theirs !== undefined) remote.push({ path, kind: "file", hash: blobHash(theirs) });
				if (mine !== undefined) local.push({ path, hash: blobHash(mine) });
			}
		}
	}
	const plan = planOf({ remote, local, records });
	const deletes = plan.actions.filter(
		(action) => action.type === "delete-local" || action.type === "delete-remote",
	);

	test("a path without a record is never deleted on either side", () => {
		expect(unrecorded.size).toBe(9);
		expect(deletes.filter((action) => unrecorded.has(action.key))).toEqual([]);
	});

	test("the same holds when each path is planned on its own", () => {
		for (const path of unrecorded) {
			const alone = planOf({
				remote: remote.filter((entry) => entry.path === path),
				local: local.filter((entry) => entry.path === path),
				records: [],
			});
			expect(alone.actions.map((action) => action.type)).not.toContain("delete-local");
			expect(alone.actions.map((action) => action.type)).not.toContain("delete-remote");
		}
	});

	test("the recorded paths do include deletions, so the check above can fail", () => {
		expect(summary({ actions: deletes, skipped: [] })).toEqual([
			"delete-remote A/A-none.md",
			"delete-local A/none-A.md",
		]);
		expect(plan.skipped).toEqual([]);
	});
});

describe("entries that are not regular files", () => {
	const hash = blobHash("../target");

	test("a symlink or submodule on the remote is not written", () => {
		const plan = planOf({
			remote: [
				{ path: "link", kind: "symlink", hash },
				{ path: "sub", kind: "submodule", hash },
			],
			local: [],
			records: [],
		});
		expect(plan.actions).toEqual([]);
		expect(plan.skipped.map((skip) => skip.reason)).toEqual(["symlink", "submodule"]);
	});

	test("a path recorded as a symlink is left alone even when both sides now hold a file", () => {
		const file = blobHash("a real file");
		const plan = planOf({
			remote: [{ path: "link", kind: "file", hash: file }],
			local: [{ path: "link", hash: blobHash("another file") }],
			records: [{ path: "link", kind: "symlink", hash }],
		});
		expect(plan.actions).toEqual([]);
		expect(skips(plan)).toEqual(["symlink link"]);
	});

	test("a path recorded as a symlink and gone from both sides keeps its record", () => {
		const plan = planOf({ remote: [], local: [], records: [{ path: "link", kind: "symlink", hash }] });
		expect(plan.actions).toEqual([]);
		expect(skips(plan)).toEqual(["symlink link"]);
	});

	test("a recorded symlink that is absent from the vault is not deleted on the remote", () => {
		const plan = planOf({
			remote: [{ path: "link", kind: "symlink", hash }],
			local: [],
			records: [{ path: "link", kind: "symlink", hash }],
		});
		expect(plan.actions).toEqual([]);
	});

	test("a vault file at the path of a remote symlink is not sent over it", () => {
		const plan = planOf({
			remote: [{ path: "link", kind: "symlink", hash }],
			local: [{ path: "link", hash: blobHash("a real file") }],
			records: [],
		});
		expect(plan.actions).toEqual([]);
	});

	test("a vault file below a remote submodule is not sent", () => {
		const plan = planOf({
			remote: [{ path: "sub", kind: "submodule", hash }],
			local: [{ path: "sub/x.md", hash: blobHash("X") }],
			records: [],
		});
		expect(plan.actions).toEqual([]);
		expect(skips(plan)).toEqual(["submodule sub", "under-non-file sub/x.md"]);
		expect(plan.skipped[1]?.local.map((entry) => entry.path)).toEqual(["sub/x.md"]);
	});

	test("paths below a remote symlink are left alone on every side", () => {
		const x = blobHash("X");
		const plan = planOf({
			remote: [
				{ path: "link", kind: "symlink", hash },
				{ path: "link/on-remote.md", kind: "file", hash: x },
			],
			local: [
				{ path: "link/in-vault.md", hash: x },
				{ path: "link/deep/er.md", hash: x },
				{ path: "link/deleted-there.md", hash: x },
			],
			records: [
				{ path: "link/deleted-there.md", kind: "file", hash: x },
				{ path: "link/deleted-here.md", kind: "file", hash: x },
			],
		});
		expect(plan.actions).toEqual([]);
		expect(skips(plan)).toEqual([
			"symlink link",
			"under-non-file link/deep/er.md",
			"under-non-file link/deleted-here.md",
			"under-non-file link/deleted-there.md",
			"under-non-file link/in-vault.md",
			"under-non-file link/on-remote.md",
		]);
	});

	test("a symlink that is only in the records still shields the paths below it", () => {
		const x = blobHash("X");
		const plan = planOf({
			remote: [{ path: "link/on-remote.md", kind: "file", hash: x }],
			local: [{ path: "link/in-vault.md", hash: x }],
			records: [
				{ path: "link", kind: "symlink", hash },
				{ path: "link/gone.md", kind: "file", hash: x },
			],
		});
		expect(plan.actions).toEqual([]);
		expect(skips(plan)).toEqual([
			"symlink link",
			"under-non-file link/gone.md",
			"under-non-file link/in-vault.md",
			"under-non-file link/on-remote.md",
		]);
	});

	test("the parent is matched by its normalized name, and only as a whole folder name", () => {
		const plan = planOf({
			remote: [{ path: "が", kind: "submodule", hash }],
			local: [
				{ path: "が/x.md", hash: blobHash("X") },
				{ path: "がく/x.md", hash: blobHash("X") },
				{ path: "が.md", hash: blobHash("X") },
			],
			records: [],
		});
		expect(summary(plan)).toEqual(["upload が.md", "upload がく/x.md"]);
		expect(skips(plan)).toEqual(["submodule が", "under-non-file が/x.md"]);
	});
});

describe("the rules of .gitignore", () => {
	const drafts = rules("/drafts/\n*.png\n");

	test("only in the vault and matched: left alone, and listed as excluded", async () => {
		const plan = await planFor({ local: { "drafts/a.md": "A", "img.png": "P", "b.md": "B" }, exclusion: drafts });
		expect(summary(plan)).toEqual(["upload b.md"]);
		expect(skips(plan)).toEqual(["excluded drafts/a.md", "excluded img.png"]);
		expect(plan.skipped[0]?.local.map((entry) => entry.path)).toEqual(["drafts/a.md"]);
	});

	test("only on the remote and matched: downloaded, never deleted there", async () => {
		const plan = await planFor({ remote: { "drafts/a.md": "A", "img.png": "P" }, exclusion: drafts });
		expect(summary(plan)).toEqual(["download drafts/a.md", "download img.png"]);
		expect(plan.skipped).toEqual([]);
	});

	test("on both sides without a record and matched: compared like any other path", async () => {
		const plan = await planFor({
			remote: { "drafts/same.md": "S", "drafts/differs.md": "theirs" },
			local: { "drafts/same.md": "S", "drafts/differs.md": "mine" },
			exclusion: drafts,
		});
		expect(summary(plan)).toEqual(["conflict drafts/differs.md", "update-record drafts/same.md"]);
	});

	test("a recorded path keeps syncing when a rule is added for it", async () => {
		const plan = await planFor({
			synced: { "drafts/up.md": "1", "drafts/down.md": "1", "drafts/gone-here.md": "1", "drafts/same.md": "1" },
			remote: { "drafts/down.md": "2" },
			local: { "drafts/up.md": "2", "drafts/gone-here.md": null },
			exclusion: drafts,
		});
		expect(summary(plan)).toEqual([
			"download drafts/down.md",
			"delete-remote drafts/gone-here.md",
			"upload drafts/up.md",
		]);
		expect(plan.skipped).toEqual([]);
	});

	test("recorded, deleted on the remote, untouched in the vault: deleted in the vault as usual", async () => {
		const plan = await planFor({
			synced: { "drafts/a.md": "A" },
			remote: { "drafts/a.md": null },
			exclusion: drafts,
		});
		expect(summary(plan)).toEqual(["delete-local drafts/a.md"]);
	});

	test("recorded, deleted on the remote, edited in the vault: kept, not sent back, and the record dropped", async () => {
		const plan = await planFor({
			synced: { "drafts/a.md": "A" },
			remote: { "drafts/a.md": null },
			local: { "drafts/a.md": "edited" },
			exclusion: drafts,
		});
		expect(summary(plan)).toEqual(["drop-record drafts/a.md"]);
		// The action carries the vault file, which tells it from "gone on both sides".
		expect(plan.actions[0]?.local?.hash).toBe(blobHash("edited"));
		expect(plan.actions[0]?.remote).toBeUndefined();
	});

	test("after the record is dropped the file is simply excluded, so the decision is not repeated", async () => {
		const plan = await planFor({ local: { "drafts/a.md": "edited" }, exclusion: drafts });
		expect(plan.actions).toEqual([]);
		expect(skips(plan)).toEqual(["excluded drafts/a.md"]);
	});

	test("and if the remote holds it again with other content, that is a conflict", async () => {
		const plan = await planFor({
			remote: { "drafts/a.md": "back" },
			local: { "drafts/a.md": "edited" },
			exclusion: drafts,
		});
		expect(summary(plan)).toEqual(["conflict drafts/a.md"]);
	});

	test("the same case without a matching rule is still sent back", async () => {
		const plan = await planFor({
			synced: { "notes/a.md": "A" },
			remote: { "notes/a.md": null },
			local: { "notes/a.md": "edited" },
			exclusion: drafts,
		});
		expect(summary(plan)).toEqual(["upload notes/a.md"]);
	});

	test("gone on both sides: the record is dropped, as without rules", async () => {
		const plan = await planFor({
			synced: { "drafts/a.md": "A" },
			remote: { "drafts/a.md": null },
			local: { "drafts/a.md": null },
			exclusion: drafts,
		});
		expect(summary(plan)).toEqual(["drop-record drafts/a.md"]);
		expect(plan.actions[0]?.local).toBeUndefined();
	});

	test("with no section in .gitignore, the default lines exclude what the remote does not hold", async () => {
		const plan = await planFor({
			remote: { ".obsidian/workspace.json": "theirs", ".obsidian/plugins/dataview/main.js": "D" },
			local: {
				".obsidian/workspace.json": "mine",
				".obsidian/workspace-mobile.json": "M",
				".obsidian/plugins/tasks/main.js": "T",
				".trash/old.md": "O",
				"notes/.DS_Store": "S",
				".obsidian/app.json": "A",
			},
			exclusion: rules("*.log\n"),
		});
		expect(summary(plan)).toEqual([
			"upload .obsidian/app.json",
			"download .obsidian/plugins/dataview/main.js",
			"conflict .obsidian/workspace.json",
		]);
		expect(skips(plan)).toEqual([
			"excluded .obsidian/plugins/tasks/main.js",
			"excluded .obsidian/workspace-mobile.json",
			"excluded .trash/old.md",
			"excluded notes/.DS_Store",
		]);
	});

	test("paths that start with a dot are ordinary files", async () => {
		const plan = await planFor({
			synced: { ".github/workflows/ci.yml": "1" },
			remote: { ".github/workflows/ci.yml": "2", ".gitmodules": "M", ".claude/settings.json": "C" },
			local: { ".github/dependabot.yml": "D" },
			exclusion: rules(null),
		});
		expect(summary(plan)).toEqual([
			"download .claude/settings.json",
			"upload .github/dependabot.yml",
			"download .github/workflows/ci.yml",
			"download .gitmodules",
		]);
		expect(plan.skipped).toEqual([]);
	});

	test("a .gitignore in a subfolder is an ordinary file and its rules have no effect", async () => {
		const plan = await planFor({
			local: { "notes/.gitignore": "*.png\n", "notes/a.png": "P" },
			exclusion: rules("*.log\n"),
		});
		expect(summary(plan)).toEqual(["upload notes/.gitignore", "upload notes/a.png"]);
	});

	test(".gitignore changed on the remote is fetched, not a conflict, and no rule can exclude it", async () => {
		const plan = await planFor({
			synced: { ".gitignore": "*.log\n" },
			remote: { ".gitignore": "*.log\n/drafts/\n" },
			// Made from the text the vault has: nothing was written to it.
			exclusion: rules("*.log\n"),
		});
		expect(summary(plan)).toEqual(["download .gitignore"]);

		const firstSend = await planFor({ local: { ".gitignore": ".*\n" }, exclusion: rules(".*\n") });
		expect(summary(firstSend)).toEqual(["upload .gitignore"]);
	});

	test("a rule in NFC excludes a vault path returned in NFD, and a known path is one file in either form", async () => {
		const nfc = "ガイド/が.md";
		const nfd = nfc.normalize("NFD");
		const exclusion = rules("/ガイド/\n");
		const onlyLocal = await planFor({ local: { [nfd]: "A" }, exclusion });
		expect(skips(onlyLocal)).toEqual([`excluded ${nfc}`]);

		for (const [theirs, mine] of [
			[nfc, nfd],
			[nfd, nfc],
		] as const) {
			const plan = await planFor({ synced: { [theirs]: "A" }, local: { [theirs]: null, [mine]: "A" }, exclusion });
			expect(plan).toEqual({ actions: [], skipped: [] });
		}
	});

	test("a conflict copy is judged by the name of the file it is a copy of", async () => {
		const at = new Date(2026, 9, 3, 22, 15, 0);
		const exclusion = rules("/exact.md\n*.conflict-from-*\n!kept.md\n");
		const excluded = conflictCopyPath("exact.md", "iPhone", at);
		const sent = conflictCopyPath("kept.md", "iPhone", at);
		const plan = await planFor({ local: { [excluded]: "mine", [sent]: "mine" }, exclusion });
		expect(summary(plan)).toEqual([`upload ${sent}`]);
		expect(skips(plan)).toEqual([`excluded ${excluded}`]);
	});
});

describe("a conflict copy and the rules", () => {
	const at = new Date(2026, 9, 3, 22, 15, 0);
	const exclusion = rules("/drafts/\n*.png\n");

	test("the copy of a tracked file in an excluded folder is sent", async () => {
		const copy = conflictCopyPath("drafts/a.md", "iPhone", at);
		const plan = await planFor({ synced: { "drafts/a.md": "theirs" }, local: { [copy]: "mine" }, exclusion });
		expect(summary(plan)).toEqual([`upload ${copy}`]);
		expect(plan.skipped).toEqual([]);
	});

	test("the copy of a tracked image is sent, though the rule matches images", async () => {
		const copy = conflictCopyPath("img.png", "iPhone", at);
		const plan = await planFor({
			synced: { "img.png": "theirs" },
			local: { [copy]: "mine", "new.png": "N" },
			exclusion,
		});
		expect(summary(plan)).toEqual([`upload ${copy}`]);
		expect(skips(plan)).toEqual(["excluded new.png"]);
	});

	test("the original on the remote is enough, with or without a record", async () => {
		const copy = conflictCopyPath("img.png", "iPhone", at);
		const plan = await planFor({ remote: { "img.png": "theirs" }, local: { [copy]: "mine" }, exclusion });
		expect(summary(plan)).toEqual([`upload ${copy}`, "download img.png"]);
	});

	test("a record of the original is not enough: once the remote deleted it, the copy is excluded", async () => {
		const copy = conflictCopyPath("img.png", "iPhone", at);
		const plan = await planFor({
			synced: { "img.png": "theirs" },
			remote: { "img.png": null },
			local: { [copy]: "mine" },
			exclusion,
		});
		expect(summary(plan)).toEqual(["delete-local img.png"]);
		expect(skips(plan)).toEqual([`excluded ${copy}`]);
	});

	test("the copy of a file that is not known is excluded", async () => {
		const copies = [conflictCopyPath("drafts/a.md", "iPhone", at), conflictCopyPath("img.png", "iPhone", at)];
		const plan = await planFor({
			synced: { "drafts/other.md": "O" },
			local: { [copies[0] ?? ""]: "mine", [copies[1] ?? ""]: "mine" },
			exclusion,
		});
		expect(plan.actions).toEqual([]);
		expect(skips(plan)).toEqual(copies.map((copy) => `excluded ${copy}`).sort());
	});

	test("a copy of a copy goes by the first file", async () => {
		const first = conflictCopyPath("img.png", "iPhone", at);
		const second = conflictCopyPath(first, "iPhone", at, 2);
		const plan = await planFor({ synced: { "img.png": "theirs" }, local: { [second]: "mine" }, exclusion });
		expect(summary(plan)).toEqual([`upload ${second}`]);
	});

	test("a recorded copy the remote deleted and the vault edited is sent back only while its original is on the remote", async () => {
		const copy = conflictCopyPath("img.png", "iPhone", at);
		const onRemote = await planFor({
			synced: { "img.png": "theirs", [copy]: "mine" },
			remote: { [copy]: null },
			local: { [copy]: "edited" },
			exclusion,
		});
		expect(summary(onRemote)).toEqual([`upload ${copy}`]);

		// The remote deleted both: the copy is like any other matched path.
		const deleted = await planFor({
			synced: { "img.png": "theirs", [copy]: "mine" },
			remote: { "img.png": null, [copy]: null },
			local: { [copy]: "edited" },
			exclusion,
		});
		expect(summary(deleted)).toEqual([`drop-record ${copy}`, "delete-local img.png"]);
	});
});

describe("the two things that are never synced", () => {
	// Every line that could bring them back.
	const exclusion = rules("!.git\n!.git/\n!**/.git/**\n!/.obsidian/plugins/\n!/.obsidian/plugins/sync-evo/\n");

	test("the plugin's own folder is left alone on every side, even when the remote holds it", () => {
		const hash = blobHash("x");
		const other = blobHash("y");
		const plan = planOf({
			remote: [
				{ path: `${ownFolder}/main.js`, kind: "file", hash },
				{ path: `${ownFolder}/remote-only.js`, kind: "file", hash },
				{ path: `${ownFolder}/deleted-here.js`, kind: "file", hash },
				{ path: `${ownFolder}/changed-there.js`, kind: "file", hash: other },
			],
			local: [
				{ path: `${ownFolder}/main.js`, hash: other },
				{ path: `${ownFolder}/manifest.json`, hash },
				{ path: `${ownFolder}/deleted-there.js`, hash },
				{ path: `${ownFolder}/changed-there.js`, hash },
			],
			records: [
				{ path: `${ownFolder}/deleted-here.js`, kind: "file", hash },
				{ path: `${ownFolder}/deleted-there.js`, kind: "file", hash },
				{ path: `${ownFolder}/changed-there.js`, kind: "file", hash },
				{ path: `${ownFolder}/gone.js`, kind: "file", hash },
			],
			exclusion,
		});
		expect(plan.actions).toEqual([]);
		expect(plan.skipped.map((skip) => skip.reason)).toEqual(Array(7).fill("own-folder"));
		// What tells the caller that the remote holds the folder.
		const onRemote = plan.skipped.filter((skip) => skip.reason === "own-folder" && skip.remote.length > 0);
		expect(onRemote.map((skip) => skip.key)).toEqual([
			`${ownFolder}/changed-there.js`,
			`${ownFolder}/deleted-here.js`,
			`${ownFolder}/main.js`,
			`${ownFolder}/remote-only.js`,
		]);
	});

	test("the other plugins next to it are synced, since the rule for them was taken back", async () => {
		const plan = await planFor({ local: { ".obsidian/plugins/dataview/main.js": "D" }, exclusion });
		expect(summary(plan)).toEqual(["upload .obsidian/plugins/dataview/main.js"]);
	});

	test("anything under a .git is left alone on every side, at any depth", () => {
		const hash = blobHash("x");
		const plan = planOf({
			remote: [{ path: "sub/.git/config", kind: "file", hash }],
			local: [
				{ path: ".git/HEAD", hash },
				{ path: "sub/.git", hash },
				{ path: ".gitignore", hash },
				{ path: ".github/a.yml", hash },
			],
			records: [{ path: ".git/index", kind: "file", hash }],
			exclusion,
		});
		expect(summary(plan)).toEqual(["upload .github/a.yml", "upload .gitignore"]);
		expect(skips(plan)).toEqual(["dot-git .git/HEAD", "dot-git .git/index", "dot-git sub/.git", "dot-git sub/.git/config"]);
	});

	test("they come before every other reason to skip a path", () => {
		const hash = blobHash("x");
		const plan = planOf({
			remote: [
				{ path: `${ownFolder}/link`, kind: "symlink", hash },
				{ path: `${ownFolder}/link/below`, kind: "file", hash },
			],
			local: [],
			records: [],
			exclusion,
		});
		expect(plan.skipped.map((skip) => skip.reason)).toEqual(["own-folder", "own-folder"]);
	});
});

describe("paths that are not paths", () => {
	const hash = blobHash("x");
	const odd = ["", "/", "a/", "/a.md", "./a.md", "../x", "a//b.md", "a/./b.md", "a/../b.md", "."];

	test.each(odd)("%j is skipped on every side, wherever it comes from", (path) => {
		for (const side of ["remote", "local", "records"] as const) {
			const plan = planOf({
				remote: side === "remote" ? [{ path, kind: "file", hash }] : [],
				local: side === "local" ? [{ path, hash }] : [],
				records: side === "records" ? [{ path, kind: "file", hash }] : [],
			});
			expect(plan.actions).toEqual([]);
			expect(skips(plan)).toEqual([`invalid-path ${path}`]);
			expect(plan.skipped[0]?.[side].map((entry) => entry.path)).toEqual([path]);
		}
	});

	test("the rest of the plan is made as usual", () => {
		const plan = planOf({
			remote: [...odd.map((path) => ({ path, kind: "file" as const, hash })), { path: "a.md", kind: "file", hash }],
			local: [
				{ path: "b.md", hash },
				{ path: "drafts/c.md", hash },
				{ path: "./d.md", hash },
			],
			records: [{ path: "a//b.md", kind: "file", hash }],
			exclusion: rules("/drafts/\n"),
		});
		expect(summary(plan)).toEqual(["download a.md", "upload b.md"]);
		expect(plan.skipped.filter((skip) => skip.reason === "invalid-path").map((skip) => skip.key).sort()).toEqual(
			[...odd, "./d.md"].sort(),
		);
		expect(skips(plan)).toContain("excluded drafts/c.md");
	});

	test("it comes before every other reason, a duplicate included", () => {
		const plan = planOf({
			remote: [
				{ path: "が/", kind: "file", hash },
				{ path: "が/".normalize("NFD"), kind: "symlink", hash },
			],
			local: [],
			records: [],
		});
		expect(skips(plan)).toEqual(["invalid-path が/"]);
	});
});
