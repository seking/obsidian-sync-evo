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
import { AUTO_SYNC_KEY, readAutoSyncMemory } from "../src/core/auto-sync";
import { translatorFor } from "../src/core/i18n";
import { DEFAULT_AUTO_SYNC, type DeviceSettings } from "../src/core/settings";
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
	/** Answers a request: rejects like a device without a network unless a test says otherwise. */
	request: (): Promise<unknown> => Promise.reject(new Error("net::ERR_INTERNET_DISCONNECTED")),
	requests: 0,
}));

vi.mock("obsidian", () => {
	class Notice {
		constructor(text: string) {
			app.notices.push(text);
		}
		setMessage(): void {}
		hide(): void {}
	}
	class Empty {}
	return {
		Notice,
		Modal: Empty,
		ButtonComponent: Empty,
		TFile: Empty,
		TFolder: Empty,
		requestUrl: () => {
			app.requests += 1;
			return app.request();
		},
	};
});

const { SyncRunner } = await import("../src/obsidian/sync-runner");

const HEADING = "Automatic sync:\n";
const OFFLINE = "The pull failed. Could not reach GitHub. Check the network connection and try again.";

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

function setup(over: Partial<DeviceSettings> = {}) {
	const store = new MemoryStateStore();
	const state = { opens: 0, closed: 0 };
	const settings: DeviceSettings = {
		backend: "github",
		repository: "octo/notes",
		branch: "main",
		tokenSecret: "github-token",
		deviceName: "iPhone",
		autoSync: { ...DEFAULT_AUTO_SYNC, onStartup: true, atInterval: true },
		...over,
	};
	const tokens: Record<string, string | null> = { "github-token": "github_pat_SECRET" };
	const host = {
		app: {
			vault: {
				configDir: ".obsidian",
				// A vault with nothing but its configuration folder, as far
				// as a sync that reaches it asks.
				adapter: {
					stat: async (path: string) => (path === ".obsidian" ? { type: "folder", mtime: 0, size: 0 } : null),
					list: async (folder: string) => ({ files: [], folders: folder === "/" ? [".obsidian"] : [] }),
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
	};
	const runner = new SyncRunner(host as unknown as SyncHost);
	return { runner, store, state, tokens, host };
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
	app.requests = 0;
	app.request = () => Promise.reject(new Error("net::ERR_INTERNET_DISCONNECTED"));
	vi.stubGlobal("window", { setTimeout, clearTimeout });
	vi.stubGlobal("document", { visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} });
	vi.spyOn(console, "info").mockImplementation(() => {});
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
			"The pull was stopped because the connection was changed. The next pull starts with the new connection.",
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
		expect(app.notices).toEqual(["The pull was stopped. The next pull continues from there."]);
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

describe("a sync that started by itself and was stopped", () => {
	test("by the user: it says that it stopped, and remembers neither a failure nor a cause", async () => {
		const { runner, store } = setup();
		heldRequest();
		const automatic = runner.runAuto("full");
		await underWay();
		const started = await store.getMeta(AUTO_SYNC_KEY);

		runner.requestStop();
		await automatic;

		expect(app.notices).toEqual(["The pull was stopped. The next pull continues from there."]);
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

describe("the end of a sync", () => {
	test("that cannot be recorded still ends: the next sync can begin", async () => {
		const { runner, store } = setup();
		store.setMeta = async () => {
			throw new Error("the sync state is gone");
		};
		// And what tells of it fails as well.
		vi.mocked(console.info).mockImplementation((message?: unknown) => {
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
			expect(app.notices[0]).toContain("Pull");
			held.fail();
			await vi.advanceTimersByTimeAsync(0);
			await automatic;
		} finally {
			vi.useRealTimers();
		}
	});
});
