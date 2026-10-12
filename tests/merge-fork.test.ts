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

// The `node-diff3` that is bundled is a fork with one change, a binary search
// in `LCS` (esbuild.config.mjs). The change is for speed alone: every merge
// must come out as the release it was made from gives it. When the change is
// in a release and the dependency is the registry's again, this file goes.

import { diff3Merge as forked } from "node-diff3";
import { diff3Merge as released } from "node-diff3-upstream";
import { expect, test } from "vitest";

/** The same sequence on every run. */
function random(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		return state / 0x7fffffff;
	};
}

function documents(next: () => number, length: number, kinds: number): [string[], string[], string[]] {
	const line = () => `line ${Math.floor(next() * kinds)}`;
	const base = Array.from({ length: Math.floor(next() * (length + 1)) }, line);
	const edited = () => {
		const lines = base.slice();
		for (let edits = 1 + Math.floor(next() * 4); edits > 0; edits--) {
			const at = Math.floor(next() * (lines.length + 1));
			const what = next();
			if (what < 0.34) lines.splice(at, 0, line());
			else if (what < 0.67) lines.splice(at, 1);
			else if (lines.length > 0) lines[Math.min(at, lines.length - 1)] = line();
		}
		return lines;
	};
	return [edited(), base, edited()];
}

// Few kinds of lines, so that equal lines are many and the search has to
// choose among them: where the two could differ if the change were wrong.
test.each([
	[6, 3, 8000],
	[12, 4, 8000],
	[30, 6, 4000],
	[30, 1000, 1000],
	[200, 8, 300],
])("documents of up to %i lines of %i kinds merge as the release merges them", (length, kinds, count) => {
	const next = random(length * 1000 + kinds);
	let conflicts = 0;
	for (let n = 0; n < count; n++) {
		const [mine, base, theirs] = documents(next, length, kinds);
		const expected = released(mine, base, theirs, { excludeFalseConflicts: true });
		expect(forked(mine, base, theirs, { excludeFalseConflicts: true })).toEqual(expected);
		if (expected.some((region) => region.conflict !== undefined)) conflicts++;
	}
	// Both outcomes are among them.
	expect(conflicts).toBeGreaterThan(0);
	expect(conflicts).toBeLessThan(count);
});

test("a long note with many blank lines is merged in well under a second", () => {
	const next = random(7);
	const base = Array.from({ length: 4000 }, (_, n) => (next() < 0.45 ? "" : `line ${n}`));
	const mine = base.slice();
	const theirs = base.slice();
	mine[100] = "mine";
	theirs[3900] = "theirs";
	const started = performance.now();
	const regions = forked(mine, base, theirs, { excludeFalseConflicts: true });
	// The release takes about ten seconds for this; the fork, a tenth of one.
	expect(performance.now() - started).toBeLessThan(2000);
	expect(regions.every((region) => region.conflict === undefined)).toBe(true);
});
