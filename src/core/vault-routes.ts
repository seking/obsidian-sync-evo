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

// The decisions about reaching a file of the vault that need nothing of the
// app: which of its two ways a path goes, which call takes a file away, and
// which of the names in a folder a wanted name is. They are here, and not
// beside the calls, so that they can be tested.

import { foldedKey, pathKey } from "./paths";
import type { TrashMode } from "./pull-io";

/**
 * Whether a name on the way starts with a `.` (`.github/a.yml`,
 * `notes/.x/a.md`, `.hidden.md`). The app's own index of the vault leaves
 * such a path out, so it is read and written through the data adapter.
 */
export function isDotPath(path: string): boolean {
	return path.split("/").some((part) => part.startsWith("."));
}

/** The folder a path is in; empty for a path at the root. */
export function parentOf(path: string): string {
	return path.slice(0, Math.max(path.lastIndexOf("/"), 0));
}

/** The last name of a path. */
export function lastOf(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

/** `name` in `folder`; the root is the empty folder. */
export function joinPath(folder: string, name: string): string {
	return folder === "" ? name : `${folder}/${name}`;
}

/** Every folder on the way to a path, from the top down: `a/b/c.md` gives `a`, `a/b`. */
export function foldersTo(path: string): string[] {
	const folders: string[] = [];
	for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
		folders.push(path.slice(0, slash));
	}
	return folders;
}

/**
 * The app's setting for deleted files: the system trash, the `.trash/` of
 * the vault, or deleting for good.
 */
export type TrashOption = "system" | "local" | "none";

/**
 * The setting as the app stores it, or `null` when what was read is not one
 * of the three. The setting is read through a call that is not part of the
 * public API, so anything can come back.
 */
export function trashOptionOf(value: unknown): TrashOption | null {
	return value === "system" || value === "local" || value === "none" ? value : null;
}

/**
 * The call that takes a file out of the vault.
 *
 * - "file-manager": `fileManager.trashFile`, which follows the setting.
 * - "vault-local": `vault.trash(file, false)`, the `.trash/` of the vault.
 * - "adapter-system": `adapter.trashSystem`, then `adapter.trashLocal` when
 *   it answers that there is no system trash.
 * - "adapter-local": `adapter.trashLocal`.
 * - "adapter-remove": `adapter.remove`, for good.
 */
export type TrashRoute = "file-manager" | "vault-local" | "adapter-system" | "adapter-local" | "adapter-remove";

/**
 * Which call takes a file away. `indexed` is whether the app's index holds
 * the file: its own calls only take a file of the index. `option` is the
 * setting, or `null` when it could not be read.
 *
 * A file moved away to protect its content always goes to the `.trash/` of
 * the vault. An ordinary deletion follows the setting, and one that could
 * not be read counts as `.trash/`: rather kept than gone.
 */
export function trashRoute(mode: TrashMode, indexed: boolean, option: TrashOption | null): TrashRoute {
	if (mode === "vault-trash") return indexed ? "vault-local" : "adapter-local";
	if (indexed) return "file-manager";
	switch (option) {
		case "system":
			return "adapter-system";
		case "none":
			return "adapter-remove";
		case "local":
		case null:
			return "adapter-local";
	}
}

/**
 * Which of the names a folder holds is the wanted one, or `null` for none.
 *
 * A name that is the same but for its Unicode form wins: on a file system
 * that tells the cases apart, `Notes.md` beside `notes.md` are two files,
 * and the one that was asked for is the one that is spelled so. Failing
 * that, a single name that differs in case is the same file on a file
 * system that does not tell the cases apart. The caller only asks after the
 * file system said that something is at the wanted name, so such a name is
 * that something. More than one of them is no answer.
 */
export function pickSpelling(names: readonly string[], wanted: string): string | null {
	const key = pathKey(wanted);
	const exact = names.find((name) => name === wanted) ?? names.find((name) => pathKey(name) === key);
	if (exact !== undefined) return exact;
	const folded = foldedKey(wanted);
	const [first, ...others] = names.filter((name) => foldedKey(name) === folded);
	return first !== undefined && others.length === 0 ? first : null;
}

/**
 * Whether a rename from one path to the other could be a rename of a file
 * onto its own name: the two differ in nothing but case and Unicode form.
 * Only then can something found at the new name be the file itself.
 */
export function differOnlyInSpelling(from: string, to: string): boolean {
	return foldedKey(from) === foldedKey(to);
}

/**
 * What is put at the end of a name to make the name a rename goes through
 * where the app refuses a change of case alone (`RoutedVault.rename`):
 * `Tools` → `Tools.sync-evo-renaming` → `Tools`. Not at the start, so that a
 * path keeps the way it goes (`isDotPath`). Of characters every platform
 * takes in a name, and in no form a conflict copy has.
 */
export const RENAMING_MARK = ".sync-evo-renaming";

/** The path a rename of `path` onto its own name in another case goes through. */
export function renamingPath(path: string): string {
	return `${path}${RENAMING_MARK}`;
}

/**
 * Whether a name is one a rename went through (`RENAMING_MARK`). Without the
 * cases, like the fixed exclusions: such a name is never synced.
 */
export function isRenamingName(name: string): boolean {
	return name.length > RENAMING_MARK.length && foldedKey(name).endsWith(RENAMING_MARK);
}

/**
 * The path a rename went through that `path` is at or below, or `null` for
 * none: `Tools.sync-evo-renaming/a.md` gives `Tools.sync-evo-renaming`. The
 * one nearest the root, when there are more.
 */
export function renamingPathOf(path: string): string | null {
	const parts = path.split("/");
	const at = parts.findIndex(isRenamingName);
	return at === -1 ? null : parts.slice(0, at + 1).join("/");
}

/** The path a rename that went through `path` was to: the mark taken off its end. */
export function withoutRenamingMark(path: string): string {
	return path.slice(0, path.length - RENAMING_MARK.length);
}
