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

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { NO_DEVICE_EXCLUSION } from "../src/core/device-exclusion";
import { translatorFor } from "../src/core/i18n";
import type { PullDeps, PullResult } from "../src/core/pull";
import type { EmptyVaultAnswer, EmptyVaultRequest, PushDeps, PushRunResult } from "../src/core/push";
import { DEFAULT_AUTO_SYNC, type DeviceSettings } from "../src/core/settings";
import type { SyncHost } from "../src/obsidian/sync-runner";
import { MemoryStateStore } from "./support/memory-state-store";

// What the runner does with the question about a vault without its files
// (`askEmptyVault`): who is asked, and what follows the answer. The pull and
// the push are stood in for; when the question is asked, and what each
// answer sends, is tested in the core (`push.test.ts`).
const app = vi.hoisted(() => ({
	notices: [] as string[],
	/** The notices that stay as they come and go, and the dialog as it opens, in order. */
	events: [] as string[],
	/** What the pull answers on top of nothing to do. */
	pulled: {} as Record<string, unknown>,
	/** Every sync that ran, by what it was: a pull, a first fetch, a push. */
	ran: [] as string[],
	/** Every time the dialog was opened. */
	dialogs: [] as unknown[],
	answer: "cancel" as string,
	/** What the push was answered, by the dialog or without one. */
	answered: [] as string[],
	/** Whether the screen was asked to stay on when each sync began. */
	lit: [] as boolean[],
	held: false,
	/** Run by the push once it has its answer, before it ends. */
	beforeEnd: null as (() => void) | null,
}));

vi.mock("obsidian", () => {
	class Notice {
		private readonly stays: boolean;
		constructor(
			private readonly text: string,
			duration?: number,
		) {
			app.notices.push(text);
			this.stays = duration === 0;
			if (this.stays) app.events.push(`shown: ${text}`);
		}
		setMessage(): void {}
		hide(): void {
			if (this.stays) app.events.push(`hidden: ${this.text}`);
		}
	}
	class Empty {}
	return {
		Notice,
		Modal: Empty,
		ButtonComponent: Empty,
		TFile: Empty,
		TFolder: Empty,
		Platform: { isAndroidApp: false },
		requestUrl: () => Promise.reject(new Error("offline")),
	};
});

vi.mock("../src/obsidian/empty-vault-confirm", () => ({
	askEmptyVaultIn: () => async (request: EmptyVaultRequest) => {
		app.dialogs.push(request);
		app.events.push("dialog");
		return app.answer as EmptyVaultAnswer;
	},
}));

const pulled: PullResult = {
	outcome: "completed",
	revision: "a".repeat(40),
	remoteEmpty: false,
	rewritten: false,
	counts: { fetched: 0, deleted: 0, renamed: 0, conflicts: 0 },
	conflicts: [],
	merged: [],
	replacedSettings: [],
	trashed: [],
	halfWritten: [],
	halfMerged: [],
	halfCopies: [],
	deferred: [],
	unwritable: [],
	keptLocal: [],
	tidiedCopies: [],
	newSymlinks: [],
	notices: [],
	closedViews: false,
	refetched: 0,
};

const unsent: PushRunResult = {
	outcome: "declined",
	revision: null,
	counts: { added: 0, modified: 0, deleted: 0 },
	recovered: null,
	refused: [],
	heldRenames: [],
	held: [],
	leftOut: [],
	notices: [],
	storedOtherwise: [],
};

vi.mock("../src/core/pull", async (original) => ({
	...(await original<typeof import("../src/core/pull")>()),
	runPull: async (deps: PullDeps): Promise<PullResult> => {
		app.ran.push(deps.discardState === undefined ? "pull" : "first fetch");
		app.lit.push(app.held);
		return { ...pulled, ...app.pulled } as PullResult;
	},
}));

// A push that finds every file with a record gone, and ends as the core's does on each answer.
vi.mock("../src/core/push", async (original) => ({
	...(await original<typeof import("../src/core/push")>()),
	runPush: async (deps: PushDeps): Promise<PushRunResult> => {
		app.ran.push("push");
		app.lit.push(app.held);
		const answer = await deps.askEmptyVault({ missing: 2, deletions: 2 });
		app.answered.push(answer);
		app.beforeEnd?.();
		if (answer === "later") return { ...unsent, outcome: "waiting", waitingFor: "empty-vault" };
		if (answer === "refetch") return { ...unsent, refetch: true };
		if (answer === "delete") return { ...unsent, outcome: "pushed", revision: "b".repeat(40), counts: { added: 0, modified: 0, deleted: 2 } };
		return unsent;
	},
}));

const { SyncRunner } = await import("../src/obsidian/sync-runner");

function setup() {
	const store = new MemoryStateStore();
	const settings: DeviceSettings = {
		backend: "github",
		repository: "octo/notes",
		branch: "main",
		tokenSecret: "github-token",
		deviceName: "iPhone",
		autoSync: { ...DEFAULT_AUTO_SYNC, onStartup: true, atInterval: true, sendsChanges: true },
		onConflict: "copy",
		deviceExclusion: NO_DEVICE_EXCLUSION,
		exclusionChangeTold: true,
	};
	const host = {
		app: {
			vault: { configDir: ".obsidian", adapter: {}, getFiles: () => [], getAbstractFileByPath: () => null },
			workspace: { iterateAllLeaves: () => {}, getLeavesOfType: () => [] },
			fileManager: {},
		},
		manifest: { id: "sync-evo", dir: ".obsidian/plugins/sync-evo" },
		t: translatorFor("en"),
		deviceSettings: settings,
		syncState: { open: async () => ({ status: "ok", store }), close: () => {} },
		readToken: () => "github_pat_SECRET",
		editing: { facts: () => [] },
	};
	return new SyncRunner(host as unknown as SyncHost);
}

beforeEach(() => {
	app.notices.length = 0;
	app.events.length = 0;
	app.pulled = {};
	app.ran.length = 0;
	app.dialogs.length = 0;
	app.answered.length = 0;
	app.lit.length = 0;
	app.held = false;
	app.beforeEnd = null;
	app.answer = "cancel";
	vi.stubGlobal("window", { setTimeout, clearTimeout });
	vi.stubGlobal("document", { visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} });
	// Granted and let go of at once, so that what is held can be read as it is asked for.
	vi.stubGlobal("navigator", {
		wakeLock: {
			request: () => {
				app.held = true;
				const sentinel = {
					release: () => {
						app.held = false;
						return Promise.resolve();
					},
				};
				return { then: (granted: (lock: typeof sentinel) => void) => granted(sentinel) };
			},
		},
	});
	vi.spyOn(console, "info").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("a push that finds none of the files it has a record of", () => {
	test("fetch again: the first fetch that discards the sync state follows, with the screen kept on, and no word of a push that was cancelled", async () => {
		const runner = setup();
		app.answer = "refetch";

		await runner.run("push");

		expect(app.ran).toEqual(["push", "first fetch"]);
		expect(app.lit).toEqual([true, true]);
		expect(app.held).toBe(false);
		expect(app.notices).not.toContain("The upload was cancelled. Nothing was uploaded.");
		expect(runner.running).toBe(false);
	});

	test("fetch again, in a sync: after the pull and the push that sent nothing", async () => {
		const runner = setup();
		app.answer = "refetch";

		await runner.run("sync");

		expect(app.ran).toEqual(["pull", "push", "first fetch"]);
	});

	test("fetch again, but the sync was stopped before the push ended: no first fetch follows", async () => {
		const runner = setup();
		app.answer = "refetch";
		app.beforeEnd = () => runner.requestStop();

		await runner.run("push");

		expect(app.ran).toEqual(["push"]);
		expect(app.answered).toEqual(["refetch"]);
		expect(app.held).toBe(false);
		expect(runner.running).toBe(false);
	});

	test("the notices that stay are taken away while the question is open, and put back after", async () => {
		const runner = setup();
		// What the pull right before tells with a notice that stays.
		app.pulled = { replacedSettings: [".obsidian/core-plugins.json"] };
		app.answer = "cancel";

		await runner.run("sync");

		const staying = app.events.find((event) => event.startsWith("shown: ") && event.includes("core-plugins.json"));
		expect(staying).toBeDefined();
		const text = (staying as string).slice("shown: ".length);
		const about = app.events.filter((event) => event === "dialog" || event.endsWith(text));
		expect(about).toEqual([`shown: ${text}`, `hidden: ${text}`, "dialog", `shown: ${text}`]);
	});

	test("cancel: told as any push the user said no to, and nothing follows", async () => {
		const runner = setup();

		await runner.run("push");

		expect(app.ran).toEqual(["push"]);
		expect(app.dialogs).toEqual([{ missing: 2, deletions: 2 }]);
		expect(app.notices).toContain("The upload was cancelled. Nothing was uploaded.");
		expect(app.held).toBe(false);
	});

	test("delete on the remote too: the push goes on, and nothing follows it", async () => {
		const runner = setup();
		app.answer = "delete";

		await runner.run("push");

		expect(app.ran).toEqual(["push"]);
		expect(app.answered).toEqual(["delete"]);
	});

	test("in a sync that started by itself, no dialog is opened: the answer is that it waits, told once", async () => {
		const runner = setup();
		app.answer = "refetch";

		await runner.runAuto("full");
		await runner.runAuto("full");

		expect(app.dialogs).toEqual([]);
		expect(app.answered).toEqual(["later", "later"]);
		expect(app.ran).toEqual(["pull", "push", "pull", "push"]);
		expect(app.notices).toEqual([
			"Automatic sync:\nNone of the files synced before is on this device, which needs your confirmation. Nothing was uploaded. Sync manually to be asked.",
		]);
	});
});
