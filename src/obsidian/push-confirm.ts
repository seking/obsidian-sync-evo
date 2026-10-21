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

import { type App, ButtonComponent, Modal } from "obsidian";
import type { Translate } from "../core/i18n";
import type { ConfirmPush, PushAnswer, PushConfirmRequest } from "../core/push";
import { pushQuestion } from "../core/push-report";
import { closeWhenAborted, keyboardOn, type PullTarget, renderPathList } from "./pull-confirm";

/** Asks in a dialog. Closing it in any way but a button is "cancel". */
export function confirmPushIn(app: App, t: Translate, target: PullTarget, signal?: AbortSignal): ConfirmPush {
	return (request) =>
		new Promise((resolve) => {
			let unwatch = (): void => {};
			const modal = new PushConfirmModal(app, t, target, request, (answer) => {
				unwatch();
				resolve(answer);
			});
			modal.open();
			unwatch = closeWhenAborted(modal, signal);
		});
}

/**
 * The dialog a push stops with. Two questions, each yes or no: what the
 * first push from this device sends, and many files deleted on this device.
 * A request with both reasons to ask is one dialog with both.
 */
class PushConfirmModal extends Modal {
	private readonly t: Translate;
	private readonly target: PullTarget;
	private readonly request: PushConfirmRequest;
	private readonly resolve: (answer: PushAnswer) => void;
	private answer: PushAnswer = "cancel";

	constructor(
		app: App,
		t: Translate,
		target: PullTarget,
		request: PushConfirmRequest,
		resolve: (answer: PushAnswer) => void,
	) {
		super(app);
		this.t = t;
		this.target = target;
		this.request = request;
		this.resolve = resolve;
	}

	override onOpen(): void {
		const { t, contentEl } = this;
		contentEl.empty();

		const question = pushQuestion(t, this.target, this.request);
		this.setTitle(question.title);
		for (const part of question.parts) {
			contentEl.createEl("p", { text: part.text });
			if (part.paths !== undefined) renderPathList(contentEl, t, part.paths);
		}
		contentEl.createEl("p", { text: question.note });

		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		new ButtonComponent(buttons)
			.setButtonText(t("confirm.proceed"))
			.setWarning()
			.onClick(() => this.closeWith("proceed"));
		const cancel = new ButtonComponent(buttons).setButtonText(t("confirm.cancel")).onClick(() => this.closeWith("cancel"));
		keyboardOn(buttons, cancel.buttonEl);
	}

	override onClose(): void {
		this.contentEl.empty();
		this.resolve(this.answer);
	}

	private closeWith(answer: PushAnswer): void {
		this.answer = answer;
		this.close();
	}
}
