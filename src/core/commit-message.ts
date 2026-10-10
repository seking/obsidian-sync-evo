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

// The message of the commit a push makes. English and of one fixed form in
// every language: it is read in `git log` on another machine, beside the
// commits git made there.

/** As `git show --stat` would name it: against the tree of the parent commit. */
export type CommitChangeKind = "added" | "modified" | "deleted";

export interface CommitChange {
	readonly kind: CommitChangeKind;
	/** As the tree spells it. */
	readonly path: string;
}

/** How many paths the body lists before it only counts the rest. */
export const COMMIT_BODY_LIMIT = 50;

const LETTERS: Readonly<Record<CommitChangeKind, string>> = { added: "A", modified: "M", deleted: "D" };

/**
 * `Sync Evo: <device> (<n> added, <n> modified, <n> deleted)`, a blank line,
 * and one line per path: the letter, two spaces, the path. A kind that
 * counts nothing is left out of the first line.
 *
 * The paths are sorted, and written as they are: no quotes and no escapes,
 * so that a name in Japanese reads as one. A rename is not looked for; it
 * is a `D` and an `A`.
 */
export function commitMessage(deviceName: string, changes: readonly CommitChange[]): string {
	const counts = (["added", "modified", "deleted"] as const)
		.map((kind) => ({ kind, count: changes.filter((change) => change.kind === kind).length }))
		.filter(({ count }) => count > 0)
		.map(({ kind, count }) => `${count} ${kind}`);
	return message(`Sync Evo: ${deviceOf(deviceName)} (${counts.join(", ")})`, changes);
}

/**
 * The message of the commit that untracks files: `Sync Evo: <device> untrack
 * <n> files`, a blank line, and a `D` line per path, as in any other commit
 * of a push. Told apart by its first line, since the files it takes out of
 * the remote were not deleted on the device.
 */
export function untrackMessage(deviceName: string, paths: readonly string[]): string {
	const files = paths.length === 1 ? "1 file" : `${paths.length} files`;
	return message(
		`Sync Evo: ${deviceOf(deviceName)} untrack ${files}`,
		paths.map((path): CommitChange => ({ kind: "deleted", path })),
	);
}

// A line break in the name would end the first line early.
function deviceOf(deviceName: string): string {
	const device = deviceName.replace(/\s+/g, " ").trim();
	return device === "" ? "unnamed device" : device;
}

function message(subject: string, changes: readonly CommitChange[]): string {
	const sorted = [...changes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const lines = sorted.slice(0, COMMIT_BODY_LIMIT).map((change) => `${LETTERS[change.kind]}  ${change.path}`);
	if (sorted.length > COMMIT_BODY_LIMIT) lines.push(`... and ${sorted.length - COMMIT_BODY_LIMIT} more`);
	return [subject, "", ...lines].join("\n");
}
