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

import { type App, ButtonComponent, Modal } from "obsidian";
import type { Translate } from "../core/i18n";
import type { ConfirmPush, PushAnswer, PushConfirmRequest } from "../core/push";
import { pushQuestion } from "../core/push-report";
import { closeWhenAborted, type PullTarget, renderPathList } from "./pull-confirm";

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
 * The dialog a push stops with. Three questions, each yes or no: what the
 * first push from this device sends, many files deleted on this device, and
 * large files to send. A request with more than one reason to ask is one
 * dialog with all of them.
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
			.setButtonText(question.buttons?.proceed ?? t("confirm.proceed"))
			.setWarning()
			.onClick(() => this.closeWith("proceed"));
		// The safe answer is the one the keyboard is on.
		const cancel = new ButtonComponent(buttons)
			.setButtonText(question.buttons?.cancel ?? t("confirm.cancel"))
			.onClick(() => this.closeWith("cancel"));
		cancel.buttonEl.focus();
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
