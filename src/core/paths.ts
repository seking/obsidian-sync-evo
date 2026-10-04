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

/**
 * The key under which one file is matched across the remote listing, the
 * vault scan, and the records. Always NFC, whatever form either side returns,
 * so that the same name in NFC and NFD is one file and not a delete plus an add.
 */
export function pathKey(path: string): string {
	return path.normalize("NFC");
}
