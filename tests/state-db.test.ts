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
import { makeMarker, writeBaseRevision, readBaseRevision } from "../src/core/state";
import {
	discardStateDb,
	type IdbStateStore,
	openStateDb,
	STATE_DB_VERSION,
	stateDbName,
} from "../src/obsidian/state-db";
import { fileRecord } from "./support/state-store-contract";

const HASH = "a".repeat(40);

async function open(appId: unknown, factory: IDBFactory): Promise<IdbStateStore> {
	const result = await openStateDb(appId, factory);
	if (result.status !== "ok") throw new Error(`could not open: ${result.status}`);
	return result.store;
}

/** Opens a database outside of the code under test. */
function rawOpen(factory: IDBFactory, name: string, version?: number, upgrade?: (db: IDBDatabase) => void) {
	return new Promise<IDBDatabase>((resolve, reject) => {
		const request = factory.open(name, version);
		request.onupgradeneeded = () => upgrade?.(request.result);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

async function databaseNames(factory: IDBFactory): Promise<(string | undefined)[]> {
	return (await factory.databases()).map((info) => info.name);
}

async function fill(store: IdbStateStore): Promise<void> {
	await store.commitWrite(fileRecord("a.md"));
	await store.putMarker(makeMarker("b.md", null, HASH, false));
	await store.putListing({ revision: "rev-1", entries: [{ path: "a.md", kind: "file", hash: HASH }] });
	await writeBaseRevision(store, "rev-1");
}

describe("the name of the database", () => {
	test("carries the id of the vault", () => {
		expect(stateDbName("0123456789abcdef")).toBe("sync-evo-0123456789abcdef");
		expect(stateDbName("documents/notes")).toBe("sync-evo-documents/notes");
	});

	test.each([undefined, null, "", 42, {}, ["a"]])("there is none for the id %j", (appId) => {
		expect(stateDbName(appId)).toBeNull();
	});
});

describe("opening", () => {
	test("creates the database at the current version, under the name of the vault", async () => {
		const factory = new IDBFactory();
		const store = await open("vault-id", factory);
		expect(await factory.databases()).toEqual([{ name: "sync-evo-vault-id", version: STATE_DB_VERSION }]);
		await store.close();
	});

	test("what was stored is there after closing and opening again", async () => {
		const factory = new IDBFactory();
		const first = await open("vault-id", factory);
		await fill(first);
		await first.close();

		const second = await open("vault-id", factory);
		expect(await second.readRecords()).toEqual([fileRecord("a.md")]);
		expect(await second.readMarkers()).toEqual([makeMarker("b.md", null, HASH, false)]);
		expect((await second.getListing())?.revision).toBe("rev-1");
		expect(await readBaseRevision(second)).toBe("rev-1");
	});

	test.each([undefined, null, "", 42])("fails as unavailable, opening nothing, for the vault id %j", async (appId) => {
		const factory = new IDBFactory();
		expect(await openStateDb(appId, factory)).toEqual({ status: "unavailable", reason: "no-app-id" });
		expect(await factory.databases()).toEqual([]);
	});

	test("fails as unavailable where there is no IndexedDB", async () => {
		expect(await openStateDb("vault-id", undefined)).toEqual({ status: "unavailable", reason: "no-indexeddb" });
	});

	test("fails as unavailable when IndexedDB refuses", async () => {
		const refusing = {
			open: () => {
				throw new Error("not allowed here");
			},
		} as unknown as IDBFactory;
		expect(await openStateDb("vault-id", refusing)).toMatchObject({ status: "unavailable", reason: "open-failed" });
	});

	test("an id with a slash, as on an iPhone, works as a name", async () => {
		const factory = new IDBFactory();
		const store = await open("documents/spike", factory);
		await store.commitWrite(fileRecord("a.md"));
		await store.close();

		expect(await databaseNames(factory)).toEqual(["sync-evo-documents/spike"]);
		expect(await (await open("documents/spike", factory)).readRecords()).toEqual([fileRecord("a.md")]);
	});

	test("two vaults do not see each other's state", async () => {
		const factory = new IDBFactory();
		const one = await open("documents/one", factory);
		const two = await open("documents/two", factory);
		await fill(one);

		expect(await two.readRecords()).toEqual([]);
		expect(await two.readMarkers()).toEqual([]);
		expect(await two.getListing()).toBeNull();
		expect(await readBaseRevision(two)).toBeNull();

		await two.commitWrite(fileRecord("other.md"));
		expect(await one.readRecords()).toEqual([fileRecord("a.md")]);
	});
});

describe("a stored listing that is not one", () => {
	test.each([
		["an entry of an unknown kind", { revision: "rev-1", entries: [{ path: "a.md", kind: "tree", hash: HASH }] }],
		["an entry without a hash", { revision: "rev-1", entries: [{ path: "a.md", kind: "file" }] }],
		["no entries", { revision: "rev-1" }],
	])("with %s reads as no listing, so that the remote is listed again", async (_name, value) => {
		const factory = new IDBFactory();
		const store = await open("vault-id", factory);
		await store.putListing({ revision: "rev-0", entries: [] });

		const raw = await rawOpen(factory, "sync-evo-vault-id");
		await new Promise<void>((resolve, reject) => {
			const transaction = raw.transaction("listing", "readwrite");
			transaction.objectStore("listing").put(value, "current");
			transaction.oncomplete = () => resolve();
			transaction.onabort = () => reject(transaction.error);
		});
		raw.close();

		expect(await store.getListing()).toBeNull();
	});
});

describe("a database written by a newer version", () => {
	test("is reported as such and left exactly as it was", async () => {
		const factory = new IDBFactory();
		const store = await open("vault-id", factory);
		await fill(store);
		await store.close();

		// A later Sync Evo migrates it to the next version and adds something.
		const newer = await rawOpen(factory, "sync-evo-vault-id", STATE_DB_VERSION + 1, (db) => {
			db.createObjectStore("added-later");
		});
		newer.close();

		expect(await openStateDb("vault-id", factory)).toEqual({ status: "newer-version" });

		expect(await factory.databases()).toEqual([{ name: "sync-evo-vault-id", version: STATE_DB_VERSION + 1 }]);
		const after = await rawOpen(factory, "sync-evo-vault-id");
		expect([...after.objectStoreNames].sort()).toEqual(["added-later", "listing", "markers", "meta", "records"]);
		const records = await new Promise((resolve) => {
			const request = after.transaction("records").objectStore("records").getAll();
			request.onsuccess = () => resolve(request.result);
		});
		expect(records).toEqual([fileRecord("a.md")]);
		after.close();
	});
});

describe("starting over", () => {
	const seed = {
		listing: { revision: "rev-2", entries: [{ path: "c.md", kind: "file", hash: HASH }] },
		markers: [makeMarker("half.md", null, HASH, false)],
		meta: [["half-written", { files: ["x.md"], copies: [], conflicts: [] }]],
	} as const;

	test("what was stored is gone and the seed is there, in the same database", async () => {
		const factory = new IDBFactory();
		const store = await open("vault-id", factory);
		await fill(store);

		await store.startOver(seed);

		expect(store.closed).toBe(false);
		expect(await store.readRecords()).toEqual([]);
		expect(await store.readMarkers()).toEqual(seed.markers);
		expect(await store.getListing()).toEqual(seed.listing);
		expect(await readBaseRevision(store)).toBeNull();
		expect(await store.getMeta("half-written")).toEqual(seed.meta[0][1]);
		await store.close();
	});

	test("a seed that cannot be stored leaves everything as it was", async () => {
		const factory = new IDBFactory();
		const store = await open("vault-id", factory);
		await fill(store);

		await expect(store.startOver({ ...seed, meta: [...seed.meta, ["bad", () => {}]] })).rejects.toThrow();

		expect((await store.readRecords()).map((record) => record.path)).toEqual(["a.md"]);
		expect((await store.readMarkers()).map((marker) => marker.path)).toEqual(["b.md"]);
		expect((await store.getListing())?.revision).toBe("rev-1");
		expect(await readBaseRevision(store)).toBe("rev-1");
		expect(await store.getMeta("half-written")).toBeUndefined();
		await store.close();
	});
});

describe("discarding", () => {
	test("removes everything, and the state opened next is empty", async () => {
		const factory = new IDBFactory();
		const store = await open("vault-id", factory);
		await fill(store);
		await store.close();

		expect(await discardStateDb("vault-id", factory)).toEqual({ status: "ok" });
		expect(await factory.databases()).toEqual([]);

		const fresh = await open("vault-id", factory);
		expect(await fresh.readRecords()).toEqual([]);
		expect(await fresh.readMarkers()).toEqual([]);
		expect(await fresh.getListing()).toBeNull();
		expect(await readBaseRevision(fresh)).toBeNull();
	});

	test("leaves the state of another vault alone", async () => {
		const factory = new IDBFactory();
		await fill(await open("documents/one", factory));
		await fill(await open("documents/two", factory));

		expect(await discardStateDb("documents/one", factory)).toEqual({ status: "ok" });
		expect(await databaseNames(factory)).toEqual(["sync-evo-documents/two"]);
	});

	test("is fine when there is nothing to remove", async () => {
		expect(await discardStateDb("vault-id", new IDBFactory())).toEqual({ status: "ok" });
	});

	test("removes a database of a newer version as well", async () => {
		const factory = new IDBFactory();
		(await rawOpen(factory, "sync-evo-vault-id", STATE_DB_VERSION + 1)).close();
		expect(await discardStateDb("vault-id", factory)).toEqual({ status: "ok" });
		expect(await factory.databases()).toEqual([]);
	});

	test("a connection left open, as in another window, closes itself and does not block it", async () => {
		const factory = new IDBFactory();
		const other = await open("vault-id", factory);
		await fill(other);

		expect(await discardStateDb("vault-id", factory)).toEqual({ status: "ok" });
		expect(await factory.databases()).toEqual([]);

		// The other window's store is of no use any more, and says so.
		expect(other.closed).toBe(true);
		await expect(other.readRecords()).rejects.toThrow();
		await expect(other.commitWrite(fileRecord("late.md"))).rejects.toThrow();
		expect(await factory.databases()).toEqual([]);
	});

	test("waits for a connection that does not close by itself, and says that it waits", async () => {
		const factory = new IDBFactory();
		await (await open("vault-id", factory)).close();
		// Not one of ours: it ignores the request to close.
		const stubborn = await rawOpen(factory, "sync-evo-vault-id");

		let blocked = 0;
		let done = false;
		const discard = discardStateDb("vault-id", factory, () => blocked++).then((result) => {
			done = true;
			return result;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(blocked).toBe(1);
		expect(done).toBe(false);

		stubborn.close();
		expect(await discard).toEqual({ status: "ok" });
		expect(await factory.databases()).toEqual([]);
	});

	test.each([undefined, ""])("fails as unavailable for the vault id %j", async (appId) => {
		expect(await discardStateDb(appId, new IDBFactory())).toEqual({ status: "unavailable", reason: "no-app-id" });
	});

	test("fails as unavailable when IndexedDB refuses", async () => {
		const refusing = {
			deleteDatabase: () => {
				throw new Error("not allowed here");
			},
		} as unknown as IDBFactory;
		expect(await discardStateDb("vault-id", refusing)).toMatchObject({
			status: "unavailable",
			reason: "delete-failed",
		});
	});
});
