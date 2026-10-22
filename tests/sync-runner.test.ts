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

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { NO_DEVICE_EXCLUSION } from "../src/core/device-exclusion";
import { AUTO_SYNC_KEY, readAutoSyncMemory } from "../src/core/auto-sync";
import { MAX_CONCURRENT_FETCH_BYTES } from "../src/core/concurrent-fetch";
import { translatorFor } from "../src/core/i18n";
import { DODO_LIVE_API } from "../pro/src/core/license";
import { dayOf } from "../pro/src/core/paid";
import { FIRST_SEEN_KEY, PaidGate, SINCE_KEY } from "../pro/src/core/paid-gate";
import { DEFAULT_AUTO_SYNC, type DeviceSettings } from "../src/core/settings";
import { ANDROID_CONCURRENT_FETCH_BYTES } from "../src/obsidian/http-transport";
import type { SyncResult } from "../src/core/sync-results";
import type { SyncHost } from "../src/obsidian/sync-runner";
import { MemoryStateStore } from "./support/memory-state-store";

// The runner is the one part of a sync that shows things, so the app's
// module is stood in for: its notices are kept, and its requests are
// answered as the test says. Only the ways a sync can end before it reaches
// the vault are run here (no network, a stop, settings that are not ready);
// what a sync does is tested where it is decided, in the core.
const app = vi.hoisted(() => ({
	/** Every notice that was put up, in order. */
	notices: [] as string[],
	/** Every notice that was taken down, in order. */
	hidden: [] as string[],
	/** Every notice that was taken down, as its place in `notices`: which one it was, of those with the same text. */
	hiddenAt: [] as number[],
	/** Every notice that was made to look as an error (`sync-evo-notice-error`), by its text, in order. */
	errors: [] as string[],
	/** Answers a request: rejects like a device without a network unless a test says otherwise. */
	request: (_params?: { url: string; body?: unknown }): Promise<unknown> => Promise.reject(new Error("net::ERR_INTERNET_DISCONNECTED")),
	requests: 0,
	/** What the app says the device is. */
	platform: { isAndroidApp: false },
	/** The options every backend was built with, in order. */
	backends: [] as { maxConcurrentFetchBytes?: number; signal?: AbortSignal }[],
	/** What every pull was given of `archiveAllowed`, in order. */
	pulls: [] as (boolean | undefined)[],
	/** What every pull was given of `mergeConflicts`, in order. */
	merges: [] as (boolean | undefined)[],
	/** What every pull was given of `device`, in order. */
	devices: [] as unknown[],
}));

vi.mock("obsidian", () => {
	class Notice {
		private readonly text: string;
		private readonly at: number;
		/** Only what the runner touches of it: the classes it is given. */
		readonly containerEl: { classList: { add(name: string): void } };
		constructor(text: string) {
			this.text = text;
			this.at = app.notices.length;
			app.notices.push(text);
			this.containerEl = {
				classList: {
					add: (name: string) => {
						if (name === "sync-evo-notice-error") app.errors.push(text);
					},
				},
			};
		}
		setMessage(): void {}
		hide(): void {
			app.hidden.push(this.text);
			app.hiddenAt.push(this.at);
		}
	}
	class Empty {}
	return {
		Notice,
		Modal: Empty,
		ButtonComponent: Empty,
		TFile: Empty,
		TFolder: Empty,
		Platform: app.platform,
		requestUrl: (params: { url: string; body?: unknown }) => {
			app.requests += 1;
			return app.request(params);
		},
	};
});

// The backend is the real one; only what it was built with is noted.
vi.mock("../src/core/github/backend", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/core/github/backend")>();
	class GitHubBackend extends original.GitHubBackend {
		constructor(...given: ConstructorParameters<typeof original.GitHubBackend>) {
			super(...given);
			app.backends.push(given[1] ?? {});
		}
	}
	return { ...original, GitHubBackend };
});

// The pull is the real one as well; only what it was told of the archive is noted.
vi.mock("../src/core/pull", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/core/pull")>();
	const runPull: typeof original.runPull = (deps) => {
		app.pulls.push(deps.archiveAllowed);
		app.merges.push(deps.mergeConflicts);
		app.devices.push(deps.device);
		return original.runPull(deps);
	};
	return { ...original, runPull };
});

// The tokens of Google Drive, taken in the paid part: one that Google gives.
vi.mock("../pro/src/obsidian/google-tokens", () => ({
	googleTokens: () => ({ get: async () => "access", refused: () => {} }),
}));

const { SyncRunner } = await import("../src/obsidian/sync-runner");

const HEADING = "Automatic sync:\n";
const OFFLINE = "The download failed. Could not reach GitHub. Check the network connection and try again.";

/** The screen wake lock of the page: how often it was asked for, and how many of those are still held. */
function wakeLock() {
	const lock = { requested: 0, held: 0 };
	vi.stubGlobal("navigator", {
		wakeLock: {
			request: async () => {
				lock.requested += 1;
				lock.held += 1;
				return {
					release: async () => {
						lock.held -= 1;
					},
				};
			},
		},
	});
	return lock;
}

function setup(over: Partial<DeviceSettings> = {}, files: Record<string, string> = {}) {
	const store = new MemoryStateStore();
	const state = { opens: 0, closed: 0 };
	/** How often a sync asked where the user types. */
	const editing = { asked: 0 };
	const settings: DeviceSettings = {
		backend: "github",
		repository: "octo/notes",
		branch: "main",
		tokenSecret: "github-token",
		dropboxFolder: "",
		dropboxAccount: null,
		gdriveFolder: "",
		gdriveAccount: null,
		gdriveFolderId: null,
		deviceName: "iPhone",
		autoSync: { ...DEFAULT_AUTO_SYNC, onStartup: true, atInterval: true },
		onConflict: "copy",
		deviceExclusion: NO_DEVICE_EXCLUSION,
		exclusionChangeTold: true,
		...over,
	};
	const tokens: Record<string, string | null> = { "github-token": "github_pat_SECRET" };
	/** What was kept for the screen of the results, in order. */
	const results: SyncResult[] = [];
	const host = {
		app: {
			vault: {
				configDir: ".obsidian",
				// A vault with nothing but its configuration folder, as far
				// as a sync that reaches it asks.
				adapter: {
					stat: async (path: string) => {
						if (path === ".obsidian") return { type: "folder", mtime: 0, size: 0 };
						const content = files[path];
						return content === undefined ? null : { type: "file", mtime: 1, size: content.length };
					},
					list: async (folder: string) =>
						folder === "/" ? { files: Object.keys(files), folders: [".obsidian"] } : { files: [], folders: [] },
					readBinary: async (path: string) => new TextEncoder().encode(files[path] ?? "").buffer,
					writeBinary: async () => {},
					mkdir: async () => {},
				},
				getFiles: () => [],
				getAbstractFileByPath: () => null,
			},
			workspace: { iterateAllLeaves: () => {}, getLeavesOfType: () => [] },
			fileManager: {},
		},
		manifest: { id: "sync-evo", dir: ".obsidian/plugins/sync-evo" },
		t: translatorFor("en"),
		deviceSettings: settings,
		syncState: {
			open: async () => {
				state.opens += 1;
				return { status: "ok", store };
			},
			close: () => {
				state.closed += 1;
			},
		},
		readToken: (name: string) => tokens[name] ?? null,
		editing: {
			facts: () => {
				editing.asked += 1;
				return [];
			},
		},
		results: {
			add: async (result: SyncResult) => {
				results.push(result);
			},
		},
	};
	const runner = new SyncRunner(host as unknown as SyncHost);
	return { runner, store, state, tokens, host, editing, results };
}

/** A request that does not answer until the test lets it fail: a sync that is running. */
function heldRequest(): { fail(): void } {
	let reject: (error: Error) => void = () => {};
	app.request = () =>
		new Promise<never>((_resolve, no) => {
			reject = no;
		});
	return { fail: () => reject(new Error("offline")) };
}

/** GitHub answers for a repository without commits: a sync of an empty vault with it has nothing to do. */
function emptyRemote(): void {
	const body = new TextEncoder().encode(JSON.stringify({ message: "Git Repository is empty." }));
	app.request = async () => ({ status: 409, headers: {}, arrayBuffer: body.buffer });
}

/** Lets a sync get as far as its first request. */
const underWay = async (): Promise<void> => {
	for (let turn = 0; turn < 50 && app.requests === 0; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
	app.notices.length = 0;
	app.hidden.length = 0;
	app.hiddenAt.length = 0;
	app.errors.length = 0;
	app.requests = 0;
	app.platform.isAndroidApp = false;
	app.backends.length = 0;
	app.pulls.length = 0;
	app.merges.length = 0;
	app.devices.length = 0;
	app.request = () => Promise.reject(new Error("net::ERR_INTERNET_DISCONNECTED"));
	vi.stubGlobal("window", { setTimeout, clearTimeout });
	vi.stubGlobal("document", { visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} });
	vi.spyOn(console, "debug").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("a sync that started by itself, without a network", () => {
	test("tells the failure once, under its own heading, and counts every one", async () => {
		const { runner, store } = setup();

		await runner.runAuto("full");
		await runner.runAuto("light");
		await runner.runAuto("light");

		expect(app.notices).toEqual([HEADING + OFFLINE]);
		expect(await readAutoSyncMemory(store)).toMatchObject({ failures: 3, told: "error:unreachable" });
		expect(runner.autoClock().failures).toBe(3);
		expect(runner.running).toBe(false);
	});

	test("does not ask the screen to stay on", async () => {
		const lock = wakeLock();
		const { runner } = setup();
		await runner.runAuto("full");
		expect(lock.requested).toBe(0);
	});

	test("is not told again after the app was started anew: what was told is in the sync state", async () => {
		const first = setup();
		await first.runner.runAuto("full");
		app.notices.length = 0;
		const again = new SyncRunner({ ...first.host } as unknown as SyncHost);

		await again.recallAuto();
		await again.runAuto("full");

		expect(app.notices).toEqual([]);
	});

	test("a sync the user starts tells it every time, and is not counted", async () => {
		const { runner, store } = setup();
		await runner.runAuto("full");
		app.notices.length = 0;

		await runner.run("pull");
		await runner.run("pull");

		expect(app.notices.filter((text) => text === OFFLINE)).toHaveLength(2);
		expect(await readAutoSyncMemory(store)).toMatchObject({ failures: 1, told: "error:unreachable" });
	});

	test("leaves a line in the log each time, of what failed and how the sync started", async () => {
		const { runner } = setup();
		await runner.runAuto("full");
		await runner.run("pull");

		const failed = vi
			.mocked(console.debug)
			.mock.calls.map(([message]) => String(message))
			.filter((message) => message.includes(": failed ("));
		expect(failed).toEqual([
			"Sync Evo: pull: failed (pull, automatic): BackendError unreachable: the request failed: net::ERR_INTERNET_DISCONNECTED",
			"Sync Evo: pull: failed (pull, by hand): BackendError unreachable: the request failed: net::ERR_INTERNET_DISCONNECTED",
		]);
	});

	test("ends what is still on its way, and tells the failure as it came, not as a stop", async () => {
		const { runner } = setup();
		await runner.run("pull");
		// The signal the backend was built with: the clients' too.
		expect(app.backends[0]?.signal?.aborted).toBe(true);
		expect(app.notices[app.notices.length - 1]).toBe(OFFLINE);
	});

	test("the start of every sync is what the next is counted from, also of one that fails", async () => {
		const { runner, store } = setup();
		expect(runner.autoClock().lastStartedAt).toBeNull();
		const before = Date.now();

		await runner.run("pull");

		expect(runner.autoClock().lastStartedAt).toBeGreaterThanOrEqual(before);
		expect((await readAutoSyncMemory(store)).lastStartedAt).toBe(runner.autoClock().lastStartedAt);
	});

	test("a full check that fails before it lists the vault still owes one, whoever started it", async () => {
		const { runner } = setup();
		expect(runner.autoClock().fullOwed).toBe(true);
		await runner.runAuto("full");
		expect(runner.autoClock().fullOwed).toBe(true);
		await runner.run("pull");
		expect(runner.autoClock().fullOwed).toBe(true);
	});
});

describe("the full check that is owed", () => {
	const sending = { autoSync: { ...DEFAULT_AUTO_SYNC, atInterval: true, sendsChanges: true } };

	test("is paid by a sync with a full check that lists the vault, and tells nothing when it went well", async () => {
		const { runner, store } = setup(sending);
		emptyRemote();

		await runner.runAuto("full");

		expect(runner.autoClock().fullOwed).toBe(false);
		expect(app.notices).toEqual([]);
		expect(await readAutoSyncMemory(store)).toMatchObject({ failures: 0, told: null });
	});

	test("is not paid by a light one", async () => {
		const { runner } = setup(sending);
		emptyRemote();
		await runner.runAuto("light");
		expect(runner.autoClock().fullOwed).toBe(true);
	});

	test("is owed again after every return to the front", async () => {
		const { runner } = setup(sending);
		emptyRemote();
		await runner.runAuto("full");
		runner.resumed();
		expect(runner.autoClock().fullOwed).toBe(true);
	});

	test("an automatic sync that went well forgets what a failure before it told", async () => {
		const { runner, store } = setup(sending);
		await runner.runAuto("full");
		expect(app.notices).toHaveLength(1);
		emptyRemote();
		await runner.runAuto("full");
		expect(await readAutoSyncMemory(store)).toMatchObject({ failures: 0, told: null });
		app.request = () => Promise.reject(new Error("offline"));
		await runner.runAuto("light");
		expect(app.notices).toHaveLength(2);
	});
});

describe("a sync that started by itself, with settings that are not ready", () => {
	test("with no repository there is no connection: it is told, and no sync state is opened to remember it", async () => {
		const { runner, state } = setup({ repository: "" });

		await runner.runAuto("full");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(app.notices).toHaveLength(1);
		expect(state.opens).toBe(0);
		expect(runner.autoClock().failures).toBe(1);
	});

	test("a token that is gone is told once, counted, and not tried again at once", async () => {
		const { runner, tokens, store } = setup();
		tokens["github-token"] = null;
		const before = Date.now();

		await runner.runAuto("full");
		await runner.runAuto("light");

		expect(app.notices).toHaveLength(1);
		expect(app.notices[0]?.startsWith(HEADING)).toBe(true);
		expect(app.notices[0]).toContain("github-token");
		expect(app.requests).toBe(0);
		const clock = runner.autoClock();
		expect(clock.failures).toBe(2);
		expect(clock.lastStartedAt).toBeGreaterThanOrEqual(before);
		// Stored, so that the next start of the app does not tell it again.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(await readAutoSyncMemory(store)).toMatchObject({ failures: 2, told: "not-ready:token-value" });
	});

	test("a sync the user starts says it as before, every time", async () => {
		const { runner, tokens } = setup();
		tokens["github-token"] = null;
		await runner.run("sync");
		await runner.run("sync");
		expect(app.notices).toHaveLength(2);
		expect(app.notices[0]?.startsWith(HEADING)).toBe(false);
	});

	test("once the token is back, the sync runs, and a later loss is told again", async () => {
		const { runner, tokens } = setup();
		tokens["github-token"] = null;
		await runner.runAuto("full");
		tokens["github-token"] = "github_pat_SECRET";
		await runner.runAuto("full");
		expect(app.notices).toEqual([expect.stringContaining("github-token"), HEADING + OFFLINE]);
	});
});

describe("a sync the user starts while one that started by itself runs", () => {
	test("takes its place: the screen is kept on at once, nothing says that a sync is running, and it runs", async () => {
		const lock = wakeLock();
		const { runner, store } = setup();
		heldRequest();
		const automatic = runner.runAuto("light");
		await underWay();
		expect(runner.running).toBe(true);

		const manual = runner.run("pull");
		// In the handler of the press, before anything was awaited.
		expect(lock.requested).toBe(1);
		app.request = () => Promise.reject(new Error("offline"));
		await Promise.all([automatic, manual]);

		expect(app.notices).not.toContain("A sync is already running.");
		// The pull the user started ran, and told how it went as any does.
		expect(app.requests).toBe(2);
		expect(app.notices.filter((text) => text === OFFLINE)).toHaveLength(1);
		expect(app.notices.some((text) => text.startsWith(HEADING))).toBe(false);
		// The one that was stopped is neither a success nor a failure.
		expect(await readAutoSyncMemory(store)).toMatchObject({ failures: 0, told: "error:unreachable" });
		expect(lock.requested).toBe(1);
		expect(lock.held).toBe(0);
		expect(runner.running).toBe(false);
	});

	test("a second press during the wait is told that a sync is running", async () => {
		const { runner } = setup();
		heldRequest();
		const automatic = runner.runAuto("light");
		await underWay();

		const manual = runner.run("pull");
		await runner.run("pull");
		app.request = () => Promise.reject(new Error("offline"));
		await Promise.all([automatic, manual]);

		expect(app.notices.filter((text) => text === "A sync is already running.")).toHaveLength(1);
	});

	test("does not start when the connection was changed during the wait, and lets the screen go", async () => {
		const lock = wakeLock();
		const { runner } = setup();
		heldRequest();
		const automatic = runner.runAuto("light");
		await underWay();

		const manual = runner.run("untrack", ["old.md"]);
		const interrupted = runner.interrupt();
		await Promise.all([automatic, manual, interrupted]);

		expect(app.requests).toBe(1);
		expect(app.notices).toEqual([
			"The download was stopped because the connection was changed. The next download starts with the new connection.",
		]);
		expect(lock.held).toBe(0);
		expect(runner.running).toBe(false);
	});

	test("does not start when the plugin went away during the wait, and tells nothing", async () => {
		const lock = wakeLock();
		const { runner } = setup();
		heldRequest();
		const automatic = runner.runAuto("light");
		await underWay();

		const manual = runner.run("sync");
		runner.stop();
		await Promise.all([automatic, manual]);

		expect(app.requests).toBe(1);
		expect(app.notices).toEqual([]);
		expect(lock.held).toBe(0);
	});

	test("does not start when the user says stop during the wait", async () => {
		const lock = wakeLock();
		const { runner } = setup();
		heldRequest();
		const automatic = runner.runAuto("light");
		await underWay();

		const manual = runner.run("sync");
		runner.requestStop();
		await Promise.all([automatic, manual]);

		expect(app.requests).toBe(1);
		expect(app.notices).toEqual(["The download was stopped. The next download continues from there."]);
		expect(lock.held).toBe(0);
	});

	test("two syncs the user starts do not take each other's place", async () => {
		const { runner } = setup();
		const held = heldRequest();
		const first = runner.run("pull");
		await underWay();

		await runner.run("pull");
		held.fail();
		await first;

		expect(app.notices).toContain("A sync is already running.");
		expect(app.requests).toBe(1);
	});
});

describe("where the user types", () => {
	const sending = { autoSync: { ...DEFAULT_AUTO_SYNC, atInterval: true, sendsChanges: true } };
	const files = { "a.md": "A" };

	test("is asked by a sync that started by itself, for the file it is about to look at", async () => {
		const { runner, editing } = setup(sending, files);
		emptyRemote();

		await runner.runAuto("full");

		expect(editing.asked).toBeGreaterThan(0);
		// It got as far as the question before the first push, which it leaves.
		expect(app.notices).toEqual([expect.stringContaining("The first upload from this device needs your confirmation.")]);
	});

	test.each(["sync", "pull", "push"] as const)("is not asked by a %s the user starts", async (mode) => {
		const { runner, editing } = setup(sending, files);
		emptyRemote();

		await runner.run(mode);

		expect(app.requests).toBeGreaterThan(0);
		expect(editing.asked).toBe(0);
	});

	test("nor by one the user starts in the place of an automatic one", async () => {
		const { runner, editing } = setup(sending, files);
		heldRequest();
		const automatic = runner.runAuto("full");
		await underWay();

		const manual = runner.run("push");
		emptyRemote();
		await Promise.all([automatic, manual]);

		expect(app.requests).toBeGreaterThan(1);
		expect(editing.asked).toBe(0);
	});
});

describe("what a sync that started by itself left on the screen", () => {
	const sending = { autoSync: { ...DEFAULT_AUTO_SYNC, atInterval: true, sendsChanges: true } };
	const QUESTION = "The first upload from this device needs your confirmation.";
	const automatic = (texts: string[]): string[] => texts.filter((text) => text.startsWith(HEADING));

	test("a question that waits is taken down when the user starts a sync, and stays remembered as told", async () => {
		const { runner, store } = setup(sending, { "a.md": "A" });
		emptyRemote();
		await runner.runAuto("full");
		expect(automatic(app.hidden)).toEqual([]);
		const { told } = await readAutoSyncMemory(store);
		// Held, so that the sync the user starts has not ended when it is looked at.
		const held = heldRequest();
		app.requests = 0;

		const manual = runner.run("pull");
		await underWay();

		expect(automatic(app.hidden)).toEqual([expect.stringContaining(QUESTION)]);
		expect(await readAutoSyncMemory(store)).toMatchObject({ told });
		held.fail();
		await manual;
		// Once: a later sync does not take it down again.
		app.request = () => Promise.reject(new Error("offline"));
		await runner.run("pull");
		expect(automatic(app.hidden)).toHaveLength(1);
	});

	test("a question taken away for another question and put back is still taken down by a sync the user starts", async () => {
		const { runner } = setup(sending, { "a.md": "A" });
		emptyRemote();
		await runner.runAuto("full");

		const putBack = runner.hideStaying();
		putBack();
		expect(automatic(app.hidden)).toEqual([expect.stringContaining(QUESTION)]);
		expect(automatic(app.notices).filter((text) => text.includes(QUESTION))).toHaveLength(2);
		app.request = () => Promise.reject(new Error("offline"));
		await runner.run("pull");

		// The one that was put back, and not only the one it replaced.
		const putBackAt = app.notices.findLastIndex((text) => text.startsWith(HEADING) && text.includes(QUESTION));
		expect(app.hiddenAt).toContain(putBackAt);
	});

	test("a failure is not: it stays until it is dismissed", async () => {
		const { runner } = setup();
		await runner.runAuto("full");
		expect(app.notices).toEqual([HEADING + OFFLINE]);

		await runner.run("pull");

		expect(automatic(app.hidden)).toEqual([]);
	});
});

describe("how much what a sync tells matters", () => {
	test("a failure looks apart from the other notices, whoever started the sync", async () => {
		const { runner } = setup();

		await runner.runAuto("full");
		await runner.run("pull");

		expect(app.errors).toEqual([HEADING + OFFLINE, OFFLINE]);
	});

	test("a failure taken away for a question is put back looking as it did", async () => {
		const { runner } = setup();
		await runner.run("pull");
		app.notices.length = 0;
		app.hidden.length = 0;
		app.errors.length = 0;

		const putBack = runner.hideStaying();
		expect(app.hidden).toEqual([OFFLINE]);
		putBack();

		expect(app.notices).toEqual([OFFLINE]);
		expect(app.errors).toEqual([OFFLINE]);
	});

	test("what a sync told is kept for the screen of the results, with who started it", async () => {
		const { runner, results } = setup();

		await runner.runAuto("full");
		await runner.run("pull");

		expect(results).toEqual([
			{ at: expect.any(Number), automatic: true, summaries: [], items: [{ level: "error", text: OFFLINE }] },
			{ at: expect.any(Number), automatic: false, summaries: [], items: [{ level: "error", text: OFFLINE }] },
		]);
	});

	test("a sync the user stopped, with nothing else to tell, is not kept", async () => {
		const { runner, results } = setup();
		heldRequest();
		const manual = runner.run("pull");
		await underWay();

		runner.requestStop();
		await manual;

		expect(app.notices).toContain("The download was stopped. The next download continues from there.");
		expect(results).toEqual([]);
	});

	test("a sync that told nothing but how it ended is not kept, nor one that did not tell its cause again", async () => {
		const sending = { autoSync: { ...DEFAULT_AUTO_SYNC, atInterval: true, sendsChanges: true } };
		const { runner, results } = setup(sending);
		await runner.runAuto("full");
		await runner.runAuto("light");
		expect(results).toHaveLength(1);

		emptyRemote();
		await runner.run("pull");

		expect(results.slice(1)).toEqual([]);
	});
});

describe("a sync that started by itself and was stopped", () => {
	test("by the user: it says that it stopped, and remembers neither a failure nor a cause", async () => {
		const { runner, store } = setup();
		heldRequest();
		const automatic = runner.runAuto("full");
		await underWay();
		const started = await store.getMeta(AUTO_SYNC_KEY);

		runner.requestStop();
		await automatic;

		expect(app.notices).toEqual(["The download was stopped. The next download continues from there."]);
		expect(await store.getMeta(AUTO_SYNC_KEY)).toEqual(started);
		expect(await readAutoSyncMemory(store)).toMatchObject({ failures: 0, told: null });
	});

	test("by a change of the connection: nothing is told, nothing is written, and nothing is remembered", async () => {
		const { runner, store } = setup();
		heldRequest();
		const automatic = runner.runAuto("full");
		await underWay();
		const started = await store.getMeta(AUTO_SYNC_KEY);

		await Promise.all([runner.interrupt(), automatic]);

		expect(app.notices).toEqual([]);
		expect(await store.getMeta(AUTO_SYNC_KEY)).toEqual(started);
		// The memory is the old connection's, and went with it.
		expect(runner.autoClock()).toMatchObject({ lastStartedAt: null, failures: 0 });
	});

	test("by the plugin going away: nothing is told or written", async () => {
		const { runner, store } = setup();
		heldRequest();
		const automatic = runner.runAuto("full");
		await underWay();
		const started = await store.getMeta(AUTO_SYNC_KEY);

		runner.stop();
		await automatic;

		expect(app.notices).toEqual([]);
		expect(await store.getMeta(AUTO_SYNC_KEY)).toEqual(started);
	});

	test("starts no more once the plugin is gone", async () => {
		const { runner } = setup();
		runner.stop();
		await runner.runAuto("full");
		await runner.run("pull");
		expect(app.requests).toBe(0);
		expect(app.notices).toEqual([]);
	});
});

describe("the limit on the bytes fetched at once", () => {
	test("is the smaller one on Android, and the usual one anywhere else", async () => {
		const { runner } = setup();
		await runner.runAuto("light");
		app.platform.isAndroidApp = true;
		await runner.runAuto("light");

		expect(app.backends.map((options) => options.maxConcurrentFetchBytes)).toEqual([
			MAX_CONCURRENT_FETCH_BYTES,
			ANDROID_CONCURRENT_FETCH_BYTES,
		]);
	});
});

describe("what becomes of a conflict", () => {
	test("a pull merges on a device that is set to, and on no other", async () => {
		await setup().runner.runAuto("light");
		await setup({ onConflict: "merge" }).runner.runAuto("light");

		expect(app.merges).toEqual([false, true]);
	});
});

describe("what this device alone does not sync", () => {
	test("is what the pull goes by, as the settings have it once the kinds of the section were copied", async () => {
		const own = { kinds: ["image"] as const, folders: ["Attachments"], sectionChecked: false };
		const { runner, host } = setup({ deviceExclusion: own });
		const adopted = { calls: 0 };
		Object.assign(host, {
			adoptSectionKinds: async () => {
				adopted.calls += 1;
				host.deviceSettings = { ...host.deviceSettings, deviceExclusion: { ...own, kinds: ["image", "video"], sectionChecked: true } };
			},
		});

		await runner.runAuto("light");

		expect(adopted.calls).toBe(1);
		expect(app.devices).toEqual([{ kinds: ["image", "video"], folders: ["Attachments"], sectionChecked: true }]);
	});
});

describe("the zip of a commit", () => {
	test("is not for a pull on Android, and is for one anywhere else", async () => {
		const { runner } = setup();
		await runner.runAuto("light");
		app.platform.isAndroidApp = true;
		await runner.runAuto("light");

		expect(app.pulls).toEqual([true, false]);
	});
});

describe("the end of a sync", () => {
	test("that cannot be recorded still ends: the next sync can begin", async () => {
		const { runner, store } = setup();
		store.setMeta = async () => {
			throw new Error("the sync state is gone");
		};
		// And what tells of it fails as well.
		vi.mocked(console.debug).mockImplementation((message?: unknown) => {
			if (String(message).includes("automatic sync: failure")) throw new Error("no console");
		});

		await runner.runAuto("full");

		expect(runner.running).toBe(false);
		await runner.runAuto("full");
		expect(app.requests).toBe(2);
	});

	test("no line of progress comes up after an automatic sync that ended quickly", async () => {
		vi.useFakeTimers();
		try {
			vi.stubGlobal("window", { setTimeout, clearTimeout });
			const { runner } = setup();
			await runner.runAuto("full");
			app.notices.length = 0;
			await vi.advanceTimersByTimeAsync(10_000);
			expect(app.notices).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	test("an automatic sync that is still running after five seconds shows that it is", async () => {
		vi.useFakeTimers();
		try {
			vi.stubGlobal("window", { setTimeout, clearTimeout });
			const { runner } = setup();
			const held = heldRequest();
			const automatic = runner.runAuto("full");
			await vi.advanceTimersByTimeAsync(4_900);
			expect(app.notices).toEqual([]);
			await vi.advanceTimersByTimeAsync(200);
			expect(app.notices).toHaveLength(1);
			expect(app.notices[0]).toContain("Download");
			held.fail();
			await vi.advanceTimersByTimeAsync(0);
			await automatic;
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("a folder on Google Drive that is no longer to be seen", () => {
	function driveSetup() {
		const made = setup({
			backend: "gdrive",
			gdriveFolder: "Vault",
			gdriveAccount: { id: "perm1", email: "a@example.com" },
			gdriveFolderId: "f1",
		});
		const gone: { id: string; running: boolean }[] = [];
		Object.assign(made.host, {
			readGdriveToken: () => "refresh",
			gdriveClientSecret: () => "",
			// What the plugin does: a change of the connection, which stops a sync that runs.
			driveFolderGone: (id: string) => {
				gone.push({ id, running: made.runner.running });
				void made.runner.interrupt();
			},
		});
		const body = new TextEncoder().encode(JSON.stringify({ error: { code: 404, errors: [{ reason: "notFound" }] } }));
		app.request = async () => ({ status: 404, headers: {}, arrayBuffer: body.buffer });
		return { ...made, gone };
	}

	const GONE = translatorFor("en", "Google Drive")("gdrive.folderGone", { folder: "Vault" });

	test("a sync that started by itself tells it, and the id is let go of once the sync has ended", async () => {
		const { runner, gone } = driveSetup();
		await runner.runAuto("full");
		expect(app.notices).toHaveLength(1);
		expect(app.notices[0]?.startsWith(HEADING)).toBe(true);
		expect(app.notices[0]).toContain(GONE);
		expect(gone).toEqual([{ id: "f1", running: false }]);
	});

	test("a sync the user started tells it as the failure it is", async () => {
		const { runner, gone } = driveSetup();
		await runner.run("pull");
		expect(app.notices.some((text) => text.includes(GONE))).toBe(true);
		expect(gone).toEqual([{ id: "f1", running: false }]);
	});
});

describe("the paid plan of Dropbox and Google Drive", () => {
	const DAY = 24 * 60 * 60 * 1000;
	// Long enough ago that the end is three months after the start of the count.
	const ENABLED = Date.now() - 400 * DAY;
	const t = translatorFor("en", "Google Drive");

	/** Google Drive, whose free time ended `daysAgo` days ago for the account, or ends in minus that many. */
	function paidSetup(daysAgo: number, enabledAt: number | null = ENABLED) {
		const made = setup({
			backend: "gdrive",
			gdriveFolder: "Vault",
			gdriveAccount: { id: "perm1", email: "a@example.com" },
			gdriveFolderId: "f1",
		});
		const values = new Map<string, unknown>();
		const storage = { read: (key: string) => values.get(key) ?? null, write: (key: string, value: unknown) => void values.set(key, value) };
		const end = Date.now() - daysAgo * DAY;
		// A start of the count three months before that end.
		const since = new Date(end);
		since.setUTCMonth(since.getUTCMonth() - 3);
		const paid = new PaidGate({ storage, http: () => Promise.reject(new Error("offline")), now: Date.now, enabledAt, api: DODO_LIVE_API });
		values.set(SINCE_KEY, { "gdrive:perm1": since.getTime() });
		// A device that has run the plan since it was switched on: no days of a late install.
		if (enabledAt !== null) values.set(FIRST_SEEN_KEY, { enabledAt, at: enabledAt });
		Object.assign(made.host, {
			readGdriveToken: () => "refresh",
			gdriveClientSecret: () => "",
			paid,
			// What the plugin gives with Google Drive chosen.
			t,
		});
		return { ...made, paid, end };
	}

	const failedLines = (): string[] =>
		vi
			.mocked(console.debug)
			.mock.calls.map(([message]) => String(message))
			.filter((message) => message.includes(": failed (") || message.includes(": not started ("));

	test("while it is switched off, every sync runs as it did", async () => {
		const { runner } = paidSetup(100, null);
		await runner.run("push");
		expect(app.requests).toBeGreaterThan(0);
		expect(failedLines()[0]).toContain("(push, by hand)");
		expect(app.notices.some((text) => text.includes("license key"))).toBe(false);
	});

	test("after the free time, an upload does not start, and says why", async () => {
		const { runner } = paidSetup(1);
		await runner.run("push");
		expect(app.requests).toBe(0);
		expect(app.notices).toHaveLength(1);
		expect(app.notices[0]).toContain("Nothing was uploaded.");
		expect(failedLines()).toEqual(["Sync Evo: push: not started (by hand): paid plan, read-only"]);
	});

	test("after the free time, a sync becomes a download, and says so first", async () => {
		const { runner } = paidSetup(1);
		await runner.run("sync");
		expect(app.notices[0]).toContain("only downloads");
		expect(app.requests).toBeGreaterThan(0);
		expect(failedLines()[0]).toContain("(pull, by hand)");
	});

	test("30 days after, nothing starts; automatic sync tells it once, and counts it as a failure", async () => {
		const { runner, store, end } = paidSetup(31);
		await runner.runAuto("full");
		await runner.runAuto("light");
		expect(app.requests).toBe(0);
		expect(app.notices).toEqual([HEADING + t("paid.stopped", { ended: dayOf(end) })]);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(await readAutoSyncMemory(store)).toMatchObject({ told: "paid:stopped", failures: 2 });
	});

	test("a week before the end, it is told once, and the sync runs", async () => {
		const { runner } = paidSetup(-7);
		await runner.run("push");
		await runner.run("push");
		const warned = app.notices.filter((text) => text.includes("more days"));
		expect(warned).toHaveLength(1);
		expect(warned[0]).toContain("7 more days");
		expect(failedLines().filter((line) => line.includes("(push, by hand)"))).toHaveLength(2);
	});
});

describe("the start of the free time, learned before a sync goes on", () => {
	const DAY = 24 * 60 * 60 * 1000;
	const ENABLED = Date.now() - 400 * DAY;
	const json = (status: number, body: unknown) => ({ status, headers: {}, arrayBuffer: new TextEncoder().encode(JSON.stringify(body)).buffer });

	function learning(backend: "dropbox" | "gdrive") {
		const made = setup(
			backend === "dropbox"
				? { backend, dropboxFolder: "Vault", dropboxAccount: { id: "dbid:1", email: "a@example.com" } }
				: { backend, gdriveFolder: "Vault", gdriveAccount: { id: "perm1", email: "a@example.com" }, gdriveFolderId: "f1" },
		);
		const values = new Map<string, unknown>();
		const storage = { read: (key: string) => values.get(key) ?? null, write: (key: string, value: unknown) => void values.set(key, value) };
		values.set(FIRST_SEEN_KEY, { enabledAt: ENABLED, at: ENABLED });
		const paid = new PaidGate({ storage, http: () => Promise.reject(new Error("offline")), now: Date.now, enabledAt: ENABLED, api: DODO_LIVE_API });
		const learned: number[] = [];
		const host = {
			check: paid.check.bind(paid),
			sinceWanted: paid.sinceWanted.bind(paid),
			sinceLearned: (settings: DeviceSettings, at: number) => {
				learned.push(at);
				paid.sinceLearned(settings, at);
			},
		};
		const tokens = { get: async () => "access", refused: () => {} };
		Object.assign(made.host, {
			readDropboxToken: () => "refresh",
			dropboxTokens: () => tokens,
			readGdriveToken: () => "refresh",
			gdriveClientSecret: () => "",
			paid: host,
			t: translatorFor("en", backend === "dropbox" ? "Dropbox" : "Google Drive"),
		});
		/** The URLs asked, in order. */
		const urls: string[] = [];
		return { ...made, learned, urls };
	}

	/** A start of the count long enough ago that nothing syncs any more. */
	const LONG_AGO = new Date(Date.now() - 200 * DAY).toISOString();

	const lines = (): string[] => vi.mocked(console.debug).mock.calls.map(([message]) => String(message));

	test("Dropbox: the file is read, the start kept, and a sync it ends before does not reach the folder", async () => {
		const { runner, learned, urls } = learning("dropbox");
		app.request = async (params) => {
			urls.push(params?.url ?? "");
			return json(200, { name: ".sync-evo-since", server_modified: LONG_AGO });
		};
		await runner.run("sync");
		expect(learned).toEqual([Date.parse(LONG_AGO)]);
		expect(urls).toEqual(["https://api.dropboxapi.com/2/files/get_metadata"]);
		expect(app.notices.some((text) => text.startsWith("Sync Evo no longer syncs with Dropbox"))).toBe(true);
		expect(lines()).toContain("Sync Evo: sync: not started (by hand): paid plan, stopped");
	});

	test("Dropbox: once known, it is not asked again, and the sync is held back before it starts", async () => {
		const { runner, urls } = learning("dropbox");
		app.request = async (params) => {
			urls.push(params?.url ?? "");
			return json(200, { name: ".sync-evo-since", server_modified: LONG_AGO });
		};
		await runner.run("sync");
		urls.length = 0;
		await runner.run("sync");
		expect(urls).toEqual([]);
	});

	test("Dropbox: a start that cannot be read fails nothing: the sync goes on", async () => {
		const { runner, learned } = learning("dropbox");
		await runner.run("sync");
		expect(learned).toEqual([]);
		expect(lines().some((line) => line.includes("paid: the start of the free time could not be read: BackendError unreachable"))).toBe(true);
		expect(lines().some((line) => line.includes("pull: failed (sync, by hand)"))).toBe(true);
	});

	test("Dropbox: a sync stopped while the start is asked for ends as stopped", async () => {
		const { runner, learned } = learning("dropbox");
		let answer: (value: unknown) => void = () => {};
		app.request = () => new Promise((resolve) => (answer = resolve));
		const running = runner.run("sync");
		await underWay();
		runner.requestStop();
		// Dropbox asks to wait: the wait is where the stop is seen.
		answer({ status: 429, headers: { "Retry-After": "1" }, arrayBuffer: new ArrayBuffer(0) });
		await running;
		expect(learned).toEqual([]);
		expect(app.requests).toBe(1);
		expect(lines().some((line) => line.includes("could not be read"))).toBe(false);
		expect(lines().some((line) => line.includes(": failed ("))).toBe(false);
	});

	test("Google Drive: a folder kept that is gone fails the sync once, as the pull would, and not as a start that could not be read", async () => {
		const { runner, learned, results } = learning("gdrive");
		app.request = async () => json(404, { error: { code: 404, errors: [{ reason: "notFound" }] } });
		await runner.run("push");
		expect(learned).toEqual([]);
		expect(lines().some((line) => line.includes("could not be read"))).toBe(false);
		expect(lines().filter((line) => line.includes(": failed ("))).toHaveLength(1);
		expect(lines().find((line) => line.includes(": failed ("))).toContain("DriveFolderGoneError");
		expect(results).toHaveLength(1);
	});

	test("a sync the user started, held back once the start is learned, is told and not kept as a result", async () => {
		const { runner, results } = learning("dropbox");
		app.request = async () => json(200, { name: ".sync-evo-since", server_modified: LONG_AGO });
		await runner.run("sync");
		expect(app.notices.some((text) => text.startsWith("Sync Evo no longer syncs with Dropbox"))).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(results).toEqual([]);
	});

	test("Google Drive: the folder Sync Evo is asked for by its id, the parent of the folder kept", async () => {
		const { runner, learned, urls } = learning("gdrive");
		app.request = async (params) => {
			const url = params?.url ?? "";
			urls.push(url);
			if (url.includes("/files/f1?")) return json(200, { id: "f1", mimeType: "application/vnd.google-apps.folder", trashed: false, parents: ["top1"] });
			if (url.includes("/files/top1?")) return json(200, { createdTime: LONG_AGO });
			// The folders of the same name: none but the ones kept.
			return json(200, { files: [] });
		};
		await runner.run("push");
		expect(learned).toEqual([Date.parse(LONG_AGO)]);
		const asked = urls.find((url) => url.includes("/files/top1?"));
		expect(asked).toBe("https://www.googleapis.com/drive/v3/files/top1?fields=createdTime");
		expect(lines()).toContain("Sync Evo: push: not started (by hand): paid plan, stopped");
	});
});
