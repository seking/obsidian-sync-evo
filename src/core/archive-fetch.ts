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

// How the contents of a pull are fetched: all at once, as the archive (zip)
// of the commit, or one file at a time. The pull decides what to fetch; this
// decides the means, and is the one place that does, for every remote.
//
// The archive is one request whatever the number of files, but it holds the
// whole commit and is in memory in one piece, and a device that has not the
// room for it does not fail: the app is killed. So an attempt is marked in
// the sync state before it starts, and a mark that is still there the next
// time is all that tells of an attempt that did not end. Whether the archive
// can be used is a matter of the device and not of the remote, which is why
// none of this is in a backend.

import { type ArchiveContents, type Backend, BackendError, type RemoteEntry, type RemoteListing } from "./backend";
import { type ContentSource, SourcedStateError, type SourcedFile } from "./pull-io";
import type { StateStore } from "./state";

/**
 * Up to this many files are fetched one by one; the archive is for more.
 * One by one, 1,000 files take about as long as an archive of the largest
 * size that is tried, and use a fifth of an hour's requests.
 */
export const ARCHIVE_FILE_THRESHOLD = 1000;

/**
 * The largest archive that is tried, by its estimated size, in bytes. A
 * phone took one of 170 MB and was killed over one of about 310 MB; the app
 * needs memory of its own beside it.
 */
export const MAX_ARCHIVE_ESTIMATE_BYTES = 150 * 1024 * 1024;

/** How often an attempt that did not end is made again before the archive is given up on this device. */
export const MAX_ARCHIVE_RETRIES = 1;

/**
 * The extensions of files that are compressed already, in lower case. An
 * archive holds such a file at about its size. What shrinks (`svg`, `bmp`,
 * `wav`, `tiff`, `ttf`, `otf`) is left out on purpose.
 */
export const COMPRESSED_EXTENSIONS: ReadonlySet<string> = new Set([
	// Images
	...["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "avif"],
	"pdf",
	// Video
	...["mp4", "mov", "m4v", "webm", "mkv", "avi"],
	// Audio
	...["mp3", "m4a", "aac", "ogg", "opus", "flac"],
	// Archives
	...["zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "zst"],
	// Documents that are zips inside
	...["docx", "xlsx", "pptx", "epub"],
	// Fonts
	...["woff", "woff2"],
]);

/** How much of its size a file that is not compressed already is taken to keep in an archive. */
export const ASSUMED_COMPRESSION_RATIO = 0.5;

function isCompressed(path: string): boolean {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	return dot >= 0 && COMPRESSED_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/**
 * About how large the archive of a listing is, in bytes. Its real size is
 * not known before it is fetched. `entries` is every entry of the listing,
 * also those that are not fetched: the archive holds the whole commit. An
 * entry without a size counts as empty.
 */
export function estimateArchiveSize(entries: readonly RemoteEntry[]): number {
	let compressed = 0;
	let other = 0;
	for (const entry of entries) {
		const size = entry.size ?? 0;
		if (isCompressed(entry.path)) compressed += size;
		else other += size;
	}
	return compressed + Math.ceil(other * ASSUMED_COMPRESSION_RATIO);
}

export type FetchMeans = "archive" | "per-file";

export interface FetchMeansInput {
	/** How many files the pull decided to fetch. */
	readonly fetchCount: number;
	/** `estimateArchiveSize` of the whole listing. */
	readonly estimate: number;
	/** Whether this device remembers not to use the archive. */
	readonly disabled: boolean;
	/** Whether the remote has an archive to fetch. */
	readonly available: boolean;
}

/** The means for one pull. Everything it goes by is in `input`. */
export function chooseFetchMeans(input: FetchMeansInput): FetchMeans {
	if (!input.available || input.disabled) return "per-file";
	if (input.fetchCount <= ARCHIVE_FILE_THRESHOLD) return "per-file";
	if (input.estimate > MAX_ARCHIVE_ESTIMATE_BYTES) return "per-file";
	return "archive";
}

// ---------------------------------------------------------------------------
// What the sync state remembers of it. Both go when the state is discarded.

/**
 * The key of the mark of an attempt that is under way: from before the
 * archive is asked for until the first file out of it has been dealt with.
 * Its value is `{ retries }`, how many attempts before this one did not end.
 */
export const ARCHIVE_ATTEMPT_KEY = "archive-attempt";

/** The key of the memory that this device does not use the archive. `true`, or absent. */
export const ARCHIVE_DISABLED_KEY = "archive-disabled";

type MetaStore = Pick<StateStore, "getMeta" | "setMeta" | "deleteMeta">;

/**
 * `store`, with every failure of it thrown as a `SourcedStateError`. What a
 * source of contents throws is otherwise taken for a failure to fetch, which
 * leaves the files for the next sync; a sync state that does not answer ends
 * the pull, here as everywhere else.
 */
function stateOf(store: MetaStore): MetaStore {
	const guard = async <T>(work: () => Promise<T>): Promise<T> => {
		try {
			return await work();
		} catch (error) {
			throw new SourcedStateError(error);
		}
	};
	return {
		getMeta: (key) => guard(() => store.getMeta(key)),
		setMeta: (key, value) => guard(() => store.setMeta(key, value)),
		deleteMeta: (key) => guard(() => store.deleteMeta(key)),
	};
}

/** The attempt that is marked, or `null`. A mark that cannot be read is one of a first attempt. */
async function readAttempt(store: MetaStore): Promise<{ readonly retries: number } | null> {
	const value = await store.getMeta(ARCHIVE_ATTEMPT_KEY);
	if (value === undefined || value === null) return null;
	const retries = typeof value === "object" ? (value as { retries?: unknown }).retries : undefined;
	return { retries: typeof retries === "number" && retries > 0 ? Math.floor(retries) : 0 };
}

/** Whether this device remembers not to use the archive. */
export async function isArchiveDisabled(store: Pick<StateStore, "getMeta">): Promise<boolean> {
	return (await store.getMeta(ARCHIVE_DISABLED_KEY)) === true;
}

// ---------------------------------------------------------------------------
// The source

/**
 * What is shown while the archive is on its way. No count moves then: the
 * download is one request that tells nothing until it is over.
 *
 * - "waiting": nothing is asked for yet. An archive that a pull which was
 *   stopped had asked for is still on its way (`ArchiveGate`).
 * - "downloading": a first attempt.
 * - "retrying": the attempt before this one did not end. The user is told
 *   to keep the app in front.
 */
export type ArchiveDownload = "waiting" | "downloading" | "retrying";

/**
 * Keeps the request for an archive that is on its way, across pulls. A pull
 * that is stopped does not wait for the archive it asked for, and the
 * request cannot be taken back: it goes on, and what it answers is in
 * memory until it is dropped. A pull started meanwhile waits for it to end
 * before it asks for an archive itself. Two archives at once are more than
 * a device can be expected to hold, and an app killed over them would leave
 * the mark of the second attempt, which had no part in it.
 *
 * One of these is kept by whoever starts the pulls, and lives as long as
 * the app does: a request does not outlive the app.
 */
export class ArchiveGate {
	private request: Promise<void> | null = null;

	/** Resolves when the request that is on its way has ended, however it ends; `null` when none is. */
	get pending(): Promise<void> | null {
		return this.request;
	}

	hold(request: Promise<unknown>): void {
		const ended: Promise<void> = request
			.then(
				() => {},
				() => {},
			)
			.then(() => {
				if (this.request === ended) this.request = null;
			});
		this.request = ended;
	}
}

export interface ArchiveSourceDeps {
	readonly store: MetaStore;
	readonly backend: Pick<Backend, "hashContent" | "fetchArchive">;
	/** The listing the pull works from: all of it, for the estimate. */
	readonly listing: RemoteListing;
	/** Yields files one at a time. Used for whatever the archive is not. */
	readonly perFile: ContentSource;
	/** Aborted when the user stops the sync. */
	readonly signal?: AbortSignal;
	/** Where the request for the archive is kept while it is on its way. Without one, nothing is waited for. */
	readonly gate?: ArchiveGate;
	/** For the record: the estimate and the real size, to see later whether the estimate holds. */
	readonly log?: (message: string) => void;
	/**
	 * Called when the download of the archive starts, and with `null` when
	 * it is over, however it ends. In the same way around the wait for a
	 * request of a pull before this one ("waiting").
	 */
	readonly onDownload?: (download: ArchiveDownload | null) => void;
	/**
	 * Called with the number of files that were asked of the archive and
	 * not taken from it: missing there, or not the content the listing has.
	 * They are fetched one at a time after it.
	 */
	readonly onRefetch?: (count: number) => void;
}

/**
 * A source of contents that chooses its means each time it is asked: the
 * archive when there are many files to fetch and this device can be
 * expected to hold it, `perFile` otherwise. Either way every entry asked for
 * is yielded once, unless the fetching fails.
 *
 * With the archive, in this order:
 *
 * 1. An archive that a stopped pull asked for and that is still on its way
 *    is waited for (`ArchiveGate`). Then the attempt is marked in the sync
 *    state, and the archive is fetched. In that order: an app that is
 *    killed during the wait leaves no mark.
 * 2. Each entry asked for is taken out of it, one at a time, hashed, and
 *    yielded when it has the hash the listing gave. The hash goes along
 *    (`SourcedFile.hash`), so that it is not computed a second time where
 *    the file is written. No other entry of the archive is ever read.
 * 3. The mark is taken away when the consumer comes back for the file after
 *    the first: it has dealt with one file out of the archive by then, and
 *    a device that got that far can hold the archive. It is also taken away
 *    when the archive fails as an error and when the consumer stops. Only
 *    an app that is killed leaves it.
 * 4. What the archive did not give (left out of it, of another content, or
 *    everything that was not yielded yet when it failed) is fetched with
 *    `perFile`, in the same pull.
 *
 * A mark that is found, left by an attempt that did not end: the archive is
 * tried once more, with the user told to keep the app in front. A mark left
 * by that attempt as well makes this device remember not to use the archive.
 * Why an attempt did not end is not told apart.
 *
 * A failure that says something about the device (a redirect it did not
 * follow, or no memory for the archive) is remembered in the same way. Any
 * other is not, and the next pull tries the archive again: see
 * `saysDeviceCannot`.
 *
 * A failure of the sync state is not one of the fetching: it is thrown as a
 * `SourcedStateError`, and ends the pull.
 */
export function archiveContentSource(deps: ArchiveSourceDeps): ContentSource {
	return (revision, entries) => fetchByMeans(deps, revision, entries);
}

async function* fetchByMeans(
	deps: ArchiveSourceDeps,
	revision: string | null,
	entries: readonly RemoteEntry[],
): AsyncGenerator<SourcedFile, void, void> {
	const { backend, signal } = deps;
	const store = stateOf(deps.store);
	const log = deps.log ?? ((): void => {});

	let left = await readAttempt(store);
	let disabled = await isArchiveDisabled(store);
	if (left !== null && left.retries >= MAX_ARCHIVE_RETRIES) {
		// Twice in a row. Whatever the reason, it is not tried for ever.
		await store.setMeta(ARCHIVE_DISABLED_KEY, true);
		await store.deleteMeta(ARCHIVE_ATTEMPT_KEY);
		log("archive: two attempts in a row did not end. This device fetches one file at a time from now on.");
		disabled = true;
		left = null;
	}

	const estimate = estimateArchiveSize(deps.listing.entries);
	const fetchArchive = backend.fetchArchive?.bind(backend);
	const means =
		revision === null || fetchArchive === undefined
			? "per-file"
			: chooseFetchMeans({ fetchCount: entries.length, estimate, disabled, available: true });
	log(
		`fetch: ${entries.length} files to fetch, archive estimated at ${estimate} bytes` +
			`${disabled ? ", archive not used on this device" : ""}: ${means}`,
	);
	if (revision === null || fetchArchive === undefined || means === "per-file") {
		// A mark that is left stays for the next time the archive is chosen.
		yield* deps.perFile(revision, entries);
		return;
	}

	const earlier = deps.gate?.pending ?? null;
	if (earlier !== null) {
		log("archive: waiting for the request of a pull that was stopped to end");
		deps.onDownload?.("waiting");
		try {
			// Thrown when the user stops this pull as well: nothing was begun.
			await untilAborted(earlier, signal);
		} finally {
			deps.onDownload?.(null);
		}
	}

	await store.setMeta(ARCHIVE_ATTEMPT_KEY, { retries: left === null ? 0 : left.retries + 1 });
	let marked = true;
	const unmark = async (): Promise<void> => {
		if (!marked) return;
		marked = false;
		await store.deleteMeta(ARCHIVE_ATTEMPT_KEY);
	};

	// Not yielded yet, in the order asked for.
	const remaining = new Map(entries.map((entry) => [entry.path, entry]));
	let refetched = 0;
	let failure: { readonly error: unknown } | null = null;
	// Let go of as soon as the last entry is out of it: the files that
	// follow one at a time need the memory.
	let archive: ArchiveContents | null = null;
	try {
		// The sync state was awaited since the pull last looked at the signal.
		// A request that is sent cannot be taken back, so one that is no
		// longer wanted is not sent.
		if (signal?.aborted) {
			failure = { error: new BackendError("cancelled", "fetch: cancelled") };
		} else {
			deps.onDownload?.(left === null ? "downloading" : "retrying");
			try {
				const request = fetchArchive(revision);
				deps.gate?.hold(request);
				archive = await untilAborted(request, signal);
			} catch (error) {
				failure = { error };
			} finally {
				deps.onDownload?.(null);
			}
		}
		if (archive !== null) {
			log(`archive: ${archive.byteLength} bytes downloaded, estimated at ${estimate} bytes`);
			for (const entry of entries) {
				let file: SourcedFile | null;
				try {
					// Looked at here too: a run of entries that are not
					// yielded gives the consumer no chance to stop.
					if (signal?.aborted) throw new BackendError("cancelled", "fetch: cancelled");
					file = await takeOut(archive, entry, backend);
				} catch (error) {
					failure = { error };
					break;
				}
				if (file === null) {
					refetched += 1;
					continue;
				}
				remaining.delete(entry.path);
				yield file;
				// The consumer is back: it wrote that file, or settled it
				// in another way. Either way the archive was received and
				// read on this device.
				await unmark();
			}
		}
	} finally {
		archive = null;
		// However it ended: done, failed, or stopped by the consumer.
		await unmark();
	}

	if (failure !== null) {
		const { error } = failure;
		if (error instanceof BackendError && error.kind === "cancelled") throw error;
		const remember = saysDeviceCannot(error);
		if (remember) await store.setMeta(ARCHIVE_DISABLED_KEY, true);
		// The reason is on record either way: it is all there is to tell
		// later why a device stopped using the archive, or did not.
		const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		log(
			`archive: failed (${reason}). The other ${remaining.size} files are fetched one at a time` +
				`${remember ? ", and so is every file on this device from now on" : "; the next pull tries the archive again"}.`,
		);
	}
	if (refetched > 0) {
		log(`archive: ${refetched} files were missing from it or had another content; fetched one at a time`);
		deps.onRefetch?.(refetched);
	}
	if (remaining.size > 0) yield* deps.perFile(revision, [...remaining.values()]);
}

/**
 * The content of an entry out of the archive, or `null` when the archive
 * does not have it as the listing does: left out (`export-ignore`), or
 * changed on the way in (`export-subst`, a conversion of line ends). A size
 * other than the listed one says so without inflating anything.
 */
async function takeOut(
	archive: ArchiveContents,
	entry: RemoteEntry,
	backend: Pick<Backend, "hashContent">,
): Promise<SourcedFile | null> {
	const size = archive.sizeOf(entry.path);
	if (size === null || (entry.size !== undefined && size !== entry.size)) return null;
	const content = archive.read(entry.path);
	const hash = await backend.hashContent(content);
	return hash === entry.hash ? { entry, content, hash } : null;
}

/**
 * Whether a failure of the archive is a reason to stop trying it on this
 * device. What is remembered stays for good, so only what says something
 * about the device is:
 *
 * - A redirect that was not followed. The archive is behind one, and whether
 *   it is followed is a matter of the platform's HTTP function.
 * - No memory for the archive, or for a content out of it: an allocation
 *   that fails where the app is not killed outright is a `RangeError`.
 *
 * Everything else falls back to one file at a time for this pull and tries
 * the archive again the next time. That is what the remote, the network or
 * the credentials can be the cause of, and also what cannot be told: an
 * answer that is not a zip can be the page of a network that wants a login,
 * and an error of another kind can be a mistake in this code.
 */
function saysDeviceCannot(error: unknown): boolean {
	// By name as well: an error thrown by the platform's own code can be of
	// another realm, where `instanceof` does not hold.
	if (error instanceof RangeError || (error instanceof Error && error.name === "RangeError")) return true;
	if (!(error instanceof BackendError)) return false;
	// No `default`: a kind added later fails the type check here.
	switch (error.kind) {
		case "other":
			return error.status !== undefined && error.status >= 300 && error.status < 400;
		case "unreachable":
		case "rate-limited":
		case "unauthorized":
		case "forbidden":
		case "not-found":
		case "branch-not-found":
		case "workflows-permission":
		case "too-large":
		case "incomplete-listing":
		case "not-as-listed":
		case "cancelled":
			return false;
	}
}

/**
 * `work`, or a "cancelled" failure as soon as the signal is set. A request
 * cannot be taken back; what it answers afterwards is dropped.
 */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (signal === undefined) return work;
	return new Promise<T>((resolve, reject) => {
		const cancel = (): void => reject(new BackendError("cancelled", "fetch: cancelled"));
		if (signal.aborted) cancel();
		else signal.addEventListener("abort", cancel, { once: true });
		work.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
	});
}
