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
 * Whether a line of the log only tells how long a pull or a push took
 * (`timing.ts`): left out by a test that looks at what else was written.
 */
export function isTimingLine(line: string): boolean {
	return /^(pull|push): ([a-z-]+ in \d+ ms|full check: )/.test(line);
}
