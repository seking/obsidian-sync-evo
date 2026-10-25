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

import { apiVersion, type App, ButtonComponent, Modal, Notice, Platform } from "obsidian";
import type { Translate } from "../core/i18n";
import { deviceText, logCopyText, type LogContext, LogRing } from "../core/log-ring";

// The lines of this run of the app, in memory only (`log-ring.ts`). They
// are what the console got, and no more: a line must never carry the token.
const ring = new LogRing();

/** Writes a line to the console, and keeps it to be read on the device (`showLog`). */
export const log = (message: string): void => {
	ring.add(Date.now(), message);
	console.debug(`Sync Evo: ${message}`);
};

/**
 * Shows the lines that are kept, as they are at this moment, under what
 * they were written on and with: the version of Sync Evo and the service
 * are the plugin's to say, the rest is asked of the app here. `hideNotices`
 * takes the notices of the syncs that stay off the screen while the dialog
 * is open, and answers what puts them back (`SyncRunner.hideStaying`): they
 * would lie over its top.
 */
export function showLog(
	app: App,
	t: Translate,
	plugin: Pick<LogContext, "version" | "service">,
	hideNotices?: () => () => void,
): void {
	const context: LogContext = { ...plugin, obsidianVersion: apiVersion, device: deviceText(Platform) };
	new LogModal(app, t, logCopyText(context, ring.lines()), ring.lines().length === 0, hideNotices).open();
}

/**
 * The dialog with the last lines of the log: for a phone, where the console
 * cannot be read. Oldest first, as they are copied, and scrolled to the
 * newest.
 */
class LogModal extends Modal {
	private readonly t: Translate;
	/** As it is copied (`logCopyText`). */
	private readonly text: string;
	private readonly empty: boolean;
	private readonly hideNotices: (() => () => void) | undefined;
	private putBack: (() => void) | null = null;

	constructor(app: App, t: Translate, text: string, empty: boolean, hideNotices?: () => () => void) {
		super(app);
		this.t = t;
		this.text = text;
		this.empty = empty;
		this.hideNotices = hideNotices;
	}

	override onOpen(): void {
		const { t, contentEl } = this;
		contentEl.empty();
		this.putBack = this.hideNotices?.() ?? null;
		this.setTitle(t("log.title"));
		contentEl.createEl("p", { text: t("log.desc") });

		if (this.empty) {
			contentEl.createEl("p", { text: t("log.empty") });
			return;
		}
		const { text } = this;
		// The log itself is in English, in every language. Shown as it is
		// copied, so that what goes into a report is what is seen here.
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
