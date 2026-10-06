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

import { IDBFactory } from "fake-indexeddb";
import { describe, expect, test } from "vitest";
import type { StateStore } from "../src/core/state";
import { type DiscardNote, SyncState } from "../src/obsidian/sync-state";
import { fileRecord } from "./support/state-store-contract";

class MemoryNote implements DiscardNote {
	value = false;
	/** As when the app's local storage is full: nothing is stored and nothing is reported. */
	ignoresSet = false;
	/** As when the storage cannot be read at all. */
	unreadable = false;
	isSet(): boolean {
		if (this.unreadable) throw new Error("storage cannot be read");
		return this.value;
	}
	set(): void {
		if (!this.ignoresSet) this.value = true;
	}
	clear(): void {
		this.value = false;
	}
}

/** One device: what outlives the app (the databases and the note), and a way to start the plugin on it. */
function device(appId: unknown = "vault-id") {
	const real = new IDBFactory();
	const note = new MemoryNote();
	const failing = { deletes: false };
	const has = { indexedDb: true };
	const blocked = { count: 0 };
	const factory = {
		open: (name: string, version?: number) => real.open(name, version),
		deleteDatabase: (name: string) => {
			if (failing.deletes) throw new Error("cannot delete");
			return real.deleteDatabase(name);
		},
	} as unknown as IDBFactory;
	const start = (): SyncState =>
		new SyncState({
			appId: () => appId,
			note,
			indexedDb: () => (has.indexedDb ? factory : undefined),
			onDiscardBlocked: () => blocked.count++,
		});
	return { real, note, failing, has, blocked, start };
}

async function opened(state: SyncState): Promise<StateStore> {
	const result = await state.open();
	if (result.status !== "ok") throw new Error(`could not open: ${result.status}`);
	return result.store;
}

describe("opening the sync state", () => {
	test("gives a store, and the same one while it is open", async () => {
		const state = device().start();
		const first = await opened(state);
		expect(await opened(state)).toBe(first);

		state.close();
		const second = await opened(state);
		expect(second).not.toBe(first);
	});

	test("touches no database until asked", async () => {
		const { real, start } = device();
		start();
		expect(await real.databases()).toEqual([]);
	});

	test("passes on that the vault has no id", async () => {
		expect(await device(null).start().open()).toEqual({ status: "unavailable", reason: "no-app-id" });
	});
});

describe("discarding on a change of the connection", () => {
	test("an open that follows waits for it and finds nothing of the old state", async () => {
		const state = device().start();
		await (await opened(state)).commitWrite(fileRecord("old.md"));

		state.requestDiscard();
		// Not awaited in between, as the settings screen does not.
		const store = await opened(state);

		expect(await store.readRecords()).toEqual([]);
	});

	test("the store that was open is of no use any more", async () => {
		const state = device().start();
		const before = await opened(state);
		await before.commitWrite(fileRecord("old.md"));

		state.requestDiscard();
		await state.settled();

		await expect(before.commitWrite(fileRecord("late.md"))).rejects.toThrow();
		expect(await (await opened(state)).readRecords()).toEqual([]);
	});

	test("the note is set at once and cleared when the state is gone", async () => {
		const { note, real, start } = device();
		const state = start();
		await (await opened(state)).commitWrite(fileRecord("old.md"));

		state.requestDiscard();
		expect(note.value).toBe(true);
		await state.settled();
		expect(note.value).toBe(false);
		expect(await real.databases()).toEqual([]);
	});

	test("several changes in a row leave an empty state and no note", async () => {
		const { note, start } = device();
		const state = start();
		await (await opened(state)).commitWrite(fileRecord("old.md"));

		state.requestDiscard();
		state.requestDiscard();
		const store = await opened(state);
		state.requestDiscard();
		await state.settled();

		expect(note.value).toBe(false);
		expect(store).toHaveProperty("closed", true);
		expect(await (await opened(state)).readRecords()).toEqual([]);
	});

	test("when the app stops before the state is removed, the next start removes it before opening", async () => {
		const { note, start } = device();
		const first = start();
		await (await opened(first)).commitWrite(fileRecord("old.md"));
		first.close();
		// The change of the connection got as far as the note.
		note.set();

		const second = start();
		expect(await (await opened(second)).readRecords()).toEqual([]);
		expect(note.value).toBe(false);
	});

	test("when the state cannot be removed, it is not opened, and it is removed once that works", async () => {
		const { note, failing, start } = device();
		const state = start();
		await (await opened(state)).commitWrite(fileRecord("old.md"));

		failing.deletes = true;
		state.requestDiscard();
		expect(await state.open()).toMatchObject({ status: "unavailable", reason: "discard-failed" });
		expect(note.value).toBe(true);

		// Also after a restart, as long as it fails.
		expect(await start().open()).toMatchObject({ status: "unavailable", reason: "discard-failed" });

		failing.deletes = false;
		expect(await (await opened(state)).readRecords()).toEqual([]);
		expect(note.value).toBe(false);
	});

	test("a note that could not be stored does not keep the old state: the session remembers by itself", async () => {
		const { note, real, start } = device();
		const state = start();
		await (await opened(state)).commitWrite(fileRecord("old.md"));

		note.ignoresSet = true;
		state.requestDiscard();
		expect(note.value).toBe(false);

		expect(await (await opened(state)).readRecords()).toEqual([]);
		expect((await real.databases()).map((info) => info.name)).toEqual(["sync-evo-vault-id"]);
	});

	test("without a stored note, a removal that fails is still tried again, and nothing is opened meanwhile", async () => {
		const { note, failing, start } = device();
		const state = start();
		await (await opened(state)).commitWrite(fileRecord("old.md"));

		note.ignoresSet = true;
		failing.deletes = true;
		state.requestDiscard();
		expect(await state.open()).toMatchObject({ status: "unavailable", reason: "discard-failed" });
		expect(await state.open()).toMatchObject({ status: "unavailable", reason: "discard-failed" });

		failing.deletes = false;
		expect(await (await opened(state)).readRecords()).toEqual([]);
	});

	test("a note that cannot be cleared does not make every open discard again", async () => {
		const { note, start } = device();
		const state = start();
		note.clear = () => {
			throw new Error("storage refused");
		};

		state.requestDiscard();
		const store = await opened(state);
		await store.commitWrite(fileRecord("new.md"));
		expect(note.value).toBe(true);

		expect(await opened(state)).toBe(store);
		expect(await store.readRecords()).toEqual([fileRecord("new.md")]);
	});

	test("the reason is that the vault has no id, when that is why nothing could be removed", async () => {
		const state = device(null).start();
		state.requestDiscard();
		expect(await state.open()).toEqual({ status: "unavailable", reason: "no-app-id" });
	});

	test("the reason is that there is no IndexedDB, when that is why nothing could be removed", async () => {
		const { has, start } = device();
		const state = start();
		await (await opened(state)).commitWrite(fileRecord("old.md"));

		has.indexedDb = false;
		state.requestDiscard();
		expect(await state.open()).toEqual({ status: "unavailable", reason: "no-indexeddb" });

		// Still due once there is one: what opens then is not the old state.
		has.indexedDb = true;
		expect(await (await opened(state)).readRecords()).toEqual([]);
	});

	test("a note that cannot be read is taken as set: the state an earlier session left is not used", async () => {
		const { note, start } = device();
		const first = start();
		await (await opened(first)).commitWrite(fileRecord("old.md"));
		first.close();

		// After a restart, with nothing asked for in the new session.
		note.unreadable = true;
		const second = start();
		const store = await opened(second);
		expect(await store.readRecords()).toEqual([]);

		// Once per session, not on every open.
		await store.commitWrite(fileRecord("new.md"));
		expect(await opened(second)).toBe(store);
		expect(await store.readRecords()).toEqual([fileRecord("new.md")]);
	});

	test("a removal that has to wait for another connection says so, and the open waits with it", async () => {
		const { real, blocked, start } = device();
		const state = start();
		await (await opened(state)).commitWrite(fileRecord("old.md"));
		// Not one of ours: it ignores the request to close.
		const stubborn = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = real.open("sync-evo-vault-id");
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});

		state.requestDiscard();
		let done = false;
		const open = opened(state).then((store) => {
			done = true;
			return store;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(blocked.count).toBe(1);
		expect(done).toBe(false);

		stubborn.close();
		expect(await (await open).readRecords()).toEqual([]);
		expect(blocked.count).toBe(1);
	});

	test("a state written by a newer version is removed like any other", async () => {
		const { real, start } = device();
		await new Promise<void>((resolve, reject) => {
			const request = real.open("sync-evo-vault-id", 99);
			request.onsuccess = () => {
				request.result.close();
				resolve();
			};
			request.onerror = () => reject(request.error);
		});
		const state = start();
		expect(await state.open()).toEqual({ status: "newer-version" });

		state.requestDiscard();
		expect((await state.open()).status).toBe("ok");
	});
});
