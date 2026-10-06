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

// The name of the copy that keeps the vault's content of a file in conflict:
//
//   <name>.conflict-from-<device>-<YYYYMMDD-HHmmss>[-N].<extension>
//
// The form is the same in every language, and it is read back from the shape
// of the end of the file name alone, so that a copy made on another device,
// under a device name this one knows nothing about, is still recognized.

const MARK = ".conflict-from-";

/** What most file systems allow for one file name, in bytes of UTF-8. */
const MAX_NAME_BYTES = 255;

// A file name without its extension that ends the way a copy does. Both the
// name and the device name are greedy: of several marks in one name the last
// is the one that was added, and a device name may itself hold hyphens and
// digits.
const COPY_END = /^(.+)\.conflict-from-.+-\d{8}-\d{6}(?:-\d+)?$/s;

/**
 * The path of the conflict copy of `path`.
 *
 * - The extension is what follows the last `.` of the file name, so the copy
 *   of a note is still a note. A leading `.` does not start an extension:
 *   `.gitignore` has none, and what is added goes at its end.
 * - `deviceName` is the device that wrote the content the copy holds.
 * - `at` is read on the device's own clock, in local time.
 * - `attempt` is 1 for the plain name. From 2 on it is added before the
 *   extension, for when the plain name is taken by other content (two
 *   devices with one name).
 *
 * A file name longer than 255 bytes is shortened at the end of `<name>`,
 * between characters. The original path can then no longer be read back in
 * full, which is the price of a name that can be written at all.
 */
export function conflictCopyPath(path: string, deviceName: string, at: Date, attempt = 1): string {
	const slash = path.lastIndexOf("/");
	const folder = path.slice(0, slash + 1);
	const fileName = path.slice(slash + 1);
	const dot = fileName.lastIndexOf(".");
	const name = dot > 0 ? fileName.slice(0, dot) : fileName;
	const extension = dot > 0 ? fileName.slice(dot) : "";

	const added = `${MARK}${deviceName}-${stamp(at)}${attempt > 1 ? `-${attempt}` : ""}${extension}`;
	return folder + shortened(name, MAX_NAME_BYTES - byteLength(added)) + added;
}

/**
 * The path a conflict copy was made of, or `null` when `path` is not named
 * like one. Only the shape of the end of the file name is looked at, never
 * what the device name says.
 *
 * A copy of a copy gives the copy it was made of; ask again to get further.
 */
export function originalPathOfConflictCopy(path: string): string | null {
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
