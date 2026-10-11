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

import type { App, Plugin } from "obsidian";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { isBeingEdited } from "../src/core/editing";

// The watch is all calls of the app and of the page, so both are stood in
// for: leaves with a view each, and handlers that are called with what an
// event carries. That an editor on a device sends these events, and that
// they reach the document, is not tested here and cannot be.
vi.mock("obsidian", () => ({
	TFile: class {
		path = "";
	},
}));

const { TFile } = await import("obsidian");
const { EditingWatch } = await import("../src/obsidian/editing-watch");

const NOW = Date.UTC(2026, 9, 11, 9, 0, 0);

/** An element of a page: nothing but something a view can hold. */
interface FakeNode {
	readonly nodeType: number;
}

interface FakeDoc {
	readonly name: string;
}

function fileAt(path: string): InstanceType<typeof TFile> {
	const file = new TFile();
	file.path = path;
	return file;
}

/** A leaf with a view that shows `file`, holds `inside`, and can save unless told otherwise. */
function leaf(file: unknown, doc: FakeDoc, options: { saves?: boolean } = {}) {
	const inside: FakeNode = { nodeType: 1 };
	const view: Record<string, unknown> = {
		file,
		containerEl: { contains: (node: unknown) => node === inside, ownerDocument: doc },
	};
	if (options.saves !== false) view.save = async () => {};
	return { view, inside };
}

function setup(leaves: { view: Record<string, unknown> }[], main: FakeDoc = { name: "main" }) {
	vi.stubGlobal("document", main);
	/** The handlers that were registered, by document and event, with their options. */
	const handlers: { doc: FakeDoc; type: string; handle: (event: unknown) => void; options: unknown }[] = [];
	let windowOpened: (win: unknown, window: { document: FakeDoc }) => void = () => {};
	const app = {
		workspace: {
			iterateAllLeaves: (each: (leaf: unknown) => void) => leaves.forEach(each),
			on: (_name: string, callback: typeof windowOpened) => {
				windowOpened = callback;
				return {};
			},
			onLayoutReady: (ready: () => void) => ready(),
		},
	};
	const plugin = {
		registerEvent: () => {},
		registerDomEvent: (doc: FakeDoc, type: string, handle: (event: unknown) => void, options: unknown) => {
			handlers.push({ doc, type, handle, options });
		},
	};
	const watch = new EditingWatch(app as unknown as App);
	watch.register(plugin as unknown as Plugin);
	/** The page sends an event, as far as it is listened for there. */
	const send = (type: string, target: unknown, more: Record<string, unknown> = {}, doc: FakeDoc = main): void => {
		for (const handler of handlers) {
			if (handler.doc === doc && handler.type === type) handler.handle({ target, ...more });
		}
	};
	const typing = (path: string): boolean => isBeingEdited(watch.facts(), path, Date.now());
	return { watch, handlers, send, typing, main, openWindow: (doc: FakeDoc) => windowOpened({}, { document: doc }) };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("what is listened for", () => {
	test("input, the three events of a composition and the loss of the keyboard, on the document, in the capture phase", () => {
		const { handlers, main } = setup([]);
		expect(handlers.map((handler) => handler.type).sort()).toEqual([
			"compositionend",
			"compositionstart",
			"compositionupdate",
			"focusout",
			"input",
		]);
		expect(handlers.every((handler) => handler.doc === main)).toBe(true);
		expect(handlers.every((handler) => (handler.options as { capture?: boolean }).capture === true)).toBe(true);
	});

	test("the document of a window that is opened later, once", () => {
		const { handlers, openWindow } = setup([]);
		const popout = { name: "popout" };
		openWindow(popout);
		openWindow(popout);
		expect(handlers.filter((handler) => handler.doc === popout)).toHaveLength(5);
	});

	test("the document of a window that was open before the plugin was loaded", () => {
		const popout = { name: "popout" };
		const { handlers } = setup([leaf(fileAt("a.md"), popout)]);
		expect(handlers.filter((handler) => handler.doc === popout)).toHaveLength(5);
	});
});

describe("what is seen of the typing", () => {
	test("input in a view is typing in the file it shows, for 20 seconds", () => {
		const note = leaf(fileAt("notes/a.md"), { name: "main" });
		const { send, typing, watch } = setup([note]);
		expect(typing("notes/a.md")).toBe(false);

		send("input", note.inside, { isComposing: false, inputType: "insertText" });

		expect(watch.facts()).toEqual([{ path: "notes/a.md", lastInputAt: NOW, composing: false }]);
		expect(typing("notes/a.md")).toBe(true);
		vi.setSystemTime(NOW + 19_999);
		expect(typing("notes/a.md")).toBe(true);
		vi.setSystemTime(NOW + 20_000);
		expect(typing("notes/a.md")).toBe(false);
	});

	test("input in one view is not typing in the file of another", () => {
		const main = { name: "main" };
		const a = leaf(fileAt("a.md"), main);
		const b = leaf(fileAt("b.md"), main);
		const { send, typing } = setup([a, b], main);
		send("input", b.inside, { isComposing: false, inputType: "insertText" });
		expect(typing("a.md")).toBe(false);
		expect(typing("b.md")).toBe(true);
	});

	test("a composition counts from its start to its end, however long nothing is typed", () => {
		const note = leaf(fileAt("a.md"), { name: "main" });
		const { send, typing } = setup([note]);

		send("compositionstart", note.inside);
		vi.setSystemTime(NOW + 10 * 60_000);
		expect(typing("a.md")).toBe(true);

		send("compositionend", note.inside);
		expect(typing("a.md")).toBe(true);
		vi.setSystemTime(NOW + 10 * 60_000 + 20_000);
		expect(typing("a.md")).toBe(false);
	});

	test("the input of a composition keeps it open, by what the event says or by what it is called", () => {
		const note = leaf(fileAt("a.md"), { name: "main" });
		const { send, watch } = setup([note]);
		send("compositionupdate", note.inside);
		send("input", note.inside, { isComposing: true, inputType: "insertCompositionText" });
		expect(watch.facts()[0]?.composing).toBe(true);
		// A page that does not say that it is composing, and names the input as one.
		send("input", note.inside, { isComposing: false, inputType: "insertCompositionText" });
		expect(watch.facts()[0]?.composing).toBe(true);
	});

	test("an input that is no part of a composition closes one whose end never came", () => {
		const note = leaf(fileAt("a.md"), { name: "main" });
		const { send, typing } = setup([note]);
		send("compositionstart", note.inside);
		// The app went to the background, and no end was sent.
		vi.setSystemTime(NOW + 60 * 60_000);
		expect(typing("a.md")).toBe(true);

		send("input", note.inside, { isComposing: false, inputType: "insertText" });
		vi.setSystemTime(NOW + 60 * 60_000 + 20_000);

		expect(typing("a.md")).toBe(false);
	});

	test("an input event that says nothing of compositions leaves one open", () => {
		const note = leaf(fileAt("a.md"), { name: "main" });
		const { send, watch } = setup([note]);
		send("compositionstart", note.inside);
		send("input", note.inside);
		expect(watch.facts()[0]?.composing).toBe(true);
	});

	test("the view losing the keyboard ends a composition, and is no typing by itself", () => {
		const main = { name: "main" };
		const a = leaf(fileAt("a.md"), main);
		const b = leaf(fileAt("b.md"), main);
		const { send, typing, watch } = setup([a, b], main);
		send("compositionstart", a.inside);
		send("focusout", a.inside);
		send("focusout", b.inside);
		expect(watch.facts()).toEqual([{ path: "a.md", lastInputAt: NOW, composing: false }]);
		vi.setSystemTime(NOW + 20_000);
		expect(typing("a.md")).toBe(false);
	});

	test("a file that is renamed under its view is still being typed in, under its new path", () => {
		const file = fileAt("notes/a.md");
		const note = leaf(file, { name: "main" });
		const { send, typing } = setup([note]);
		send("compositionstart", note.inside);

		// A pull renamed the folder, and the app gave the file its new path.
		file.path = "Notes/a.md";

		expect(typing("Notes/a.md")).toBe(true);
		file.path = "b.md";
		expect(typing("b.md")).toBe(true);
	});

	test("a view that is closed is forgotten; the same file in a new view was not typed in", () => {
		const main = { name: "main" };
		const note = leaf(fileAt("a.md"), main);
		const leaves = [note];
		const { send, typing } = setup(leaves, main);
		send("compositionstart", note.inside);
		expect(typing("a.md")).toBe(true);

		leaves.length = 0;
		expect(typing("a.md")).toBe(false);
		leaves.push(leaf(fileAt("a.md"), main));
		expect(typing("a.md")).toBe(false);
	});

	test("events of a window of its own are seen like those of the main one", () => {
		const popout = { name: "popout" };
		const note = leaf(fileAt("a.md"), popout);
		const leaves: { view: Record<string, unknown> }[] = [];
		const { send, typing, openWindow } = setup(leaves);
		openWindow(popout);
		leaves.push(note);

		send("input", note.inside, { isComposing: false, inputType: "insertText" }, popout);

		expect(typing("a.md")).toBe(true);
	});
});

describe("what is not typing in a file", () => {
	test("input outside every view: a dialog, the search, a setting", () => {
		const note = leaf(fileAt("a.md"), { name: "main" });
		const { send, watch } = setup([note]);
		send("input", { nodeType: 1 }, { isComposing: false, inputType: "insertText" });
		send("compositionstart", { nodeType: 1 });
		send("input", null);
		send("input", { notANode: true });
		expect(watch.facts()).toEqual([]);
	});

	test("input in a view that shows no file, or cannot save", () => {
		const main = { name: "main" };
		const search = leaf(undefined, main);
		const reader = leaf(fileAt("a.pdf"), main, { saves: false });
		const notAFile = leaf({ path: "a.md" }, main);
		const { send, watch } = setup([search, reader, notAFile], main);
		for (const view of [search, reader, notAFile]) {
			send("input", view.inside, { isComposing: false, inputType: "insertText" });
			send("compositionstart", view.inside);
		}
		expect(watch.facts()).toEqual([]);
	});
});
