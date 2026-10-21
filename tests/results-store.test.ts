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

import { IDBFactory } from "fake-indexeddb";
import { describe, expect, test } from "vitest";
import { RESULTS_KEPT, type SyncResult } from "../src/core/sync-results";
import { resultsDbName, ResultsStore } from "../src/obsidian/results-store";

const result = (at: number): SyncResult => ({
	at,
	automatic: at % 2 === 0,
	summaries: ["Download finished."],
	items: [{ level: "warn", text: `A conflict:\n${at}.md` }],
});

const storeOf = (factory: IDBFactory | undefined, appId: unknown = "0123456789abcdef"): ResultsStore =>
	new ResultsStore({ appId: () => appId, indexedDb: () => factory });

describe("the name of the database", () => {
	test("carries the id of the vault, apart from the sync state", () => {
		expect(resultsDbName("0123456789abcdef")).toBe("sync-evo-results-0123456789abcdef");
	});

	test.each([undefined, null, "", 42])("there is none for the id %j", (appId) => {
		expect(resultsDbName(appId)).toBeNull();
	});
});

describe("the results of the last syncs", () => {
	test("are there for the next start of the app: another store of the same vault finds them", async () => {
		const factory = new IDBFactory();
		await storeOf(factory).add(result(1));
		await storeOf(factory).add(result(2));

		expect(await storeOf(factory).list()).toEqual([result(2), result(1)]);
		// Not those of another vault.
		expect(await storeOf(factory, "fedcba9876543210").list()).toEqual([]);
	});

	test("are kept up to the limit, the newest first, also when added at once", async () => {
		const factory = new IDBFactory();
		const store = storeOf(factory);
		await Promise.all(Array.from({ length: RESULTS_KEPT + 3 }, (_, at) => store.add(result(at))));

		const kept = await storeOf(factory).list();
		expect(kept).toHaveLength(RESULTS_KEPT);
		expect(kept.map((entry) => entry.at)).toEqual(Array.from({ length: RESULTS_KEPT }, (_, index) => RESULTS_KEPT + 2 - index));
	});

	test("without IndexedDB, are kept in memory until the app is closed, and nothing rejects", async () => {
		const store = storeOf(undefined);
		await expect(store.add(result(1))).resolves.toBeUndefined();
		await store.add(result(2));

		expect(await store.list()).toEqual([result(2), result(1)]);
		expect(await storeOf(undefined).list()).toEqual([]);
	});

	test("without the id of the vault, as well", async () => {
		const store = storeOf(new IDBFactory(), undefined);
		await expect(store.add(result(1))).resolves.toBeUndefined();
		expect(await store.list()).toEqual([result(1)]);
	});

	test("a database that cannot be opened does not reject either", async () => {
		const broken = {
			open: () => {
				throw new Error("blocked");
			},
		} as unknown as IDBFactory;
		const store = storeOf(broken);
		await expect(store.add(result(1))).resolves.toBeUndefined();
		expect(await store.list()).toEqual([result(1)]);
	});

	test("a read that failed does not make the next add lose what was stored", async () => {
		const factory = new IDBFactory();
		await storeOf(factory).add(result(1));
		// The first open fails (the read of what is stored), the later ones work.
		let opens = 0;
		const flaky = {
			open: (...given: Parameters<IDBFactory["open"]>) => {
				opens += 1;
				if (opens === 1) throw new Error("blocked");
				return factory.open(...given);
			},
		} as unknown as IDBFactory;

		await storeOf(flaky).add(result(2));

		expect(await storeOf(factory).list()).toEqual([result(2), result(1)]);
	});

	test("two stores of the same vault that both add keep both, and not only the last", async () => {
		const factory = new IDBFactory();
		const first = storeOf(factory);
		const second = storeOf(factory);
		// Both have read what is stored before either adds.
		await first.list();
		await second.list();

		await first.add(result(1));
		await second.add(result(2));

		expect(await storeOf(factory).list()).toEqual([result(2), result(1)]);
	});

	test("a list right after an add that is not awaited has it", async () => {
		const store = storeOf(new IDBFactory());
		void store.add(result(1));
		expect(await store.list()).toEqual([result(1)]);
	});

	test("what was stored that is not a sync is left out", async () => {
		const factory = new IDBFactory();
		await storeOf(factory).add(result(1));
		// What an older or a newer version wrote.
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = factory.open("sync-evo-results-0123456789abcdef", 1);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		await new Promise<void>((resolve, reject) => {
			const transaction = db.transaction("results", "readwrite");
			transaction.objectStore("results").put([{ when: "yesterday" }, result(1)], "recent");
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error);
		});
		db.close();

		expect(await storeOf(factory).list()).toEqual([result(1)]);
	});
});
