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

/**
 * Whether a line of the log only tells how long a pull or a push took
 * (`timing.ts`): left out by a test that looks at what else was written.
 */
export function isTimingLine(line: string): boolean {
	return /^(pull|push): ([a-z-]+ in \d+ ms|full check: )/.test(line);
}
