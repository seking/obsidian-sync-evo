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

import type { PaidStorage } from "../core/paid-gate";

/**
 * Where the paid plan keeps what it remembers (`paid-gate.ts`): the local
 * storage of the app as it is, and not through `saveLocalStorage`, which
 * puts the id of the vault in front of each key. The key is one for the
 * device, whichever vault it is entered in, and an activation is not used
 * up by a second vault. Outside the vault, and never in `data.json` (S-4).
 * A storage that cannot be read or written is taken for an empty one.
 */
export const windowStorage: PaidStorage = {
	read(key) {
		try {
			const raw = window.localStorage.getItem(key);
			return raw === null ? null : (JSON.parse(raw) as unknown);
		} catch {
			return null;
		}
	},
	write(key, value) {
		try {
			if (value === null || value === undefined) window.localStorage.removeItem(key);
			else window.localStorage.setItem(key, JSON.stringify(value));
		} catch {
			// Nothing is remembered: the key is asked for again, the count read again.
		}
	},
};
