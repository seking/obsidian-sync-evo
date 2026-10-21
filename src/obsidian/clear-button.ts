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

import type { ExtraButtonComponent, Setting, TextComponent } from "obsidian";

/**
 * Puts a × beside a text field that empties it: for a field whose value is
 * pasted, or whose emptying means something. Shown while there is
 * something in the field. A press does what the field does when the user
 * empties it and leaves it: `commit`, the handler of its `change`, with
 * whatever that asks or tells. `tooltip` is also what a screen reader says.
 */
export function addClearButton(
	setting: Pick<Setting, "addExtraButton">,
	text: Pick<TextComponent, "getValue" | "setValue" | "inputEl">,
	tooltip: string,
	commit: () => void,
): void {
	setting.addExtraButton((clear: ExtraButtonComponent) => {
		const shown = (): void => {
			clear.extraSettingsEl.toggle(text.getValue() !== "");
		};
		clear
			.setIcon("x")
			.setTooltip(tooltip)
			.onClick(() => {
				text.setValue("");
				shown();
				commit();
			});
		text.inputEl.addEventListener("input", shown);
		shown();
	});
}
