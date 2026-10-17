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

// The last lines of the log, kept so that they can be read on a device whose
// console cannot be: a phone. Only in memory. Nothing of it is written to
// the disk or to the sync state, and it is gone when the app is closed.

/**
 * How many lines are kept. The oldest goes when one more comes. A limit
 * can write a line for each of 16 requests at once, five times over.
 */
export const LOG_LINES_KEPT = 500;

/** One line of the log, with when it was written. */
export interface LogLine {
	/** Milliseconds since the epoch, by the clock of the device. */
	readonly at: number;
	readonly message: string;
}

/** The most recent lines of the log, oldest first. */
export class LogRing {
	private readonly capacity: number;
	private kept: LogLine[] = [];

	constructor(capacity: number = LOG_LINES_KEPT) {
		this.capacity = Math.max(1, Math.floor(capacity));
	}

	add(at: number, message: string): void {
		this.kept.push({ at, message });
		if (this.kept.length > this.capacity) this.kept = this.kept.slice(-this.capacity);
	}

	/** The lines that are kept, oldest first. Not changed by a line added later. */
	lines(): readonly LogLine[] {
		return [...this.kept];
	}
}

const two = (value: number): string => String(value).padStart(2, "0");

/**
 * A time as the log writes it: the month, the day and the time of the
 * device. No year, to keep a line short on a phone: the lines do not
 * outlive the run of the app.
 */
export function logTime(at: number): string {
	const time = new Date(at);
	const day = `${two(time.getMonth() + 1)}-${two(time.getDate())}`;
	const clock = `${two(time.getHours())}:${two(time.getMinutes())}:${two(time.getSeconds())}`;
	return `${day} ${clock}`;
}

/** The lines as text, one each, oldest first: when it was written (`logTime`), then the message. */
export function logText(lines: readonly LogLine[]): string {
	return lines.map(({ at, message }) => `${logTime(at)} ${message}`).join("\n");
}
