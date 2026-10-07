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

// When a sync deletes so much that it stops and asks first. The same test
// for both directions: files a pull would delete in the vault, and files a
// push would delete on the remote, each counted on its own.

/** More deletions than this always ask. */
export const DELETION_LIMIT = 50;

/** More deletions than this ask when they are also more than a tenth of everything. */
export const DELETION_SHARE_FLOOR = 5;

/**
 * Whether `deletions` is too many to carry out without asking: more than 50,
 * or more than 5 and more than a tenth of `recordCount`.
 *
 * `recordCount` is the number of records, of every kind, when that direction
 * of the sync starts. The share alone would let 665 of 6,655 files go, which
 * is what the fixed limit is for; in a vault of 30 the share stops at 6.
 *
 * What counts as a deletion is the caller's to decide. Moves, renames, and
 * files that are deleted to be written again are not among them.
 */
export function exceedsDeletionThreshold(deletions: number, recordCount: number): boolean {
	if (deletions > DELETION_LIMIT) return true;
	return deletions > DELETION_SHARE_FLOOR && deletions * 10 > recordCount;
}
