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

// The name of the copy that keeps the vault's content of a file in conflict,
// and where it is put: directly in one folder at the vault root,
//
//   _conflicts/<YYYYMMDD-HHmmss> <name> (<device>)[-N].<extension>
//
// The folders of the file are not kept: the path of the file cannot be read
// back from the path of its copy, and whoever needs it has to remember it.
// The form is the same in every language. A copy is told by where it is and
// by the start of its name alone, so that one made on another device, of a
// file and under a device name this one knows nothing about, is still
// recognized.
//
// Up to 0.2.0 a copy was made beside its file instead:
//
//   <name>.conflict-from-<device>-<YYYYMMDD-HHmmss>[-N].<extension>
//
// No copy is given that form any more, but a vault can hold such copies, and
// a device with an older version still makes them. They are read back from
// the shape of the end of the file name (`originalPathOfConflictCopy`).

import { foldedKey } from "./paths";

/** The folder at the vault root the copies are made in. Not a setting, and not translated. */
export const CONFLICT_FOLDER = "_conflicts";

/** What most file systems allow for one file name, in bytes of UTF-8. */
const MAX_NAME_BYTES = 255;

// A file name that starts the way a copy in the folder does. Nothing after
// the space is looked at.
const COPY_START = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2}) /;

// A file name without its extension that ends the way a copy of the earlier
// form does. Both the name and the device name are greedy: of several marks
// in one name the last is the one that was added, and a device name may
// itself hold hyphens and digits.
const COPY_END = /^(.+)\.conflict-from-.+-\d{8}-\d{6}(?:-\d+)?$/s;

/**
 * The path of the conflict copy of `path`.
 *
 * - The extension is what follows the last `.` of the file name, so the copy
 *   of a note is still a note. A leading `.` does not start an extension:
 *   `.gitignore` has none, and what is added goes at its end.
 * - `deviceName` is the device that wrote the content the copy holds.
 * - `at` is read on the device's own clock, in local time. It comes first,
 *   so that a list of the folder is in the order the copies were made.
 * - `attempt` is 1 for the plain name. From 2 on it is added before the
 *   extension, for when the plain name is taken: two devices with one name,
 *   or two files of one name in different folders within one second.
 * - `folder` is the folder as the vault spells it, when it has one under
 *   another case (`isConflictFolder`).
 *
 * A file name longer than 255 bytes is shortened at the end of `<name>`,
 * between characters.
 */
export function conflictCopyPath(
	path: string,
	deviceName: string,
	at: Date,
	attempt = 1,
	folder = CONFLICT_FOLDER,
): string {
	const fileName = path.slice(path.lastIndexOf("/") + 1);
	const dot = fileName.lastIndexOf(".");
	const name = dot > 0 ? fileName.slice(0, dot) : fileName;
	const extension = dot > 0 ? fileName.slice(dot) : "";

	const before = `${stamp(at)} `;
	const after = ` (${deviceName})${attempt > 1 ? `-${attempt}` : ""}${extension}`;
	return `${folder}/${before}${shortened(name, MAX_NAME_BYTES - byteLength(before) - byteLength(after))}${after}`;
}

/**
 * Whether `path` is the folder of the copies. Without the cases, like every
 * question of whether two paths could be one on a disk that does not tell
 * them apart: a vault that spells it `_Conflicts` has its copies there.
 */
export function isConflictFolder(path: string): boolean {
	return foldedKey(path) === CONFLICT_FOLDER;
}

/**
 * Whether `path` is a conflict copy in the folder of the copies: directly in
 * it, with a file name that starts with a date, a time and a space. Nothing
 * else of the name is looked at, and whether there is a file is not asked.
 *
 * Asked before `originalPathOfConflictCopy`, which answers `null` for such a
 * path whatever its end looks like: a device with an older version makes a
 * copy of the earlier form of a file in this folder, beside it.
 */
export function isCopyInConflictFolder(path: string): boolean {
	const slash = path.indexOf("/");
	if (slash === -1 || !isConflictFolder(path.slice(0, slash))) return false;
	const fileName = path.slice(slash + 1);
	return !fileName.includes("/") && COPY_START.test(fileName);
}

/**
 * When a copy in the folder of the copies was made, by its name, in
 * milliseconds since the epoch. `null` for a path that is no such copy, and
 * for digits that are no date and time (a 13th month, a 25th hour).
 *
 * The date and the time are read as UTC, though the device that made the
 * copy wrote them on its own clock: read on the clock of this device, an
 * hour that a change of its clocks skips would be no time at all. The
 * answer is off by the offset of that device's zone, a few hours, which
 * does not matter for what it is asked for: whether a copy is 30 days old.
 */
export function timeOfConflictCopy(path: string): number | null {
	if (!isCopyInConflictFolder(path)) return null;
	const digits = COPY_START.exec(path.slice(path.indexOf("/") + 1));
	if (digits === null) return null;
	const [year, month, day, hour, minute, second] = digits.slice(1).map(Number) as [
		number,
		number,
		number,
		number,
		number,
		number,
	];
	const at = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
	// A date that is none rolls over into the next month or day, and a year
	// below 100 is read as one of the 1900s.
	const same =
		at.getUTCFullYear() === year &&
		at.getUTCMonth() === month - 1 &&
		at.getUTCDate() === day &&
		at.getUTCHours() === hour &&
		at.getUTCMinutes() === minute &&
		at.getUTCSeconds() === second;
	return same ? at.getTime() : null;
}

/**
 * The path a conflict copy of the earlier form was made of, or `null` when
 * `path` is not named like one. Only the shape of the end of the file name
 * is looked at, never what the device name says.
 *
 * A copy of a copy gives the copy it was made of; ask again to get further.
 * A copy in the folder of the copies is never one of the earlier form
 * (`isCopyInConflictFolder`).
 */
export function originalPathOfConflictCopy(path: string): string | null {
	if (isCopyInConflictFolder(path)) return null;
	const slash = path.lastIndexOf("/");
	const folder = path.slice(0, slash + 1);
	const fileName = path.slice(slash + 1);

	// Without an extension first: what was added is then the end of the name,
	// and its last `.` (a device name may hold one) is not an extension.
	const whole = COPY_END.exec(fileName);
	if (whole !== null) return folder + (whole[1] ?? "");

	const dot = fileName.lastIndexOf(".");
	if (dot <= 0) return null;
	const stem = COPY_END.exec(fileName.slice(0, dot));
	return stem === null ? null : folder + (stem[1] ?? "") + fileName.slice(dot);
}

function stamp(at: Date): string {
	const two = (value: number): string => String(value).padStart(2, "0");
	const date = `${String(at.getFullYear()).padStart(4, "0")}${two(at.getMonth() + 1)}${two(at.getDate())}`;
	return `${date}-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`;
}

const encoder = new TextEncoder();

function byteLength(text: string): number {
	return encoder.encode(text).length;
}

// Cut by code point, so that no character is left in halves. At least one
// stays: a name that still does not fit then fails where it is written, and
// is reported there as a path that cannot be written.
function shortened(name: string, maxBytes: number): string {
	if (byteLength(name) <= maxBytes) return name;
	const characters = Array.from(name);
	while (characters.length > 1 && byteLength(characters.join("")) > maxBytes) characters.pop();
	return characters.join("");
}
