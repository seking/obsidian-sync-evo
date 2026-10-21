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

// Watches where the user types, for the one thing a sync that starts by
// itself has to know of it: which file is being typed in right now. It only
// notes what it sees, per file; what follows from that is decided in
// `core/editing.ts`.
//
// It goes by the events of the page and by the app's public views, and by
// nothing of an editor's inside: any view that shows a file and can save it
// counts, a note as much as a canvas, like the views a sync asks to save
// (`editorOf` in `pull-vault.ts`).

import { type App, type Plugin, TFile, type View } from "obsidian";
import { type EditingFact, EditingLog, type ShownFile } from "../core/editing";

// - `input`: the content of an editable element changed, by a key, a paste,
//   a deletion, or an input method. One that is not part of a composition
//   also says that none is open (`EditingLog.input`).
// - `compositionstart` and `compositionupdate`: an input method has text on
//   the screen that is not confirmed. The update is listened to as well, so
//   that a composition whose start was not seen (it began before the plugin
//   was loaded) is known from its next key.
// - `compositionend`: it was confirmed or given up.
// - `focusout`: the view lost the keyboard. A composition does not outlive
//   that; where its end is not told, this is.
const EVENTS = ["input", "compositionstart", "compositionupdate", "compositionend", "focusout"] as const;

/** The inputs that are part of a composition, by what the event calls them. */
const COMPOSITION_INPUT = /composition/i;

export class EditingWatch {
	private readonly app: App;
	/** By view: the file a view shows can get another path while the view stays. */
	private readonly log = new EditingLog<View>();
	/** The documents that are listened to: the main window's, and one per window that was opened from it. */
	private readonly watched = new WeakSet<Document>();

	constructor(app: App) {
		this.app = app;
	}

	/**
	 * Begins to listen, until the plugin is unloaded. In the capture phase,
	 * on the document: an editor may stop an event before it gets back up
	 * to there.
	 */
	register(plugin: Plugin): void {
		this.watch(plugin, document);
		// A window of its own, on a desktop, has a document of its own.
		plugin.registerEvent(this.app.workspace.on("window-open", (_window, win) => this.watch(plugin, win.document)));
		// The ones that were open before the plugin was loaded.
		this.app.workspace.onLayoutReady(() => {
			this.app.workspace.iterateAllLeaves((leaf) => this.watch(plugin, leaf.view.containerEl.ownerDocument));
		});
	}

	/**
	 * What was seen of the files that views show now, each under the path
	 * it has at this moment (`EditingLog.facts`). Read when a sync asks,
	 * right before it touches a file.
	 */
	facts(): EditingFact[] {
		const shown: ShownFile<View>[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => {
			const path = filePathOf(leaf.view);
			if (path !== null) shown.push({ view: leaf.view, path });
		});
		return this.log.facts(shown);
	}

	private watch(plugin: Plugin, doc: Document): void {
		if (this.watched.has(doc)) return;
		this.watched.add(doc);
		for (const type of EVENTS) {
			plugin.registerDomEvent(doc, type, (event) => this.saw(type, event), { capture: true });
		}
	}

	private saw(type: (typeof EVENTS)[number], event: Event): void {
		const view = this.viewAt(event.target);
		if (view === null) return;
		const now = Date.now();
		if (type === "input") this.log.input(view, now, composingOf(event));
		else if (type === "compositionstart" || type === "compositionupdate") this.log.composing(view, now);
		else this.log.compositionEnded(view, now);
	}

	/**
	 * The view the event came from, when it is one that shows a file and
	 * can save it; `null` when it came from anything else: a dialog, the
	 * search, a setting.
	 *
	 * Only the file the view of a leaf shows is known this way. A note
	 * that is embedded in a canvas counts as the canvas, and an editor that
	 * is in no leaf at all (the hover editor of another plugin) as nothing:
	 * typing there does not hold a sync back.
	 */
	private viewAt(target: EventTarget | null): View | null {
		// Not `instanceof Node`: an element of another window is no `Node`
		// of this one.
		if (target === null || typeof (target as { nodeType?: unknown }).nodeType !== "number") return null;
		let found: View | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (found !== null || !leaf.view.containerEl.contains(target as Node)) return;
			if (filePathOf(leaf.view) !== null) found = leaf.view;
		});
		return found;
	}
}

/**
 * Whether an `input` event is part of a composition: `true` or `false`
 * where the event says, `null` for an event that says nothing of it (one
 * that is no `InputEvent`).
 */
function composingOf(event: Event): boolean | null {
	const { isComposing, inputType } = event as { isComposing?: unknown; inputType?: unknown };
	if (typeof inputType !== "string") return null;
	return isComposing === true || COMPOSITION_INPUT.test(inputType);
}

/**
 * The path of the file a view shows, when it is a view that can save what
 * is typed into it; `null` for any other view.
 */
function filePathOf(view: unknown): string | null {
	const { file, save } = view as { file?: unknown; save?: unknown };
	return file instanceof TFile && typeof save === "function" ? file.path : null;
}
