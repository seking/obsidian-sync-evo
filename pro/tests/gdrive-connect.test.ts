/*
 * Sync Evo
 * Copyright (C) 2026 seking
 *
 * This file is part of the paid part of Sync Evo (the folder pro/), which is
 * licensed under the Elastic License 2.0, not the AGPL. You may not move,
 * change, disable, or circumvent the license key functionality in it. See
 * pro/LICENSE for the full text.
 *
 * Source: https://github.com/seking/obsidian-sync-evo
 */

import { describe, expect, test, vi } from "vitest";
import type { DeviceCode } from "../src/core/gdrive/auth";

/** An element of the dialog: its text, and whether it was taken off. */
class FakeEl {
	text = "";
	removed = false;
	readonly children: FakeEl[] = [];
	constructor(readonly cls = "") {}
	empty(): void {
		this.children.length = 0;
	}
	createEl(_tag: string, options?: { cls?: string; text?: string }): FakeEl {
		const child = new FakeEl(options?.cls ?? "");
		child.text = options?.text ?? "";
		this.children.push(child);
		return child;
	}
	createDiv(options?: { cls?: string }): FakeEl {
		return this.createEl("div", options);
	}
	setText(text: string): void {
		this.text = text;
	}
	remove(): void {
		this.removed = true;
	}
}

/** The buttons made, with what was done to them. */
const buttons: FakeButton[] = [];

class FakeButton {
	label = "";
	disabled = false;
	handler: (() => void) | null = null;
	constructor(_el: FakeEl) {
		buttons.push(this);
	}
	setButtonText(text: string): this {
		this.label = text;
		return this;
	}
	setCta(): this {
		return this;
	}
	setDisabled(disabled: boolean): this {
		this.disabled = disabled;
		return this;
	}
	onClick(handler: () => void): this {
		this.handler = handler;
		return this;
	}
}

vi.mock("obsidian", () => ({
	ButtonComponent: FakeButton,
	Modal: class {
		contentEl = new FakeEl();
		setTitle(): void {}
		close(): void {
			(this as unknown as { onClose(): void }).onClose();
		}
	},
}));

const { DriveCodeModal, DriveCodeSteps } = await import("../src/obsidian/gdrive-connect");

const CODE: DeviceCode = {
	deviceCode: "device",
	userCode: "ABCD-EFGH",
	verificationUrl: "https://www.google.com/device",
	expiresAt: Date.UTC(2026, 9, 17, 10, 0, 0),
	intervalMs: 5000,
};

/** The copies and the pages opened, in the order they were made. */
function recorder(): { calls: string[]; copy(text: string): Promise<boolean>; open(url: string): void } {
	const calls: string[] = [];
	return {
		calls,
		copy: (text) => {
			calls.push(`copy ${text}`);
			return Promise.resolve(true);
		},
		open: (url) => {
			calls.push(`open ${url}`);
		},
	};
}

describe("the steps of the dialog of Google Drive (R-1)", () => {
	test("nothing opens before the code is there", () => {
		const ports = recorder();
		const steps = new DriveCodeSteps(ports);
		expect(steps.press()).toBeNull();
		expect(steps.code).toBeNull();
		expect(ports.calls).toEqual([]);
	});

	test("a code that came to the dialog is copied, and the browser does not open", async () => {
		const ports = recorder();
		const steps = new DriveCodeSteps(ports);
		await expect(steps.received(CODE, null)).resolves.toBe(true);
		expect(steps.code).toBe(CODE);
		expect(ports.calls).toEqual(["copy ABCD-EFGH"]);
	});

	test("a code copied at the press of Connect is not copied again on its arrival", async () => {
		const ports = recorder();
		const steps = new DriveCodeSteps(ports);
		await expect(steps.received(CODE, Promise.resolve(true))).resolves.toBe(true);
		expect(ports.calls).toEqual([]);
	});

	test("a copy that failed at the press of Connect is tried again on the arrival", async () => {
		const ports = recorder();
		const steps = new DriveCodeSteps(ports);
		await expect(steps.received(CODE, Promise.resolve(false))).resolves.toBe(true);
		expect(ports.calls).toEqual(["copy ABCD-EFGH"]);
	});

	test("the press copies again and opens the page in the handler, with nothing awaited", () => {
		const ports = recorder();
		const steps = new DriveCodeSteps(ports);
		void steps.received(CODE, Promise.resolve(true));
		const copied = steps.press();
		// Already opened when press() returns: iOS opens a page only right after a tap.
		expect(ports.calls).toEqual(["copy ABCD-EFGH", "open https://www.google.com/device"]);
		expect(copied).not.toBeNull();
	});
});

describe("the dialog of Google Drive (R-1)", () => {
	/** A dialog whose code comes when `arrive` is called. */
	function dialogOf(copied: Promise<boolean> | null) {
		buttons.length = 0;
		const ports = recorder();
		let arrive: (code: DeviceCode) => void = () => undefined;
		const code = new Promise<DeviceCode>((resolve) => {
			arrive = resolve;
		});
		const t = ((key: string) => key) as unknown as ConstructorParameters<typeof DriveCodeModal>[1];
		const modal = new DriveCodeModal({} as never, t, { code, copied, copy: ports.copy, open: ports.open });
		modal.onOpen();
		const content = (modal as unknown as { contentEl: FakeEl }).contentEl;
		const open = buttons.find((button) => button.label === "gdrive.code.open");
		const note = content.children.find((el) => el.cls === "setting-item-description");
		if (open === undefined || note === undefined) throw new Error("the dialog has no button to open, or no note");
		return { ports, modal, arrive, open, note, content };
	}

	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

	test("the button to open is off until the code is there, and the arrival opens nothing", async () => {
		const { ports, arrive, open, note, content } = dialogOf(null);
		expect(open.disabled).toBe(true);
		arrive(CODE);
		await settle();
		expect(open.disabled).toBe(false);
		expect(content.children.find((el) => el.cls === "sync-evo-device-code")?.text).toBe("ABCD-EFGH");
		expect(note.text).toBe("gdrive.code.copied");
		expect(ports.calls).toEqual(["copy ABCD-EFGH"]);
		open.handler?.();
		expect(ports.calls).toEqual(["copy ABCD-EFGH", "copy ABCD-EFGH", "open https://www.google.com/device"]);
	});

	test("once closed, the note does not change", async () => {
		const { modal, arrive, open, note } = dialogOf(Promise.resolve(true));
		modal.close();
		arrive(CODE);
		await settle();
		expect(note.text).toBe("");
		expect(open.disabled).toBe(true);
	});
});
