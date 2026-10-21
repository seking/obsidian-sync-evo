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

/**
 * The path of a conflict copy of the earlier form, beside its file, as
 * versions up to 0.2.0 made it:
 *
 *   <name>.conflict-from-<device>-<YYYYMMDD-HHmmss>[-N].<extension>
 *
 * Nothing makes such a name any more; a vault can hold them, and a test of
 * how they are read needs one.
 */
export function earlierCopyPath(path: string, deviceName: string, at: Date, attempt = 1): string {
	const slash = path.lastIndexOf("/");
	const folder = path.slice(0, slash + 1);
	const fileName = path.slice(slash + 1);
	const dot = fileName.lastIndexOf(".");
	const name = dot > 0 ? fileName.slice(0, dot) : fileName;
	const extension = dot > 0 ? fileName.slice(dot) : "";
	const two = (value: number): string => String(value).padStart(2, "0");
	const date = `${String(at.getFullYear()).padStart(4, "0")}${two(at.getMonth() + 1)}${two(at.getDate())}`;
	const time = `${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`;
	return `${folder}${name}.conflict-from-${deviceName}-${date}-${time}${attempt > 1 ? `-${attempt}` : ""}${extension}`;
}
