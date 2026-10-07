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

// Which copies belong to one file, and what the next copy of it is called.
// Built on the form of the name alone (`conflict-name.ts`).

import { conflictCopyPath, originalPathOfConflictCopy } from "./conflict-name";
import { pathKey } from "./paths";

// The same shape `conflict-name.ts` reads, with the number at the end apart.
const COPY_PARTS = /^(.+\.conflict-from-.+-\d{8}-\d{6})(?:-(\d+))?$/s;

interface CopyParts {
	/** The path up to and including the time. */
	readonly stem: string;
	/** 1 for a name without a number. */
	readonly attempt: number;
	readonly extension: string;
}

function copyParts(path: string): CopyParts | null {
	const slash = path.lastIndexOf("/");
	const folder = path.slice(0, slash + 1);
	const fileName = path.slice(slash + 1);
	// Without an extension first, as the name is read back there.
	const whole = COPY_PARTS.exec(fileName);
	if (whole !== null) return partsOf(folder, whole, "");
	const dot = fileName.lastIndexOf(".");
	if (dot <= 0) return null;
	const stem = COPY_PARTS.exec(fileName.slice(0, dot));
	return stem === null ? null : partsOf(folder, stem, fileName.slice(dot));
}

function partsOf(folder: string, match: RegExpExecArray, extension: string): CopyParts {
	return {
		stem: folder + (match[1] ?? ""),
		attempt: match[2] === undefined ? 1 : Number(match[2]),
		extension,
	};
}

/**
 * The `n`th name to try (from 1) for the copy that keeps the vault's content
 * of `path`.
 *
 * A file that is itself a copy gets no copy of a copy: its content goes to
 * the same name with the next number (`-2`, `-3`), as if the plain name had
 * been taken. The number the file itself has is passed over.
 */
export function copyCandidate(path: string, deviceName: string, at: Date, n: number): string {
	const parts = copyParts(path);
	if (parts === null) return conflictCopyPath(path, deviceName, at, n);
	// 2, 3, … without the file's own number.
	const number = n + 1 < parts.attempt || parts.attempt === 1 ? n + 1 : n + 2;
	return `${parts.stem}-${number}${parts.extension}`;
}

/**
 * The name under which the copies of one file are found. For a file that is
 * not a copy: its own key, which is what every copy of it gives as its
 * original. For a copy: its name without the number, shared by the names its
 * content can go to.
 */
function familyOf(path: string): string {
	const parts = copyParts(path);
	return parts === null ? `file:${pathKey(path)}` : `copy:${pathKey(parts.stem + parts.extension)}`;
}

/**
 * The copies among a list of paths, by the file they keep content of. Asked
 * when a conflict is about to make a copy: one that is already there with
 * the same content is used instead, so that a pull that is carried out twice
 * leaves one copy and not two with different times.
 */
export class CopyIndex {
	private readonly families = new Map<string, string[]>();

	constructor(paths: Iterable<string> = []) {
		for (const path of paths) this.add(path);
	}

	add(path: string): void {
		const original = originalPathOfConflictCopy(path);
		if (original === null) return;
		const parts = copyParts(path);
		const families = [`file:${pathKey(original)}`];
		if (parts !== null) families.push(`copy:${pathKey(parts.stem + parts.extension)}`);
		for (const family of families) {
			const group = this.families.get(family);
			if (group === undefined) this.families.set(family, [path]);
			else if (!group.includes(path)) group.push(path);
		}
	}

	/** The paths that may already keep content of `path`. Never `path` itself. */
	copiesOf(path: string): readonly string[] {
		const key = pathKey(path);
		return (this.families.get(familyOf(path)) ?? []).filter((copy) => pathKey(copy) !== key);
	}
}
