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
import { planSync, type LocalEntry, type SyncPlan, type SyncRecord } from "../src/core/plan";
import { blobHash, MemoryBackend } from "./support/memory-backend";

interface Scenario {
	/** Files that were on both sides, with a record, at the last sync. */
	synced?: Record<string, string>;
	/** What another device did to the remote since then (`null` deletes). */
	remote?: Record<string, string | null>;
	/** What happened in the vault since then (`null` deletes). */
	local?: Record<string, string | null>;
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
	return planSync({ remote: await listRemote(backend), local, records });
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
		const plan = planSync({ remote, local, records: remote });
		expect(plan.actions).toEqual([]);
		expect(skips(plan)).toEqual([`duplicate-path ${nfc}`]);
		expect(plan.skipped[0]?.local).toEqual(local);
		expect(plan.skipped[0]?.remote).toEqual(remote);
		expect(plan.skipped[0]?.records).toEqual(remote);
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
	const plan = planSync({ remote, local, records });
	const deletes = plan.actions.filter(
		(action) => action.type === "delete-local" || action.type === "delete-remote",
	);

	test("a path without a record is never deleted on either side", () => {
		expect(unrecorded.size).toBe(9);
		expect(deletes.filter((action) => unrecorded.has(action.key))).toEqual([]);
	});

	test("the same holds when each path is planned on its own", () => {
		for (const path of unrecorded) {
			const alone = planSync({
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
		const plan = planSync({
			remote: [
				{ path: "link", kind: "symlink", hash },
				{ path: "sub", kind: "submodule", hash },
			],
			local: [],
			records: [],
		});
		expect(plan.actions).toEqual([]);
		expect(plan.skipped.map((skip) => skip.reason)).toEqual(["not-a-file", "not-a-file"]);
	});

	test("a path recorded as a symlink is left alone even when both sides now hold a file", () => {
		const file = blobHash("a real file");
		const plan = planSync({
			remote: [{ path: "link", kind: "file", hash: file }],
			local: [{ path: "link", hash: blobHash("another file") }],
			records: [{ path: "link", kind: "symlink", hash }],
		});
		expect(plan.actions).toEqual([]);
		expect(skips(plan)).toEqual(["not-a-file link"]);
	});

	test("a path recorded as a symlink and gone from both sides keeps its record", () => {
		const plan = planSync({ remote: [], local: [], records: [{ path: "link", kind: "symlink", hash }] });
		expect(plan.actions).toEqual([]);
		expect(skips(plan)).toEqual(["not-a-file link"]);
	});

	test("a recorded symlink that is absent from the vault is not deleted on the remote", () => {
		const plan = planSync({
			remote: [{ path: "link", kind: "symlink", hash }],
			local: [],
			records: [{ path: "link", kind: "symlink", hash }],
		});
		expect(plan.actions).toEqual([]);
	});

	test("a vault file at the path of a remote symlink is not sent over it", () => {
		const plan = planSync({
			remote: [{ path: "link", kind: "symlink", hash }],
			local: [{ path: "link", hash: blobHash("a real file") }],
			records: [],
		});
		expect(plan.actions).toEqual([]);
	});

	test("a vault file below a remote submodule is not sent", () => {
		const plan = planSync({
			remote: [{ path: "sub", kind: "submodule", hash }],
			local: [{ path: "sub/x.md", hash: blobHash("X") }],
			records: [],
		});
		expect(plan.actions).toEqual([]);
		expect(skips(plan)).toEqual(["not-a-file sub", "under-non-file sub/x.md"]);
		expect(plan.skipped[1]?.local.map((entry) => entry.path)).toEqual(["sub/x.md"]);
	});

	test("paths below a remote symlink are left alone on every side", () => {
		const x = blobHash("X");
		const plan = planSync({
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
			"not-a-file link",
			"under-non-file link/deep/er.md",
			"under-non-file link/deleted-here.md",
			"under-non-file link/deleted-there.md",
			"under-non-file link/in-vault.md",
			"under-non-file link/on-remote.md",
		]);
	});

	test("a symlink that is only in the records still shields the paths below it", () => {
		const x = blobHash("X");
		const plan = planSync({
			remote: [{ path: "link/on-remote.md", kind: "file", hash: x }],
			local: [{ path: "link/in-vault.md", hash: x }],
			records: [
				{ path: "link", kind: "symlink", hash },
				{ path: "link/gone.md", kind: "file", hash: x },
			],
		});
		expect(plan.actions).toEqual([]);
		expect(skips(plan)).toEqual([
			"not-a-file link",
			"under-non-file link/gone.md",
			"under-non-file link/in-vault.md",
			"under-non-file link/on-remote.md",
		]);
	});

	test("the parent is matched by its normalized name, and only as a whole folder name", () => {
		const plan = planSync({
			remote: [{ path: "が", kind: "submodule", hash }],
			local: [
				{ path: "が/x.md", hash: blobHash("X") },
				{ path: "がく/x.md", hash: blobHash("X") },
				{ path: "が.md", hash: blobHash("X") },
			],
			records: [],
		});
		expect(summary(plan)).toEqual(["upload が.md", "upload がく/x.md"]);
		expect(skips(plan)).toEqual(["not-a-file が", "under-non-file が/x.md"]);
	});
});
