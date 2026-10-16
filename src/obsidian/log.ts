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

import { type App, ButtonComponent, Modal, Notice } from "obsidian";
import type { Translate } from "../core/i18n";
import { type LogLine, LogRing, logText } from "../core/log-ring";

// The lines of this run of the app, in memory only (`log-ring.ts`). They
// are what the console got, and no more: a line must never carry the token.
const ring = new LogRing();

/** Writes a line to the console, and keeps it to be read on the device (`showLog`). */
export const log = (message: string): void => {
	ring.add(Date.now(), message);
	console.debug(`Sync Evo: ${message}`);
};

/**
 * Shows the lines that are kept, as they are at this moment. `hideNotices`
 * takes the notices of the syncs that stay off the screen while the dialog
 * is open, and answers what puts them back (`SyncRunner.hideStaying`): they
 * would lie over its top.
 */
export function showLog(app: App, t: Translate, hideNotices?: () => () => void): void {
	new LogModal(app, t, ring.lines(), hideNotices).open();
}

/**
 * The dialog with the last lines of the log: for a phone, where the console
 * cannot be read. Oldest first, as they are copied, and scrolled to the
 * newest.
 */
class LogModal extends Modal {
	private readonly t: Translate;
	private readonly lines: readonly LogLine[];
	private readonly hideNotices: (() => () => void) | undefined;
	private putBack: (() => void) | null = null;

	constructor(app: App, t: Translate, lines: readonly LogLine[], hideNotices?: () => () => void) {
		super(app);
		this.t = t;
		this.lines = lines;
		this.hideNotices = hideNotices;
	}

	override onOpen(): void {
		const { t, contentEl } = this;
		contentEl.empty();
		this.putBack = this.hideNotices?.() ?? null;
		this.setTitle(t("log.title"));
		contentEl.createEl("p", { text: t("log.desc") });

		if (this.lines.length === 0) {
			contentEl.createEl("p", { text: t("log.empty") });
			return;
		}
		const text = logText(this.lines);
		// The log itself is in English, in every language.
		const shown = contentEl.createEl("pre", { cls: "sync-evo-log", text });

		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		new ButtonComponent(buttons).setButtonText(t("log.copy")).onClick(async () => {
			try {
				await navigator.clipboard.writeText(text);
				new Notice(t("log.copied"));
			} catch {
				// The lines can still be selected by hand.
				new Notice(t("log.copyFailed"));
			}
		});

		// Once it is laid out: before that it has no height to scroll.
		window.requestAnimationFrame(() => {
			shown.scrollTop = shown.scrollHeight;
		});
	}

	override onClose(): void {
		this.contentEl.empty();
		this.putBack?.();
		this.putBack = null;
	}
}
