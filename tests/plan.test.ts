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
import { createExclusion, type Exclusion } from "../src/core/exclusion";
import { planSync, type LocalEntry, type PlanInput, type SyncPlan, type SyncRecord } from "../src/core/plan";
import { blobHash, MemoryBackend } from "./support/memory-backend";
import { earlierCopyPath } from "./support/earlier-copy-name";

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
		expect(plan).toEqual({ actions: [], skipped: [], marks: [] });
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
		expect(plan).toEqual({ actions: [], skipped: [], marks: [] });
	});

	test("the same name in NFD on the remote and NFC in the vault is one file", async () => {
		const plan = await planFor({ synced: { [nfd]: "A" }, local: { [nfd]: null, [nfc]: "A" } });
		expect(plan).toEqual({ actions: [], skipped: [], marks: [] });
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

	test("the limit is 38 MiB unless given, and a file of exactly that size is synced", () => {
		const at = (size: number): RemoteEntry[] => [{ path: "big.bin", kind: "file", hash: small, size }];
		expect(summary(planOf({ remote: at(38 * 1024 * 1024), local: [], records: [] }))).toEqual(["download big.bin"]);
		expect(skips(planOf({ remote: at(38 * 1024 * 1024 + 1), local: [], records: [] }))).toEqual(["too-large big.bin"]);
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
		expect(summary({ actions: deletes, skipped: [], marks: [] })).toEqual([
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

describe("below a submodule whose inside the listing holds", () => {
	const commit = "c".repeat(40);
	const source = { submodule: "sub", repository: "octo/sub", revision: commit };
	/** The submodule, with what is inside it listed. */
	const sub: RemoteEntry = {
		path: "sub",
		kind: "submodule",
		hash: commit,
		contents: { listed: true, repository: "octo/sub" },
	};
	/** A file the listing holds below the submodule. */
	const inside = (path: string, content: string): RemoteEntry => ({
		path,
		kind: "file",
		hash: blobHash(content),
		source,
	});
	const inVault = (path: string, content: string): LocalEntry => ({ path, hash: blobHash(content) });
	const recorded = (path: string, content: string): SyncRecord => ({ path, kind: "file", hash: blobHash(content) });

	test("the submodule itself is still not written, and is skipped as one", () => {
		const plan = planOf({ remote: [sub], local: [], records: [] });
		expect(plan.actions).toEqual([]);
		expect(skips(plan)).toEqual(["submodule sub"]);
	});

	test("a file only on the remote is downloaded", () => {
		const plan = planOf({ remote: [sub, inside("sub/a.md", "A"), inside("sub/docs/b.md", "B")], local: [], records: [] });
		expect(summary(plan)).toEqual(["download sub/a.md", "download sub/docs/b.md"]);
		expect(skips(plan)).toEqual(["submodule sub"]);
	});

	test("the entry to download is the one of the listing, with where it is read from", () => {
		const entry = inside("sub/a.md", "A");
		const plan = planOf({ remote: [sub, entry], local: [], records: [] });
		expect(plan.actions).toEqual([{ type: "download", key: "sub/a.md", remote: entry }]);
	});

	test("the same content on both sides only needs a record", () => {
		const plan = planOf({ remote: [sub, inside("sub/a.md", "A")], local: [inVault("sub/a.md", "A")], records: [] });
		expect(summary(plan)).toEqual(["update-record sub/a.md"]);
	});

	test("nothing changed: nothing to do", () => {
		const plan = planOf({
			remote: [sub, inside("sub/a.md", "A")],
			local: [inVault("sub/a.md", "A")],
			records: [recorded("sub/a.md", "A")],
		});
		expect(plan.actions).toEqual([]);
		expect(skips(plan)).toEqual(["submodule sub"]);
	});

	test("changed only on the remote: download", () => {
		const plan = planOf({
			remote: [sub, inside("sub/a.md", "A2")],
			local: [inVault("sub/a.md", "A")],
			records: [recorded("sub/a.md", "A")],
		});
		expect(summary(plan)).toEqual(["download sub/a.md"]);
	});

	test("edited only in the vault: not sent, and nothing else is done to it", () => {
		const plan = planOf({
			remote: [sub, inside("sub/a.md", "A")],
			local: [inVault("sub/a.md", "mine")],
			records: [recorded("sub/a.md", "A")],
		});
		expect(plan.actions).toEqual([]);
		expect(skips(plan)).toEqual(["submodule sub", "in-submodule sub/a.md"]);
		// All three sides go along, for whoever tells the user.
		expect(plan.skipped[1]).toEqual({
			key: "sub/a.md",
			reason: "in-submodule",
			remote: [inside("sub/a.md", "A")],
			local: [inVault("sub/a.md", "mine")],
			records: [recorded("sub/a.md", "A")],
		});
	});

	test("a file only in the vault is not sent", () => {
		const plan = planOf({ remote: [sub, inside("sub/a.md", "A")], local: [inVault("sub/new.md", "N")], records: [] });
		expect(summary(plan)).toEqual(["download sub/a.md"]);
		expect(skips(plan)).toEqual(["submodule sub", "in-submodule sub/new.md"]);
	});

	test("a file only in the vault is not sent though the submodule holds nothing", () => {
		const plan = planOf({ remote: [sub], local: [inVault("sub/new.md", "N")], records: [] });
		expect(plan.actions).toEqual([]);
		expect(skips(plan)).toEqual(["submodule sub", "in-submodule sub/new.md"]);
	});

	test("a recorded file deleted in the vault is not deleted on the remote", () => {
		const plan = planOf({ remote: [sub, inside("sub/a.md", "A")], local: [], records: [recorded("sub/a.md", "A")] });
		expect(plan.actions).toEqual([]);
		expect(skips(plan)).toEqual(["submodule sub", "in-submodule sub/a.md"]);
	});

	test("changed on both sides is a conflict: the vault's content is not written over", () => {
		const plan = planOf({
			remote: [sub, inside("sub/a.md", "theirs")],
			local: [inVault("sub/a.md", "mine")],
			records: [recorded("sub/a.md", "A")],
		});
		expect(summary(plan)).toEqual(["conflict sub/a.md"]);
		expect(skips(plan)).toEqual(["submodule sub"]);
	});

	test("different content on both sides without a record is a conflict", () => {
		const plan = planOf({ remote: [sub, inside("sub/a.md", "theirs")], local: [inVault("sub/a.md", "mine")], records: [] });
		expect(summary(plan)).toEqual(["conflict sub/a.md"]);
	});

	test("deleted on the remote and unchanged in the vault: deleted in the vault", () => {
		const plan = planOf({ remote: [sub], local: [inVault("sub/a.md", "A")], records: [recorded("sub/a.md", "A")] });
		expect(summary(plan)).toEqual(["delete-local sub/a.md"]);
	});

	test("deleted on both sides: only the record goes", () => {
		const plan = planOf({ remote: [sub], local: [], records: [recorded("sub/a.md", "A")] });
		expect(summary(plan)).toEqual(["drop-record sub/a.md"]);
	});

	test("deleted on the remote but edited in the vault: the edit is kept, and not sent back", () => {
		const plan = planOf({ remote: [sub], local: [inVault("sub/a.md", "mine")], records: [recorded("sub/a.md", "A")] });
		expect(plan.actions).toEqual([]);
		expect(skips(plan)).toEqual(["submodule sub", "in-submodule sub/a.md"]);
	});

	test("deleted in the vault but edited on the remote: the edit is fetched", () => {
		const plan = planOf({ remote: [sub, inside("sub/a.md", "A2")], local: [], records: [recorded("sub/a.md", "A")] });
		expect(summary(plan)).toEqual(["download sub/a.md"]);
	});

	test("the submodule gone from the remote: what was fetched below it is deleted in the vault", () => {
		const plan = planOf({
			remote: [],
			local: [inVault("sub/a.md", "A"), inVault("sub/docs/b.md", "B")],
			records: [recorded("sub/a.md", "A"), recorded("sub/docs/b.md", "B")],
		});
		expect(summary(plan)).toEqual(["delete-local sub/a.md", "delete-local sub/docs/b.md"]);
		expect(plan.skipped).toEqual([]);
	});

	// Once the remote no longer holds the submodule, nothing says the paths were below one.
	test("the submodule gone from the remote: what the vault alone changed below it is sent as files of the remote", () => {
		const plan = planOf({
			remote: [],
			local: [inVault("sub/a.md", "mine"), inVault("sub/new.md", "N")],
			records: [recorded("sub/a.md", "A")],
		});
		expect(summary(plan)).toEqual(["upload sub/a.md", "upload sub/new.md"]);
	});

	test("a submodule inside it stays closed, and the files beside it are still compared", () => {
		const deep: RemoteEntry = {
			path: "sub/deep",
			kind: "submodule",
			hash: commit,
			contents: { listed: false, reason: "nested" },
		};
		const plan = planOf({
			remote: [sub, deep, inside("sub/a.md", "A")],
			local: [inVault("sub/deep/x.md", "X"), inVault("sub/new.md", "N")],
			records: [],
		});
		expect(summary(plan)).toEqual(["download sub/a.md"]);
		expect(skips(plan)).toEqual([
			"submodule sub",
			"submodule sub/deep",
			"under-non-file sub/deep/x.md",
			"in-submodule sub/new.md",
		]);
	});

	test("a path whose name only begins like the submodule's is not below it", () => {
		const plan = planOf({
			remote: [sub],
			local: [inVault("sub.md", "X"), inVault("subs/x.md", "X")],
			records: [],
		});
		expect(summary(plan)).toEqual(["upload sub.md", "upload subs/x.md"]);
	});

	test("a file over the size limit below it is not fetched", () => {
		const big: RemoteEntry = { ...inside("sub/big.bin", "B"), size: 11 };
		const plan = planOf({ remote: [sub, big], local: [], records: [], sizeLimit: 10 });
		expect(plan.actions).toEqual([]);
		expect(skips(plan)).toEqual(["submodule sub", "too-large sub/big.bin"]);
	});

	test("a rule that matches a file below it leaves that file out like any other", () => {
		const plan = planOf({
			remote: [sub, inside("sub/a.md", "A")],
			local: [inVault("sub/debug.log", "L")],
			records: [],
			exclusion: rules("*.log\n"),
		});
		expect(summary(plan)).toEqual(["download sub/a.md"]);
		expect(skips(plan)).toEqual(["submodule sub", "excluded sub/debug.log"]);
	});

	describe("one whose inside is not synced stays closed", () => {
		const sides = {
			local: [inVault("sub/in-vault.md", "X"), inVault("sub/edited.md", "mine")],
			records: [recorded("sub/edited.md", "A"), recorded("sub/gone.md", "G")],
		};
		const closed = [
			"submodule sub",
			"under-non-file sub/edited.md",
			"under-non-file sub/gone.md",
			"under-non-file sub/in-vault.md",
		];

		test("one the listing says nothing of the inside of", () => {
			const plan = planOf({ remote: [{ path: "sub", kind: "submodule", hash: commit }], ...sides });
			expect(plan.actions).toEqual([]);
			expect(skips(plan)).toEqual(closed);
		});

		test.each(["not-supported", "no-access", "no-commit", "too-large", "nested"] as const)(
			"one that was not listed (%s)",
			(reason) => {
				const entry: RemoteEntry = { path: "sub", kind: "submodule", hash: commit, contents: { listed: false, reason } };
				const plan = planOf({ remote: [entry], ...sides });
				expect(plan.actions).toEqual([]);
				expect(skips(plan)).toEqual(closed);
			},
		);

		test.each([
			["the submodule as a folder", "/sub/\n", "submodule"],
			["the submodule by its name", "sub\n", "excluded"],
		])("one that a rule matches (%s), though the listing holds its inside", (_name, gitignore, itself) => {
			const plan = planOf({
				remote: [sub, inside("sub/a.md", "A"), inside("sub/edited.md", "A")],
				...sides,
				exclusion: rules(gitignore),
			});
			expect(plan.actions).toEqual([]);
			// Excluded, before anything else is asked: a rule for a folder
			// does not match the one entry of the listing taken for a file.
			expect(skips(plan)).toEqual([
				`${itself} sub`,
				"excluded sub/a.md",
				"excluded sub/edited.md",
				"excluded sub/gone.md",
				"excluded sub/in-vault.md",
			]);
		});

		test("one below a folder that a rule matches", () => {
			const lib: RemoteEntry = { ...sub, path: "vendor/lib" };
			const file: RemoteEntry = { ...inside("vendor/lib/a.md", "A"), source: { ...source, submodule: "vendor/lib" } };
			const plan = planOf({ remote: [lib, file], local: [], records: [], exclusion: rules("/vendor/\n") });
			expect(plan.actions).toEqual([]);
			expect(skips(plan)).toEqual(["excluded vendor/lib", "excluded vendor/lib/a.md"]);
		});

		test("a rule that a later one undoes leaves it open", () => {
			const plan = planOf({
				remote: [sub, inside("sub/a.md", "A")],
				local: [],
				records: [],
				exclusion: rules("/sub/\n!/sub/\n"),
			});
			expect(summary(plan)).toEqual(["download sub/a.md"]);
		});

		test("a rule that matches another folder leaves it open", () => {
			const plan = planOf({
				remote: [sub, inside("sub/a.md", "A")],
				local: [],
				records: [],
				exclusion: rules("/other/\n"),
			});
			expect(summary(plan)).toEqual(["download sub/a.md"]);
		});
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

	test("only on the remote and matched: not downloaded, and never deleted there", async () => {
		const plan = await planFor({ remote: { "drafts/a.md": "A", "img.png": "P" }, exclusion: drafts });
		expect(plan.actions).toEqual([]);
		expect(skips(plan)).toEqual(["excluded drafts/a.md", "excluded img.png"]);
		// No record is made for it.
		expect(plan.marks).toEqual([]);
	});

	test("on both sides without a record and matched: left alone, not compared", async () => {
		const plan = await planFor({
			remote: { "drafts/same.md": "S", "drafts/differs.md": "theirs" },
			local: { "drafts/same.md": "S", "drafts/differs.md": "mine" },
			exclusion: drafts,
		});
		expect(plan.actions).toEqual([]);
		expect(skips(plan)).toEqual(["excluded drafts/differs.md", "excluded drafts/same.md"]);
	});

	test("with no section in .gitignore, the default lines exclude what the remote holds too", async () => {
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
		expect(summary(plan)).toEqual(["upload .obsidian/app.json"]);
		expect(skips(plan)).toEqual([
			"excluded .obsidian/plugins/dataview/main.js",
			"excluded .obsidian/plugins/tasks/main.js",
			"excluded .obsidian/workspace-mobile.json",
			"excluded .obsidian/workspace.json",
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

	test("a rule in NFC excludes a vault path returned in NFD, and a recorded path is one file in either form", async () => {
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
			expect(plan.actions).toEqual([]);
			expect(skips(plan)).toEqual([`excluded ${nfc}`]);
			expect(plan.marks.map((mark) => `${mark.key} ${mark.wasExcluded}`)).toEqual([`${nfc} true`]);
		}
	});

	test("a conflict copy is judged by the name of the file it is a copy of", async () => {
		const at = new Date(2026, 9, 3, 22, 15, 0);
		const exclusion = rules("/exact.md\n*.conflict-from-*\n!kept.md\n");
		const excluded = earlierCopyPath("exact.md", "iPhone", at);
		const sent = earlierCopyPath("kept.md", "iPhone", at);
		const plan = await planFor({ local: { [excluded]: "mine", [sent]: "mine" }, exclusion });
		expect(summary(plan)).toEqual([`upload ${sent}`]);
		expect(skips(plan)).toEqual([`excluded ${excluded}`]);
	});
});

describe("a recorded path a rule excludes", () => {
	const drafts = rules("/drafts/\n");
	const a = "drafts/a.md";
	/** A record of `a` with this content, with the mark of the last sync or without. */
	const recordOf = (content: string, wasExcluded = false): SyncRecord => ({
		path: a,
		kind: "file",
		hash: blobHash(content),
		...(wasExcluded ? { wasExcluded: true as const } : {}),
	});
	const remoteOf = (content: string): RemoteEntry => ({ path: a, kind: "file", hash: blobHash(content) });
	const localOf = (content: string): LocalEntry => ({ path: a, hash: blobHash(content) });

	// The vault: as recorded, edited, gone. The remote: as recorded,
	// changed, deleted.
	const vaults: readonly (readonly [string, LocalEntry[]])[] = [
		["as recorded in the vault", [localOf("A")]],
		["edited in the vault", [localOf("mine")]],
		["gone from the vault", []],
	];
	const remotes: readonly (readonly [string, RemoteEntry[]])[] = [
		["as recorded on the remote", [remoteOf("A")]],
		["changed on the remote", [remoteOf("theirs")]],
		["deleted on the remote", []],
	];
	const cases = vaults.flatMap(([vault, local]) => remotes.map(([remote, entries]) => [`${vault}, ${remote}`, local, entries] as const));

	test.each(cases)("%s: nothing is fetched, sent, or deleted, and the record stays", (_name, local, remote) => {
		for (const wasExcluded of [false, true]) {
			const record = recordOf("A", wasExcluded);
			const plan = planOf({ remote, local, records: [record], exclusion: drafts });
			expect(plan.actions).toEqual([]);
			expect(skips(plan)).toEqual([`excluded ${a}`]);
			// Its value as it was; only the mark is set, once.
			expect(plan.marks).toEqual(wasExcluded ? [] : [{ key: a, record, wasExcluded: true }]);
		}
	});

	test("a rule of this device's own excludes it the same way", () => {
		const device = createExclusion({ configDir: ".obsidian", pluginDir: ownFolder, gitignore: null, device: { kinds: [], folders: ["drafts"] } });
		const plan = planOf({ remote: [remoteOf("theirs")], local: [], records: [recordOf("A")], exclusion: device });
		expect(plan.actions).toEqual([]);
		expect(skips(plan)).toEqual([`excluded ${a}`]);
		expect(plan.marks.map((mark) => mark.wasExcluded)).toEqual([true]);
	});

	describe("once no rule excludes it any more", () => {
		test("both sides have it: compared as usual from the record, and the mark goes", () => {
			const record = recordOf("A", true);
			const cases: readonly (readonly [string, string, string])[] = [
				["A", "A", "nothing"],
				["mine", "A", "upload"],
				["A", "theirs", "download"],
				["mine", "theirs", "conflict"],
				["same", "same", "update-record"],
			];
			for (const [vault, remote, expected] of cases) {
				const plan = planOf({ remote: [remoteOf(remote)], local: [localOf(vault)], records: [record], exclusion: noRules });
				expect(plan.actions.map((action) => action.type)).toEqual(expected === "nothing" ? [] : [expected]);
				expect(plan.marks).toEqual([{ key: a, record, wasExcluded: false }]);
			}
		});

		test("gone from the vault while it was excluded: the record goes, and the remote keeps it", () => {
			const plan = planOf({ remote: [remoteOf("A")], local: [], records: [recordOf("A", true)], exclusion: noRules });
			expect(summary(plan)).toEqual([`drop-record ${a}`]);
			expect(plan.marks).toEqual([]);
			// Without the record, the next plan fetches it again.
			expect(summary(planOf({ remote: [remoteOf("A")], local: [], records: [], exclusion: noRules }))).toEqual([`download ${a}`]);
		});

		test("deleted on the remote while it was excluded (taken out of it, say): the record goes, and the vault keeps it", () => {
			const plan = planOf({ remote: [], local: [localOf("A")], records: [recordOf("A", true)], exclusion: noRules });
			expect(summary(plan)).toEqual([`drop-record ${a}`]);
			expect(plan.actions[0]?.local?.hash).toBe(blobHash("A"));
			// Without the record, the next plan sends it again.
			expect(summary(planOf({ remote: [], local: [localOf("A")], records: [], exclusion: noRules }))).toEqual([`upload ${a}`]);
		});

		test("gone from both sides: the record goes, as without the mark", () => {
			const plan = planOf({ remote: [], local: [], records: [recordOf("A", true)], exclusion: noRules });
			expect(summary(plan)).toEqual([`drop-record ${a}`]);
		});

		test("without the mark, a deletion on one side is carried over as ever: the mark is what makes the difference", () => {
			expect(summary(planOf({ remote: [remoteOf("A")], local: [], records: [recordOf("A")], exclusion: noRules }))).toEqual([
				`delete-remote ${a}`,
			]);
			expect(summary(planOf({ remote: [], local: [localOf("A")], records: [recordOf("A")], exclusion: noRules }))).toEqual([
				`delete-local ${a}`,
			]);
		});

		test("deleted on one side after the last sync that excluded it, and the rule taken back with no sync in between: the other side stays", () => {
			// The sync while it was excluded set the mark; then the vault
			// deleted it, or it was taken out of the remote, and the rule
			// went before any other sync ran.
			const excluded = planOf({ remote: [remoteOf("A")], local: [localOf("A")], records: [recordOf("A")], exclusion: drafts });
			const marked = recordOf("A", excluded.marks[0]?.wasExcluded === true);
			expect(marked.wasExcluded).toBe(true);
			const deletedHere = planOf({ remote: [remoteOf("A")], local: [], records: [marked], exclusion: noRules });
			expect(deletedHere.actions.map((action) => action.type)).toEqual(["drop-record"]);
			const takenOut = planOf({ remote: [], local: [localOf("A")], records: [marked], exclusion: noRules });
			expect(takenOut.actions.map((action) => action.type)).toEqual(["drop-record"]);
		});

		test("a file a cloud drive took off the device is there: held, and its record and mark stay", () => {
			const plan = planOf({
				remote: [remoteOf("A")],
				local: [{ path: a, hash: "" }],
				records: [recordOf("A", true)],
				exclusion: noRules,
				held: new Set([a]),
			});
			expect(plan.actions).toEqual([]);
			expect(skips(plan)).toEqual([`held ${a}`]);
			expect(plan.marks).toEqual([]);
		});

		test("below a submodule the listing does not hold the inside of, the remote is not taken to have lost it", () => {
			const commit = "c".repeat(40);
			const record: SyncRecord = { path: "sub/a.md", kind: "file", hash: blobHash("A"), wasExcluded: true };
			for (const contents of [undefined, { listed: false, reason: "no-access" } as const, { listed: false, reason: "no-commit" } as const]) {
				const sub: RemoteEntry = { path: "sub", kind: "submodule", hash: commit, ...(contents === undefined ? {} : { contents }) };
				const plan = planOf({ remote: [sub], local: [{ path: "sub/a.md", hash: blobHash("A") }], records: [record], exclusion: noRules });
				expect(plan.actions).toEqual([]);
				expect(skips(plan)).toEqual(["submodule sub", "under-non-file sub/a.md"]);
				expect(plan.marks).toEqual([]);
			}
			// One a rule matches is not listed into either.
			const sub: RemoteEntry = { path: "sub", kind: "submodule", hash: commit, contents: { listed: true, repository: "octo/sub" } };
			const ruled = planOf({ remote: [sub], local: [], records: [record], exclusion: rules("/sub/\n") });
			expect(ruled.actions).toEqual([]);
			expect(skips(ruled)).toEqual(["submodule sub", "excluded sub/a.md"]);
		});

		test("below a submodule whose inside the listing holds, the remote not having it is known", () => {
			const commit = "c".repeat(40);
			const sub: RemoteEntry = { path: "sub", kind: "submodule", hash: commit, contents: { listed: true, repository: "octo/sub" } };
			const record: SyncRecord = { path: "sub/a.md", kind: "file", hash: blobHash("A"), wasExcluded: true };
			const plan = planOf({ remote: [sub], local: [{ path: "sub/a.md", hash: blobHash("A") }], records: [record], exclusion: noRules });
			expect(summary(plan)).toEqual(["drop-record sub/a.md"]);
		});
	});
});

describe("the rules of the root .gitignore and of this device", () => {
	const both = (gitignore: string, kinds: readonly ("image" | "pdf" | "other")[], folders: readonly string[]): Exclusion =>
		createExclusion({ configDir: ".obsidian", pluginDir: ownFolder, gitignore, device: { kinds, folders } });

	test("a path either excludes is excluded, and a ! of one does not undo a line of the other", async () => {
		// The file takes back `photos/` and images; this device leaves them out.
		const exclusion = both("*.png\n!*.png\n/photos/\n!/photos/\n/drafts/\n", ["image"], ["photos"]);
		const plan = await planFor({
			local: { "a.png": "P", "photos/b.md": "B", "drafts/c.md": "C", "notes/d.md": "D", ".obsidian/icon.png": "I" },
			exclusion,
		});
		expect(summary(plan)).toEqual(["upload .obsidian/icon.png", "upload notes/d.md"]);
		expect(skips(plan)).toEqual(["excluded a.png", "excluded drafts/c.md", "excluded photos/b.md"]);
	});

	test("with only one of them, the other path is synced", async () => {
		const plan = await planFor({ local: { "a.png": "P", "drafts/c.md": "C" }, exclusion: both("/drafts/\n", [], []) });
		expect(summary(plan)).toEqual(["upload a.png"]);
		const device = await planFor({ local: { "a.png": "P", "drafts/c.md": "C" }, exclusion: both("", ["image"], []) });
		expect(summary(device)).toEqual(["upload drafts/c.md"]);
	});
});

describe("a conflict copy and the rules", () => {
	const at = new Date(2026, 9, 3, 22, 15, 0);
	const exclusion = rules("/drafts/\n*.png\n");

	test("a copy of the earlier form goes by the file it is a copy of, whatever the remote holds", async () => {
		const draft = earlierCopyPath("drafts/a.md", "iPhone", at);
		const image = earlierCopyPath("img.png", "iPhone", at);
		const plan = await planFor({
			synced: { "drafts/a.md": "theirs", "img.png": "theirs" },
			remote: { [image]: "other" },
			local: { [draft]: "mine", "new.png": "N" },
			exclusion,
		});
		expect(plan.actions).toEqual([]);
		expect(skips(plan)).toEqual([`excluded ${draft}`, "excluded drafts/a.md", `excluded ${image}`, "excluded img.png", "excluded new.png"].sort());
	});

	test("a copy of the earlier form of a file no rule matches is synced like any file", async () => {
		const copy = earlierCopyPath("notes/a.md", "iPhone", at);
		const first = earlierCopyPath(earlierCopyPath("notes/b.md", "iPhone", at), "Mac", at, 2);
		const plan = await planFor({ synced: { "notes/a.md": "A" }, remote: { [first]: "theirs" }, local: { [copy]: "mine" }, exclusion });
		expect(summary(plan)).toEqual([`upload ${copy}`, `download ${first}`]);
	});

	test("a copy in the folder of the copies is sent and fetched, whatever either rule says", async () => {
		const mine = "_conflicts/2026-10-11 a (iPhone).md";
		const theirs = "_conflicts/2026-10-11 b (Mac).png";
		const both = createExclusion({
			configDir: ".obsidian",
			pluginDir: ownFolder,
			gitignore: "_conflicts/\n*.md\n",
			device: { kinds: ["image", "other"], folders: ["_conflicts"] },
		});
		const plan = await planFor({ remote: { [theirs]: "T" }, local: { [mine]: "M", "_conflicts/notes.md": "N" }, exclusion: both });
		expect(summary(plan)).toEqual([`upload ${mine}`, `download ${theirs}`]);
		expect(skips(plan)).toEqual(["excluded _conflicts/notes.md"]);
	});

	test("a copy inside the configuration folder is left out until it is known; known, it goes by the rules", async () => {
		const copy = earlierCopyPath(".obsidian/app.json", "Mac", at);
		const after = await planFor({ synced: { ".obsidian/app.json": "theirs" }, local: { [copy]: "edited" } });
		expect(after.actions).toEqual([]);
		expect(skips(after)).toEqual([`excluded ${copy}`]);

		// One an earlier version sent is synced like any other file.
		const onRemote = await planFor({ synced: { ".obsidian/app.json": "theirs", [copy]: "mine" }, local: { [copy]: "edited" } });
		expect(summary(onRemote)).toEqual([`upload ${copy}`]);
		const unchanged = await planFor({ synced: { ".obsidian/app.json": "theirs", [copy]: "mine" }, remote: { [copy]: null } });
		expect(summary(unchanged)).toEqual([`delete-local ${copy}`]);
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

describe("paths that are held", () => {
	test("are left alone on every side, whatever their case, and whatever the three sides hold", () => {
		const remote: RemoteEntry[] = [
			{ path: "notes/a.md", kind: "file", hash: blobHash("theirs"), size: 6 },
			{ path: "b.md", kind: "file", hash: blobHash("B2"), size: 2 },
		];
		// The hash of a held file is not known, and not looked at.
		const local: LocalEntry[] = [
			{ path: "Notes/A.md", hash: "" },
			{ path: "b.md", hash: blobHash("B") },
		];
		const records: SyncRecord[] = [
			{ path: "Notes/A.md", kind: "file", hash: blobHash("A") },
			{ path: "b.md", kind: "file", hash: blobHash("B") },
		];
		const plan = planOf({ remote, local, records, held: new Set(["notes/a.md"]) });
		expect(plan.actions.map((action) => `${action.type} ${action.key}`)).toEqual(["download b.md"]);
		expect(plan.skipped.map((skip) => `${skip.reason} ${skip.key}`)).toEqual(["held Notes/A.md", "held notes/a.md"]);

		// Without it, the same input is a rename the remote made and a conflict.
		const free = planOf({ remote, local, records });
		expect(free.skipped).toEqual([]);
		expect(free.actions.length).toBe(3);
	});
});
