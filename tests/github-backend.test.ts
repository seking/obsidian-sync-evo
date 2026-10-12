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

import { strToU8, zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { BackendError, type BackendErrorKind, type FetchedFile, type RemoteEntry } from "../src/core/backend";
import { MAX_CONCURRENT_FETCH_BYTES, MAX_CONCURRENT_FETCHES } from "../src/core/concurrent-fetch";
import { entryOfTreeItem, GitHubBackend, type GitHubBackendClient } from "../src/core/github/backend";
import type { CreatedFile, GitCommit, GitTreeItem, HeadResult } from "../src/core/github/client";
import { blobHash } from "./support/memory-backend";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const T = "d".repeat(40);

/** A client that answers from what the test sets, and notes every call. */
class FakeClient implements GitHubBackendClient {
	readonly calls: string[] = [];
	head: HeadResult | BackendError = { status: "commit", sha: A };
	tree: GitTreeItem[] | BackendError = [];
	blobs = new Map<string, Uint8Array | BackendError>();
	ancestor: boolean | BackendError = true;
	zip: Uint8Array | BackendError = new Uint8Array();

	readonly branch = "main";

	async defaultBranch(): Promise<string> {
		this.calls.push("defaultBranch");
		return "main";
	}

	async createFile(path: string): Promise<CreatedFile> {
		this.calls.push(`createFile ${path}`);
		return { commitSha: A, blobSha: T, parents: 0 };
	}

	async resolveHead(): Promise<HeadResult> {
		this.calls.push("resolveHead");
		if (this.head instanceof BackendError) throw this.head;
		return this.head;
	}

	async getCommit(sha: string): Promise<GitCommit> {
		this.calls.push(`getCommit ${sha}`);
		return { sha, treeSha: T, parents: [] };
	}

	async getTree(sha: string): Promise<GitTreeItem[]> {
		this.calls.push(`getTree ${sha}`);
		if (this.tree instanceof BackendError) throw this.tree;
		return this.tree;
	}

	async getBlob(sha: string, size?: number): Promise<Uint8Array> {
		this.calls.push(`getBlob ${sha} ${String(size)}`);
		const blob = this.blobs.get(sha);
		if (blob === undefined) throw new BackendError("not-found", "no such blob");
		if (blob instanceof BackendError) throw blob;
		return blob;
	}

	async getZip(sha: string): Promise<ArrayBuffer> {
		this.calls.push(`getZip ${sha}`);
		if (this.zip instanceof BackendError) throw this.zip;
		// As a response hands it over: a buffer of its own.
		return this.zip.slice().buffer;
	}

	async isAncestor(base: string, head: string): Promise<boolean> {
		this.calls.push(`isAncestor ${base} ${head}`);
		if (this.ancestor instanceof BackendError) throw this.ancestor;
		return this.ancestor;
	}

	// Sending is tested against a fake of GitHub itself (`github-push.test.ts`).
	// Reading must never get here.
	async createBlob(): Promise<string> {
		throw new Error("createBlob: nothing is sent while reading");
	}

	async createTree(): Promise<string> {
		throw new Error("createTree: nothing is sent while reading");
	}

	async createCommit(): Promise<string> {
		throw new Error("createCommit: nothing is sent while reading");
	}

	async updateRef(): Promise<{ status: "updated" }> {
		throw new Error("updateRef: nothing is sent while reading");
	}
}

async function kindOf(promise: Promise<unknown>): Promise<BackendErrorKind | "resolved" | "not a BackendError"> {
	try {
		await promise;
		return "resolved";
	} catch (error) {
		return error instanceof BackendError ? error.kind : "not a BackendError";
	}
}

async function collect(files: AsyncIterable<FetchedFile>): Promise<FetchedFile[]> {
	const out: FetchedFile[] = [];
	for await (const file of files) out.push(file);
	return out;
}

describe("entryOfTreeItem", () => {
	test("a blob is a file, and keeps its size", () => {
		expect(entryOfTreeItem({ path: "a.md", mode: "100644", type: "blob", sha: B, size: 3 })).toEqual({
			path: "a.md",
			kind: "file",
			hash: B,
			size: 3,
		});
	});

	test("an executable is a file like any other", () => {
		expect(entryOfTreeItem({ path: "run.sh", mode: "100755", type: "blob", sha: B, size: 9 })?.kind).toBe("file");
	});

	test("mode 120000 is a symlink", () => {
		expect(entryOfTreeItem({ path: "link", mode: "120000", type: "blob", sha: B, size: 6 })).toEqual({
			path: "link",
			kind: "symlink",
			hash: B,
			size: 6,
		});
	});

	test("a commit is a submodule, without a size", () => {
		expect(entryOfTreeItem({ path: "lib", mode: "160000", type: "commit", sha: C })).toEqual({
			path: "lib",
			kind: "submodule",
			hash: C,
		});
	});

	test("a tree is not an entry", () => {
		expect(entryOfTreeItem({ path: "notes", mode: "040000", type: "tree", sha: C })).toBeNull();
	});
});

describe("list", () => {
	test("lists the tree of the commit the branch points at", async () => {
		const client = new FakeClient();
		client.tree = [
			{ path: "notes", mode: "040000", type: "tree", sha: C },
			{ path: "notes/a.md", mode: "100644", type: "blob", sha: B, size: 3 },
			{ path: "link", mode: "120000", type: "blob", sha: C, size: 5 },
			{ path: "lib", mode: "160000", type: "commit", sha: A },
		];
		const listed = await new GitHubBackend(client).list(null);
		expect(listed).toEqual({
			changed: true,
			listing: {
				revision: A,
				entries: [
					{ path: "notes/a.md", kind: "file", hash: B, size: 3 },
					{ path: "link", kind: "symlink", hash: C, size: 5 },
					{ path: "lib", kind: "submodule", hash: A },
				],
			},
		});
		expect(client.calls).toEqual(["resolveHead", `getCommit ${A}`, `getTree ${T}`]);
	});

	test("a head that is the known revision is answered without listing", async () => {
		const client = new FakeClient();
		expect(await new GitHubBackend(client).list(A)).toEqual({ changed: false });
		expect(client.calls).toEqual(["resolveHead"]);
	});

	test("a head that moved is listed", async () => {
		const client = new FakeClient();
		client.head = { status: "commit", sha: B };
		const listed = await new GitHubBackend(client).list(A);
		expect(listed.changed && listed.listing.revision).toBe(B);
	});

	test("a repository without commits has no revision and no entries", async () => {
		const client = new FakeClient();
		client.head = { status: "empty" };
		expect(await new GitHubBackend(client).list(null)).toEqual({
			changed: true,
			listing: { revision: null, entries: [] },
		});
		expect(client.calls).toEqual(["resolveHead"]);
	});

	test("a repository that became empty is a change, not the known revision", async () => {
		const client = new FakeClient();
		client.head = { status: "empty" };
		const listed = await new GitHubBackend(client).list(A);
		expect(listed.changed).toBe(true);
	});

	test("a tree that was cut short fails the listing", async () => {
		const client = new FakeClient();
		client.tree = new BackendError("incomplete-listing", "too large");
		expect(await kindOf(new GitHubBackend(client).list(null))).toBe("incomplete-listing");
	});

	test("a missing branch fails the listing", async () => {
		const client = new FakeClient();
		client.head = new BackendError("branch-not-found", "no such branch");
		expect(await kindOf(new GitHubBackend(client).list(null))).toBe("branch-not-found");
	});
});

describe("hashContent", () => {
	test("is the hash git gives the blob", async () => {
		const content = new TextEncoder().encode("hello\n");
		expect(await new GitHubBackend(new FakeClient()).hashContent(content)).toBe(blobHash(content));
	});

	test("yields between the pieces of a large file", async () => {
		let yields = 0;
		const backend = new GitHubBackend(new FakeClient(), {
			yieldControl: async () => {
				yields += 1;
			},
		});
		const content = new Uint8Array(4 * 1024 * 1024 + 1);
		expect(await backend.hashContent(content)).toBe(blobHash(content));
		expect(yields).toBe(1);
	});
});

describe("checkBase", () => {
	test("an ancestor continues", async () => {
		const client = new FakeClient();
		expect(await new GitHubBackend(client).checkBase(A, B)).toBe("continues");
		expect(client.calls).toEqual([`isAncestor ${A} ${B}`]);
	});

	test("GitHub's no is a rewritten history", async () => {
		const client = new FakeClient();
		client.ancestor = false;
		expect(await new GitHubBackend(client).checkBase(A, B)).toBe("rewritten");
	});

	test("a failure to find out is thrown, not read as rewritten", async () => {
		const client = new FakeClient();
		client.ancestor = new BackendError("unreachable", "timeout");
		expect(await kindOf(new GitHubBackend(client).checkBase(A, B))).toBe("unreachable");
	});
});

describe("fetch", () => {
	const file = (path: string, hash: string, size?: number): RemoteEntry => ({
		path,
		kind: "file",
		hash,
		...(size === undefined ? {} : { size }),
	});

	test("one blob per entry, with the size the tree gave", async () => {
		const client = new FakeClient();
		client.blobs.set(B, new Uint8Array([1]));
		client.blobs.set(C, new Uint8Array([2, 3]));
		const entries = [file("a.md", B, 1), file("b.md", C)];
		const fetched = await collect(new GitHubBackend(client).fetch(A, entries));
		expect(fetched).toEqual([
			{ entry: entries[0], content: new Uint8Array([1]) },
			{ entry: entries[1], content: new Uint8Array([2, 3]) },
		]);
		expect(client.calls).toEqual([`getBlob ${B} 1`, `getBlob ${C} undefined`]);
	});

	/** A client whose blobs stay on their way until the test lets them through. */
	class SlowClient extends FakeClient {
		private readonly open: (() => void)[] = [];

		override async getBlob(sha: string, size?: number): Promise<Uint8Array> {
			this.calls.push(`getBlob ${sha} ${String(size)}`);
			await new Promise<void>((resolve) => {
				this.open.push(resolve);
			});
			return new Uint8Array([1]);
		}

		/** Answers the request that has waited longest. */
		async answerOne(): Promise<void> {
			this.open.shift()?.();
			await settle();
		}
	}

	async function settle(): Promise<void> {
		for (let i = 0; i < 20; i++) await Promise.resolve();
	}

	const hashOf = (index: number): string => index.toString(16).padStart(40, "0");

	test("nothing is asked for before the first is wanted", async () => {
		const client = new FakeClient();
		new GitHubBackend(client).fetch(A, [file("a.md", B)]);
		await settle();
		expect(client.calls).toEqual([]);
	});

	test("16 blobs at a time, and one more for each one taken", async () => {
		const client = new SlowClient();
		const entries = Array.from({ length: 40 }, (_, index) => file(`${index}.md`, hashOf(index), 1));
		const iterator = new GitHubBackend(client).fetch(A, entries)[Symbol.asyncIterator]();
		const first = iterator.next();
		await settle();
		expect(client.calls).toEqual(entries.slice(0, MAX_CONCURRENT_FETCHES).map((entry) => `getBlob ${entry.hash} 1`));

		await client.answerOne();
		expect((await first).value?.entry).toBe(entries[0]);
		expect(client.calls).toHaveLength(16);
		iterator.next();
		await settle();
		expect(client.calls).toHaveLength(17);
	});

	test("the sizes the tree gave bound what is fetched at once", async () => {
		const client = new SlowClient();
		const half = MAX_CONCURRENT_FETCH_BYTES / 2;
		const entries = [file("a.bin", hashOf(1), half), file("b.bin", hashOf(2), half), file("c.md", hashOf(3), 1)];
		const iterator = new GitHubBackend(client).fetch(A, entries)[Symbol.asyncIterator]();
		iterator.next();
		await settle();
		expect(client.calls).toHaveLength(2);
	});

	test("a limit on the bytes given to the backend takes the place of the usual one", async () => {
		const client = new SlowClient();
		const limit = 8 * 1024 * 1024;
		const entries = [file("a.bin", hashOf(1), limit / 2), file("b.bin", hashOf(2), limit / 2), file("c.md", hashOf(3), 1)];
		const iterator = new GitHubBackend(client, { maxConcurrentFetchBytes: limit }).fetch(A, entries)[Symbol.asyncIterator]();
		iterator.next();
		await settle();
		expect(client.calls).toHaveLength(2);
	});

	test("a blob over the limit on the bytes is fetched alone", async () => {
		const client = new SlowClient();
		const limit = 8 * 1024 * 1024;
		const entries = [file("a.bin", hashOf(1), limit * 4), file("b.md", hashOf(2), 1)];
		const iterator = new GitHubBackend(client, { maxConcurrentFetchBytes: limit }).fetch(A, entries)[Symbol.asyncIterator]();
		const first = iterator.next();
		await settle();
		expect(client.calls).toHaveLength(1);

		await client.answerOne();
		expect((await first).value?.entry).toBe(entries[0]);
		iterator.next();
		await settle();
		expect(client.calls).toHaveLength(2);
	});

	test("a stop ends the fetch, and starts nothing more", async () => {
		const client = new SlowClient();
		const stop = new AbortController();
		const entries = Array.from({ length: 40 }, (_, index) => file(`${index}.md`, hashOf(index)));
		const fetching = collect(new GitHubBackend(client, { signal: stop.signal }).fetch(A, entries));
		await settle();
		stop.abort();
		expect(await kindOf(fetching)).toBe("cancelled");
		await client.answerOne();
		expect(client.calls).toHaveLength(16);
	});

	test("the blob of a symlink is fetched like a file's", async () => {
		const client = new FakeClient();
		client.blobs.set(B, new TextEncoder().encode("../x"));
		const entry: RemoteEntry = { path: "link", kind: "symlink", hash: B, size: 4 };
		expect(await collect(new GitHubBackend(client).fetch(A, [entry]))).toHaveLength(1);
	});

	test("a failure ends the fetch after what was already yielded", async () => {
		const client = new FakeClient();
		client.blobs.set(B, new Uint8Array([1]));
		client.blobs.set(C, new BackendError("cancelled", "get blob: cancelled"));
		const got: string[] = [];
		const run = (async () => {
			for await (const { entry } of new GitHubBackend(client).fetch(A, [file("a.md", B), file("b.md", C)])) {
				got.push(entry.path);
			}
		})();
		expect(await kindOf(run)).toBe("cancelled");
		expect(got).toEqual(["a.md"]);
	});

	test("a submodule has no content to fetch", async () => {
		const entry: RemoteEntry = { path: "lib", kind: "submodule", hash: C };
		expect(await kindOf(collect(new GitHubBackend(new FakeClient()).fetch(A, [entry])))).toBe("other");
	});

	test("a submodule among the entries fails the fetch before anything is asked for", async () => {
		const client = new SlowClient();
		const entries: RemoteEntry[] = [
			file("a.md", hashOf(1), 1),
			file("b.md", hashOf(2), 1),
			{ path: "lib", kind: "submodule", hash: C },
			file("c.md", hashOf(3), 1),
		];
		const fetching = new GitHubBackend(client).fetch(A, entries);
		await settle();
		// Thrown when the first is wanted, like every failure of a fetch.
		expect(await kindOf(collect(fetching))).toBe("other");
		await settle();
		expect(client.calls).toEqual([]);
	});
});

describe("contentOf", () => {
	test("one blob by its hash, whichever commit named it", async () => {
		const client = new FakeClient();
		client.blobs.set(B, new Uint8Array([1, 2]));
		expect(await new GitHubBackend(client).contentOf(B)).toEqual(new Uint8Array([1, 2]));
		expect(client.calls).toEqual([`getBlob ${B} undefined`]);
	});

	test("a blob GitHub no longer holds is no content, and no failure", async () => {
		expect(await new GitHubBackend(new FakeClient()).contentOf(B)).toBeNull();
	});

	test("every other failure is thrown as the client threw it", async () => {
		const client = new FakeClient();
		client.blobs.set(B, new BackendError("unreachable", "timeout"));
		expect(await kindOf(new GitHubBackend(client).contentOf(B))).toBe("unreachable");
	});
});

describe("fetchArchive", () => {
	test("the zip of the commit, with the folder GitHub puts everything in left out", async () => {
		const client = new FakeClient();
		client.zip = zipSync({
			[`octo-notes-${A.slice(0, 7)}/`]: new Uint8Array(),
			[`octo-notes-${A.slice(0, 7)}/a.md`]: strToU8("alpha"),
			[`octo-notes-${A.slice(0, 7)}/notes/b.md`]: strToU8("beta"),
		});
		const archive = await new GitHubBackend(client).fetchArchive(A);
		// Asked for by the commit, and nothing else is asked for.
		expect(client.calls).toEqual([`getZip ${A}`]);
		expect(archive.byteLength).toBe(client.zip.length);
		expect(archive.sizeOf("a.md")).toBe(5);
		expect(new TextDecoder().decode(archive.read("notes/b.md"))).toBe("beta");
		expect(archive.sizeOf(`octo-notes-${A.slice(0, 7)}/a.md`)).toBeNull();
	});

	test("a failure of the request is the client's, unchanged", async () => {
		const client = new FakeClient();
		client.zip = new BackendError("other", "get zip: HTTP 302");
		expect(await kindOf(new GitHubBackend(client).fetchArchive(A))).toBe("other");
	});

	test("an answer that is not a zip fails, and not as a failure of the remote", async () => {
		const client = new FakeClient();
		client.zip = strToU8("<html>Sign in</html>".repeat(5));
		await expect(new GitHubBackend(client).fetchArchive(A)).rejects.not.toBeInstanceOf(BackendError);
	});
});
