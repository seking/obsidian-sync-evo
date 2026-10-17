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
import { GDriveBackend } from "../src/core/gdrive/backend";
import { DriveDuplicateFolderError, DriveFolderGoneError } from "../src/core/gdrive/errors";
import { runPull } from "../src/core/pull";
import { type PushDeps, type PushRunResult, runPush } from "../src/core/push";
import { FakeDrive } from "./support/fake-gdrive";
import { MemoryPullVault } from "./support/memory-pull-vault";
import { MemoryStateStore } from "./support/memory-state-store";

// Whole syncs against Google Drive: the pull and the push of the core,
// through the Drive backend, against Drive in memory, from two devices.

let time = Date.UTC(2026, 9, 17, 12, 0, 0);
const now = (): number => time;

function device(drive: FakeDrive, name: string, folder = "Vault") {
	let store = new MemoryStateStore();
	const vault = new MemoryPullVault({ caseSensitive: true, now });
	// What the settings keep of the folder (`DeviceSettings.gdriveFolderId`).
	const kept: { id: string | null } = { id: null };
	const common = () => ({
		store,
		// Made for each sync, as the plugin does.
		backend: new GDriveBackend(drive, {
			folder,
			folderId: kept.id,
			onFolderFound: (id) => {
				kept.id = id;
			},
		}),
		vault,
		paths: { configDir: ".obsidian", pluginDir: ".obsidian/plugins/sync-evo" },
		deviceName: name,
		now,
	});
	const pull = (): ReturnType<typeof runPull> => {
		time += 60_000;
		return runPull({ ...common(), pluginId: "sync-evo", confirm: async () => "proceed", mergeConflicts: true });
	};
	const push = (overrides: Partial<PushDeps> = {}): Promise<PushRunResult> => {
		time += 60_000;
		return runPush({ ...common(), confirm: async () => "proceed", askEmptyVault: async () => "delete", ...overrides });
	};
	/** What the plugin does when the folder is gone: the id and the sync state go. */
	const forget = (): void => {
		kept.id = null;
		store = new MemoryStateStore();
	};
	return { get store() { return store; }, vault, pull, push, kept, forget };
}

/** Everything in the vault but the `.gitignore`, which Sync Evo writes a section of its own into. */
function notes(vault: MemoryPullVault): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [path, text] of Object.entries(vault.snapshot())) if (path !== ".gitignore") out[path] = text;
	return out;
}

/**
 * Has `other` run right after the next push has listed and planned, right
 * before it asks Drive for the changes since its listing: the second time
 * changes are asked for, once.
 */
function sendFirst(drive: FakeDrive, other: () => Promise<unknown>): void {
	let asked = 0;
	drive.beforeCall = async (call) => {
		if (call !== "GET changes" || ++asked < 2) return;
		drive.beforeCall = undefined;
		await other();
	};
}

describe("syncing two devices through Google Drive", () => {
	test("the first device makes the folders and fills them, and the second gets all of it", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "iPhone");
		a.vault.put("notes/a.md", "A");
		a.vault.put("b.md", "B");
		expect((await a.pull()).outcome).toBe("remote-empty");
		expect((await a.push()).outcome).toBe("pushed");
		expect(Object.keys(drive.tree("Sync Evo/Vault")).sort()).toEqual([".gitignore", "b.md", "notes/a.md"]);
		expect(a.kept.id).toBe(drive.idOf("Sync Evo/Vault"));

		const b = device(drive, "Pixel");
		expect((await b.pull()).outcome).toBe("completed");
		expect(b.kept.id).toBe(a.kept.id);
		expect(notes(b.vault)).toEqual({ "b.md": "B", "notes/a.md": "A" });
		expect((await b.push()).outcome).toBe("nothing-to-push");
	});

	test("changes and deletions go across, a deletion is a file in the trash, and a sync without changes fetches nothing", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "iPhone");
		a.vault.put("a.md", "A");
		a.vault.put("b.md", "B");
		await a.pull();
		await a.push();
		const b = device(drive, "Pixel");
		await b.pull();
		const bId = drive.idOf("Sync Evo/Vault/b.md") as string;

		a.vault.put("a.md", "A2");
		a.vault.remove("b.md");
		a.vault.put("c.md", "C");
		expect((await a.push()).counts).toMatchObject({ added: 1, modified: 1, deleted: 1 });
		expect(drive.isTrashed(bId)).toBe(true);

		drive.calls.length = 0;
		const pulled = await b.pull();
		expect(pulled.counts).toMatchObject({ fetched: 2, deleted: 1 });
		expect(notes(b.vault)).toEqual({ "a.md": "A2", "c.md": "C" });
		// Only the changes since the page token were asked for: no listing of everything.
		expect(drive.calls).not.toContain("GET startPageToken");

		drive.calls.length = 0;
		expect((await b.pull()).counts).toMatchObject({ fetched: 0 });
		// The folder by its id, whether it is the only one of its name, and the changes.
		expect(drive.calls).toEqual(["GET file", "GET files", "GET changes"]);
	});

	test("a file edited on Drive keeps its id, and is fetched", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "iPhone");
		a.vault.put("a.md", "A");
		await a.pull();
		await a.push();
		const id = drive.idOf("Sync Evo/Vault/a.md");
		await drive.put("Sync Evo/Vault/a.md", "edited on the web");
		expect(drive.idOf("Sync Evo/Vault/a.md")).toBe(id);
		expect((await a.pull()).counts).toMatchObject({ fetched: 1 });
		expect(a.vault.text("a.md")).toBe("edited on the web");
	});

	test("a file put in the trash, or moved out of the folder, on Drive is deleted on the device", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "iPhone");
		a.vault.put("a.md", "A");
		a.vault.put("b.md", "B");
		a.vault.put("c.md", "C");
		await a.pull();
		await a.push();
		drive.trash("Sync Evo/Vault/a.md");
		drive.move("Sync Evo/Vault/b.md", "");
		const pulled = await a.pull();
		expect(pulled.counts).toMatchObject({ deleted: 2 });
		expect(notes(a.vault)).toEqual({ "c.md": "C" });
	});

	test("a folder renamed on Drive lists everything again, and the files move on the device", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "iPhone");
		a.vault.put("old/a.md", "A");
		await a.pull();
		await a.push();
		drive.move("Sync Evo/Vault/old", "Sync Evo/Vault", "new");
		drive.calls.length = 0;
		await a.pull();
		expect(drive.calls).toContain("GET files");
		expect(notes(a.vault)).toEqual({ "new/a.md": "A" });
	});

	test("an edit another device sent first is not written over: the next pull makes it a conflict", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "iPhone");
		a.vault.put("a.md", "one\ntwo\nthree\n");
		await a.pull();
		await a.push();
		const b = device(drive, "Pixel");
		await b.pull();

		b.vault.put("a.md", "one\ntwo\nTHREE\n");
		sendFirst(drive, () => {
			a.vault.put("a.md", "ONE\ntwo\nthree\n");
			return a.push();
		});
		const refused = await b.push();
		expect(refused.leftOut).toEqual([{ path: "a.md", reason: "remote-changed" }]);
		expect(drive.text("Sync Evo/Vault/a.md")).toBe("ONE\ntwo\nthree\n");

		// Drive has no way to look up what the file held before, so nothing
		// is merged: the device's content is kept beside it.
		await b.pull();
		expect(b.vault.text("a.md")).toBe("ONE\ntwo\nthree\n");
		const copies = Object.keys(notes(b.vault)).filter((path) => path !== "a.md");
		expect(copies.length).toBe(1);
		expect(b.vault.text(copies[0] as string)).toBe("one\ntwo\nTHREE\n");
	});

	test("a file one device deleted and the other changed is kept with the change", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "iPhone");
		a.vault.put("a.md", "A");
		await a.pull();
		await a.push();
		const b = device(drive, "Pixel");
		await b.pull();

		b.vault.remove("a.md");
		sendFirst(drive, () => {
			a.vault.put("a.md", "A2");
			return a.push();
		});
		const kept = await b.push();
		expect(kept.leftOut).toEqual([{ path: "a.md", reason: "remote-changed" }]);
		expect(drive.text("Sync Evo/Vault/a.md")).toBe("A2");
		await b.pull();
		expect(b.vault.text("a.md")).toBe("A2");
	});

	test("a new file of a name another device put there first is not written beside it", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "iPhone");
		a.vault.put("x.md", "X");
		await a.pull();
		await a.push();
		const b = device(drive, "Pixel");
		await b.pull();

		b.vault.put("n.md", "from Pixel");
		sendFirst(drive, () => {
			a.vault.put("n.md", "from iPhone");
			return a.push();
		});
		const refused = await b.push();
		expect(refused.leftOut).toEqual([{ path: "n.md", reason: "remote-changed" }]);
		expect(Object.keys(drive.tree("Sync Evo/Vault")).filter((path) => path === "n.md")).toEqual(["n.md"]);
	});

	test("two files of one name on Drive are neither written nor fetched, and are told", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "iPhone");
		a.vault.put("a.md", "A");
		await a.pull();
		await a.push();
		await drive.put("Sync Evo/Vault/a.md", "another", { asNew: true });
		const pulled = await a.pull();
		expect(pulled.notices?.some((notice) => notice.kind === "remote-path-collision") ?? JSON.stringify(pulled)).toBe(true);
		expect(a.vault.text("a.md")).toBe("A");
	});

	test("a page token Drive will not go on from lists everything again, and fetches only what differs", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "iPhone");
		a.vault.put("a.md", "A");
		a.vault.put("b.md", "B");
		await a.pull();
		await a.push();
		const b = device(drive, "Pixel");
		await b.pull();
		a.vault.put("a.md", "A2");
		await a.push();

		for (let token = 0; token < 100; token++) drive.expired.add(String(token));
		const pulled = await b.pull();
		expect(pulled.counts).toMatchObject({ fetched: 1 });
		expect(notes(b.vault)).toEqual({ "a.md": "A2", "b.md": "B" });
	});

	test("a folder of the vault gone from Drive fails the sync, and changes nothing on the device", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "iPhone");
		a.vault.put("a.md", "A");
		await a.pull();
		await a.push();
		drive.trash("Sync Evo/Vault");
		await expect(a.pull()).rejects.toBeInstanceOf(DriveFolderGoneError);
		expect(notes(a.vault)).toEqual({ "a.md": "A" });

		// The plugin lets go of the id and the sync state: a first sync,
		// which finds no folder and uploads into a new one.
		a.forget();
		expect((await a.pull()).outcome).toBe("remote-empty");
		expect((await a.push()).outcome).toBe("pushed");
		expect(drive.tree("Sync Evo/Vault")).toMatchObject({ "a.md": "A" });
		expect(a.kept.id).not.toBeNull();
	});

	test("two vaults of one account sync with folders of their own", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "iPhone", "One");
		const b = device(drive, "iPhone", "Two");
		a.vault.put("a.md", "A");
		b.vault.put("b.md", "B");
		await a.pull();
		await a.push();
		await b.pull();
		await b.push();
		expect(Object.keys(drive.tree("Sync Evo/One"))).toContain("a.md");
		expect(Object.keys(drive.tree("Sync Evo/Two"))).not.toContain("a.md");
		a.vault.put("a2.md", "A2");
		await a.push();
		expect((await b.pull()).counts).toMatchObject({ fetched: 0, deleted: 0 });
		expect(notes(b.vault)).toEqual({ "b.md": "B" });
	});

	test("a folder back from the trash beside the new one stops both devices, which keep one each", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "Pixel");
		a.vault.put("a.md", "A");
		await a.pull();
		await a.push();
		const b = device(drive, "Pixel 2");
		await b.pull();
		const first = drive.idOf("Sync Evo/Vault") as string;

		drive.trash("Sync Evo/Vault");
		await expect(a.pull()).rejects.toBeInstanceOf(DriveFolderGoneError);
		a.forget();
		await a.pull();
		await a.push();
		expect(a.kept.id).not.toBe(first);
		drive.untrash(first);

		await expect(a.pull()).rejects.toBeInstanceOf(DriveDuplicateFolderError);
		await expect(b.pull()).rejects.toMatchObject({ folder: "Sync Evo/Vault" });
		expect(b.kept.id).toBe(first);
	});

	test("a second folder Sync Evo at the top of Drive stops a device that keeps its folder by id", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "Pixel");
		a.vault.put("a.md", "A");
		await a.pull();
		await a.push();
		drive.makeFolder("", "Sync Evo");
		await expect(a.pull()).rejects.toMatchObject({ folder: "Sync Evo" });
	});

	test("a folder renamed on Drive is still synced with by its id", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "Pixel");
		a.vault.put("a.md", "A");
		await a.pull();
		await a.push();
		drive.move("Sync Evo/Vault", "Sync Evo", "Renamed");
		a.vault.put("b.md", "B");
		expect((await a.push()).outcome).toBe("pushed");
		expect(Object.keys(drive.tree("Sync Evo/Renamed")).sort()).toEqual([".gitignore", "a.md", "b.md"]);
	});

	test("nothing is made on Drive before the first upload is confirmed", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "Pixel");
		a.vault.put("a.md", "A");
		await a.pull();
		expect((await a.push({ confirm: async () => "cancel" })).outcome).toBe("declined");
		expect(drive.calls.filter((call) => call.startsWith("POST") || call.startsWith("PATCH"))).toEqual([]);
		expect(drive.idOf("Sync Evo")).toBeUndefined();
	});

	test("an empty file goes up and comes down, both ways, and an edit to and from empty goes across", async () => {
		const drive = new FakeDrive();
		const a = device(drive, "Pixel");
		a.vault.put("mass/m1.md", "m1\n");
		a.vault.put("mass/m3.md", "");
		await a.pull();
		const pushed = await a.push();
		expect(pushed.outcome).toBe("pushed");
		expect(pushed.leftOut ?? []).toEqual([]);
		expect(drive.tree("Sync Evo/Vault")).toMatchObject({ "mass/m3.md": "" });

		const b = device(drive, "Pixel 2");
		const pulled = await b.pull();
		expect(pulled.outcome).toBe("completed");
		expect(b.vault.text("mass/m3.md")).toBe("");

		// Filled on one side, emptied on the other.
		b.vault.put("mass/m3.md", "now m3");
		b.vault.put("mass/m1.md", "");
		b.vault.put("mass/new-empty.md", "");
		expect((await b.push()).counts).toMatchObject({ added: 1, modified: 2 });
		await a.pull();
		expect(notes(a.vault)).toEqual({ "mass/m1.md": "", "mass/m3.md": "now m3", "mass/new-empty.md": "" });
		expect((await a.push()).outcome).toBe("nothing-to-push");
		expect((await b.pull()).counts).toMatchObject({ fetched: 0 });
	});
});
