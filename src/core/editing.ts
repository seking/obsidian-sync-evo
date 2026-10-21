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

// Whether a file is being typed in right now. A sync that starts by itself
// leaves such a file alone for the time being: writing the remote's content
// into a note in the middle of a sentence takes what was typed off the
// screen, into a copy, under the user's fingers; on a phone it did so in
// the middle of an input method's composition, which then went on over the
// remote's text (seen on an iPhone). A sync the user starts is not held
// back by this: starting it ends the typing.
//
// The app only says what it saw: when a file's view last got input, and
// whether a composition is open in it. What that means is decided here.

import { foldedKey } from "./paths";

/**
 * How long after the last input a file still counts as being typed in. A
 * pause to think is shorter than this; and a sync that comes by every few
 * minutes takes the file the next time.
 */
export const EDITING_QUIET_MS = 20_000;

/** What the app saw of one file that a view shows. */
export interface EditingFact {
	/** The path of the file, as the view spells it. */
	readonly path: string;
	/** When the view last got input, on the clock the question is asked with; `null` for never. */
	readonly lastInputAt: number | null;
	/**
	 * Whether an input method is in the middle of a composition there: text
	 * that is on the screen and not yet in the note. It counts for as long
	 * as it is open, however long nothing is typed: the keyboard is up, and
	 * the next key goes on with it.
	 */
	readonly composing: boolean;
}

/**
 * Whether the file at `path` is being typed in at `now`: a composition is
 * open in a view of it, or one got input within `EDITING_QUIET_MS`.
 *
 * The path is matched without regard to case and normalization, like the
 * editors that are asked to save (`saveOpenEditors`): where the disk does
 * not tell the cases apart, the view may have the file under another
 * spelling, and leaving a file alone once too often loses nothing. An input
 * dated after `now` (a clock that was set back) counts as just made.
 */
export function isBeingEdited(facts: readonly EditingFact[], path: string, now: number): boolean {
	const wanted = foldedKey(path);
	return facts.some((fact) => {
		if (foldedKey(fact.path) !== wanted) return false;
		return fact.composing || (fact.lastInputAt !== null && now - fact.lastInputAt < EDITING_QUIET_MS);
	});
}

/** A view of the app that shows a file, with the path of that file as it is now. */
export interface ShownFile<View extends object> {
	readonly view: View;
	readonly path: string;
}

/**
 * What was seen, kept per view. The app tells it of each event as it comes
 * (`obsidian/editing-watch.ts`); nothing here looks at the app.
 *
 * Per view and not per path: the path of a file changes under a view that
 * stays (a pull renames its folder, the user renames the note), and what
 * was typed there a moment ago, or is being composed there, is still so.
 * The path is put to it when the facts are asked for, as it is then. A
 * view that is gone is forgotten with it.
 */
export class EditingLog<View extends object> {
	private readonly seen = new WeakMap<View, { lastInputAt: number | null; composing: boolean }>();

	/**
	 * The view got input. `composing`: whether the input is part of a
	 * composition, where the event says; `false` when it says that it is
	 * not, and `null` when it does not say. An input that is not part of
	 * one means that none is open: an end that was never told (a phone does
	 * not tell it when the app goes to the background) is made up for here.
	 */
	input(view: View, at: number, composing: boolean | null = null): void {
		const entry = this.entry(view);
		entry.lastInputAt = at;
		if (composing !== null) entry.composing = composing;
	}

	/**
	 * A composition began in the view, or goes on: an update of one says so
	 * too, for when its beginning was not seen.
	 */
	composing(view: View, at: number): void {
		const entry = this.entry(view);
		entry.composing = true;
		entry.lastInputAt = at;
	}

	/**
	 * The composition ended: confirmed, or given up. What it left in the
	 * note was typed just now. Nothing when none was open.
	 */
	compositionEnded(view: View, at: number): void {
		const entry = this.seen.get(view);
		if (entry === undefined || !entry.composing) return;
		entry.composing = false;
		entry.lastInputAt = at;
	}

	/**
	 * What is known of the files that views show now, each under the path
	 * its view shows at this moment. A view nothing was seen of has no fact.
	 */
	facts(shown: readonly ShownFile<View>[]): EditingFact[] {
		const facts: EditingFact[] = [];
		for (const { view, path } of shown) {
			const entry = this.seen.get(view);
			if (entry !== undefined) facts.push({ path, lastInputAt: entry.lastInputAt, composing: entry.composing });
		}
		return facts;
	}

	private entry(view: View): { lastInputAt: number | null; composing: boolean } {
		let entry = this.seen.get(view);
		if (entry === undefined) {
			entry = { lastInputAt: null, composing: false };
			this.seen.set(view, entry);
		}
		return entry;
	}
}
