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

import { type App, ButtonComponent, Modal, Platform } from "obsidian";
import type { Translate } from "../core/i18n";
import type { ConfirmPull, PullAnswer, PullConfirmRequest } from "../core/pull-io";
import type { PullLoss } from "../core/pull-plan";
import { CONFIRM_LIST_LIMIT, capList } from "../core/pull-report";

/** Asks in a dialog. Closing it in any way but a button is "cancel". */
export function confirmPullIn(app: App, t: Translate): ConfirmPull {
	return (request) =>
		new Promise((resolve) => {
			new PullConfirmModal(app, t, request, resolve).open();
		});
}

/**
 * The dialog a pull stops with before it takes files away. Two forms: many
 * files deleted on the remote (yes or no), and a rewritten history, where
 * the files to delete and to overwrite may exist nowhere else and can also
 * be kept.
 */
class PullConfirmModal extends Modal {
	private readonly t: Translate;
	private readonly request: PullConfirmRequest;
	private readonly resolve: (answer: PullAnswer) => void;
	private answer: PullAnswer = "cancel";

	constructor(app: App, t: Translate, request: PullConfirmRequest, resolve: (answer: PullAnswer) => void) {
		super(app);
		this.t = t;
		this.request = request;
		this.resolve = resolve;
	}

	override onOpen(): void {
		const { t, contentEl } = this;
		const { losses } = this.request;
		contentEl.empty();

		if (losses.rewritten) {
			this.setTitle(t("confirm.rewritten.title"));
			contentEl.createEl("p", { text: t("confirm.rewritten.body") });
			if (losses.deletions.length > 0) {
				contentEl.createEl("p", { text: t("confirm.rewritten.deletions", { count: losses.deletions.length }) });
				this.list(losses.deletions);
			}
			if (losses.overwrites.length > 0) {
				contentEl.createEl("p", { text: t("confirm.rewritten.overwrites", { count: losses.overwrites.length }) });
				this.list(losses.overwrites);
			}
			contentEl.createEl("p", { text: t("confirm.rewritten.trashNote") });
			contentEl.createEl("p", { text: t("confirm.rewritten.keepNote") });
		} else {
			this.setTitle(t("confirm.delete.title"));
			contentEl.createEl("p", { text: t("confirm.delete.body", { count: losses.deletions.length }) });
			this.list(losses.deletions);
			contentEl.createEl("p", { text: t("confirm.delete.note") });
		}

		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		new ButtonComponent(buttons)
			.setButtonText(t("confirm.proceed"))
			.setWarning()
			.onClick(() => this.closeWith("proceed"));
		if (losses.rewritten) {
			new ButtonComponent(buttons).setButtonText(t("confirm.keepLocal")).onClick(() => this.closeWith("keep-local"));
		}
		// The safe answer is the one the keyboard is on.
		const cancel = new ButtonComponent(buttons).setButtonText(t("confirm.cancel")).onClick(() => this.closeWith("cancel"));
		cancel.buttonEl.focus();
	}

	override onClose(): void {
		this.contentEl.empty();
		this.resolve(this.answer);
	}

	private closeWith(answer: PullAnswer): void {
		this.answer = answer;
		this.close();
	}

	/** The paths, up to the limit, and then only how many more there are. */
	private list(losses: readonly PullLoss[]): void {
		const { shown, more } = capList(losses, CONFIRM_LIST_LIMIT);
		const list = this.contentEl.createEl("ul");
		// Fifty paths are tall, so on a desktop the list scrolls by itself.
		// Not on a phone: there the dialog scrolls as a whole, and with two
		// lists that scrolled inside it no path was shown at all (seen on an
		// iPhone; likely the lists shrank to nothing, or were not painted, as
		// scrolling boxes inside a scrolling box). A plain list can do neither.
		if (!Platform.isPhone) {
			list.style.maxHeight = "30vh";
			list.style.overflowY = "auto";
		}
		for (const loss of shown) list.createEl("li", { text: loss.path });
		if (more > 0) list.createEl("li", { text: this.t("list.more", { count: more }) });
	}
}
