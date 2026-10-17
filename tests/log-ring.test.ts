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

import { describe, expect, test } from "vitest";
import { LOG_LINES_KEPT, LogRing, logText } from "../src/core/log-ring";

// Built from the parts of a local time, so that the text is the same in
// whatever time zone the tests run.
const at = (hours: number, minutes: number, seconds: number): number =>
	new Date(2026, 9, 3, hours, minutes, seconds).getTime();

describe("the last lines of the log", () => {
	test("kept in the order they came, with their time", () => {
		const ring = new LogRing();
		expect(ring.lines()).toEqual([]);
		ring.add(1, "first");
		ring.add(2, "second");
		expect(ring.lines()).toEqual([
			{ at: 1, message: "first" },
			{ at: 2, message: "second" },
		]);
	});

	test("500 of them, and the oldest goes when one more comes", () => {
		expect(LOG_LINES_KEPT).toBe(500);
		const ring = new LogRing();
		for (let i = 0; i < LOG_LINES_KEPT + 3; i++) ring.add(i, `line ${i}`);
		const lines = ring.lines();
		expect(lines).toHaveLength(LOG_LINES_KEPT);
		expect(lines[0]).toEqual({ at: 3, message: "line 3" });
		expect(lines[lines.length - 1]).toEqual({ at: LOG_LINES_KEPT + 2, message: `line ${LOG_LINES_KEPT + 2}` });
	});

	test("as many as it is made for, and never none", () => {
		const two = new LogRing(2);
		for (const message of ["a", "b", "c"]) two.add(0, message);
		expect(two.lines().map((line) => line.message)).toEqual(["b", "c"]);

		const none = new LogRing(0);
		none.add(0, "a");
		none.add(0, "b");
		expect(none.lines().map((line) => line.message)).toEqual(["b"]);
	});

	test("what was handed out is not changed by a line added later", () => {
		const ring = new LogRing(2);
		ring.add(1, "a");
		const before = ring.lines();
		ring.add(2, "b");
		ring.add(3, "c");
		expect(before).toEqual([{ at: 1, message: "a" }]);
	});
});

describe("the lines as text", () => {
	test("one line each, oldest first, with the day and the time of the device", () => {
		const text = logText([
			{ at: at(7, 5, 9), message: "automatic sync: pull, light check" },
			{ at: at(23, 59, 0), message: "head: not modified (304)" },
		]);
		expect(text).toBe("10-03 07:05:09 automatic sync: pull, light check\n10-03 23:59:00 head: not modified (304)");
	});

	test("nothing for no lines", () => {
		expect(logText([])).toBe("");
	});
});
