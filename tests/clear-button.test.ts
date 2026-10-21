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

import { describe, expect, test } from "vitest";
import type { ExtraButtonComponent, Setting, TextComponent } from "obsidian";
import { addClearButton } from "../src/obsidian/clear-button";

/** A row with a text field, as far as the button touches them. */
function field(value: string) {
	const listeners: (() => void)[] = [];
	const state = { value, shown: null as boolean | null, tooltip: "", icon: "", press: () => {} };
	const text = {
		getValue: () => state.value,
		setValue: (next: string) => {
			state.value = next;
			return text;
		},
		inputEl: { addEventListener: (_name: string, listener: () => void) => listeners.push(listener) },
	};
	const button = {
		extraSettingsEl: { toggle: (shown: boolean) => (state.shown = shown) },
		setIcon: (icon: string) => ((state.icon = icon), button),
		setTooltip: (tooltip: string) => ((state.tooltip = tooltip), button),
		onClick: (press: () => void) => ((state.press = press), button),
	};
	const setting = { addExtraButton: (make: (made: ExtraButtonComponent) => void) => make(button as unknown as ExtraButtonComponent) };
	/** The user types: the field's `input` event. */
	const type = (next: string): void => {
		state.value = next;
		for (const listener of listeners) listener();
	};
	return { state, type, setting: setting as unknown as Setting, text: text as unknown as TextComponent };
}

describe("the × beside a text field", () => {
	test("is shown only while the field holds something, as it is typed in", () => {
		const { state, type, setting, text } = field("");
		addClearButton(setting, text, "Clear the repository", () => {});
		expect(state).toMatchObject({ shown: false, icon: "x", tooltip: "Clear the repository" });
		type("octo/notes");
		expect(state.shown).toBe(true);
		type("");
		expect(state.shown).toBe(false);
	});

	test("empties the field, goes away, and runs what leaving an emptied field runs, with the field empty", () => {
		const { state, setting, text } = field("lic_KEY");
		const committed: string[] = [];
		addClearButton(setting, text, "Remove the key", () => committed.push(text.getValue()));
		expect(state.shown).toBe(true);
		state.press();
		expect(state.value).toBe("");
		expect(state.shown).toBe(false);
		expect(committed).toEqual([""]);
	});
});
