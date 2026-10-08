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

import { afterEach, describe, expect, test, vi } from "vitest";
import { ScreenWakeLock } from "../src/obsidian/wake-lock";

/** The parts of a page the lock touches. `request` answers as the test says. */
function page(request?: () => Promise<{ release(): Promise<void> }>) {
	const listeners = new Set<() => void>();
	const doc = {
		visibilityState: "visible",
		addEventListener: (_type: string, listener: () => void) => void listeners.add(listener),
		removeEventListener: (_type: string, listener: () => void) => void listeners.delete(listener),
	};
	vi.stubGlobal("document", doc);
	vi.stubGlobal("navigator", request === undefined ? {} : { wakeLock: { request } });
	return {
		listeners,
		/** The app goes to the back, or comes to the front. */
		show(state: "visible" | "hidden"): void {
			doc.visibilityState = state;
			for (const listener of [...listeners]) listener();
		},
	};
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => vi.unstubAllGlobals());

describe("the screen wake lock", () => {
	test("is asked for before `hold` returns, and let go of by `release`", async () => {
		const released: number[] = [];
		let requests = 0;
		const { listeners } = page(async () => {
			const id = ++requests;
			return { release: async () => void released.push(id) };
		});
		const lock = new ScreenWakeLock();
		lock.hold();
		expect(requests).toBe(1);
		lock.hold();
		expect(requests).toBe(1);
		await settle();

		lock.release();
		expect(released).toEqual([1]);
		expect(listeners.size).toBe(0);
		lock.release();
		expect(released).toEqual([1]);
	});

	test("is asked for again, in the handler, when the app comes back to the front while it is held", async () => {
		let requests = 0;
		const released: number[] = [];
		const { show } = page(async () => {
			const id = ++requests;
			return { release: async () => void released.push(id) };
		});
		const lock = new ScreenWakeLock();
		lock.hold();
		await settle();

		show("hidden");
		expect(requests).toBe(1);
		show("visible");
		expect(requests).toBe(2);
		await settle();

		lock.release();
		expect(released).toContain(2);
		show("visible");
		expect(requests).toBe(2);
	});

	test("coming back to the front while an earlier request is still on its way leaves no lock held", async () => {
		// In either order of the two answers.
		for (const order of [
			[0, 1],
			[1, 0],
		]) {
			const grants: (() => void)[] = [];
			const held = new Set<number>();
			const { show } = page(
				() =>
					new Promise((resolve) => {
						const id = grants.length;
						grants.push(() => {
							held.add(id);
							resolve({ release: async () => void held.delete(id) });
						});
					}),
			);
			const lock = new ScreenWakeLock();
			lock.hold();
			show("hidden");
			show("visible");
			expect(grants).toHaveLength(2);
			for (const index of order) grants[index]?.();
			await settle();
			// One is kept, and the other was let go of.
			expect(held.size).toBe(1);

			lock.release();
			await settle();
			expect(held.size).toBe(0);
		}

		// Both still on their way when the sync ends.
		const grants: (() => void)[] = [];
		const held = new Set<number>();
		const { show } = page(
			() =>
				new Promise((resolve) => {
					const id = grants.length;
					grants.push(() => {
						held.add(id);
						resolve({ release: async () => void held.delete(id) });
					});
				}),
		);
		const lock = new ScreenWakeLock();
		lock.hold();
		show("hidden");
		show("visible");
		lock.release();
		for (const grant of grants) grant();
		await settle();
		expect(held.size).toBe(0);
	});

	test("one that is granted after the sync ended is let go of at once", async () => {
		let grant = (): void => {};
		let released = 0;
		page(
			() =>
				new Promise((resolve) => {
					grant = () => resolve({ release: async () => void released++ });
				}),
		);
		const lock = new ScreenWakeLock();
		lock.hold();
		lock.release();
		grant();
		await settle();
		expect(released).toBe(1);
	});

	test("a refusal, a request that throws, and a platform without the lock are all ignored", async () => {
		page(() => Promise.reject(new DOMException("Permission was denied", "NotAllowedError")));
		const refused = new ScreenWakeLock();
		refused.hold();
		await settle();
		refused.release();

		page(() => {
			throw new Error("not here");
		});
		const throwing = new ScreenWakeLock();
		expect(() => throwing.hold()).not.toThrow();
		throwing.release();

		page();
		const without = new ScreenWakeLock();
		expect(() => without.hold()).not.toThrow();
		without.release();
	});
});
