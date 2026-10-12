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

import { describe, expect, test } from "vitest";
import { areMergeable, isMergedPath, mergeContents } from "../src/core/merge";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (content: Uint8Array | null): string | null =>
	content === null ? null : new TextDecoder("utf-8", { ignoreBOM: true }).decode(content);
const BOM = "﻿";

/** `mine`, `base` and `theirs` merged, as text. */
function merged(mine: string, base: string, theirs: string, path = "notes/a.md"): string | null {
	return text(mergeContents(path, bytes(mine), bytes(base), bytes(theirs)));
}

describe("a merge by lines", () => {
	const base = "# Title\n\nfirst paragraph\n\nsecond paragraph\n\nthird paragraph\n";

	test("changes to different paragraphs are both in the result", () => {
		const mine = base.replace("first paragraph", "first paragraph, mine");
		const theirs = base.replace("third paragraph", "third paragraph, theirs");
		expect(merged(mine, base, theirs)).toBe(
			"# Title\n\nfirst paragraph, mine\n\nsecond paragraph\n\nthird paragraph, theirs\n",
		);
	});

	test("lines added on both sides at different places are all kept", () => {
		expect(merged(`mine\n${base}`, base, `${base}theirs\n`)).toBe(`mine\n${base}theirs\n`);
	});

	test("the same line changed in two ways does not merge, and nothing with conflict marks comes back", () => {
		const mine = base.replace("second paragraph", "second, mine");
		const theirs = base.replace("second paragraph", "second, theirs");
		expect(mergeContents("a.md", bytes(mine), bytes(base), bytes(theirs))).toBeNull();
	});

	test("the same change on both sides is no conflict", () => {
		const both = base.replace("second paragraph", "second, agreed");
		const theirs = both.replace("third paragraph", "third, theirs");
		expect(merged(both, base, theirs)).toBe(theirs);
	});

	test("a deletion on one side stays a deletion", () => {
		const mine = base.replace("first paragraph", "first paragraph, mine");
		const theirs = base.replace("third paragraph\n", "");
		expect(merged(mine, base, theirs)).toBe("# Title\n\nfirst paragraph, mine\n\nsecond paragraph\n\n");
		expect(merged(theirs, base, mine)).toBe("# Title\n\nfirst paragraph, mine\n\nsecond paragraph\n\n");
	});

	test("a deletion is not undone by lines that repeat: `a, c` with `b, c, a` and `a` does not merge", () => {
		// One that merges this keeps the `c` the remote deleted, without a word.
		expect(merged("b\nc\na", "a\nc", "a")).toBeNull();
		expect(merged("b\nc\na\n", "a\nc\n", "a\n")).toBeNull();
	});

	test("the line feed at the end is there exactly when the sides have it", () => {
		expect(merged("mine\nb\nc\n", "a\nb\nc\n", "a\nb\ntheirs\n")).toBe("mine\nb\ntheirs\n");
		expect(merged("mine\nb\nc", "a\nb\nc", "a\nb\ntheirs")).toBe("mine\nb\ntheirs");
		// One side added it: a change of the last line, which the other left alone.
		expect(merged("mine\nb\nc", "a\nb\nc", "a\nb\nc\n")).toBe("mine\nb\nc\n");
	});

	test("a side that only differs from the base by nothing gives the other side", () => {
		expect(merged(base, base, "theirs\n")).toBe("theirs\n");
		expect(merged("mine\n", base, base)).toBe("mine\n");
	});

	test("merging the merged content with the remote's again gives the merged content", () => {
		const mine = base.replace("first paragraph", "first paragraph, mine");
		const theirs = base.replace("third paragraph", "third paragraph, theirs");
		const once = merged(mine, base, theirs) ?? "";
		expect(merged(once, base, theirs)).toBe(once);
	});

	test("line ends are not made alike: a side that changed every one of them does not merge", () => {
		const mine = base.replace("first paragraph", "first paragraph, mine");
		const theirs = base.replace("third paragraph", "third paragraph, theirs").replace(/\n/g, "\r\n");
		expect(merged(mine, base, theirs)).toBeNull();
	});

	test("with the same line ends on every side, they are kept as they are", () => {
		const crlf = (value: string): string => value.replace(/\n/g, "\r\n");
		const mine = base.replace("first paragraph", "first paragraph, mine");
		const theirs = base.replace("third paragraph", "third paragraph, theirs");
		expect(merged(crlf(mine), crlf(base), crlf(theirs))).toBe(
			crlf("# Title\n\nfirst paragraph, mine\n\nsecond paragraph\n\nthird paragraph, theirs\n"),
		);
	});

	test("a byte order mark that not all three have: no merge", () => {
		const mine = "mine\nb\nc\n";
		const theirs = "a\nb\ntheirs\n";
		const o = "a\nb\nc\n";
		expect(merged(BOM + mine, o, theirs)).toBeNull();
		expect(merged(mine, BOM + o, theirs)).toBeNull();
		expect(merged(mine, o, BOM + theirs)).toBeNull();
		expect(merged(BOM + mine, BOM + o, theirs)).toBeNull();
	});

	test("a byte order mark all three have is kept, once, and is no part of the first line", () => {
		const result = mergeContents("a.md", bytes(`${BOM}mine\nb\nc\n`), bytes(`${BOM}a\nb\nc\n`), bytes(`${BOM}a\nb\ntheirs\n`));
		expect(text(result)).toBe(`${BOM}mine\nb\ntheirs\n`);
		expect([...(result ?? [])].slice(0, 4)).toEqual([0xef, 0xbb, 0xbf, "m".charCodeAt(0)]);
	});

	test("content that is not UTF-8 on any of the three sides: no merge", () => {
		const binary = new Uint8Array([0xff, 0xfe, 0x00, 0x0a]);
		const half = new Uint8Array([0x61, 0x0a, 0xc3]);
		const a = bytes("mine\nb\n");
		const o = bytes("a\nb\n");
		const b = bytes("a\nb\ntheirs\n");
		for (const bad of [binary, half]) {
			expect(mergeContents("a.md", bad, o, b)).toBeNull();
			expect(mergeContents("a.md", a, bad, b)).toBeNull();
			expect(mergeContents("a.md", a, o, bad)).toBeNull();
		}
	});

	test("text by the content and not by the name: a file without an ending, or with the ending of an image, merges", () => {
		for (const path of ["LICENSE", "notes/odd.png", ".gitignore", "a.canvas.md"]) {
			expect(merged("mine\nb\nc\n", "a\nb\nc\n", "a\nb\ntheirs\n", path)).toBe("mine\nb\ntheirs\n");
		}
	});

	test("a control character, which a push would not send as text either: no merge", () => {
		expect(merged("mine\0\nb\n", "a\nb\n", "a\nb\ntheirs\n")).toBeNull();
	});

	test.each(["board.canvas", "notes/Board.CANVAS", "tasks.base", "views/All.Base"])(
		"%s is never merged, whatever it holds",
		(path) => {
			expect(isMergedPath(path)).toBe(false);
			expect(merged("mine\nb\nc\n", "a\nb\nc\n", "a\nb\ntheirs\n", path)).toBeNull();
		},
	);

	test("empty contents are text", () => {
		expect(merged("", "", "theirs\n")).toBe("theirs\n");
		expect(merged("mine\n", "", "")).toBe("mine\n");
	});
});

describe("whether two sides can be merged at all, before the base is fetched", () => {
	test("two texts that agree on the byte order mark", () => {
		expect(areMergeable([bytes("a\n"), bytes("b\n")])).toBe(true);
		expect(areMergeable([bytes(`${BOM}a\n`), bytes(`${BOM}b\n`)])).toBe(true);
	});

	test("not with a side that is no text, or with the mark on one side alone", () => {
		expect(areMergeable([bytes("a\n"), new Uint8Array([0xff, 0xfe])])).toBe(false);
		expect(areMergeable([bytes(`${BOM}a\n`), bytes("b\n")])).toBe(false);
	});
});
