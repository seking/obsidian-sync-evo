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

// A pull, from the listing of the remote to the base revision: what is
// looked at, in which order, when the user is asked, and what is remembered.
// The decision is `pull-plan.ts`; carrying it out is `pull-apply.ts`. A first
// fetch is this same pull, run when there is no base revision.
//
// The order, and why:
//
// 1. The listing. The one that is stored is used while the remote has not
//    moved past it.
// 2. Whether the history still builds on the base revision. Asked before
//    anything is touched, since it decides how carefully files are written
//    over; a failure to find out ends the pull.
// 3. The text the root `.gitignore` will have once the pull is done, worked
//    out without writing it. The rules decide what the scan looks at, so
//    they have to be the ones the remote has now; the file itself is
//    written by the plan, like any other.
// 4. The scan, the hashing of what it found, and the plan.
// 5. Asking the user, when the plan takes away too much.
// 6. The plan, step by step.
// 7. The base revision, when nothing was put off.

import type { RemoteEntry, RemoteListing } from "./backend";
import { createExclusion } from "./exclusion";
import { HASH_CHUNK_BYTES } from "./hash";
import { type NoticeKind, type NoticeRef, readNotices, reconcileNotices, writeNotices } from "./notices";
import { foldedKey, pathKey } from "./paths";
import { DEFAULT_SIZE_LIMIT, type LocalEntry } from "./plan";
import { type ApplyEnv, applyPlan, isLfsPointer, type Seen, Tally } from "./pull-apply";
import type {
	BulkWriteSession,
	PullDeps,
	PullOutcome,
	PullPhase,
	PullResult,
	UnwritablePath,
	UnwritableReason,
} from "./pull-io";
import {
	confirmationOf,
	isConfirmed,
	keepLocal,
	needsConfirmation,
	type PullConfirmation,
	type PullPlan,
	type PullSkip,
	planPull,
	pullLosses,
} from "./pull-plan";
import { fromRoot, type ScanResult, scanVault } from "./scan";
import {
	BASE_REVISION_KEY,
	isUnchangedByStat,
	RecordBatcher,
	readBaseRevision,
	refreshStat,
	type StateStore,
	type StoredRecord,
	writeBaseRevision,
} from "./state";

export type * from "./pull-io";

/** The key, among the other values of the sync state, of what the user last said yes to. */
export const PULL_CONFIRMATION_KEY = "pull-confirmation";

/** The key of the symlinks of the remote and where they point. */
export const SYMLINK_TARGETS_KEY = "symlink-targets";

const GITIGNORE = ".gitignore";

/**
 * Pulls. Resolves with what happened, also when the pull did not get to the
 * end. Rejects when it could not be carried out at all or the sync state
 * failed: the listing, the check of the history, the scan. The vault is
 * consistent with the records either way, and the base revision has only
 * moved when everything was done.
 */
export async function runPull(deps: PullDeps): Promise<PullResult> {
	const run = new PullRun(deps);
	try {
		return await run.pull();
	} finally {
		await run.restoreViews();
	}
}

class PullRun {
	private readonly store: StateStore;
	private readonly startedAt: number;
	private readonly sizeLimit: number;
	private readonly tally = new Tally();
	private session: BulkWriteSession | undefined;
	private closedViews = false;
	/** Whether this is a first fetch: only then are views closed for the writing. */
	private firstFetch = false;

	constructor(private readonly deps: PullDeps) {
		this.store = deps.store;
		this.startedAt = deps.now();
		this.sizeLimit = deps.sizeLimit ?? DEFAULT_SIZE_LIMIT;
	}

	async restoreViews(): Promise<void> {
		const session = this.session;
		this.session = undefined;
		if (session === undefined) return;
		try {
			await session.restore();
		} catch {
			// A view that does not reopen is no reason to call the pull failed.
		}
	}

	private progress(phase: PullPhase, done = 0, total = 0): void {
		this.deps.onProgress?.({ phase, done, total, closedViews: this.closedViews });
	}

	private aborted(): boolean {
		return this.deps.signal?.aborted === true;
	}

	async pull(): Promise<PullResult> {
		const { store, deps } = this;
		const base = await readBaseRevision(store);
		this.firstFetch = base === null;

		this.progress("listing");
		const listing = await this.currentListing();
		const head = listing.revision;

		// A remote without content. With nothing pulled before, there is
		// nothing to do and nothing to compare. With a base revision, the
		// content that was there is gone: no history holds the base any
		// more, which is what a rewritten history is, and nothing can be
		// asked of the remote about a head it does not have.
		let rewritten = false;
		if (head === null) {
			if (base === null) return this.result("remote-empty", head, false, {});
			rewritten = true;
		} else if (base !== null && head !== base) {
			rewritten = (await deps.backend.checkBase(base, head)) === "rewritten";
		}
		const finish = (outcome: PullOutcome, extra: Partial<PullResult> = {}): PullResult =>
			this.result(outcome, head, rewritten, extra);
		if (this.aborted()) return finish("cancelled");

		// A pull that the user let go on after the history was rewritten
		// keeps protecting what it takes away until it is done, even if the
		// history reads as continuous by the time it resumes.
		const confirmed = readConfirmation(await store.getMeta(PULL_CONFIRMATION_KEY));
		const protect = rewritten || confirmed?.rewritten === true;

		// T024: write markers a pull left behind when it stopped are dealt
		// with here, before any file is compared: each one settles what its
		// file is (written, not begun, or half written) so that the scan
		// below sees the vault as the plan may take it. Until then a marker
		// that is left is only ever replaced or removed by a later write of
		// the same path.

		const records = await store.readRecords();
		const gitignore = await this.gitignoreAfter(listing, records, protect);
		if (this.aborted()) return finish("cancelled");

		const exclusion = createExclusion({ ...deps.paths, gitignore });

		this.progress("scanning");
		const scan = await scanVault({ lister: deps.vault, exclusion, remote: listing.entries, records });
		const local = await this.readLocal(scan, records, listing);
		if (local === null) return finish("cancelled");

		let plan = planPull({
			remote: listing.entries,
			local: local.entries,
			records,
			exclusion,
			sizeLimit: this.sizeLimit,
		});
		// `tried`: whether every write of the plan was attempted.
		const notices = (tried: boolean): Promise<NoticeRef[]> =>
			this.updateNotices(plan, scan, listing, local.lfsPointers, tried);

		const losses = pullLosses(plan, rewritten);
		const keptLocal: string[] = [];
		if (needsConfirmation(losses, plan.recordCount)) {
			if (!isConfirmed(losses, confirmed)) {
				const answer = await deps.confirm({ losses, recordCount: plan.recordCount });
				if (answer === "keep-local" && rewritten) {
					const all = [...losses.deletions, ...losses.overwrites];
					plan = keepLocal(plan, new Set(all.map((loss) => loss.key)));
					keptLocal.push(...all.map((loss) => loss.path));
					// Nothing was confirmed by this answer, and a "yes" from
					// before was to another question. Left in place, it
					// would stand for this pull if it stops halfway.
					await store.deleteMeta(PULL_CONFIRMATION_KEY);
				} else if (answer === "proceed") {
					// Before anything is changed, so that a pull that stops
					// halfway goes on without asking again.
					await store.setMeta(PULL_CONFIRMATION_KEY, confirmationOf(losses));
				} else {
					// What was confirmed before does not outlive a "no".
					await store.deleteMeta(PULL_CONFIRMATION_KEY);
					return finish("declined", { notices: await notices(false) });
				}
			}
		}
		if (this.aborted()) return finish("cancelled", { notices: await notices(false) });

		this.progress("applying", 0, 0);
		const completed = await applyPlan(
			this.applyEnv(listing, protect, local.seen, scan.paths.map((scanned) => scanned.path)),
			plan,
		);
		for (const skip of plan.skipped) {
			if (skip.reason !== "blocked") continue;
			this.tally.unwritable.push({
				path: blockedPath(skip),
				reason: "blocked",
				inTheWay: skip.local.map((entry) => entry.path),
			});
		}
		// The record changes are made whatever the signal says, so every
		// symlink has its record by now and is not told a second time.
		const newSymlinks = plan.symlinks.filter((link) => link.firstSeen).map((link) => link.remote.path);
		const tried = completed && this.tally.fetchError === undefined;
		const extra = { keptLocal, newSymlinks, notices: await notices(tried) };
		if (!completed) return finish("cancelled", extra);

		await this.updateSymlinkTargets(plan, listing);

		if (this.tally.deferred.length > 0 || this.tally.fetchError !== undefined) return finish("incomplete", extra);

		// Everything is done: only now is the head what this device builds on.
		if (head === null) await store.deleteMeta(BASE_REVISION_KEY);
		else await writeBaseRevision(store, head);
		await store.deleteMeta(PULL_CONFIRMATION_KEY);
		return finish("completed", extra);
	}

	private result(
		outcome: PullOutcome,
		revision: string | null,
		rewritten: boolean,
		extra: Partial<PullResult>,
	): PullResult {
		const { tally } = this;
		// A path is new when its notice is shown by this pull.
		const shown = new Set<string>();
		const shownBlocked = new Set<string>();
		for (const notice of extra.notices ?? []) {
			if (notice.kind === "unwritable-path") shown.add(notice.path);
			if (notice.kind === "blocked-path") shownBlocked.add(notice.path);
		}
		const unwritable = tally.unwritable.map(
			(entry): UnwritablePath => ({
				...entry,
				isNew:
					entry.reason === "blocked"
						? shownBlocked.has(entry.path)
						: NOTICED_REASONS.has(entry.reason) &&
							tally.refused.some((item) => item.reportedAs === entry.path && shown.has(item.remotePath)),
			}),
		);
		return {
			outcome,
			revision,
			remoteEmpty: revision === null,
			rewritten,
			counts: {
				fetched: tally.fetched,
				deleted: tally.deleted,
				renamed: tally.renamed,
				conflicts: tally.conflicts.length,
			},
			conflicts: tally.conflicts,
			trashed: tally.trashed,
			deferred: tally.deferred,
			unwritable,
			keptLocal: [],
			newSymlinks: [],
			notices: [],
			closedViews: this.closedViews,
			...(tally.fetchError === undefined ? {} : { fetchError: tally.fetchError }),
			...extra,
		};
	}

	/** The listing of the head: the stored one when the remote has not moved past it. */
	private async currentListing(): Promise<RemoteListing> {
		const stored = await this.store.getListing();
		// Without a listing to fall back on, "unchanged" would be of no use.
		const listed = await this.deps.backend.list(stored === null ? null : stored.revision);
		if (!listed.changed) {
			if (stored !== null) return stored;
			throw new Error("The remote answered that nothing changed since a listing that was never taken.");
		}
		await this.store.putListing(listed.listing);
		return listed.listing;
	}

	private applyEnv(
		listing: RemoteListing,
		protect: boolean,
		seen: Map<string, Seen>,
		localPaths: readonly string[],
	): ApplyEnv {
		const { deps } = this;
		return {
			store: this.store,
			backend: deps.backend,
			vault: deps.vault,
			fetchContents: deps.fetchContents ?? ((revision, entries) => deps.backend.fetch(revision, entries)),
			deviceName: deps.deviceName,
			now: deps.now,
			startedAt: this.startedAt,
			...(deps.signal === undefined ? {} : { signal: deps.signal }),
			listing,
			protect,
			seen,
			localPaths,
			tally: this.tally,
			beforeWrite: () => this.beforeWrite(),
			onStep: (done, total) => this.progress("applying", done, total),
			communityPluginsKey: pathKey(`${trimSlashes(deps.paths.configDir)}/community-plugins.json`),
			pluginId: deps.pluginId,
		};
	}

	// Asked for at the first write rather than up front, so that a first
	// fetch that writes nothing closes nothing.
	private async beforeWrite(): Promise<void> {
		if (!this.firstFetch || this.session !== undefined || this.deps.beginBulkWrite === undefined) return;
		try {
			this.session = await this.deps.beginBulkWrite();
			this.closedViews = this.session.closedViews;
		} catch {
			// Writing with the views open is slow, not wrong.
			this.session = { closedViews: false, restore: async () => {} };
		}
	}

	// -----------------------------------------------------------------------
	// `.gitignore` first

	/**
	 * The text the root `.gitignore` will have once this pull is done, or
	 * `null` for none. Nothing is written here: the file goes through the
	 * plan like any other, so that a pull the user declines has changed
	 * nothing, and a `.gitignore` that was edited here becomes a conflict
	 * like any other file. But the rules have to be known before the scan,
	 * so the decision about this one path is made ahead, from its record,
	 * the vault's file and the remote's entry:
	 *
	 * - Where it puts the remote's content at the name (a fetch, or a
	 *   conflict, whose copy takes the vault's), the text is the remote's.
	 *   That one blob is fetched here, from the backend itself and not from
	 *   whatever the contents of the pull come from, which may be an archive
	 *   that is fetched once. A failure to fetch it fails the pull, before
	 *   anything is changed.
	 * - Everywhere else the text is the vault's: the two are the same, the
	 *   remote did not change it or has none, or the step takes something
	 *   away (a deletion, writing over the file after the history was
	 *   rewritten) and is the user's to confirm first.
	 *
	 * When the write is then put off, refused, or not confirmed, the file
	 * differs from the rules this pull went by. That is accepted: a rule
	 * only matters for a path the remote does not hold, a pull changes no
	 * such path because of a rule, and the next pull reads the rules again.
	 */
	private async gitignoreAfter(
		listing: RemoteListing,
		records: readonly StoredRecord[],
		protect: boolean,
	): Promise<string | null> {
		const { deps } = this;
		const remote = listing.entries.filter((entry) => foldedKey(entry.path) === GITIGNORE);
		const [entry] = remote;
		// Anything but one plain file of exactly that name is not written
		// to that name by this pull.
		if (remote.length !== 1 || entry === undefined || entry.kind !== "file" || pathKey(entry.path) !== GITIGNORE) {
			return this.rootGitignore();
		}

		const local: LocalEntry[] = [];
		const listed = await deps.vault.list("/");
		for (const returned of listed.files) {
			const path = fromRoot(returned);
			if (foldedKey(path) !== GITIGNORE) continue;
			const stat = await deps.vault.stat(path);
			if (stat === null || stat.type !== "file") continue;
			if (stat.size > this.sizeLimit) {
				local.push({ path, hash: "", size: stat.size });
				continue;
			}
			const hash = await deps.backend.hashContent(await deps.vault.read(path));
			local.push({ path, hash, size: stat.size });
		}

		const plan = planPull({
			remote,
			local,
			records: records.filter((record) => foldedKey(record.path) === GITIGNORE),
			// No rule applies to the root `.gitignore`, and the two fixed
			// exclusions cannot match it.
			exclusion: createExclusion({ ...deps.paths, gitignore: null }),
			sizeLimit: this.sizeLimit,
		});
		const losses = pullLosses(plan, protect);
		const takesAway =
			plan.deletes.length + plan.asides.length + losses.deletions.length + losses.overwrites.length > 0;
		if (takesAway || !plan.writes.some((write) => write.key === GITIGNORE)) return this.rootGitignore();

		for await (const file of deps.backend.fetch(listing.revision, [entry])) {
			if (file.entry.path !== entry.path) continue;
			if ((await deps.backend.hashContent(file.content)) !== entry.hash) break;
			return new TextDecoder().decode(file.content);
		}
		throw new Error("The .gitignore of the remote could not be fetched as it is listed.");
	}

	/** The `.gitignore` at the vault root, as it is now. */
	private async rootGitignore(): Promise<string | null> {
		const { vault } = this.deps;
		const stat = await vault.stat(GITIGNORE);
		if (stat === null || stat.type !== "file" || stat.size > this.sizeLimit) return null;
		return new TextDecoder().decode(await vault.read(GITIGNORE));
	}

	// -----------------------------------------------------------------------
	// The vault side of the decision

	/**
	 * The hash of every file the scan found. A file whose time and size are
	 * those of its record is not read. A file over the size limit is not read
	 * either; it is listed with its size, which is what the plan turns it
	 * away by. `null` when the signal stopped it.
	 */
	private async readLocal(
		scan: ScanResult,
		records: readonly StoredRecord[],
		listing: RemoteListing,
	): Promise<{ entries: LocalEntry[]; seen: Map<string, Seen>; lfsPointers: string[] } | null> {
		const { deps } = this;
		const byKey = new Map(records.map((record) => [record.key, record]));
		const remoteByKey = new Map(listing.entries.map((entry) => [pathKey(entry.path), entry]));
		const batcher = new RecordBatcher(this.store, { now: deps.now });
		const entries: LocalEntry[] = [];
		const seen = new Map<string, Seen>();
		const lfsPointers: string[] = [];
		const total = scan.paths.length;
		let hashedBytes = 0;

		for (const [index, scanned] of scan.paths.entries()) {
			if (this.aborted()) {
				await batcher.flush();
				return null;
			}
			const { path, key } = scanned;
			const stat = await deps.vault.stat(path);
			// Gone since it was listed.
			if (stat === null || stat.type !== "file") continue;
			if (stat.size > this.sizeLimit) {
				entries.push({ path, hash: "", size: stat.size });
				continue;
			}

			const record = byKey.get(key);
			let hash: string;
			if (record !== undefined && isUnchangedByStat(record, stat)) {
				hash = record.hash;
			} else {
				const content = await deps.vault.read(path);
				hash = await deps.backend.hashContent(content);
				// Found here too, and not only when it is written: a pointer
				// that was already in the vault is one all the same.
				const remote = remoteByKey.get(key);
				if (remote?.kind === "file" && remote.hash === hash && isLfsPointer(content)) {
					lfsPointers.push(remote.path);
				}
				if (record !== undefined && record.kind === "file" && record.hash === hash) {
					const refreshed = refreshStat(record, stat, this.startedAt);
					if (refreshed !== null) await batcher.add(refreshed);
				}
				hashedBytes += content.length;
				if (hashedBytes >= HASH_CHUNK_BYTES && deps.yieldControl !== undefined) {
					hashedBytes = 0;
					await deps.yieldControl();
				}
			}
			entries.push({ path, hash, size: stat.size });
			seen.set(key, { hash, stat: { mtime: stat.mtime, size: stat.size } });
			this.progress("hashing", index + 1, total);
		}
		await batcher.flush();
		return { entries, seen, lfsPointers };
	}

	// -----------------------------------------------------------------------
	// What is told once

	/**
	 * Works out which notices apply now, remembers them, and answers the
	 * ones that apply for the first time.
	 */
	private async updateNotices(
		plan: PullPlan,
		scan: ScanResult,
		listing: RemoteListing,
		localLfsPointers: readonly string[],
		tried: boolean,
	): Promise<NoticeRef[]> {
		const { deps, tally } = this;
		const remembered = await readNotices(this.store);
		const current: NoticeRef[] = [];
		const add = (kind: NoticeKind, path: string): void => {
			current.push({ kind, path });
		};

		if (scan.rootHasGit) add("git-at-root", ".git");
		for (const collision of plan.collisions) {
			for (const spelling of collision.spellings) add("remote-path-collision", spelling);
		}
		let ownFolder = false;
		for (const skip of plan.skipped) {
			const path = skip.remote[0]?.path ?? skip.local[0]?.path ?? skip.records[0]?.path ?? skip.key;
			switch (skip.reason) {
				case "own-folder":
					// One notice for the folder, however many files it has.
					ownFolder = ownFolder || skip.remote.length > 0;
					break;
				case "duplicate-path":
					// Two spellings of one name in NFC and NFD.
					if (skip.remote.length > 1) {
						for (const entry of skip.remote) add("remote-path-collision", entry.path);
					}
					break;
				case "too-large":
					add("too-large", path);
					break;
				case "invalid-path":
					add("invalid-path", path);
					break;
				default:
					break;
			}
		}
		if (ownFolder) add("own-folder-on-remote", trimSlashes(deps.paths.pluginDir));

		// A pointer file is only recognized when its content passes through
		// here. One that was told before still is one while the remote holds
		// the path and this pull did not write other content there.
		for (const path of [...tally.lfsPointers, ...localLfsPointers]) add("lfs-pointer", path);
		const remoteFiles = new Set(
			listing.entries.filter((entry) => entry.kind === "file").map((entry) => entry.path),
		);
		for (const notice of remembered) {
			if (notice.kind !== "lfs-pointer") continue;
			if (remoteFiles.has(notice.path) && !tally.written.has(pathKey(notice.path))) current.push(notice);
		}

		// A path the vault refused. Every pull tries it again, so one that
		// is not refused by a pull that tried it was written, or is gone from
		// the remote. A pull that did not get to it says nothing about it.
		//
		// A vault file that could not be taken away is the other thing told
		// under this kind. Its path is not on the remote: it is kept while
		// the file is in the vault and no pull has tried it since.
		for (const { remotePath } of tally.refused) add("unwritable-path", remotePath);
		const putOff = new Set(tally.deferred.map((file) => pathKey(file.path)));
		const inVault = new Set(scan.paths.map((scanned) => scanned.key));
		for (const notice of remembered) {
			if (notice.kind !== "unwritable-path") continue;
			const key = pathKey(notice.path);
			if (!remoteFiles.has(notice.path)) {
				if (!tried && inVault.has(key)) current.push(notice);
				continue;
			}
			if (tally.written.has(key)) continue;
			if (!tried || putOff.has(key)) current.push(notice);
		}

		// A remote file with vault files in its place. Decided by the plan
		// alone, so it applies for exactly as long as the plan says so.
		for (const skip of plan.skipped) {
			if (skip.reason === "blocked") add("blocked-path", blockedPath(skip));
		}

		const update = reconcileNotices(remembered, current);
		await writeNotices(this.store, update.remember);
		const show = [...update.show];
		// Not through the memory: it is about the file as it was just
		// written, and is told every time such a file is written.
		if (tally.pluginNotListed) {
			show.push({ kind: "plugin-not-listed", path: `${trimSlashes(deps.paths.configDir)}/community-plugins.json` });
		}
		return show;
	}

	/**
	 * Keeps where each symlink of the remote points, for the list in the
	 * settings. A symlink is never written, but its blob is a few bytes that
	 * say where it points; it is fetched when the symlink is new or changed.
	 * Nothing here can fail the pull: a target that could not be fetched is
	 * missing from the list until the next pull.
	 */
	private async updateSymlinkTargets(plan: PullPlan, listing: RemoteListing): Promise<void> {
		const { backend } = this.deps;
		try {
			const stored = storedTargets(await this.store.getMeta(SYMLINK_TARGETS_KEY));
			const kept: StoredTarget[] = [];
			const missing: RemoteEntry[] = [];
			for (const { remote } of plan.symlinks) {
				const have = stored.find((item) => item.path === remote.path && item.hash === remote.hash);
				if (have === undefined) missing.push(remote);
				else kept.push(have);
			}
			if (missing.length === 0 && kept.length === stored.length) return;
			try {
				if (missing.length > 0) {
					for await (const { entry, content } of backend.fetch(listing.revision, missing)) {
						if (this.aborted()) break;
						if ((await backend.hashContent(content)) !== entry.hash) continue;
						kept.push({ path: entry.path, hash: entry.hash, target: new TextDecoder().decode(content) });
					}
				}
			} catch {
				// What was fetched so far is kept.
			}
			await this.store.setMeta(SYMLINK_TARGETS_KEY, kept);
		} catch {
			// The list is a convenience.
		}
	}
}

interface StoredTarget {
	readonly path: string;
	/** The hash of the symlink's blob, to see when it points elsewhere. */
	readonly hash: string;
	readonly target: string;
}

function storedTargets(value: unknown): StoredTarget[] {
	if (!Array.isArray(value)) return [];
	const targets: StoredTarget[] = [];
	for (const item of value as unknown[]) {
		if (typeof item !== "object" || item === null) continue;
		const { path, hash, target } = item as Record<string, unknown>;
		if (typeof path === "string" && typeof hash === "string" && typeof target === "string") {
			targets.push({ path, hash, target });
		}
	}
	return targets;
}

export interface SymlinkTarget {
	/** The path of the symlink on the remote. */
	readonly path: string;
	/** Where it points, as the remote has it: usually a path relative to the symlink. */
	readonly target: string;
}

/** The symlinks of the remote that are skipped, with where they point, as of the last pull. */
export async function readSymlinkTargets(store: Pick<StateStore, "getMeta">): Promise<SymlinkTarget[]> {
	return storedTargets(await store.getMeta(SYMLINK_TARGETS_KEY))
		.map(({ path, target }) => ({ path, target }))
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function readConfirmation(value: unknown): PullConfirmation | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { rewritten, deletions, overwrites } = value as Record<string, unknown>;
	const isKeys = (list: unknown): list is string[] =>
		Array.isArray(list) && list.every((item) => typeof item === "string");
	if (typeof rewritten !== "boolean" || !isKeys(deletions) || !isKeys(overwrites)) return undefined;
	return { rewritten, deletions, overwrites };
}

/**
 * The reasons of an unwritable path that have an "unwritable-path" notice:
 * the write or the rename of the remote path itself, and the removal of a
 * vault file.
 */
const NOTICED_REASONS: ReadonlySet<UnwritableReason> = new Set([
	"write-failed",
	"rename-failed",
	"trash-failed",
	"copy-unwritable",
	"folder-in-the-way",
]);

/** The path a blocked remote file is reported and remembered under: the remote's spelling. */
function blockedPath(skip: PullSkip): string {
	return skip.remote[0]?.path ?? skip.key;
}

function trimSlashes(path: string): string {
	return path.replace(/^\/+|\/+$/g, "");
}
