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
import { type CappedList, CONFIRM_LIST_LIMIT, capList, firstFetchQuestion } from "../core/pull-report";
import type { Connection } from "../core/settings";

/** Where a pull fetches from, as the question before a first fetch names it. `repository` is `owner/name`. */
export type PullTarget = Pick<Connection, "repository" | "branch">;

/**
 * Asks in a dialog. Closing it in any way but a button is "cancel", and so
 * is the sync being stopped while it is open (`signal`).
 */
export function confirmPullIn(app: App, t: Translate, target: PullTarget, signal?: AbortSignal): ConfirmPull {
	return (request) =>
		new Promise((resolve) => {
			let unwatch = (): void => {};
			const modal = new PullConfirmModal(app, t, target, request, (answer) => {
				unwatch();
				resolve(answer);
			});
			modal.open();
			unwatch = closeWhenAborted(modal, signal);
		});
}

/**
 * Closes a question when the sync it belongs to is stopped, which answers
 * it "cancel": closed in any way but a button is that. A sync that is
 * stopped because the connection is being changed is waited for before the
 * sync state is discarded, and must not wait in turn for the user to find
 * the dialog.
 *
 * Answers what stops the watching, to be called once the question is
 * answered: the signal is the sync's and outlives the dialog, which would
 * otherwise be held on to, and closed a second time, when the sync is
 * stopped later.
 */
export function closeWhenAborted(modal: Modal, signal: AbortSignal | undefined): () => void {
	if (signal === undefined) return () => {};
	if (signal.aborted) {
		modal.close();
		return () => {};
	}
	const close = (): void => modal.close();
	signal.addEventListener("abort", close, { once: true });
	return () => signal.removeEventListener("abort", close);
}

/**
 * The dialog a pull stops with. Three questions: a first fetch into a vault
 * whose files differ from the remote's (yes or no), many files deleted on
 * the remote (yes or no), and a rewritten history, where the files to delete
 * and to overwrite may exist nowhere else and can also be kept. A request
 * with two reasons to ask is one dialog with both, the first fetch on top.
 */
class PullConfirmModal extends Modal {
	private readonly t: Translate;
	private readonly target: PullTarget;
	private readonly request: PullConfirmRequest;
	private readonly resolve: (answer: PullAnswer) => void;
	private answer: PullAnswer = "cancel";

	constructor(
		app: App,
		t: Translate,
		target: PullTarget,
		request: PullConfirmRequest,
		resolve: (answer: PullAnswer) => void,
	) {
		super(app);
		this.t = t;
		this.target = target;
		this.request = request;
		this.resolve = resolve;
	}

	override onOpen(): void {
		const { t, contentEl } = this;
		const { losses, firstFetch } = this.request;
		contentEl.empty();

		// What "cancel" does, said last. The question about a first fetch
		// has its own when the sync state is at stake.
		let note: string | null = null;
		if (firstFetch !== null) {
			const question = firstFetchQuestion(t, this.target, firstFetch);
			this.setTitle(question.title);
			for (const part of question.parts) {
				contentEl.createEl("p", { text: part.text });
				if (part.paths !== undefined) this.list(part.paths);
			}
			note = question.note;
		}

		if (losses?.rewritten === true) {
			if (firstFetch === null) this.setTitle(t("confirm.rewritten.title"));
			contentEl.createEl("p", { text: t("confirm.rewritten.body") });
			if (losses.deletions.length > 0) {
				contentEl.createEl("p", { text: t("confirm.rewritten.deletions", { count: losses.deletions.length }) });
				this.list(pathsOf(losses.deletions));
			}
			if (losses.overwrites.length > 0) {
				contentEl.createEl("p", { text: t("confirm.rewritten.overwrites", { count: losses.overwrites.length }) });
				this.list(pathsOf(losses.overwrites));
			}
			contentEl.createEl("p", { text: t("confirm.rewritten.trashNote") });
			contentEl.createEl("p", { text: t("confirm.rewritten.keepNote") });
		} else if (losses !== null) {
			if (firstFetch === null) this.setTitle(t("confirm.delete.title"));
			contentEl.createEl("p", { text: t("confirm.delete.body", { count: losses.deletions.length }) });
			this.list(pathsOf(losses.deletions));
			note ??= t("confirm.delete.note");
		}
		if (note !== null) contentEl.createEl("p", { text: note });

		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		new ButtonComponent(buttons)
			.setButtonText(t("confirm.proceed"))
			.setWarning()
			.onClick(() => this.closeWith("proceed"));
		if (losses?.rewritten === true) {
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

	private list(paths: CappedList<string>): void {
		renderPathList(this.contentEl, this.t, paths);
	}
}

/**
 * A list of paths in a dialog: the ones that are shown, and then only how
 * many more there are. With `phoneStart`, a phone is shown that many at first,
 * and the rest of the list once the button below them is pressed: the answers
 * are below the list, a long way down past fifty paths. The button counts the
 * paths past the cap as well, so that it adds up to the number said above.
 */
export function renderPathList(
	container: HTMLElement,
	t: Translate,
	paths: CappedList<string>,
	phoneStart?: number,
): void {
	const list = container.createEl("ul");
	// Fifty paths are tall, so on a desktop the list scrolls by itself.
	// Not on a phone: there the dialog scrolls as a whole, and with two
	// lists that scrolled inside it no path was shown at all (seen on an
	// iPhone; likely the lists shrank to nothing, or were not painted, as
	// scrolling boxes inside a scrolling box). A plain list can do neither.
	if (!Platform.isPhone) {
		list.style.maxHeight = "30vh";
		list.style.overflowY = "auto";
	}
	const fill = (shown: readonly string[]): void => {
		for (const path of shown) list.createEl("li", { text: path });
	};
	const more = (): void => {
		if (paths.more > 0) list.createEl("li", { text: t("list.more", { count: paths.more }) });
	};
	if (!Platform.isPhone || phoneStart === undefined || paths.shown.length <= phoneStart) {
		fill(paths.shown);
		more();
		return;
	}
	fill(paths.shown.slice(0, phoneStart));
	const rest = paths.shown.slice(phoneStart);
	const open = container.createEl("button", { text: t("list.showRest", { count: rest.length + paths.more }) });
	open.addEventListener("click", () => {
		open.remove();
		fill(rest);
		more();
	});
}

function pathsOf(losses: readonly PullLoss[]): CappedList<string> {
	return capList(
		losses.map((loss) => loss.path),
		CONFIRM_LIST_LIMIT,
	);
}
