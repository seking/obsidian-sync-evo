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
import { type UntrackConfirmRequest, type UntrackQuestion, untrackQuestion } from "../core/untrack-report";
import { keyboardOn, renderQuestionPart } from "./pull-confirm";

/** How many paths of a list a phone is shown before the rest is asked for: the buttons are below the lists. */
const PHONE_LIST_START = 10;

/**
 * Asks in a dialog whether to untrack, before the download that comes first.
 * `proceed` is called with the paths to untrack, from the handler of the
 * button itself and with nothing awaited before: what it starts keeps the
 * screen on, which a phone only grants so (`SyncRunner.run`). That is why
 * this answers through a call and not, like the questions of a sync, through
 * a promise. Closing the dialog in any way but that button does not call
 * it, and nothing changes.
 *
 * `closed` is called once the dialog is gone, whichever way it was answered,
 * and after `proceed` where that is called. Answers what closes the dialog
 * as a "no", for whoever put it up and is going away itself.
 */
export function askUntrackIn(
	app: App,
	t: Translate,
	request: UntrackConfirmRequest,
	proceed: (shown: readonly string[]) => void,
	closed: () => void,
): () => void {
	const modal = new UntrackConfirmModal(app, t, untrackQuestion(t, request), proceed, closed);
	modal.open();
	return () => modal.close();
}

/** The dialog before untracking: the files, what becomes of them, and the two answers. */
class UntrackConfirmModal extends Modal {
	private readonly t: Translate;
	private readonly question: UntrackQuestion;
	private readonly proceed: (shown: readonly string[]) => void;
	private readonly closed: () => void;

	constructor(
		app: App,
		t: Translate,
		question: UntrackQuestion,
		proceed: (shown: readonly string[]) => void,
		closed: () => void,
	) {
		super(app);
		this.t = t;
		this.question = question;
		this.proceed = proceed;
		this.closed = closed;
	}

	override onOpen(): void {
		const { t, question, contentEl } = this;
		contentEl.empty();

		this.setTitle(question.title);
		for (const part of question.parts) renderQuestionPart(contentEl, t, part, PHONE_LIST_START);

		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		new ButtonComponent(buttons)
			.setButtonText(question.proceed)
			.setWarning()
			.onClick(() => {
				// Before the dialog is closed, and with nothing in between.
				this.proceed(question.shown);
				this.close();
			});
		const cancel = new ButtonComponent(buttons).setButtonText(question.cancel).onClick(() => this.close());
		keyboardOn(buttons, cancel.buttonEl);
	}

	override onClose(): void {
		this.contentEl.empty();
		this.closed();
	}
}
