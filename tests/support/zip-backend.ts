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

import { zipSync } from "fflate";
import type { ArchiveContents, ListResult } from "../../src/core/backend";
import { openZip } from "../../src/core/zip";
import { bytes, type FileContent, MemoryBackend } from "./memory-backend";

/** The folder a host puts every entry of the zip of a commit in. */
export const TOP_FOLDER = "owner-repo-0123abc";

/** A zip of the files, each below `TOP_FOLDER`, with an entry for the folder itself as `git archive` writes one. */
export function zipOf(files: Iterable<readonly [string, Uint8Array]>): Uint8Array {
	const entries: Record<string, Uint8Array> = { [`${TOP_FOLDER}/`]: new Uint8Array() };
	for (const [path, content] of files) entries[`${TOP_FOLDER}/${path}`] = content;
	return zipSync(entries);
}

/**
 * A memory remote that also has an archive: a real zip of the revision
 * asked for, built when it is asked for. A test can bend what the zip holds
 * (as a host's `git archive` does), what the listing says, and how the
 * request ends.
 */
export class ZipBackend extends MemoryBackend {
	/** The revisions an archive was asked for, in order. */
	readonly zipRequests: string[] = [];
	/** The paths that were taken out of an archive, in order. */
	readonly inflated: string[] = [];
	/** Paths the zip leaves out (`export-ignore`). */
	readonly omitted = new Set<string>();
	/** Paths the zip holds with another content (`export-subst`, converted line ends), and entries no listing has. */
	readonly zipped = new Map<string, FileContent>();
	/** Paths the listing calls symlinks. */
	readonly symlinks = new Set<string>();
	/** Sizes the listing gives in place of the real ones. */
	readonly listedSizes = new Map<string, number>();
	/** A path the archive fails to give the content of, as a zip that is damaged from there on. */
	unreadable: string | undefined;
	/** What reading `unreadable` throws, in place of an error of the zip. */
	readFailure: unknown = undefined;
	/** Thrown by the next requests for an archive, while set. */
	zipFailure: unknown = undefined;
	/** Awaited by a request for an archive before it answers. */
	beforeZip: ((revision: string) => Promise<void> | void) | undefined;

	override async list(known: string | null): Promise<ListResult> {
		const listed = await super.list(known);
		if (!listed.changed) return listed;
		const entries = listed.listing.entries.map((entry) => {
			const size = this.listedSizes.get(entry.path);
			return {
				...entry,
				...(this.symlinks.has(entry.path) ? ({ kind: "symlink" } as const) : {}),
				...(size === undefined ? {} : { size }),
			};
		});
		return { changed: true, listing: { revision: listed.listing.revision, entries } };
	}

	async fetchArchive(revision: string): Promise<ArchiveContents> {
		this.zipRequests.push(revision);
		await this.beforeZip?.(revision);
		if (this.zipFailure !== undefined) throw this.zipFailure;
		const files = this.filesAt(revision);
		for (const path of this.omitted) files.delete(path);
		for (const [path, content] of this.zipped) files.set(path, bytes(content));
		const archive = openZip(zipOf(files), { stripTopFolder: true });
		return {
			byteLength: archive.byteLength,
			sizeOf: (path) => archive.sizeOf(path),
			read: (path) => {
				if (path === this.unreadable) throw this.readFailure ?? new Error(`zip: an entry is cut short: ${path}`);
				this.inflated.push(path);
				return archive.read(path);
			},
		};
	}
}
