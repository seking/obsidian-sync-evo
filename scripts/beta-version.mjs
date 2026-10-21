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

// Picks the version of the next beta release. Kept apart from
// release-beta.mjs so that tests can import it without running a release.

/**
 * Returns `<base>-beta.<N>`, where N is one more than the largest N among the
 * tags of the form `<base>-beta.<N>`, or 1 when there is none.
 *
 * @param {string} base The version in manifest.json, such as "0.0.1".
 * @param {readonly string[]} tags Tags that already exist.
 * @returns {string}
 */
export function nextBetaVersion(base, tags) {
	const prefix = `${base}-beta.`;
	let max = 0;
	for (const tag of tags) {
		if (!tag.startsWith(prefix)) continue;
		const rest = tag.slice(prefix.length);
		if (!/^\d+$/.test(rest)) continue; // not one of ours, such as "0.0.1-beta.2.1"
		// Compare as numbers: as strings, "10" would sort before "2".
		max = Math.max(max, Number(rest));
	}
	return `${prefix}${max + 1}`;
}
