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

// The root `.gitignore` as a file of the vault: reading it so that "there
// is none" is told from "it cannot be read", writing it the way a pull
// writes a file, and adding the section Sync Evo keeps in it when it has
// none. What the section holds is `gitignore-section.ts`; what its rules do
// is `exclusion.ts`.
//
// The file is the one thing Sync Evo writes to the vault that did not come
// from the remote. Its rules decide what a push sends, so half of it must
// never be taken for all of it: every write goes through
// `writeRootGitignore`, which remembers what it is writing until it is
// written, and whoever reads the file as rules or writes it settles what is
// remembered first (`settleGitignoreWrite`).
//
// The write markers of a pull are not used for this. A marker says "the
// remote's content is being written here", and what resumes it stores a
// record of that content; of a text the remote never had, such a record
// would make the next pull write the remote's file over this one.

import type { EntryKind } from "./backend";
import { defaultSectionLines, type ExclusionPaths } from "./exclusion";
import { findSection, SECTION_END, SECTION_START, withSection } from "./gitignore-section";
import { foldedKey, pathKey } from "./paths";
import type { SyncRecord } from "./plan";
import { type PullVault, readWhole } from "./pull-io";
import { fromRoot, placeholderTarget } from "./scan";
import type { StateStore } from "./state";

export const ROOT_GITIGNORE = ".gitignore";

/**
 * Why a `.gitignore` that is there is not read.
 *
 * - "not-a-file": a folder of that name.
 * - "too-large": over the size limit, which is not synced either.
 * - "not-downloaded": a cloud drive has taken it off the device.
 * - "respelled": the vault spells it in another case (`.GITIGNORE`).
 * - "read-failed": the vault could not list the root, or read the file.
 * - "not-text": its bytes are not UTF-8. Written back from a text, the
 *   bytes that are not would change.
 */
export type UnreadableGitignore =
	| "not-a-file"
	| "too-large"
	| "not-downloaded"
	| "respelled"
	| "read-failed"
	| "not-text";

export type RootGitignore =
	/** The vault has none. */
	| { readonly kind: "absent" }
	/**
	 * `text` is every character of the file, a byte order mark at its start
	 * included, so that encoding it gives `content` back.
	 */
	| { readonly kind: "text"; readonly text: string; readonly content: Uint8Array }
	/** Something is there, and what it says is not known. */
	| { readonly kind: "unreadable"; readonly reason: UnreadableGitignore };

/**
 * Reads the `.gitignore` at the vault root. The root is listed and not only
 * asked for the name: where the cases are not told apart, the file system
 * answers for `.GITIGNORE` too, and a placeholder of a cloud drive has
 * another name altogether.
 */
export async function readRootGitignore(
	vault: Pick<PullVault, "list" | "stat" | "read">,
	sizeLimit: number,
): Promise<RootGitignore> {
	const raw = await readRaw(vault, sizeLimit);
	if (raw.kind !== "bytes") return raw;
	try {
		// The mark is kept: it is one of the bytes that must not change.
		const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw.content);
		return { kind: "text", text, content: raw.content };
	} catch {
		return { kind: "unreadable", reason: "not-text" };
	}
}

type RawGitignore =
	| { readonly kind: "absent" }
	| { readonly kind: "bytes"; readonly content: Uint8Array }
	| { readonly kind: "unreadable"; readonly reason: UnreadableGitignore };

// The bytes of the file, whatever they are: half of a text can end in the
// middle of a character.
async function readRaw(vault: Pick<PullVault, "list" | "stat" | "read">, sizeLimit: number): Promise<RawGitignore> {
	const unreadable = (reason: UnreadableGitignore): RawGitignore => ({ kind: "unreadable", reason });
	try {
		const listed = await vault.list("/");
		if (listed.folders.some((folder) => foldedKey(fromRoot(folder)) === ROOT_GITIGNORE)) return unreadable("not-a-file");
		const files = listed.files.map(fromRoot);
		const named = files.filter((path) => foldedKey(path) === ROOT_GITIGNORE);
		if (named.length === 0) {
			const evicted = files.some((path) => foldedKey(placeholderTarget(path) ?? "") === ROOT_GITIGNORE);
			if (evicted) return unreadable("not-downloaded");
			// Not listed and there all the same: nothing is known of it.
			return (await vault.stat(ROOT_GITIGNORE)) === null ? { kind: "absent" } : unreadable("read-failed");
		}
		if (named.length !== 1 || named[0] !== ROOT_GITIGNORE) return unreadable("respelled");
		const stat = await vault.stat(ROOT_GITIGNORE);
		if (stat === null) return unreadable("read-failed");
		if (stat.type !== "file") return unreadable("not-a-file");
		if (stat.size > sizeLimit) return unreadable("too-large");
		return { kind: "bytes", content: (await readWhole(vault, ROOT_GITIGNORE, stat)).content };
	} catch {
		return unreadable("read-failed");
	}
}

/** The key, among the other values of the sync state, of the write of the root `.gitignore` that is under way. */
export const GITIGNORE_WRITE_KEY = "gitignore-write";

/**
 * A write of the root `.gitignore` that has begun: stored before the file is
 * touched and removed once it holds `writing`. One that is still there when
 * a sync starts says that the file may hold half of `writing`. The texts
 * themselves are kept, and not their hashes: the file is small, and with the
 * text a half-written file can be told from one the user changed, and
 * finished. It goes with the sync state when that is discarded.
 */
interface GitignoreWriteMemory {
	/** The text of the file before the write, or `null` when there was no file. */
	readonly before: string | null;
	readonly writing: string;
}

function storedWrite(value: unknown): GitignoreWriteMemory | null {
	if (typeof value !== "object" || value === null) return null;
	const { before, writing } = value as { before?: unknown; writing?: unknown };
	if ((before !== null && typeof before !== "string") || typeof writing !== "string") return null;
	return { before, writing };
}

export interface GitignoreSettleDeps {
	readonly store: Pick<StateStore, "getMeta" | "deleteMeta">;
	readonly vault: Pick<PullVault, "list" | "stat" | "read" | "write">;
}

/**
 * Settles a write of the root `.gitignore` that did not get to its end
 * (`writeRootGitignore`). Called before the file is read as rules and before
 * it is written, by a pull, a push, and the settings alike, also where the
 * remote has no commit. Answers whether the file can be gone by: `false`
 * when what is remembered could not be settled, and stays remembered.
 *
 * By what the file holds now:
 *
 * - the text that was being written: the write was done. Forgotten.
 * - the text from before the write, or no file as before it: nothing was
 *   written. Forgotten.
 * - the start of the text that was being written, down to nothing at all,
 *   and not the text from before: half a file. The text is written again,
 *   and then forgotten. When that fails it stays remembered.
 * - anything else, no file where there was one included: the user or
 *   another tool has changed the file since. It is theirs. Forgotten.
 * - nothing that can be read (a cloud drive has it, a folder, another
 *   case): it stays remembered.
 *
 * No record is stored or changed, whichever it is. To the pull and the push
 * after it the file is one that was edited on this device: sent where the
 * remote did not change it, and kept as a copy of a conflict where it did.
 * Never deleted, and never written over without a trace.
 *
 * A failure of the sync state is thrown.
 */
export async function settleGitignoreWrite(deps: GitignoreSettleDeps): Promise<boolean> {
	const { store, vault } = deps;
	const memory = storedWrite(await store.getMeta(GITIGNORE_WRITE_KEY));
	if (memory === null) return true;
	const writing = new TextEncoder().encode(memory.writing);
	// Whatever its size: a file that grew past the limit since is one the
	// user changed, and has to be told from half a file all the same.
	const now = await readRaw(vault, Number.POSITIVE_INFINITY);
	if (now.kind === "unreadable") return false;
	const half =
		now.kind === "bytes" &&
		now.content.length < writing.length &&
		startsWith(writing, now.content) &&
		(memory.before === null || !sameBytes(now.content, new TextEncoder().encode(memory.before)));
	if (half) {
		try {
			await vault.write(ROOT_GITIGNORE, writing);
		} catch {
			return false;
		}
	}
	await store.deleteMeta(GITIGNORE_WRITE_KEY);
	return true;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && startsWith(a, b);
}

function startsWith(whole: Uint8Array, start: Uint8Array): boolean {
	if (start.length > whole.length) return false;
	for (let index = 0; index < start.length; index++) {
		if (whole[index] !== start[index]) return false;
	}
	return true;
}

/**
 * - "written": the file holds the text.
 * - "changed": the file is no longer what the caller read. Nothing was
 *   written.
 * - "refused": the vault would not write, and the file is as it was.
 * - "unsettled": the file cannot be gone by: the vault failed while writing
 *   and it may hold half of the text, or a write from before could not be
 *   settled. What is remembered of the write stays, so that no push goes by
 *   its rules (`gitignore-unsettled` in `push.ts`) until it is settled.
 */
export type GitignoreWrite = "written" | "changed" | "refused" | "unsettled";

export interface GitignoreWriteDeps {
	readonly store: Pick<StateStore, "getMeta" | "setMeta" | "deleteMeta">;
	readonly vault: Pick<PullVault, "list" | "stat" | "read" | "write">;
}

/**
 * Writes the root `.gitignore`: the write is remembered, made, and
 * forgotten. Stopped in between, it is still remembered, and whoever comes
 * to the file next settles it first (`settleGitignoreWrite`); so does this,
 * with a write from before. `before` is the text the new one was made from
 * (`RootGitignore`), or `null` when there was no file; with anything else at
 * the path by the time the write is remembered, nothing is written.
 *
 * No record is stored: the text is not the remote's, and the file is to
 * read as edited, which is what makes the next push send it.
 *
 * A failure of the sync state is thrown.
 */
export async function writeRootGitignore(
	deps: GitignoreWriteDeps,
	text: string,
	before: string | null,
): Promise<GitignoreWrite> {
	const { store, vault } = deps;
	if (!(await settleGitignoreWrite(deps))) return "unsettled";
	const content = new TextEncoder().encode(text);
	const expected = before === null ? null : new TextEncoder().encode(before);
	// Whether the file is what the caller read. `null` when the vault could
	// not tell.
	const untouched = async (): Promise<boolean | null> => {
		const now = await readRaw(vault, Number.POSITIVE_INFINITY);
		if (now.kind === "unreadable") return now.reason === "read-failed" ? null : false;
		if (now.kind === "absent" || expected === null) return now.kind === "absent" && expected === null;
		return sameBytes(now.content, expected);
	};

	const memory: GitignoreWriteMemory = { before, writing: text };
	await store.setMeta(GITIGNORE_WRITE_KEY, memory);
	// The last look, with nothing of this left in between: an edit that
	// landed since the file was read is not written over.
	if ((await untouched()) !== true) {
		await store.deleteMeta(GITIGNORE_WRITE_KEY);
		return "changed";
	}
	try {
		await vault.write(ROOT_GITIGNORE, content);
	} catch {
		// A write that failed may have left half a file. Then it stays
		// remembered. When the path is as it was, nothing was begun.
		if ((await untouched()) !== true) return "unsettled";
		await store.deleteMeta(GITIGNORE_WRITE_KEY);
		return "refused";
	}
	await store.deleteMeta(GITIGNORE_WRITE_KEY);
	return "written";
}

/**
 * Whether the remote's root `.gitignore` is the one this device last synced:
 * the record has the hash the listing has, or there is neither. Only then is
 * the section added. A file the remote changed since is not sent by a push
 * (the plan sends only what the remote has not changed since the record), so
 * a section added to it would stay on this device alone, and become a
 * conflict with the remote's file at the next pull.
 */
export function isGitignoreAsRecorded(
	remote: readonly { readonly path: string; readonly kind: EntryKind; readonly hash: string }[],
	records: readonly SyncRecord[],
): boolean {
	const entries = remote.filter((entry) => foldedKey(entry.path) === ROOT_GITIGNORE);
	const recorded = records.filter((record) => foldedKey(record.path) === ROOT_GITIGNORE);
	if (entries.length === 0 && recorded.length === 0) return true;
	const [entry] = entries;
	const [record] = recorded;
	if (entries.length !== 1 || recorded.length !== 1 || entry === undefined || record === undefined) return false;
	return (
		entry.kind === "file" && pathKey(entry.path) === ROOT_GITIGNORE && record.kind === "file" && record.hash === entry.hash
	);
}

/**
 * Why the section was not added.
 *
 * - "present": the file has one, an empty one included: nothing to do.
 * - "broken": it has markers that enclose no section. Where one would go
 *   is the user's to put right.
 * - "over-limit": with the section the file would be over the size limit.
 * - `UnreadableGitignore`: the file is there and was not read.
 * - "changed", "refused": the write was not made (`GitignoreWrite`).
 */
export type SectionLeftReason = "present" | "broken" | "over-limit" | UnreadableGitignore | "changed" | "refused";

export type SectionAddition =
	| {
			readonly kind: "added";
			/** Every line that was put at the top, the two markers included. */
			readonly lines: readonly string[];
			/** Whether the vault had no `.gitignore`, and has one now. */
			readonly created: boolean;
			/** The text the file has now. */
			readonly text: string;
	  }
	| { readonly kind: "left"; readonly reason: SectionLeftReason }
	/** The file cannot be gone by (`GitignoreWrite` "unsettled"). */
	| { readonly kind: "unsettled" };

export interface AddSectionDeps extends GitignoreWriteDeps {
	readonly vault: Pick<PullVault, "list" | "stat" | "read" | "write">;
	readonly paths: ExclusionPaths;
	readonly sizeLimit: number;
}

/**
 * Puts the default section at the top of a root `.gitignore` that has no
 * section, or makes the file with it. Not one byte of what the file held
 * changes (`withSection`). Nothing is asked: without the section its lines
 * are applied all the same (`effectiveRules`), and written down they also
 * reach git on a Mac.
 *
 * Whether this is the moment for it is the caller's to say: only where a
 * push follows that sends the file.
 */
export async function addDefaultSection(deps: AddSectionDeps): Promise<SectionAddition> {
	const current = await readRootGitignore(deps.vault, deps.sizeLimit);
	if (current.kind === "unreadable") return { kind: "left", reason: current.reason };
	const before = current.kind === "text" ? current : null;
	const found = findSection(before?.text ?? "").kind;
	if (found !== "none") return { kind: "left", reason: found === "found" ? "present" : "broken" };

	const rules = defaultSectionLines(deps.paths);
	const text = withSection(before?.text ?? null, rules);
	if (new TextEncoder().encode(text).length > deps.sizeLimit) return { kind: "left", reason: "over-limit" };
	const written = await writeRootGitignore(deps, text, before?.text ?? null);
	if (written === "unsettled") return { kind: "unsettled" };
	if (written !== "written") return { kind: "left", reason: written };
	return { kind: "added", lines: [SECTION_START, ...rules, SECTION_END], created: before === null, text };
}
