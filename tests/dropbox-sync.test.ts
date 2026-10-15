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
import { DropboxBackend } from "../src/core/dropbox/backend";
import { runPull } from "../src/core/pull";
import { type PushDeps, type PushRunResult, runPush } from "../src/core/push";
import { FakeDropbox } from "./support/fake-dropbox";
import { MemoryPullVault } from "./support/memory-pull-vault";
import { MemoryStateStore } from "./support/memory-state-store";

// Whole syncs against Dropbox: the pull and the push of the core, through
// the Dropbox backend, against Dropbox in memory, from two devices.

let time = Date.UTC(2026, 9, 15, 12, 0, 0);
const now = (): number => time;

function device(dropbox: FakeDropbox, name: string) {
	const store = new MemoryStateStore();
	const vault = new MemoryPullVault({ caseSensitive: true, now });
	const common = () => ({
		store,
		// Made for each sync, as the plugin does.
		backend: new DropboxBackend(dropbox, { folder: "Vault" }),
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
	return { store, vault, pull, push };
}

/** Has `other` run right before the next write of any device reaches Dropbox, once. */
function sendFirst(dropbox: FakeDropbox, other: () => Promise<unknown>): void {
	dropbox.beforeCall = async (endpoint) => {
		if (endpoint !== "files/upload" && endpoint !== "files/delete_v2") return;
		dropbox.beforeCall = undefined;
		await other();
	};
}

/** Everything in the vault but the `.gitignore`, which Sync Evo writes a section of its own into. */
function notes(vault: MemoryPullVault): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [path, text] of Object.entries(vault.snapshot())) if (path !== ".gitignore") out[path] = text;
	return out;
}

describe("syncing two devices through Dropbox", () => {
	test("the first device fills an empty folder, and the second gets all of it", async () => {
		const dropbox = new FakeDropbox();
		const a = device(dropbox, "iPhone");
		a.vault.put("notes/a.md", "A");
		a.vault.put("b.md", "B");
		expect((await a.pull()).outcome).toBe("remote-empty");
		expect((await a.push()).outcome).toBe("pushed");
		expect(Object.keys(dropbox.tree("/Vault")).sort()).toEqual([".gitignore", "b.md", "notes/a.md"]);

		const b = device(dropbox, "Pixel");
		expect((await b.pull()).outcome).toBe("completed");
		expect(notes(b.vault)).toEqual({ "b.md": "B", "notes/a.md": "A" });
		expect((await b.push()).outcome).toBe("nothing-to-push");
	});

	test("changes and deletions go across, and a sync without changes fetches nothing", async () => {
		const dropbox = new FakeDropbox();
		const a = device(dropbox, "iPhone");
		a.vault.put("a.md", "A");
		a.vault.put("b.md", "B");
		await a.pull();
		await a.push();
		const b = device(dropbox, "Pixel");
		await b.pull();

		a.vault.put("a.md", "A2");
		a.vault.remove("b.md");
		a.vault.put("c.md", "C");
		expect((await a.push()).counts).toMatchObject({ added: 1, modified: 1, deleted: 1 });

		dropbox.calls.length = 0;
		const pulled = await b.pull();
		expect(pulled.counts).toMatchObject({ fetched: 2, deleted: 1 });
		expect(notes(b.vault)).toEqual({ "a.md": "A2", "c.md": "C" });
		// Only the changes since the cursor were asked for.
		expect(dropbox.calls).not.toContain("files/list_folder");

		dropbox.calls.length = 0;
		expect((await b.pull()).counts).toMatchObject({ fetched: 0 });
		expect(dropbox.calls).toEqual(["files/list_folder/continue"]);
	});

	test("an edit another device sent first is not written over: the next pull merges the two", async () => {
		const dropbox = new FakeDropbox();
		const a = device(dropbox, "iPhone");
		a.vault.put("a.md", "one\ntwo\nthree\n");
		await a.pull();
		await a.push();
		const b = device(dropbox, "Pixel");
		await b.pull();

		// The other device sends its edit while this one is between its
		// listing and its upload.
		b.vault.put("a.md", "one\ntwo\nTHREE\n");
		sendFirst(dropbox, () => {
			a.vault.put("a.md", "ONE\ntwo\nthree\n");
			return a.push();
		});
		const refused = await b.push();
		expect(refused.leftOut).toEqual([{ path: "a.md", reason: "remote-changed" }]);
		expect(dropbox.text("/Vault/a.md")).toBe("ONE\ntwo\nthree\n");

		await b.pull();
		expect(b.vault.text("a.md")).toBe("ONE\ntwo\nTHREE\n");
		expect((await b.push()).outcome).toBe("pushed");
		await a.pull();
		expect(a.vault.text("a.md")).toBe("ONE\ntwo\nTHREE\n");
	});

	test("a file one device deleted and the other changed is kept with the change", async () => {
		const dropbox = new FakeDropbox();
		const a = device(dropbox, "iPhone");
		a.vault.put("a.md", "A");
		await a.pull();
		await a.push();
		const b = device(dropbox, "Pixel");
		await b.pull();

		b.vault.remove("a.md");
		sendFirst(dropbox, () => {
			a.vault.put("a.md", "A2");
			return a.push();
		});
		const kept = await b.push();
		expect(kept.leftOut).toEqual([{ path: "a.md", reason: "remote-changed" }]);
		expect(dropbox.text("/Vault/a.md")).toBe("A2");
		await b.pull();
		expect(b.vault.text("a.md")).toBe("A2");
	});

	test("a cursor Dropbox will not go on from lists the folder again, and fetches only what differs", async () => {
		const dropbox = new FakeDropbox();
		const a = device(dropbox, "iPhone");
		a.vault.put("a.md", "A");
		a.vault.put("b.md", "B");
		await a.pull();
		await a.push();
		const b = device(dropbox, "Pixel");
		await b.pull();
		a.vault.put("a.md", "A2");
		await a.push();

		const listing = await b.store.getListing();
		dropbox.expired.add(listing?.revision ?? "");
		const pulled = await b.pull();
		expect(pulled.counts).toMatchObject({ fetched: 1 });
		expect(notes(b.vault)).toEqual({ "a.md": "A2", "b.md": "B" });
	});
});
