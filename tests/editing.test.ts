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
import { EDITING_QUIET_MS, type EditingFact, EditingLog, isBeingEdited } from "../src/core/editing";

const NOW = 1_700_000_000_000;

const typed = (path: string, ago: number | null, composing = false): EditingFact => ({
	path,
	lastInputAt: ago === null ? null : NOW - ago,
	composing,
});

describe("whether a file is being typed in right now", () => {
	test("for 20 seconds after the last input, and no longer", () => {
		expect(EDITING_QUIET_MS).toBe(20_000);
		expect(isBeingEdited([typed("a.md", 0)], "a.md", NOW)).toBe(true);
		expect(isBeingEdited([typed("a.md", EDITING_QUIET_MS - 1)], "a.md", NOW)).toBe(true);
		expect(isBeingEdited([typed("a.md", EDITING_QUIET_MS)], "a.md", NOW)).toBe(false);
		expect(isBeingEdited([typed("a.md", 10 * 60_000)], "a.md", NOW)).toBe(false);
	});

	test("for as long as a composition is open, however long ago the last key was", () => {
		expect(isBeingEdited([typed("a.md", 60 * 60_000, true)], "a.md", NOW)).toBe(true);
		expect(isBeingEdited([typed("a.md", null, true)], "a.md", NOW)).toBe(true);
	});

	test("not a file that is only open", () => {
		expect(isBeingEdited([typed("a.md", null)], "a.md", NOW)).toBe(false);
		expect(isBeingEdited([], "a.md", NOW)).toBe(false);
	});

	test("the input of another file does not count", () => {
		const facts = [typed("notes/b.md", 0), typed("c.md", null, true)];
		expect(isBeingEdited(facts, "a.md", NOW)).toBe(false);
		expect(isBeingEdited(facts, "notes/a.md", NOW)).toBe(false);
		expect(isBeingEdited(facts, "notes/b.md", NOW)).toBe(true);
	});

	test("the path is matched without regard to case and normalization, like the editors that are asked to save", () => {
		const nfc = "ノート/ガイド.md";
		expect(isBeingEdited([typed("Notes/A.md", 0)], "notes/a.md", NOW)).toBe(true);
		expect(isBeingEdited([typed(nfc.normalize("NFD"), 0)], nfc, NOW)).toBe(true);
		expect(isBeingEdited([typed(nfc, 0)], nfc.normalize("NFD"), NOW)).toBe(true);
	});

	test("two views of one file: either is enough", () => {
		expect(isBeingEdited([typed("a.md", 60_000), typed("a.md", 1_000)], "a.md", NOW)).toBe(true);
	});

	test("an input dated after now, on a clock that was set back, counts as just made", () => {
		expect(isBeingEdited([typed("a.md", -60_000)], "a.md", NOW)).toBe(true);
	});
});

describe("what is noted of the typing", () => {
	/** A view of the app: nothing but an object that stays the same while its file is renamed. */
	const view = (): object => ({});

	test("the time of the last input, per view, under the path the view shows when asked", () => {
		const log = new EditingLog<object>();
		const a = view();
		const b = view();
		log.input(a, NOW - 5_000);
		log.input(a, NOW - 1_000);
		log.input(b, NOW - 30_000);
		expect(
			log.facts([
				{ view: a, path: "a.md" },
				{ view: b, path: "b.md" },
			]),
		).toEqual([typed("a.md", 1_000), typed("b.md", 30_000)]);
	});

	test("a file that is renamed under its view is still being typed in, under its new path", () => {
		const log = new EditingLog<object>();
		const note = view();
		log.composing(note, NOW - 60_000);
		// A pull renamed the folder, or the user the note.
		const facts = log.facts([{ view: note, path: "Notes/a.md" }]);
		expect(facts).toEqual([typed("Notes/a.md", 60_000, true)]);
		expect(isBeingEdited(facts, "Notes/a.md", NOW)).toBe(true);
		// And again under the name after that.
		expect(isBeingEdited(log.facts([{ view: note, path: "b.md" }]), "b.md", NOW)).toBe(true);
	});

	test("a view nothing was seen of has no fact, and a view that is not shown is not listed", () => {
		const log = new EditingLog<object>();
		const typedIn = view();
		log.input(typedIn, NOW);
		expect(log.facts([{ view: view(), path: "a.md" }])).toEqual([]);
		expect(log.facts([])).toEqual([]);
		// Shown again, it is known again: the view is the same one.
		expect(log.facts([{ view: typedIn, path: "a.md" }])).toEqual([typed("a.md", 0)]);
	});

	test("a composition is open from its start to its end, and its end is an input", () => {
		const log = new EditingLog<object>();
		const a = view();
		const shown = [{ view: a, path: "a.md" }];
		log.composing(a, NOW - 90_000);
		expect(isBeingEdited(log.facts(shown), "a.md", NOW)).toBe(true);
		log.compositionEnded(a, NOW - 30_000);
		expect(log.facts(shown)).toEqual([typed("a.md", 30_000)]);
		expect(isBeingEdited(log.facts(shown), "a.md", NOW)).toBe(false);
		expect(isBeingEdited(log.facts(shown), "a.md", NOW - 15_000)).toBe(true);
	});

	test("an update of a composition whose start was not seen opens it", () => {
		const log = new EditingLog<object>();
		const a = view();
		log.composing(a, NOW);
		expect(log.facts([{ view: a, path: "a.md" }])).toEqual([typed("a.md", 0, true)]);
	});

	test("an end with no composition open is nothing: a view that loses the keyboard was not typed in", () => {
		const log = new EditingLog<object>();
		const a = view();
		const b = view();
		log.compositionEnded(a, NOW);
		expect(log.facts([{ view: a, path: "a.md" }])).toEqual([]);
		log.input(b, NOW - 60_000);
		log.compositionEnded(b, NOW);
		expect(log.facts([{ view: b, path: "b.md" }])).toEqual([typed("b.md", 60_000)]);
	});

	test("an input that is part of a composition keeps it open", () => {
		const log = new EditingLog<object>();
		const a = view();
		log.composing(a, NOW - 5_000);
		log.input(a, NOW, true);
		expect(log.facts([{ view: a, path: "a.md" }])).toEqual([typed("a.md", 0, true)]);
	});

	test("an input that is not part of one closes a composition whose end was never told", () => {
		const log = new EditingLog<object>();
		const a = view();
		const shown = [{ view: a, path: "a.md" }];
		// The app went to the background in the middle of it.
		log.composing(a, NOW - 10 * 60_000);
		expect(isBeingEdited(log.facts(shown), "a.md", NOW)).toBe(true);
		log.input(a, NOW - 60_000, false);
		expect(log.facts(shown)).toEqual([typed("a.md", 60_000)]);
		expect(isBeingEdited(log.facts(shown), "a.md", NOW)).toBe(false);
	});

	test("an input that says nothing of compositions leaves one as it is", () => {
		const log = new EditingLog<object>();
		const a = view();
		log.composing(a, NOW - 5_000);
		log.input(a, NOW);
		expect(log.facts([{ view: a, path: "a.md" }])).toEqual([typed("a.md", 0, true)]);
	});

	test("the composition of one view is not another's, also of the same file", () => {
		const log = new EditingLog<object>();
		const a = view();
		const b = view();
		log.composing(a, NOW);
		log.compositionEnded(b, NOW);
		log.input(b, NOW, false);
		const facts = log.facts([
			{ view: a, path: "a.md" },
			{ view: b, path: "b.md" },
		]);
		expect(isBeingEdited(facts, "a.md", NOW + 60_000)).toBe(true);
		expect(isBeingEdited(facts, "b.md", NOW + 60_000)).toBe(false);
	});
});
