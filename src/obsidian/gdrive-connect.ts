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

// The dialog of the connection to Google Drive (R-1): the code to type at
// google.com/device, shown before the browser opens, while Sync Evo waits for
// the user to allow. The browser opens from its button only. Closing it stops
// the wait.

import { type App, ButtonComponent, Modal } from "obsidian";
import type { DeviceCode } from "../core/gdrive/auth";
import type { Translate } from "../core/i18n";

/** What the dialog shows, and what its buttons do. */
export interface DriveCodeDialog {
	/** The code, or a failure to get one. */
	readonly code: Promise<DeviceCode>;
	/**
	 * The copy of the code made at the press of "Connect", when the code was
	 * there by then; null when it was not, and the dialog copies it once it is.
	 */
	readonly copied: Promise<boolean> | null;
	/** Puts the text on the clipboard. False when the platform would not. Never rejects. */
	copy(text: string): Promise<boolean>;
	/** Opens the page. Called in the handler of a press, with nothing awaited before. */
	open(url: string): void;
}

/**
 * What the button "Open the browser" does, apart from the screen. The press
 * opens the browser in its handler, before anything is awaited: iOS opens it
 * only right after a tap.
 */
export class DriveCodeSteps {
	private shown: DeviceCode | null = null;

	constructor(private readonly dialog: Pick<DriveCodeDialog, "copy" | "open">) {}

	/** The code to show, once it is there. Nothing can be opened before. */
	get code(): DeviceCode | null {
		return this.shown;
	}

	/**
	 * Takes the code that came, and copies it unless it was copied already.
	 * A copy that failed at the press of "Connect" is tried again; outside a
	 * press, it may fail again, and the button copies it then.
	 */
	async received(code: DeviceCode, copied: Promise<boolean> | null): Promise<boolean> {
		this.shown = code;
		if (copied !== null && (await copied)) return true;
		return this.dialog.copy(code.userCode);
	}

	/**
	 * Copies the code again and opens the page, both in the press. Null
	 * without a code yet, and nothing is opened.
	 */
	press(): Promise<boolean> | null {
		const code = this.shown;
		if (code === null) return null;
		const copied = this.dialog.copy(code.userCode);
		this.dialog.open(code.verificationUrl);
		return copied;
	}
}

export class DriveCodeModal extends Modal {
	private readonly t: Translate;
	private readonly dialog: DriveCodeDialog;
	private readonly steps: DriveCodeSteps;
	private readonly controller = new AbortController();

	constructor(app: App, t: Translate, dialog: DriveCodeDialog) {
		super(app);
		this.t = t;
		this.dialog = dialog;
		this.steps = new DriveCodeSteps(dialog);
	}

	/** Aborted once the dialog is closed, however: the wait for the user ends with it. */
	get signal(): AbortSignal {
		return this.controller.signal;
	}

	override onOpen(): void {
		const { contentEl, t } = this;
		contentEl.empty();
		this.setTitle(t("gdrive.code.title"));
		const asking = contentEl.createEl("p", { text: t("gdrive.code.asking") });
		const codeEl = contentEl.createEl("p", { cls: "sync-evo-device-code" });
		const body = contentEl.createEl("p");
		const note = contentEl.createEl("p", { cls: "setting-item-description" });
		const showCopied = (copied: Promise<boolean>): void => {
			void copied.then((done) => {
				if (done && !this.signal.aborted) note.setText(t("gdrive.code.copied"));
			});
		};
		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		new ButtonComponent(buttons).setButtonText(t("gdrive.code.cancel")).onClick(() => this.close());
		// Pressable once the code is there: the dialog may still be asking for it.
		const open = new ButtonComponent(buttons)
			.setCta()
			.setButtonText(t("gdrive.code.open"))
			.setDisabled(true)
			.onClick(() => {
				const copied = this.steps.press();
				if (copied !== null) showCopied(copied);
			});
		this.dialog.code.then(
			(code) => {
				if (this.signal.aborted) return;
				asking.remove();
				codeEl.setText(code.userCode);
				body.setText(t("gdrive.code.body", { url: code.verificationUrl }));
				showCopied(this.steps.received(code, this.dialog.copied));
				open.setDisabled(false);
			},
			// The caller tells of the failure, and closes the dialog.
			() => undefined,
		);
	}

	override onClose(): void {
		this.controller.abort();
		this.contentEl.empty();
	}
}

/** Puts the text on the clipboard. False when the platform would not. Never rejects. */
export async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}
