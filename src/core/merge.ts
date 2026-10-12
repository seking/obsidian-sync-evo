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

// The merge of a conflict: the two sides of a file and what it held when it
// was last synced, put together line by line. Either all of it merges, or
// nothing is merged: the answer is the merged content or `null`, and never a
// content with conflict marks in it. What becomes of a file that does not
// merge is the caller's (`pull-apply.ts`): its vault side is kept as a copy.
//
// Nothing is made alike before the lines are compared. A side that changed
// every line end differs in every line, so it does not merge, and line ends
// are never mixed without a word.

import { diff3Merge } from "node-diff3";
import { inlineText } from "./text";

// Text files all the same, and never merged: their content is JSON, and a
// merge by lines can give something that is no JSON at all.
const UNMERGED_ENDINGS: readonly string[] = [".canvas", ".base"];

/** Whether a file of this name is one that is merged at all. Its content is another question (`mergeContents`). */
export function isMergedPath(path: string): boolean {
	const name = path.toLowerCase();
	return !UNMERGED_ENDINGS.some((ending) => name.endsWith(ending));
}

const BOM: readonly number[] = [0xef, 0xbb, 0xbf];

function hasBom(content: Uint8Array): boolean {
	return BOM.every((byte, index) => content[index] === byte);
}

/** A content as text, and whether a byte order mark comes before it. */
interface Text {
	readonly bom: boolean;
	readonly text: string;
}

/**
 * The content as text, or `null` when it is none: the same question a push
 * asks before it sends a content as text (`inlineText`), put to the bytes
 * after the byte order mark. The mark is kept apart, and not as a part of
 * the first line: there it would pass for a change of that line.
 */
function textOf(content: Uint8Array): Text | null {
	const bom = hasBom(content);
	const text = inlineText(bom ? content.subarray(BOM.length) : content);
	return text === null ? null : { bom, text };
}

/**
 * Whether these contents can be merged as far as they alone tell: each is
 * text, and they agree on the byte order mark. Asked of the two sides
 * before the third content is fetched for them.
 */
export function areMergeable(contents: readonly Uint8Array[]): boolean {
	return textsOf(contents) !== null;
}

function textsOf(contents: readonly Uint8Array[]): Text[] | null {
	const texts: Text[] = [];
	for (const content of contents) {
		const text = textOf(content);
		if (text === null || (texts[0] !== undefined && texts[0].bom !== text.bom)) return null;
		texts.push(text);
	}
	return texts;
}

/**
 * `mine` and `theirs` merged, both having come from `base`. `null` when
 * they do not merge: the name is one that is not merged, one of the three
 * is no text, they do not agree on the byte order mark, or both sides
 * changed the same lines in different ways.
 *
 * A change both sides made alike is no conflict. A line is what is between
 * two line feeds, with a carriage return that comes before one as part of
 * it, so the merged content ends in a line feed exactly when the sides do.
 */
export function mergeContents(
	path: string,
	mine: Uint8Array,
	base: Uint8Array,
	theirs: Uint8Array,
): Uint8Array | null {
	if (!isMergedPath(path)) return null;
	const texts = textsOf([mine, base, theirs]);
	if (texts === null) return null;
	const [a, o, b] = texts.map((each) => each.text.split("\n"));
	if (a === undefined || o === undefined || b === undefined) return null;

	const lines: string[] = [];
	// Arrays of lines: given a string, the library would split it by words.
	for (const region of diff3Merge(a, o, b, { excludeFalseConflicts: true })) {
		if (region.ok === undefined) return null;
		for (const line of region.ok) lines.push(line);
	}
	const text = new TextEncoder().encode(lines.join("\n"));
	if (texts[0]?.bom !== true) return text;
	const merged = new Uint8Array(BOM.length + text.length);
	merged.set(BOM);
	merged.set(text, BOM.length);
	return merged;
}
