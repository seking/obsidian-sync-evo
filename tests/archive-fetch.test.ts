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

import { describe, expect, test } from "vitest";
import {
	ARCHIVE_ATTEMPT_KEY,
	ARCHIVE_DISABLED_KEY,
	ARCHIVE_FILE_THRESHOLD,
	ArchiveGate,
	chooseFetchMeans,
	COMPRESSED_EXTENSIONS,
	estimateArchiveSize,
	isArchiveDisabled,
	MAX_ARCHIVE_ESTIMATE_BYTES,
} from "../src/core/archive-fetch";
import { BackendError, type RemoteEntry } from "../src/core/backend";
import { FetchLimitWatch } from "../src/core/fetch-quota";
import { type PullDeps, type PullProgress, type PullResult, runPull } from "../src/core/pull";
import { readBaseRevision, type StateStore } from "../src/core/state";
import { blobHash, bytes, type FileContent, MemoryBackend } from "./support/memory-backend";
import { MemoryPullVault } from "./support/memory-pull-vault";
import { MemoryStateStore } from "./support/memory-state-store";
import { ZipBackend } from "./support/zip-backend";

const MB = 1024 * 1024;
const entry = (path: string, size?: number): RemoteEntry => ({
	path,
	kind: "file",
	hash: "0".repeat(40),
	...(size === undefined ? {} : { size }),
});

describe("the estimate of the size of an archive", () => {
	test("a file of a kind that is compressed already counts whole, any other by half", () => {
		expect(estimateArchiveSize([entry("photo.png", 1000)])).toBe(1000);
		expect(estimateArchiveSize([entry("note.md", 1000)])).toBe(500);
		expect(estimateArchiveSize([entry("a/photo.png", 1000), entry("a/note.md", 1000), entry("b.pdf", 10)])).toBe(1510);
	});

	test("every extension of the list counts whole", () => {
		const list =
			"png jpg jpeg gif webp heic heif avif pdf mp4 mov m4v webm mkv avi mp3 m4a aac ogg opus flac " +
			"zip gz tgz bz2 xz 7z rar zst docx xlsx pptx epub woff woff2";
		expect([...COMPRESSED_EXTENSIONS].sort()).toEqual(list.split(" ").sort());
		for (const extension of list.split(" ")) {
			expect(estimateArchiveSize([entry(`files/x.${extension}`, 100)]), extension).toBe(100);
		}
	});

	test("what shrinks is not on the list", () => {
		for (const extension of ["svg", "bmp", "wav", "tiff", "ttf", "otf", "md", "json", "canvas", "txt"]) {
			expect(estimateArchiveSize([entry(`x.${extension}`, 100)]), extension).toBe(50);
		}
	});

	test("the case of the extension does not matter", () => {
		expect(estimateArchiveSize([entry("IMG_0001.JPG", 100), entry("Scan.Pdf", 100), entry("a.tar.GZ", 100)])).toBe(300);
	});

	test("only the last extension of the name counts, and only of the name", () => {
		expect(estimateArchiveSize([entry("photo.png.md", 100)])).toBe(50);
		expect(estimateArchiveSize([entry("archive.zip/readme", 100)])).toBe(50);
		expect(estimateArchiveSize([entry("png", 100)])).toBe(50);
		expect(estimateArchiveSize([entry("notes/png", 100)])).toBe(50);
	});

	test("a file without an extension, and one whose name ends with a dot, count by half", () => {
		expect(estimateArchiveSize([entry("LICENSE", 100), entry("Makefile", 100), entry("odd.", 100)])).toBe(150);
		expect(estimateArchiveSize([entry(".gitignore", 100)])).toBe(50);
	});

	test("an entry without a size counts as empty, and no entries as nothing", () => {
		expect(estimateArchiveSize([entry("a.png"), { path: "sub", kind: "submodule", hash: "1".repeat(40) }])).toBe(0);
		expect(estimateArchiveSize([])).toBe(0);
	});

	test("the half is of the sum: a repository of notes with a few images", () => {
		// The numbers of the repository the limit was measured with.
		const entries = [entry("images/all.png", 0.5 * MB), entry("notes/all.md", 143.4 * MB)];
		expect(estimateArchiveSize(entries) / MB).toBeCloseTo(72.2, 1);
	});
});

describe("the choice of the means", () => {
	const base = { fetchCount: 5000, estimate: 50 * MB, disabled: false, available: true };

	test("the archive is for more files than the threshold", () => {
		expect(ARCHIVE_FILE_THRESHOLD).toBe(1000);
		expect(chooseFetchMeans({ ...base, fetchCount: 1000 })).toBe("per-file");
		expect(chooseFetchMeans({ ...base, fetchCount: 1001 })).toBe("archive");
		expect(chooseFetchMeans({ ...base, fetchCount: 0 })).toBe("per-file");
	});

	test("an archive estimated over the limit is not used, however many files", () => {
		expect(MAX_ARCHIVE_ESTIMATE_BYTES).toBe(150 * MB);
		expect(chooseFetchMeans({ ...base, estimate: 150 * MB })).toBe("archive");
		expect(chooseFetchMeans({ ...base, estimate: 150 * MB + 1 })).toBe("per-file");
	});

	test("a device that remembers not to use it, and a remote without one, fetch one file at a time", () => {
		expect(chooseFetchMeans({ ...base, disabled: true })).toBe("per-file");
		expect(chooseFetchMeans({ ...base, available: false })).toBe("per-file");
	});
});

// ---------------------------------------------------------------------------
// In a pull

const paths = { configDir: ".obsidian", pluginDir: ".obsidian/plugins/sync-evo" };

/** `count` notes, each with a content of its own. */
function notes(count: number, version = ""): Record<string, string> {
	const files: Record<string, string> = {};
	for (let i = 1; i <= count; i++) files[`notes/${String(i).padStart(4, "0")}.md`] = `note ${i}${version}\n`;
	return files;
}

interface Harness<B extends MemoryBackend = ZipBackend> {
	readonly backend: B;
	/** Replaced by a test to lose the sync state. */
	store: MemoryStateStore;
	readonly vault: MemoryPullVault;
	/** The paths asked of the source that fetches one file at a time, per call. */
	readonly perFile: string[][];
	readonly progress: PullProgress[];
	readonly logs: string[];
	readonly views: string[];
	/** The app is killed: from here on nothing of the sync state or the vault answers. */
	kill(): void;
	/** The app is started again. */
	restart(): void;
	pull(overrides?: Partial<PullDeps>): Promise<PullResult>;
	records(): Promise<Record<string, string>>;
	attempt(): Promise<unknown>;
	disabled(): Promise<boolean>;
}

function harness<B extends MemoryBackend = ZipBackend>(backend: B = new ZipBackend() as MemoryBackend as B): Harness<B> {
	let time = Date.UTC(2026, 9, 7, 12, 0, 0);
	const now = (): number => time;
	let dead = false;
	const gate = (): void => {
		if (dead) throw new Error("the app is gone");
	};
	const vault = new MemoryPullVault({ caseSensitive: true, now });
	vault.before = gate;

	const h: Harness<B> = {
		backend,
		store: new MemoryStateStore(),
		vault,
		perFile: [],
		progress: [],
		logs: [],
		views: [],
		kill() {
			dead = true;
		},
		restart() {
			dead = false;
			vault.before = gate;
		},
		pull(overrides = {}) {
			time += 60_000;
			// Looked up at each call, so that a test can replace the store.
			const store = new Proxy({} as StateStore, {
				get: (_target, name) => {
					const value: unknown = Reflect.get(h.store, name, h.store);
					if (typeof value !== "function") return value;
					return (...args: unknown[]): unknown => {
						gate();
						return (value as (...rest: unknown[]) => unknown).apply(h.store, args);
					};
				},
			});
			return runPull({
				store,
				backend,
				vault,
				paths,
				pluginId: "sync-evo",
				deviceName: "iPhone",
				now,
				confirm: async () => "proceed",
				beginBulkWrite: async () => {
					h.views.push("close");
					return { closedViews: true, restore: async () => void h.views.push("reopen") };
				},
				fetchContents: (revision, entries) => {
					h.perFile.push(entries.map((item) => item.path));
					return backend.fetch(revision, entries);
				},
				onProgress: (event) => h.progress.push(event),
				log: (message) => h.logs.push(message),
				...overrides,
			});
		},
		async records() {
			const out: Record<string, string> = {};
			for (const record of await h.store.readRecords()) out[record.path] = record.hash;
			return out;
		},
		attempt: () => h.store.getMeta(ARCHIVE_ATTEMPT_KEY),
		disabled: () => isArchiveDisabled(h.store),
	};
	return h;
}

/** The one-time notice that this device no longer fetches all at once. */
const GIVEN_UP = { kind: "archive-given-up", path: "" } as const;

function last<T>(items: readonly T[]): T | undefined {
	return items[items.length - 1];
}

function hashes(files: Record<string, FileContent>): Record<string, string> {
	return Object.fromEntries(Object.entries(files).map(([path, content]) => [path, blobHash(content)]));
}

/** The hash of every file of the vault, computed from what is in it. */
function vaultHashes(vault: MemoryPullVault): Record<string, string> {
	return hashes(vault.snapshot());
}

describe("the means a pull fetches by", () => {
	test("1,000 files are fetched one at a time, with no request for the archive", async () => {
		const h = harness();
		h.backend.commit(notes(1000));
		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(result.counts.fetched).toBe(1000);
		expect(h.backend.zipRequests).toEqual([]);
		expect(h.perFile.map((asked) => asked.length)).toEqual([1000]);
		expect(await h.attempt()).toBeUndefined();
	});

	test("1,001 files come out of the archive of the listed commit, with no request per file", async () => {
		const h = harness();
		const files = notes(1001);
		const revision = h.backend.commit(files);
		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(result.counts.fetched).toBe(1001);
		expect(result.refetched).toBe(0);
		expect(h.backend.zipRequests).toEqual([revision]);
		expect(h.perFile).toEqual([]);
		expect(h.vault.snapshot()).toEqual(files);
		expect(await h.records()).toEqual(hashes(files));
		expect(await readBaseRevision(h.store)).toBe(revision);
	});

	test("an archive estimated over the limit is not asked for: the files are fetched one at a time", async () => {
		const h = harness();
		// Larger than is synced, so it is not fetched; it is in the archive all the same.
		h.backend.commit({ ...notes(1001), "data/huge.bin": "x" });
		h.backend.listedSizes.set("data/huge.bin", 301 * MB);
		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(result.counts.fetched).toBe(1001);
		expect(h.backend.zipRequests).toEqual([]);
		expect(h.perFile.map((asked) => asked.length)).toEqual([1001]);
	});

	test("a file over the size limit does not keep the archive from being used, and is not taken out of it", async () => {
		const h = harness();
		h.backend.commit({ ...notes(1001), "media/film.mp4": "x" });
		h.backend.listedSizes.set("media/film.mp4", 60 * MB);
		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(h.backend.zipRequests).toHaveLength(1);
		expect(h.backend.inflated).toHaveLength(1001);
		expect(h.backend.inflated).not.toContain("media/film.mp4");
		expect(h.vault.text("media/film.mp4")).toBeUndefined();
		expect(result.notices).toContainEqual({ kind: "too-large", path: "media/film.mp4" });
		expect(h.perFile).toEqual([]);
	});

	test("a device that remembers not to use the archive fetches one file at a time", async () => {
		const h = harness();
		h.backend.commit(notes(1001));
		await h.store.setMeta(ARCHIVE_DISABLED_KEY, true);
		expect((await h.pull()).outcome).toBe("completed");
		expect(h.backend.zipRequests).toEqual([]);
		expect(h.perFile.map((asked) => asked.length)).toEqual([1001]);
		expect(await h.disabled()).toBe(true);
	});

	test("a remote without an archive always fetches one file at a time", async () => {
		const h = harness(new MemoryBackend());
		const files = notes(1001);
		h.backend.commit(files);
		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(h.perFile.map((asked) => asked.length)).toEqual([1001]);
		expect(h.vault.snapshot()).toEqual(files);
		expect(h.progress.some((event) => event.archive !== undefined)).toBe(false);
	});

	test("a device that only lost its records fetches nothing, and no archive", async () => {
		const h = harness();
		const files = notes(1001);
		h.backend.commit(files);
		await h.pull();
		h.store = new MemoryStateStore();
		h.backend.zipRequests.length = 0;

		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(result.counts.fetched).toBe(0);
		expect(h.backend.zipRequests).toEqual([]);
		expect(h.perFile).toEqual([]);
		expect(await h.records()).toEqual(hashes(files));
	});

	test("a pull of a few changed files asks for no archive", async () => {
		const h = harness();
		h.backend.commit(notes(1001));
		await h.pull();
		h.backend.zipRequests.length = 0;
		h.backend.commit({ "notes/0001.md": "changed", "notes/0500.md": "changed too", "new.md": "new" });

		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(result.counts.fetched).toBe(3);
		expect(h.backend.zipRequests).toEqual([]);
		expect(h.perFile).toEqual([["new.md", "notes/0001.md", "notes/0500.md"]]);
	});

	test("many changed files on a device that is long behind come out of the archive too", async () => {
		const h = harness();
		h.backend.commit(notes(1001));
		await h.pull();
		const changed = notes(1001, " (edited)");
		const revision = h.backend.commit(changed);
		h.backend.zipRequests.length = 0;

		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(h.backend.zipRequests).toEqual([revision]);
		expect(h.perFile).toEqual([]);
		expect(h.vault.snapshot()).toEqual(changed);
		// Not a first fetch: the views stay open.
		expect(h.views).toEqual(["close", "reopen"]);
	});

	test("both means end with the same files, the same records and the same base revision", async () => {
		const files = { ...notes(1001), ".gitignore": "*.tmp\n", "deep/in/a/folder.md": "deep" };
		const byArchive = harness();
		const oneByOne = harness(new MemoryBackend());
		const revision = byArchive.backend.commit(files);
		expect(oneByOne.backend.commit(files)).toBe(revision);
		const first = await byArchive.pull();
		const second = await oneByOne.pull();
		expect(byArchive.backend.zipRequests).toHaveLength(1);

		expect(await byArchive.store.readRecords()).toEqual(await oneByOne.store.readRecords());
		expect(byArchive.vault.snapshot()).toEqual(oneByOne.vault.snapshot());
		expect(await readBaseRevision(byArchive.store)).toBe(await readBaseRevision(oneByOne.store));
		expect(await byArchive.store.readMarkers()).toEqual([]);
		expect(await byArchive.attempt()).toBeUndefined();
		expect(first).toEqual(second);
	});

	test("a branch that moves during the pull changes nothing: the archive is of the commit that was listed", async () => {
		const h = harness();
		const files = notes(1001);
		const listed = h.backend.commit(files);
		const list = h.backend.list.bind(h.backend);
		let moved: string | null = null;
		h.backend.list = async (known) => {
			const result = await list(known);
			// Another device pushes right after the listing was taken.
			moved ??= h.backend.commit({ "notes/0001.md": "newer", "later.md": "later" });
			return result;
		};

		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(moved).not.toBe(listed);
		expect(h.backend.zipRequests).toEqual([listed]);
		expect(result.revision).toBe(listed);
		expect(h.vault.snapshot()).toEqual(files);
		expect(await h.records()).toEqual(hashes(files));
		expect(await readBaseRevision(h.store)).toBe(listed);
	});
});

describe("what the archive does not hold as the listing does", () => {
	test("files it leaves out or holds with another content are fetched one at a time, and counted", async () => {
		const h = harness();
		const files = {
			...notes(1001),
			"docs/ignored.md": "left out of the archive (export-ignore)\n",
			"docs/crlf.txt": "one\ntwo\n",
			"docs/subst.txt": "id: $Format:%H$\n",
		};
		h.backend.commit(files);
		h.backend.omitted.add("docs/ignored.md");
		// Line ends converted on the way into the archive: another size.
		h.backend.zipped.set("docs/crlf.txt", "one\r\ntwo\r\n");
		// A placeholder filled in, to the same size.
		h.backend.zipped.set("docs/subst.txt", "id: 0123456789a\n");

		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(result.counts.fetched).toBe(1004);
		expect(result.refetched).toBe(3);
		expect(result.deferred).toEqual([]);
		expect(h.backend.zipRequests).toHaveLength(1);
		expect(h.perFile).toEqual([["docs/crlf.txt", "docs/ignored.md", "docs/subst.txt"]]);
		// A size other than the listed one is seen without inflating.
		expect(h.backend.inflated).toContain("docs/subst.txt");
		expect(h.backend.inflated).not.toContain("docs/crlf.txt");

		// Every file is in the vault as its blob, and each record has the
		// hash the listing gave, which is the hash of the file in the vault.
		expect(h.vault.snapshot()).toEqual(files);
		expect(await h.records()).toEqual(hashes(files));
		expect(vaultHashes(h.vault)).toEqual(await h.records());
		expect(await readBaseRevision(h.store)).toBe(h.backend.revision);
	});

	test("when those cannot be fetched either, they wait for the next sync and nothing wrong is written", async () => {
		const h = harness();
		h.backend.commit({ ...notes(1001), "docs/crlf.txt": "one\ntwo\n" });
		h.backend.zipped.set("docs/crlf.txt", "one\r\ntwo\r\n");

		const result = await h.pull({
			fetchContents: async function* () {
				throw new BackendError("unreachable", "no network");
			},
		});
		expect(result.outcome).toBe("incomplete");
		expect(result.counts.fetched).toBe(1001);
		expect(h.vault.text("docs/crlf.txt")).toBeUndefined();
		expect(Object.keys(await h.records())).not.toContain("docs/crlf.txt");
		expect(await readBaseRevision(h.store)).toBeNull();
	});

	test("an entry no listing has is never written", async () => {
		const h = harness();
		const files = notes(1001);
		h.backend.commit(files);
		h.backend.zipped.set("ghost.md", "in the archive alone");
		h.backend.zipped.set("../outside.md", "a name that climbs out");
		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(h.vault.snapshot()).toEqual(files);
		expect(h.backend.inflated).toHaveLength(1001);
		expect(h.backend.inflated).not.toContain("ghost.md");
		expect(Object.keys(await h.records())).not.toContain("ghost.md");
	});

	test("a symlink, which the archive holds as a file with where it points, is never written as a file", async () => {
		const h = harness();
		const files = notes(1001);
		h.backend.commit({ ...files, "skills": "../shared/skills" });
		h.backend.symlinks.add("skills");
		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(h.vault.snapshot()).toEqual(files);
		expect(h.backend.inflated).not.toContain("skills");
		expect(result.newSymlinks).toEqual(["skills"]);
		expect(result.refetched).toBe(0);
	});

	test("an excluded path is not taken out of the archive", async () => {
		const h = harness();
		const files = notes(1001);
		h.backend.commit({ ...files, ".obsidian/plugins/sync-evo/main.js": "the plugin itself" });
		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(h.vault.snapshot()).toEqual(files);
		expect(h.backend.inflated).not.toContain(".obsidian/plugins/sync-evo/main.js");
	});
});

describe("an archive that fails", () => {
	test("a failure of the network: everything is fetched one at a time in the same pull, and nothing is remembered", async () => {
		const h = harness();
		const files = notes(1001);
		h.backend.commit(files);
		h.backend.zipFailure = new BackendError("unreachable", "get zip: no response within 300000 ms");

		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(result.refetched).toBe(0);
		expect(h.perFile.map((asked) => asked.length)).toEqual([1001]);
		expect(h.vault.snapshot()).toEqual(files);
		expect(await h.attempt()).toBeUndefined();
		expect(await h.disabled()).toBe(false);

		// The next pull that has many files to fetch tries the archive again.
		h.backend.zipFailure = undefined;
		h.backend.commit(notes(1001, " v2"));
		await h.pull();
		expect(h.backend.zipRequests).toHaveLength(2);
		expect(h.perFile).toHaveLength(1);
	});

	test.each([
		["unauthorized", "get zip: HTTP 401"],
		["forbidden", "get zip: HTTP 403"],
		["not-found", "get zip: HTTP 404"],
		["rate-limited", "get zip: rate limited"],
	] as const)("a request the remote refused (%s) is not remembered either", async (kind, message) => {
		const h = harness();
		h.backend.commit(notes(1001));
		h.backend.zipFailure = new BackendError(kind, message);
		expect((await h.pull()).outcome).toBe("completed");
		expect(h.perFile.map((asked) => asked.length)).toEqual([1001]);
		expect(await h.attempt()).toBeUndefined();
		expect(await h.disabled()).toBe(false);
	});

	test("a redirect that was not followed: fetched one at a time, and remembered for this device", async () => {
		const h = harness();
		const files = notes(1001);
		h.backend.commit(files);
		h.backend.zipFailure = new BackendError("other", "get zip: HTTP 302", 302);

		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(h.vault.snapshot()).toEqual(files);
		expect(h.perFile.map((asked) => asked.length)).toEqual([1001]);
		expect(await h.attempt()).toBeUndefined();
		expect(await h.disabled()).toBe(true);
		expect(last(h.logs)).toBe(
			"archive: failed (BackendError: get zip: HTTP 302). The other 1001 files are fetched one at a time, " +
				"and so is every file on this device from now on.",
		);

		// From now on no archive is asked for, also when it would work.
		h.backend.zipFailure = undefined;
		h.backend.commit(notes(1001, " v2"));
		expect((await h.pull()).outcome).toBe("completed");
		expect(h.backend.zipRequests).toHaveLength(1);
		expect(h.perFile.map((asked) => asked.length)).toEqual([1001, 1001]);
	});

	test.each([
		["an answer the remote does not give for a redirect", new BackendError("other", "get zip: HTTP 422", 422)],
		["a failure with no status to go by", new BackendError("other", "get zip: HTTP 302")],
		// The page of a network that wants a login, in place of the zip.
		["an answer that is not an archive", new Error("zip: no end of the directory")],
		["an error of another kind", new TypeError("undefined is not a function")],
	])("%s is not remembered: one at a time for this pull, and the archive again the next time", async (_name, failure) => {
		const h = harness();
		const files = notes(1001);
		h.backend.commit(files);
		h.backend.zipFailure = failure;

		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(result.notices).toEqual([]);
		expect(h.vault.snapshot()).toEqual(files);
		expect(h.perFile.map((asked) => asked.length)).toEqual([1001]);
		expect(await h.attempt()).toBeUndefined();
		expect(await h.disabled()).toBe(false);
		// On record all the same.
		expect(last(h.logs)).toBe(
			`archive: failed (${failure.name}: ${failure.message}). The other 1001 files are fetched one at a time; ` +
				"the next pull tries the archive again.",
		);

		h.backend.zipFailure = undefined;
		h.backend.commit(notes(1001, " v2"));
		expect((await h.pull()).outcome).toBe("completed");
		expect(h.backend.zipRequests).toHaveLength(2);
		expect(h.perFile).toHaveLength(1);
	});

	test("no memory for the archive itself is remembered", async () => {
		const h = harness();
		h.backend.commit(notes(1001));
		h.backend.zipFailure = new RangeError("Array buffer allocation failed");
		expect((await h.pull()).outcome).toBe("completed");
		expect(h.perFile.map((asked) => asked.length)).toEqual([1001]);
		expect(await h.disabled()).toBe(true);
		expect(last(h.logs)).toContain("archive: failed (RangeError: Array buffer allocation failed)");
	});

	test("no memory for a content out of the archive: the rest one at a time, and remembered", async () => {
		const h = harness();
		const files = notes(1001);
		h.backend.commit(files);
		h.backend.unreadable = "notes/0301.md";
		h.backend.readFailure = new RangeError("Array buffer allocation failed");

		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(h.perFile.map((asked) => asked.length)).toEqual([701]);
		expect(h.vault.snapshot()).toEqual(files);
		expect(await h.attempt()).toBeUndefined();
		expect(await h.disabled()).toBe(true);
		expect(last(h.logs)).toContain("and so is every file on this device from now on");
	});

	test("an error of another kind out of the archive is not remembered", async () => {
		const h = harness();
		const files = notes(1001);
		h.backend.commit(files);
		h.backend.unreadable = "notes/0301.md";
		h.backend.readFailure = new TypeError("undefined is not a function");

		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(h.perFile.map((asked) => asked.length)).toEqual([701]);
		expect(h.vault.snapshot()).toEqual(files);
		expect(await h.disabled()).toBe(false);
	});

	test("an archive that cannot be read on from some entry: the rest is fetched one at a time", async () => {
		const h = harness();
		const files = notes(1001);
		h.backend.commit(files);
		h.backend.unreadable = "notes/0301.md";

		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(result.counts.fetched).toBe(1001);
		// Not counted as files the archive held otherwise.
		expect(result.refetched).toBe(0);
		expect(h.perFile.map((asked) => asked.length)).toEqual([701]);
		expect(h.perFile[0]?.[0]).toBe("notes/0301.md");
		expect(h.vault.snapshot()).toEqual(files);
		expect(await h.attempt()).toBeUndefined();
		// A damaged download says nothing about the device.
		expect(await h.disabled()).toBe(false);
	});

	test("when the files cannot be fetched one at a time either, the pull is incomplete with that failure", async () => {
		const h = harness();
		h.backend.commit(notes(1001));
		h.backend.zipFailure = new BackendError("unreachable", "get zip: the request failed");
		const failure = new BackendError("unreachable", "get blob: the request failed");
		const result = await h.pull({
			fetchContents: async function* () {
				throw failure;
			},
		});
		expect(result.outcome).toBe("incomplete");
		expect(result.fetchError).toBe(failure);
		expect(await h.attempt()).toBeUndefined();
		expect(await h.disabled()).toBe(false);
	});
});

describe("the mark of an attempt", () => {
	test("it is there before the archive is asked for, and gone once the first file is written", async () => {
		const h = harness();
		h.backend.commit(notes(1001));
		const seen: unknown[] = [];
		h.backend.beforeZip = async () => {
			seen.push(await h.attempt());
		};
		let writes = 0;
		h.vault.before = async (op) => {
			if (op !== "write") return;
			writes += 1;
			if (writes <= 2) seen.push(await h.attempt());
		};

		expect((await h.pull()).outcome).toBe("completed");
		// At the request, at the first write, at the second write.
		expect(seen).toEqual([{ retries: 0 }, { retries: 0 }, undefined]);
		expect(await h.attempt()).toBeUndefined();
		expect(await h.disabled()).toBe(false);
	});

	test("it is gone when the first file out of the archive ends as a conflict", async () => {
		const h = harness();
		h.backend.commit(notes(1001));
		h.vault.put("notes/0001.md", "written here before the first sync");
		let marked: unknown = "not asked";
		let writes = 0;
		h.vault.before = async (op) => {
			if (op !== "write") return;
			writes += 1;
			// The copy and the file of the conflict are the first two writes.
			if (writes === 3) marked = await h.attempt();
		};
		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(result.conflicts.map((conflict) => conflict.path)).toEqual(["notes/0001.md"]);
		expect(marked).toBeUndefined();
	});

	test("it is gone when the first file out of the archive cannot be written", async () => {
		const h = harness();
		h.backend.commit(notes(1001));
		let marked: unknown = "not asked";
		h.vault.before = async (op, path) => {
			if (op !== "write") return;
			if (path === "notes/0001.md") throw new Error("the device refuses the name");
			if (path === "notes/0002.md") marked = await h.attempt();
		};
		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(result.unwritable.map((item) => item.path)).toEqual(["notes/0001.md"]);
		expect(marked).toBeUndefined();
		expect(await h.disabled()).toBe(false);
	});

	test("stopping the sync while the archive is on its way takes it away, and nothing is remembered", async () => {
		const h = harness();
		h.backend.commit(notes(1001));
		const stop = new AbortController();
		h.backend.beforeZip = () => {
			stop.abort();
			// The download cannot be taken back; it never answers here.
			return new Promise<void>(() => {});
		};
		const result = await h.pull({ signal: stop.signal });
		expect(result.outcome).toBe("cancelled");
		expect(h.vault.paths()).toEqual([]);
		expect(await h.attempt()).toBeUndefined();
		expect(await h.disabled()).toBe(false);
		expect(last(h.progress)?.archive).toBeUndefined();
	});

	test("stopped while the attempt is marked: no archive is asked for, and no mark is left", async () => {
		const h = harness();
		h.backend.commit(notes(1001));
		const stop = new AbortController();
		const marks: unknown[] = [];
		class StoppingStore extends MemoryStateStore {
			override async setMeta(key: string, value: unknown): Promise<void> {
				await super.setMeta(key, value);
				if (key !== ARCHIVE_ATTEMPT_KEY) return;
				marks.push(value);
				stop.abort();
			}
		}
		h.store = new StoppingStore();

		const result = await h.pull({ signal: stop.signal });
		expect(result.outcome).toBe("cancelled");
		expect(marks).toEqual([{ retries: 0 }]);
		expect(h.backend.zipRequests).toEqual([]);
		expect(h.perFile).toEqual([]);
		expect(h.vault.paths()).toEqual([]);
		expect(await h.attempt()).toBeUndefined();
		expect(await h.disabled()).toBe(false);
		expect(h.progress.some((event) => event.archive !== undefined)).toBe(false);
	});

	test("stopping the sync while the files are written takes it away too", async () => {
		const h = harness();
		h.backend.commit(notes(1001));
		const stop = new AbortController();
		h.vault.before = (op) => {
			if (op === "write") stop.abort();
		};
		const result = await h.pull({ signal: stop.signal });
		expect(result.outcome).toBe("cancelled");
		expect(result.counts.fetched).toBe(1);
		expect(await h.attempt()).toBeUndefined();
		expect(await h.disabled()).toBe(false);
		expect(h.perFile).toEqual([]);
	});

	test("an app killed while the archive is on its way leaves it; the next pull says so and tries the archive once more", async () => {
		const h = harness();
		const files = notes(1001);
		h.backend.commit(files);
		h.backend.beforeZip = () => h.kill();
		await expect(h.pull()).rejects.toThrow("the app is gone");
		expect(await h.attempt()).toEqual({ retries: 0 });
		expect(h.progress.filter((event) => event.archive !== undefined).map((event) => event.archive)).toEqual([
			"downloading",
		]);

		h.restart();
		h.progress.length = 0;
		let during: unknown;
		h.backend.beforeZip = async () => {
			during = await h.attempt();
		};
		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(during).toEqual({ retries: 1 });
		expect(h.backend.zipRequests).toHaveLength(2);
		expect(h.perFile).toEqual([]);
		expect(h.vault.snapshot()).toEqual(files);
		// Told while the download runs, and no longer once it is over.
		const told = h.progress.filter((event) => event.archive !== undefined);
		expect(told.length).toBeGreaterThan(0);
		expect(told.every((event) => event.archive === "retrying" && event.phase === "applying")).toBe(true);
		expect(last(h.progress)?.archive).toBeUndefined();

		// Neither the mark nor the count is left.
		expect(await h.attempt()).toBeUndefined();
		expect(await h.disabled()).toBe(false);
	});

	test("after an attempt that got through, another one that is killed gets its one retry again", async () => {
		const h = harness();
		h.backend.commit(notes(1001));
		h.backend.beforeZip = () => h.kill();
		await expect(h.pull()).rejects.toThrow();
		h.restart();
		h.backend.beforeZip = undefined;
		expect((await h.pull()).outcome).toBe("completed");

		// Another first fetch, later: the remote has all new files.
		h.backend.commit(notes(1001, " v2"));
		h.backend.beforeZip = () => h.kill();
		await expect(h.pull()).rejects.toThrow();
		expect(await h.attempt()).toEqual({ retries: 0 });

		h.restart();
		h.backend.beforeZip = undefined;
		h.progress.length = 0;
		expect((await h.pull()).outcome).toBe("completed");
		expect(h.progress.some((event) => event.archive === "retrying")).toBe(true);
		expect(h.backend.zipRequests).toHaveLength(4);
		expect(await h.disabled()).toBe(false);
	});

	test("killed again during the retry: this device gives the archive up and fetches one file at a time", async () => {
		const h = harness();
		const files = notes(1001);
		h.backend.commit(files);
		h.backend.beforeZip = () => h.kill();
		await expect(h.pull()).rejects.toThrow();
		h.restart();
		await expect(h.pull()).rejects.toThrow();
		expect(await h.attempt()).toEqual({ retries: 1 });
		expect(h.backend.zipRequests).toHaveLength(2);

		h.restart();
		h.progress.length = 0;
		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(h.backend.zipRequests).toHaveLength(2);
		expect(h.perFile.map((asked) => asked.length)).toEqual([1001]);
		expect(h.vault.snapshot()).toEqual(files);
		expect(h.progress.some((event) => event.archive !== undefined)).toBe(false);
		expect(await h.attempt()).toBeUndefined();
		expect(await h.disabled()).toBe(true);
	});

	test("killed after the first file was written: nothing is left, and the next pull chooses by what remains", async () => {
		const h = harness();
		const files = notes(1001);
		h.backend.commit(files);
		let writes = 0;
		h.vault.before = (op) => {
			if (op !== "write" || ++writes < 4) return;
			h.kill();
			throw new Error("the app is gone");
		};
		await expect(h.pull()).rejects.toThrow("the app is gone");
		expect(h.vault.paths()).toHaveLength(3);
		expect(await h.attempt()).toBeUndefined();
		expect(await h.disabled()).toBe(false);

		// 998 files remain: one at a time, and only those.
		h.restart();
		h.progress.length = 0;
		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(result.counts.fetched).toBe(998);
		expect(h.backend.zipRequests).toHaveLength(1);
		expect(h.perFile.map((asked) => asked.length)).toEqual([998]);
		expect(h.perFile[0]).not.toContain("notes/0001.md");
		expect(h.vault.snapshot()).toEqual(files);
		expect(h.progress.some((event) => event.archive !== undefined)).toBe(false);
	});

	test("killed after the first file with more than the threshold left: the archive again, as a first attempt", async () => {
		const h = harness();
		const files = notes(1005);
		h.backend.commit(files);
		let writes = 0;
		h.vault.before = (op) => {
			if (op !== "write" || ++writes < 4) return;
			h.kill();
			throw new Error("the app is gone");
		};
		await expect(h.pull()).rejects.toThrow("the app is gone");

		h.restart();
		h.progress.length = 0;
		h.backend.inflated.length = 0;
		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(result.counts.fetched).toBe(1002);
		expect(h.backend.zipRequests).toHaveLength(2);
		expect(h.perFile).toEqual([]);
		// What was written before is not taken out again.
		expect(h.backend.inflated).toHaveLength(1002);
		expect(h.backend.inflated).not.toContain("notes/0001.md");
		expect(h.progress.some((event) => event.archive === "downloading")).toBe(true);
		expect(h.progress.some((event) => event.archive === "retrying")).toBe(false);
		expect(h.vault.snapshot()).toEqual(files);
	});

	test("a mark of a retry that did not end is acted on by a pull of a few files too", async () => {
		const h = harness();
		const files = notes(10);
		h.backend.commit(files);
		await h.store.setMeta(ARCHIVE_ATTEMPT_KEY, { retries: 1 });

		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(h.backend.zipRequests).toEqual([]);
		expect(h.perFile.map((asked) => asked.length)).toEqual([10]);
		expect(h.vault.snapshot()).toEqual(files);
		expect(await h.attempt()).toBeUndefined();
		expect(await h.disabled()).toBe(true);
		expect(result.notices).toEqual([GIVEN_UP]);
		expect(h.logs[0]).toBe(
			"archive: two attempts in a row did not end. This device fetches one file at a time from now on.",
		);
	});

	test("a mark that is left is not counted by a pull that asks for no archive", async () => {
		const h = harness();
		h.backend.commit(notes(10));
		await h.store.setMeta(ARCHIVE_ATTEMPT_KEY, { retries: 0 });
		expect((await h.pull()).outcome).toBe("completed");
		expect(await h.attempt()).toEqual({ retries: 0 });
		expect(await h.disabled()).toBe(false);
	});

	test("the mark and the memory are in the sync state: a device whose state is discarded tries the archive again", async () => {
		const h = harness();
		h.backend.commit(notes(1001));
		await h.store.setMeta(ARCHIVE_DISABLED_KEY, true);
		h.store = new MemoryStateStore();
		expect((await h.pull()).outcome).toBe("completed");
		expect(h.backend.zipRequests).toHaveLength(1);
	});
});

describe("a device that stops using the archive", () => {
	test("is told once, by the pull in which the archive failed for good", async () => {
		const h = harness();
		h.backend.commit(notes(1001));
		h.backend.zipFailure = new BackendError("other", "get zip: HTTP 302", 302);
		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(result.notices).toEqual([GIVEN_UP]);

		// Not by the pulls after it, whether they fetch many files or none.
		h.backend.commit(notes(1001, " v2"));
		expect((await h.pull()).notices).toEqual([]);
		expect((await h.pull()).notices).toEqual([]);
		expect(await h.disabled()).toBe(true);
	});

	test("is told once when two attempts in a row did not end", async () => {
		const h = harness();
		h.backend.commit(notes(1001));
		h.backend.beforeZip = () => h.kill();
		await expect(h.pull()).rejects.toThrow();
		h.restart();
		await expect(h.pull()).rejects.toThrow();

		h.restart();
		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(result.notices).toEqual([GIVEN_UP]);
		h.backend.commit({ "new.md": "new" });
		expect((await h.pull()).notices).toEqual([]);
	});

	test("is told by the next pull when the one that remembered it ended without a word", async () => {
		const h = harness();
		h.backend.commit(notes(1001));
		h.backend.zipFailure = new RangeError("Array buffer allocation failed");
		let writes = 0;
		h.vault.before = (op) => {
			if (op !== "write" || ++writes < 4) return;
			h.kill();
			throw new Error("the app is gone");
		};
		await expect(h.pull()).rejects.toThrow("the app is gone");
		expect(await h.disabled()).toBe(true);

		h.restart();
		const result = await h.pull();
		expect(result.outcome).toBe("completed");
		expect(result.notices).toEqual([GIVEN_UP]);
		expect((await h.pull()).notices).toEqual([]);
	});

	test("is not told when the archive failed for this pull alone, or was not asked for", async () => {
		const h = harness();
		h.backend.commit(notes(1001));
		h.backend.zipFailure = new BackendError("unreachable", "get zip: the request failed");
		expect((await h.pull()).notices).toEqual([]);
		h.backend.commit({ "new.md": "new" });
		expect((await h.pull()).notices).toEqual([]);
	});
});

describe("a sync state that fails while the contents are fetched", () => {
	/** A store whose values fail from the moment a test says so. The records and the listing still answer. */
	class FailingStore extends MemoryStateStore {
		failing: ((op: "get" | "set" | "delete", key: string) => boolean) | undefined;
		readonly failure = new Error("the storage is gone");

		private check(op: "get" | "set" | "delete", key: string): void {
			if (this.failing?.(op, key) === true) throw this.failure;
		}

		override async getMeta(key: string): Promise<unknown> {
			this.check("get", key);
			return super.getMeta(key);
		}

		override async setMeta(key: string, value: unknown): Promise<void> {
			this.check("set", key);
			return super.setMeta(key, value);
		}

		override async deleteMeta(key: string): Promise<void> {
			this.check("delete", key);
			return super.deleteMeta(key);
		}
	}

	test.each([
		["read", "get", ARCHIVE_ATTEMPT_KEY],
		["written", "set", ARCHIVE_ATTEMPT_KEY],
		["taken away", "delete", ARCHIVE_ATTEMPT_KEY],
	] as const)("the mark cannot be %s: the pull rejects with what the store threw", async (_name, op, key) => {
		const h = harness();
		h.backend.commit(notes(1001));
		const store = new FailingStore();
		store.failing = (failedOp, failedKey) => failedOp === op && failedKey === key;
		h.store = store;

		// Not a pull that ends as incomplete, with a failure to fetch to tell.
		await expect(h.pull()).rejects.toBe(store.failure);
		expect(h.perFile).toEqual([]);
		if (op !== "delete") expect(h.backend.zipRequests).toEqual([]);
	});

	test("the memory cannot be written after the archive failed: the pull rejects, and fetches nothing more", async () => {
		const h = harness();
		h.backend.commit(notes(1001));
		h.backend.zipFailure = new BackendError("other", "get zip: HTTP 302", 302);
		const store = new FailingStore();
		store.failing = (op, key) => op === "set" && key === ARCHIVE_DISABLED_KEY;
		h.store = store;
		await expect(h.pull()).rejects.toBe(store.failure);
		expect(h.perFile).toEqual([]);
		expect(h.vault.paths()).toEqual([]);
	});

	test("it rejects also when the sync was stopped in the meantime", async () => {
		const h = harness();
		h.backend.commit(notes(1001));
		const stop = new AbortController();
		const store = new FailingStore();
		store.failing = (op, key) => {
			if (op !== "set" || key !== ARCHIVE_ATTEMPT_KEY) return false;
			stop.abort();
			return true;
		};
		h.store = store;
		await expect(h.pull({ signal: stop.signal })).rejects.toBe(store.failure);
	});

	test("a failure of the source that fetches one file at a time is a failure to fetch, as before", async () => {
		const h = harness();
		h.backend.commit(notes(3));
		const failure = new Error("the storage is gone");
		const result = await h.pull({
			fetchContents: async function* () {
				throw failure;
			},
		});
		expect(result.outcome).toBe("incomplete");
		expect(result.fetchError).toBe(failure);
	});
});

describe("what a pull by archive shows and records", () => {
	test("while the archive is on its way the progress says so, and counts again afterwards", async () => {
		const h = harness();
		h.backend.commit(notes(1001));
		const during: PullProgress[] = [];
		h.backend.beforeZip = () => {
			during.push(last(h.progress) as PullProgress);
		};
		await h.pull();
		expect(during).toEqual([{ phase: "applying", done: 0, total: 1001, closedViews: false, archive: "downloading" }]);
		const after = h.progress.slice(h.progress.indexOf(during[0] as PullProgress) + 1);
		expect(after.every((event) => event.archive === undefined)).toBe(true);
		expect(last(after)).toMatchObject({ phase: "applying", done: 1001, total: 1001 });
	});

	test("the views are closed for the writing of a first fetch by archive, and reopened", async () => {
		const h = harness();
		h.backend.commit(notes(1001));
		// Not yet while the archive is on its way: nothing is written then.
		h.backend.beforeZip = () => expect(h.views).toEqual([]);
		const result = await h.pull();
		expect(result.closedViews).toBe(true);
		expect(h.views).toEqual(["close", "reopen"]);
		expect(last(h.progress)?.closedViews).toBe(true);
	});

	test("the files out of the archive do not count against the request quota; the ones fetched after it do", async () => {
		const h = harness();
		h.backend.commit({ ...notes(1001), "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" });
		for (const path of ["a.txt", "b.txt", "c.txt"]) h.backend.omitted.add(path);
		const now = Date.UTC(2026, 9, 7, 12, 0, 0);
		const watch = new FetchLimitWatch(() => ({ remaining: 1, resetAt: now + 600_000 }), () => now);
		const counted = watch.watch((revision, entries) => h.backend.fetch(revision, entries));
		const quotaNotes: (number | null)[] = [];
		let writes = 0;
		h.vault.before = (op, path) => {
			if (op !== "write") return;
			writes += 1;
			if (writes === 1 || path === "a.txt") quotaNotes.push(watch.state().quota?.fetchable ?? null);
		};
		expect((await h.pull({ fetchContents: counted })).outcome).toBe("completed");
		// 1,001 files and 1 request left: nothing to tell while they come
		// out of the archive. The 3 that follow do not fit.
		expect(quotaNotes).toEqual([null, 1]);
	});

	test("the estimate and the real size of the archive are written to the log", async () => {
		const h = harness();
		h.backend.commit(notes(1001));
		await h.pull();
		expect(h.logs[0]).toMatch(/^fetch: 1001 files to fetch, archive estimated at \d+ bytes: archive$/);
		expect(h.logs[1]).toMatch(/^archive: \d+ bytes downloaded, estimated at \d+ bytes$/);
		expect(h.logs).toHaveLength(2);
	});

	test("each content is hashed once, by whichever means it came", async () => {
		for (const count of [1000, 1001]) {
			const h = harness();
			h.backend.commit(notes(count));
			let hashed = 0;
			const hashContent = h.backend.hashContent.bind(h.backend);
			h.backend.hashContent = (content) => {
				hashed += 1;
				return hashContent(content);
			};
			expect((await h.pull()).outcome).toBe("completed");
			expect(hashed).toBe(count);
		}
	});

	test("a hash a source hands over is compared with the listing like one computed at the write", async () => {
		const h = harness();
		h.backend.commit({ "a.md": "A", "b.md": "B" });
		const result = await h.pull({
			fetchContents: async function* (_revision, entries) {
				for (const item of entries) {
					const content = bytes(item.path === "a.md" ? "not A" : "B");
					yield { entry: item, content, hash: blobHash(content) };
				}
			},
		});
		expect(result.outcome).toBe("incomplete");
		expect(result.deferred).toEqual([{ path: "a.md", reason: "hash-mismatch" }]);
		expect(h.vault.snapshot()).toEqual({ "b.md": "B" });
	});
});

describe("an archive a stopped pull left on its way", () => {
	/** A pull that is stopped while its archive is on its way; `answer` lets that request end. */
	async function stoppedMidDownload(h: Harness, archiveGate: ArchiveGate): Promise<{ answer: () => void }> {
		let answer = (): void => {};
		const stop = new AbortController();
		h.backend.beforeZip = () => {
			stop.abort();
			return new Promise<void>((resolve) => {
				answer = resolve;
			});
		};
		const result = await h.pull({ signal: stop.signal, archiveGate });
		expect(result.outcome).toBe("cancelled");
		h.backend.beforeZip = undefined;
		return { answer: () => answer() };
	}

	const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

	test("the next pull waits for it to end before it asks for an archive, and says so", async () => {
		const h = harness();
		h.backend.commit(notes(1001));
		const archiveGate = new ArchiveGate();
		const { answer } = await stoppedMidDownload(h, archiveGate);
		expect(archiveGate.pending).not.toBeNull();

		const second = h.pull({ archiveGate });
		await settle();
		// Nothing was asked for, and nothing marked: killed here, the attempt
		// that had not begun is not counted as one that did not end.
		expect(h.backend.zipRequests.length).toBe(1);
		expect(await h.attempt()).toBeUndefined();
		expect(last(h.progress)?.archive).toBe("waiting");
		expect(h.vault.paths()).toEqual([]);

		answer();
		const result = await second;
		expect(result.outcome).toBe("completed");
		expect(h.backend.zipRequests.length).toBe(2);
		expect(h.perFile).toEqual([]);
		expect(h.vault.paths().length).toBe(1001);
		expect(archiveGate.pending).toBeNull();
		expect(await h.attempt()).toBeUndefined();
		// The line of the wait is taken away before the download has its own.
		const shown = h.progress.map((event) => event.archive);
		expect(shown.indexOf("downloading", shown.indexOf("waiting"))).toBeGreaterThan(shown.indexOf("waiting"));
	});

	test("a request that failed is over as well", async () => {
		const h = harness();
		h.backend.commit(notes(1001));
		const archiveGate = new ArchiveGate();
		const { answer } = await stoppedMidDownload(h, archiveGate);
		h.backend.zipFailure = new BackendError("unreachable", "timed out");
		answer();
		await settle();
		expect(archiveGate.pending).toBeNull();
		h.backend.zipFailure = undefined;

		expect((await h.pull({ archiveGate })).outcome).toBe("completed");
		expect(h.progress.some((event) => event.archive === "waiting")).toBe(false);
	});

	test("stopping during the wait ends the pull at once, with nothing asked for and no mark", async () => {
		const h = harness();
		h.backend.commit(notes(1001));
		const archiveGate = new ArchiveGate();
		await stoppedMidDownload(h, archiveGate);

		const stop = new AbortController();
		const second = h.pull({ signal: stop.signal, archiveGate });
		await settle();
		stop.abort();
		const result = await second;
		expect(result.outcome).toBe("cancelled");
		expect(h.backend.zipRequests.length).toBe(1);
		expect(await h.attempt()).toBeUndefined();
		expect(await h.disabled()).toBe(false);
		expect(last(h.progress)?.archive).toBeUndefined();
		// The first request is still the one that is waited for.
		expect(archiveGate.pending).not.toBeNull();
	});

	test("a pull that fetches one file at a time does not wait", async () => {
		const h = harness();
		h.backend.commit(notes(1001));
		const archiveGate = new ArchiveGate();
		await stoppedMidDownload(h, archiveGate);
		h.vault.putAll(notes(1000));

		const result = await h.pull({ archiveGate });
		expect(result.outcome).toBe("completed");
		expect(h.perFile).toEqual([["notes/1001.md"]]);
		expect(h.progress.some((event) => event.archive === "waiting")).toBe(false);
	});
});
