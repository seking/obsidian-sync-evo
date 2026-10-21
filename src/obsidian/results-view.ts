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

import { type App, ButtonComponent, Modal, Notice } from "obsidian";
import type { Translate } from "../core/i18n";
import {
	RESULTS_KEPT,
	resultSections,
	resultsText,
	resultTitle,
	type SyncResult,
} from "../core/sync-results";
import type { ResultsStore } from "./results-store";

/**
 * Shows the results that are kept, as they are at this moment, with the
 * notices of the syncs that stay taken off the screen while it is open
 * (`hideNotices`, as for the log).
 */
export async function showResults(
	app: App,
	t: Translate,
	store: ResultsStore,
	hideNotices?: () => () => void,
): Promise<void> {
	new ResultsModal(app, t, await store.list(), hideNotices).open();
}

/**
 * The dialog with the results of the last syncs that had something to tell
 * (E-2): every file, which a notice lists the first few of. Opened from a
 * command, and not from a notice: a tap on a notice closes it. The newest
 * sync is open, the others folded.
 */
class ResultsModal extends Modal {
	private readonly t: Translate;
	private readonly results: readonly SyncResult[];
	private readonly hideNotices: (() => () => void) | undefined;
	private putBack: (() => void) | null = null;

	constructor(app: App, t: Translate, results: readonly SyncResult[], hideNotices?: () => () => void) {
		super(app);
		this.t = t;
		this.results = results;
		this.hideNotices = hideNotices;
	}

	override onOpen(): void {
		const { t, contentEl } = this;
		contentEl.empty();
		this.putBack = this.hideNotices?.() ?? null;
		this.setTitle(t("results.title"));
		contentEl.createEl("p", { text: t("results.desc", { count: RESULTS_KEPT }) });

		if (this.results.length === 0) {
			contentEl.createEl("p", { text: t("results.empty") });
			return;
		}
		this.results.forEach((result, index) => {
			const sync = contentEl.createEl("details", { cls: "sync-evo-result" });
			sync.open = index === 0;
			sync.createEl("summary", { text: resultTitle(t, result) });
			for (const line of result.summaries) sync.createEl("p", { text: line, cls: "sync-evo-result-text" });
			for (const section of resultSections(t, result)) {
				sync.createDiv({ cls: "sync-evo-subheading", text: section.heading });
				for (const text of section.texts) sync.createEl("p", { text, cls: "sync-evo-result-text" });
			}
		});

		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		new ButtonComponent(buttons).setButtonText(t("results.copy")).onClick(async () => {
			try {
				await navigator.clipboard.writeText(resultsText(t, this.results));
				new Notice(t("results.copied"));
			} catch {
				// The text can still be selected by hand.
				new Notice(t("results.copyFailed"));
			}
		});
	}

	override onClose(): void {
		this.contentEl.empty();
		this.putBack?.();
		this.putBack = null;
	}
}
