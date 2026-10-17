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
import { type AutoCheck, FullCheckDebt, TICK_MS } from "../src/core/auto-sync";
import { type AutoSyncSettings, DEFAULT_AUTO_SYNC, type DeviceSettings } from "../src/core/settings";
import { AutoScheduler } from "../src/obsidian/auto-scheduler";
import type { SyncRunner } from "../src/obsidian/sync-runner";

const MINUTE = 60_000;
const START = Date.UTC(2026, 9, 11, 9, 0, 0);

/** The runner, as far as the clock asks it: what it remembers, and what it was told to start. */
class FakeRunner {
	running = false;
	lastStartedAt: number | null = null;
	failures = 0;
	/** What the sync state holds, read by the first `recallAuto`. */
	stored: number | null = null;
	recalls = 0;
	readonly started: AutoCheck[] = [];
	readonly debt = new FullCheckDebt();
	/** Resolved by the test to let a `recallAuto` that waits go on. */
	private gate: Promise<void> | null = null;
	private open: () => void = () => {};

	holdRecall(): void {
		this.gate = new Promise((resolve) => {
			this.open = resolve;
		});
	}

	releaseRecall(): void {
		this.open();
		this.gate = null;
	}

	async recallAuto(): Promise<void> {
		if (this.recalls > 0) return;
		this.recalls += 1;
		if (this.gate !== null) await this.gate;
		this.lastStartedAt ??= this.stored;
	}

	autoClock(): { lastStartedAt: number | null; failures: number; fullOwed: boolean } {
		return { lastStartedAt: this.lastStartedAt, failures: this.failures, fullOwed: this.debt.isOwed };
	}

	resumed(): void {
		this.debt.resumed();
	}

	/** A sync the user starts. */
	runManually(): void {
		this.debt.syncReached("full", "scanning");
		this.lastStartedAt = Date.now();
	}

	async runAuto(check: AutoCheck): Promise<void> {
		this.started.push(check);
		this.debt.syncReached(check, "scanning");
		// As the runner does at once: the next is counted from this start.
		this.lastStartedAt = Date.now();
	}
}

function setup(auto: Partial<AutoSyncSettings>, over: Partial<DeviceSettings> = {}) {
	const host: { deviceSettings: DeviceSettings | null } = {
		deviceSettings: {
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
			autoSync: { ...DEFAULT_AUTO_SYNC, ...auto },
			onConflict: "copy",
			deviceExclusion: NO_DEVICE_EXCLUSION,
			exclusionChangeTold: true,
			...over,
		},
	};
	const runner = new FakeRunner();
	const scheduler = new AutoScheduler(host, runner as unknown as SyncRunner);
	return { host, runner, scheduler };
}

/** Lets what a look awaits run to its end. */
const settled = async (): Promise<void> => {
	for (let turn = 0; turn < 5; turn++) await Promise.resolve();
};

const page = { visibilityState: "visible" };

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(START);
	page.visibilityState = "visible";
	vi.stubGlobal("document", page);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("while automatic sync is off", () => {
	test("nothing is read from the sync state, and nothing starts", async () => {
		const { runner, scheduler } = setup({});
		scheduler.started();
		scheduler.tick();
		scheduler.visibilityChanged();
		await settled();
		expect(runner.recalls).toBe(0);
		expect(runner.started).toEqual([]);
	});

	test.each<[string, Partial<DeviceSettings>]>([
		["no repository", { repository: "" }],
		["no branch", { branch: "" }],
	])("nor with %s, whatever is switched on", async (_name, over) => {
		const { runner, scheduler } = setup({ onStartup: true, atInterval: true }, over);
		scheduler.started();
		await settled();
		expect(runner.recalls).toBe(0);
		expect(runner.started).toEqual([]);
	});

	test("nor while no token was chosen, at any look at the clock", async () => {
		const { runner, scheduler } = setup({ onStartup: true, atInterval: true, intervalMinutes: 1 }, { tokenSecret: "" });
		scheduler.started();
		for (let passed = TICK_MS; passed <= 3 * MINUTE; passed += TICK_MS) {
			vi.setSystemTime(START + passed);
			scheduler.tick();
		}
		await settled();
		expect(runner.recalls).toBe(0);
		expect(runner.started).toEqual([]);
	});

	test("nor with settings of a newer version", async () => {
		const { host, runner, scheduler } = setup({ onStartup: true });
		host.deviceSettings = null;
		scheduler.started();
		await settled();
		expect(runner.recalls).toBe(0);
		expect(runner.started).toEqual([]);
	});
});

describe("before the app has started", () => {
	test("the timer and the event do nothing, and the sync at the start is a full one", async () => {
		const { runner, scheduler } = setup({ onStartup: true, atInterval: true, intervalMinutes: 1 });
		// The timer is there from the load of the plugin; the app is still
		// reading the vault.
		scheduler.tick();
		scheduler.visibilityChanged();
		vi.setSystemTime(START + TICK_MS);
		scheduler.tick();
		await settled();
		expect(runner.recalls).toBe(0);
		expect(runner.started).toEqual([]);

		scheduler.started();
		await settled();

		expect(runner.started).toEqual(["full"]);
	});

	test("a start that takes long is not taken for a return by the first look of the timer", async () => {
		const { runner, scheduler } = setup({ onStartup: true });
		scheduler.tick();
		vi.setSystemTime(START + 2 * MINUTE);
		scheduler.started();
		await settled();
		vi.setSystemTime(START + 2 * MINUTE + TICK_MS);
		scheduler.tick();
		await settled();
		expect(runner.started).toEqual(["full"]);
	});
});

describe("when the app has started", () => {
	test("a sync with the full check starts, once the time of the last one was read", async () => {
		const { runner, scheduler } = setup({ onStartup: true });
		scheduler.started();
		await settled();
		expect(runner.recalls).toBe(1);
		expect(runner.started).toEqual(["full"]);
	});

	test("none when the last sync, as the sync state has it, started less than 5 minutes ago", async () => {
		const { runner, scheduler } = setup({ onStartup: true });
		runner.stored = START - 4 * MINUTE;
		scheduler.started();
		await settled();
		expect(runner.started).toEqual([]);
	});

	test("with sync at an interval alone, by the interval", async () => {
		const { runner, scheduler } = setup({ atInterval: true, intervalMinutes: 15 });
		runner.stored = START - 14 * MINUTE;
		scheduler.started();
		await settled();
		expect(runner.started).toEqual([]);

		const later = setup({ atInterval: true, intervalMinutes: 15 });
		later.runner.stored = START - 15 * MINUTE;
		later.scheduler.started();
		await settled();
		expect(later.runner.started).toEqual(["full"]);
	});
});

describe("a connection that is taken away while the sync state is read", () => {
	test("starts nothing", async () => {
		const { host, runner, scheduler } = setup({ onStartup: true });
		runner.holdRecall();
		scheduler.started();
		await settled();
		const settings = host.deviceSettings;
		if (settings === null) throw new Error("no settings");
		host.deviceSettings = { ...settings, repository: "" };

		runner.releaseRecall();
		await settled();

		expect(runner.started).toEqual([]);
	});
});

describe("while the app stays in front", () => {
	test("a sync with the light check starts each time the interval has passed since the last start", async () => {
		const { runner, scheduler } = setup({ atInterval: true, intervalMinutes: 1 });
		scheduler.started();
		await settled();
		expect(runner.started).toEqual(["full"]);

		for (let passed = TICK_MS; passed <= 2 * MINUTE; passed += TICK_MS) {
			vi.setSystemTime(START + passed);
			scheduler.tick();
			await settled();
		}

		expect(runner.started).toEqual(["full", "light", "light"]);
	});

	test("with sync on startup alone, nothing starts however long it stays there", async () => {
		const { runner, scheduler } = setup({ onStartup: true });
		scheduler.started();
		await settled();
		for (let passed = TICK_MS; passed <= 10 * MINUTE; passed += TICK_MS) {
			vi.setSystemTime(START + passed);
			scheduler.tick();
			await settled();
		}
		expect(runner.started).toEqual(["full"]);
	});

	test("a switch that is turned on takes effect at the next look at the clock, with the full check that is still owed", async () => {
		const { host, runner, scheduler } = setup({});
		scheduler.started();
		await settled();
		const settings = host.deviceSettings;
		if (settings === null) throw new Error("no settings");
		host.deviceSettings = { ...settings, autoSync: { ...settings.autoSync, atInterval: true } };

		vi.setSystemTime(START + TICK_MS);
		scheduler.tick();
		await settled();

		expect(runner.started).toEqual(["full"]);
	});

	test("nothing starts while a sync runs, and none is kept for when it has ended", async () => {
		const { runner, scheduler } = setup({ atInterval: true, intervalMinutes: 1 });
		runner.lastStartedAt = START - 10 * MINUTE;
		runner.running = true;
		vi.setSystemTime(START + TICK_MS);
		scheduler.tick();
		await settled();
		expect(runner.started).toEqual([]);

		// It has ended: counted from its start, which was 30 seconds ago.
		runner.running = false;
		runner.lastStartedAt = START - 20_000;
		vi.setSystemTime(START + 2 * TICK_MS);
		scheduler.tick();
		await settled();
		expect(runner.started).toEqual([]);
	});

	test("nothing is done while the app is not shown", async () => {
		const { runner, scheduler } = setup({ atInterval: true, intervalMinutes: 1 });
		runner.lastStartedAt = START - 10 * MINUTE;
		page.visibilityState = "hidden";
		scheduler.tick();
		scheduler.visibilityChanged();
		await settled();
		expect(runner.started).toEqual([]);
	});
});

describe("when the app comes back to the front", () => {
	test("the event starts a sync with the full check at once", async () => {
		const { runner, scheduler } = setup({ onStartup: true });
		scheduler.started();
		await settled();
		vi.setSystemTime(START + 30 * MINUTE);

		scheduler.visibilityChanged();
		await settled();

		expect(runner.started).toEqual(["full", "full"]);
	});

	test("the event coming twice in a row starts one sync", async () => {
		const { runner, scheduler } = setup({ onStartup: true, atInterval: true });
		runner.stored = START - MINUTE;
		scheduler.started();
		await settled();
		expect(runner.started).toEqual([]);
		vi.setSystemTime(START + 30 * MINUTE);

		scheduler.visibilityChanged();
		scheduler.visibilityChanged();
		await settled();
		scheduler.visibilityChanged();
		await settled();

		expect(runner.started).toEqual(["full"]);
	});

	test("without the event, the timer firing late tells of it", async () => {
		const { runner, scheduler } = setup({ onStartup: true });
		scheduler.started();
		await settled();
		vi.setSystemTime(START + TICK_MS);
		scheduler.tick();
		await settled();
		// The phone had the app in the background for half an hour.
		vi.setSystemTime(START + 30 * MINUTE);

		scheduler.tick();
		await settled();

		expect(runner.started).toEqual(["full", "full"]);
	});

	test("both the event and the late timer start one sync", async () => {
		const { runner, scheduler } = setup({ onStartup: true });
		scheduler.started();
		await settled();
		vi.setSystemTime(START + 30 * MINUTE);

		scheduler.tick();
		scheduler.visibilityChanged();
		await settled();

		expect(runner.started).toEqual(["full", "full"]);
	});

	test("a return that starts no sync makes the next one at the interval a full one, and only that one", async () => {
		const { runner, scheduler } = setup({ onStartup: true, atInterval: true, intervalMinutes: 15 });
		scheduler.started();
		await settled();
		// Left and come back to after two minutes: within the 5 minutes.
		vi.setSystemTime(START + 2 * MINUTE);
		scheduler.visibilityChanged();
		await settled();
		expect(runner.started).toEqual(["full"]);

		for (let passed = 2 * MINUTE + TICK_MS; passed <= 31 * MINUTE; passed += TICK_MS) {
			vi.setSystemTime(START + passed);
			scheduler.tick();
			await settled();
		}

		expect(runner.started).toEqual(["full", "full", "light"]);
	});

	test("a sync the user starts after the return is the full check that was owed", async () => {
		const { runner, scheduler } = setup({ atInterval: true, intervalMinutes: 15 });
		scheduler.started();
		await settled();
		vi.setSystemTime(START + 2 * MINUTE);
		scheduler.visibilityChanged();
		await settled();

		for (let passed = 2 * MINUTE + TICK_MS; passed <= 19 * MINUTE; passed += TICK_MS) {
			vi.setSystemTime(START + passed);
			if (passed === 3 * MINUTE) runner.runManually();
			scheduler.tick();
			await settled();
		}

		expect(runner.started).toEqual(["full", "light"]);
	});

	test("a return while automatic sync is off is remembered for when it is switched on", async () => {
		const { host, runner, scheduler } = setup({});
		scheduler.started();
		await settled();
		runner.runManually();
		vi.setSystemTime(START + 10 * MINUTE);
		scheduler.visibilityChanged();
		await settled();
		const settings = host.deviceSettings;
		if (settings === null) throw new Error("no settings");
		host.deviceSettings = { ...settings, autoSync: { ...settings.autoSync, atInterval: true } };

		vi.setSystemTime(START + 30 * MINUTE);
		scheduler.tick();
		await settled();

		expect(runner.started).toEqual(["full"]);
	});

	test("within 5 minutes of the last start, nothing starts", async () => {
		const { runner, scheduler } = setup({ onStartup: true });
		scheduler.started();
		await settled();
		vi.setSystemTime(START + 4 * MINUTE);

		scheduler.visibilityChanged();
		await settled();

		expect(runner.started).toEqual(["full"]);
	});

	test("a return that is noticed while the sync state is still read is decided as a return", async () => {
		const { runner, scheduler } = setup({ onStartup: true });
		runner.holdRecall();
		// The look at the start comes first, and waits.
		scheduler.started();
		scheduler.visibilityChanged();
		await settled();
		expect(runner.started).toEqual([]);

		runner.releaseRecall();
		await settled();

		expect(runner.started).toEqual(["full"]);
	});
});
