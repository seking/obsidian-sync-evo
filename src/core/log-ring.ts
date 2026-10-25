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

/**
 * What the device is, as `Platform` of the app tells it: its kind and its
 * system. On iPhone and iPad the app also says it is macOS, so the app of
 * iOS is asked first.
 */
export interface DeviceFlags {
	readonly isPhone: boolean;
	readonly isTablet: boolean;
	readonly isIosApp: boolean;
	readonly isAndroidApp: boolean;
	readonly isMacOS: boolean;
	readonly isWin: boolean;
	readonly isLinux: boolean;
}

/** The device, as a line of a report puts it: "phone (Android)", say. */
export function deviceText(flags: DeviceFlags): string {
	const kind = flags.isPhone ? "phone" : flags.isTablet ? "tablet" : "desktop";
	const system = flags.isIosApp
		? "iOS"
		: flags.isAndroidApp
			? "Android"
			: flags.isMacOS
				? "macOS"
				: flags.isWin
					? "Windows"
					: flags.isLinux
						? "Linux"
						: "unknown system";
	return `${kind} (${system})`;
}

/** What a report of a problem asks for, to be put above the lines of a copy of the log. */
export interface LogContext {
	/** Of Sync Evo. */
	readonly version: string;
	/** Of the app, as its API gives it. */
	readonly obsidianVersion: string;
	/** `deviceText`. */
	readonly device: string;
	/** The service chosen in the settings, or "unknown" where they cannot be read. */
	readonly service: string;
}

/**
 * The lines as a copy of the log has them: first what they were written on
 * and with, then a blank line, then the lines (`logText`). In English, like
 * the lines, in every language.
 */
export function logCopyText(context: LogContext, lines: readonly LogLine[]): string {
	const head = [
		`Sync Evo ${context.version}`,
		`Obsidian ${context.obsidianVersion}`,
		`Device: ${context.device}`,
		`Service: ${context.service}`,
	];
	return [...head, "", logText(lines)].join("\n");
}
