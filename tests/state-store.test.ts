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
import { openStateDb } from "../src/obsidian/state-db";
import { MemoryStateStore } from "./support/memory-state-store";
import { describeStateStore } from "./support/state-store-contract";

// The same expectations for the store tests are written against and for the
// one that runs on a device, so that the first cannot drift from the second.

describeStateStore("in memory", async () => new MemoryStateStore());

describeStateStore("IndexedDB", async () => {
	// A factory of its own: nothing is shared between tests.
	const result = await openStateDb("vault-id", new IDBFactory());
	if (result.status !== "ok") throw new Error(`could not open: ${result.status}`);
	return result.store;
});
