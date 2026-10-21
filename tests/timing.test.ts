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

import { describe, expect, test } from "vitest";
import { countingLister, diskTimes, fullCheckLine, PhaseClock } from "../src/core/timing";
import { isTimingLine } from "./support/timing-lines";

describe("the time of each phase", () => {
	test("each phase has the time until the next, and one entered again adds to it", () => {
		let now = 1000;
		const clock = new PhaseClock(() => now);
		now += 5;
		clock.enter("listing");
		now += 100;
		clock.enter("scanning");
		now += 30;
		clock.enter("scanning");
		now += 20;
		clock.enter("listing");
		now += 7;
		expect(clock.line()).toBe("162 ms (listing 107 ms, scanning 50 ms)");
	});

	test("a run that never told a phase has its time alone", () => {
		let now = 0;
		const clock = new PhaseClock(() => now);
		now = 12;
		expect(clock.line()).toBe("12 ms");
	});

	test("the line of a pull or a push is told apart from the other lines", () => {
		expect(isTimingLine(`pull: completed in ${new PhaseClock(() => 0).line()}`)).toBe(true);
		expect(isTimingLine("push: nothing-to-push in 3 ms (listing 3 ms)")).toBe(true);
		expect(isTimingLine("pull: full check: 2 files")).toBe(true);
		expect(isTimingLine("push: the sent blobs could not be read")).toBe(false);
	});
});

describe("the lines of a check", () => {
	test("the folders listed are counted, and links are asked of the lister", async () => {
		const asked: string[] = [];
		const lister = countingLister({
			list: (folder) => {
				asked.push(`list ${folder}`);
				return Promise.resolve({ files: [], folders: [] });
			},
			linksIn: (folder) => {
				asked.push(`links ${folder}`);
				return Promise.resolve(["a"]);
			},
		});
		await lister.list("/");
		await lister.list("b");
		expect(await lister.linksIn?.("/")).toEqual(["a"]);
		expect(lister.listed()).toBe(2);
		expect(asked).toEqual(["list /", "list b", "links /"]);
	});

	test("a lister that cannot tell links stays one", () => {
		const lister = countingLister({ list: () => Promise.resolve({ files: [], folders: [] }) });
		expect(lister.linksIn).toBeUndefined();
	});

	test("a full check tells the folders, the disk and the reading apart", () => {
		const local = { statted: 8, hashed: 2, statMs: 40, readMs: 9 };
		expect(fullCheckLine(8, 3, 20, local, 75)).toBe(
			"full check: 8 files, 3 folders listed, 8 asked of the disk, 2 hashed, 75 ms (folders 20 ms, disk 40 ms, reading 9 ms)",
		);
		expect(diskTimes(local)).toBe("disk 40 ms, reading 9 ms");
	});
});
