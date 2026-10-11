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

// Which copies of the earlier form (`conflict-name.ts`) belong together. A
// copy that was itself in conflict used to leave its content under its own
// name with another number (`-2`, `-3`); no copy is named so any more, but
// the ones a remote holds are still told to be of one conflict
// (`knownPaths` in `exclusion.ts`). Built on the form of the name alone.

import { isCopyInConflictFolder } from "./conflict-name";
import { foldedKey } from "./paths";

// The same shape `conflict-name.ts` reads, with the number at the end apart.
const COPY_PARTS = /^(.+\.conflict-from-.+-\d{8}-\d{6})(?:-(\d+))?$/s;

interface CopyParts {
	/** The path up to and including the time. */
	readonly stem: string;
	readonly extension: string;
}

function copyParts(path: string): CopyParts | null {
	// As the name is read back: never a copy in the folder of the copies.
	if (isCopyInConflictFolder(path)) return null;
	const slash = path.lastIndexOf("/");
	const folder = path.slice(0, slash + 1);
	const fileName = path.slice(slash + 1);
	// Without an extension first, as the name is read back there.
	const whole = COPY_PARTS.exec(fileName);
	if (whole !== null) return { stem: folder + (whole[1] ?? ""), extension: "" };
	const dot = fileName.lastIndexOf(".");
	if (dot <= 0) return null;
	const stem = COPY_PARTS.exec(fileName.slice(0, dot));
	return stem === null ? null : { stem: folder + (stem[1] ?? ""), extension: fileName.slice(dot) };
}

/**
 * What a copy of the earlier form shares with the other names its content
 * could go to (the same name, but for the number), or `null` when `path` is
 * not named like such a copy.
 *
 * Without the cases (`foldedKey`): a copy is listed as the disk spells it,
 * and asked for by the path of the remote, whose folders the disk may spell
 * otherwise.
 */
export function copyFamilyOf(path: string): string | null {
	const parts = copyParts(path);
	return parts === null ? null : `copy:${foldedKey(parts.stem + parts.extension)}`;
}
