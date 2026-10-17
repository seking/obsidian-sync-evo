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
// google.com/device, while Sync Evo waits for the user to allow. Closing it
// stops the wait.

import { type App, ButtonComponent, Modal } from "obsidian";
import type { DeviceCode } from "../core/gdrive/auth";
import type { Translate } from "../core/i18n";

/** What the dialog shows, and what its buttons do. */
export interface DriveCodeDialog {
	/** The code, or a failure to get one. */
	readonly code: Promise<DeviceCode>;
	/** Whether the code was copied, and the browser opened, at the press of "Connect". */
	readonly copied: boolean;
	/** Opens the page to type the code at. Called in the handler of a press. */
	openBrowser(code: DeviceCode): void;
}

export class DriveCodeModal extends Modal {
	private readonly t: Translate;
	private readonly dialog: DriveCodeDialog;
	private readonly controller = new AbortController();

	constructor(app: App, t: Translate, dialog: DriveCodeDialog) {
		super(app);
		this.t = t;
		this.dialog = dialog;
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
		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		new ButtonComponent(buttons).setButtonText(t("gdrive.code.cancel")).onClick(() => this.close());
		this.dialog.code.then(
			(code) => {
				if (this.signal.aborted) return;
				asking.remove();
				this.showCode(code, buttons);
			},
			// The caller tells of the failure, and closes the dialog.
			() => undefined,
		);
	}

	private showCode(code: DeviceCode, buttons: HTMLElement): void {
		const { contentEl, t } = this;
		contentEl.createEl("p", { cls: "sync-evo-device-code", text: code.userCode });
		contentEl.createEl("p", { text: t("gdrive.code.body", { url: code.verificationUrl }) });
		const note = contentEl.createEl("p", { cls: "setting-item-description", text: this.dialog.copied ? t("gdrive.code.copied") : "" });
		contentEl.appendChild(buttons);
		new ButtonComponent(buttons).setButtonText(t("gdrive.code.copy")).onClick(() => {
			void copyText(code.userCode).then((copied) => note.setText(copied ? t("gdrive.code.copied") : ""));
		});
		new ButtonComponent(buttons)
			.setCta()
			.setButtonText(t("gdrive.code.open"))
			.onClick(() => {
				// Copied in the same press: the user pastes it in the browser.
				void copyText(code.userCode).then((copied) => note.setText(copied ? t("gdrive.code.copied") : ""));
				this.dialog.openBrowser(code);
			});
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
