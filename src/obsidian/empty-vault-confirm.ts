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
import type { AskEmptyVault, EmptyVaultAnswer, EmptyVaultRequest } from "../core/push";
import { emptyVaultQuestion } from "../core/push-report";
import { closeWhenAborted, keyboardOn, type PullTarget } from "./pull-confirm";

/** Asks in a dialog. Closing it in any way but a button is "cancel". */
export function askEmptyVaultIn(app: App, t: Translate, target: PullTarget, signal?: AbortSignal): AskEmptyVault {
	return (request) =>
		new Promise((resolve) => {
			let unwatch = (): void => {};
			const modal = new EmptyVaultModal(app, t, target, request, (answer) => {
				unwatch();
				resolve(answer);
			});
			modal.open();
			unwatch = closeWhenAborted(modal, signal);
		});
}

/**
 * The dialog a push stops with when every file it has a record of is gone
 * from the vault. Not a yes or no: the vault may have lost its files, which
 * the remote can give back, or the user may have deleted them.
 */
class EmptyVaultModal extends Modal {
	private readonly t: Translate;
	private readonly target: PullTarget;
	private readonly request: EmptyVaultRequest;
	private readonly resolve: (answer: EmptyVaultAnswer) => void;
	private answer: EmptyVaultAnswer = "cancel";

	constructor(
		app: App,
		t: Translate,
		target: PullTarget,
		request: EmptyVaultRequest,
		resolve: (answer: EmptyVaultAnswer) => void,
	) {
		super(app);
		this.t = t;
		this.target = target;
		this.request = request;
		this.resolve = resolve;
	}

	override onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		const question = emptyVaultQuestion(this.t, this.target, this.request);
		this.setTitle(question.title);
		contentEl.createEl("p", { text: question.body });
		// What each button does, under the name it has on the button.
		for (const choice of question.choices) {
			const line = contentEl.createEl("p");
			line.createEl("strong", { text: choice.label });
			line.createEl("br");
			line.appendText(choice.text);
		}

		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		let safe: HTMLElement | null = null;
		for (const choice of question.choices) {
			const button = new ButtonComponent(buttons).setButtonText(choice.label).onClick(() => this.closeWith(choice.answer));
			// The one that deletes is marked as the others' "proceed" is, and
			// is neither the one that stands out nor the one the keyboard is
			// on: that is the safe answer.
			if (choice.answer === "delete") button.setWarning();
			if (choice.answer === "cancel") safe = button.buttonEl;
		}
		if (safe !== null) keyboardOn(buttons, safe);
	}

	override onClose(): void {
		this.contentEl.empty();
		this.resolve(this.answer);
	}

	private closeWith(answer: EmptyVaultAnswer): void {
		this.answer = answer;
		this.close();
	}
}
