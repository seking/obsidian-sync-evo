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
import type { CreatedFile, GitCommit, GitTreeItem, HeadResult, RepositoryName } from "../src/core/github/client";
import { blobHash } from "./support/memory-backend";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const T = "d".repeat(40);
const M = "e".repeat(40);
const X = "f".repeat(40);

/** A client that answers from what the test sets, and notes every call. */
class FakeClient implements GitHubBackendClient {
	readonly calls: string[] = [];
	head: HeadResult | BackendError = { status: "commit", sha: A };
	tree: GitTreeItem[] | BackendError = [];
	blobs = new Map<string, Uint8Array | BackendError>();
	ancestor: boolean | BackendError = true;
	zip: Uint8Array | BackendError = new Uint8Array();

	readonly branch = "main";
	readonly repository = { owner: "octo", repo: "notes" };
	/** The other repositories the token sees, by `owner/name`: the tree of each of their commits, or why it fails. */
	others = new Map<string, Map<string, GitTreeItem[] | BackendError>>();

	async sees(other: RepositoryName): Promise<boolean> {
		this.calls.push(`sees ${other.owner}/${other.repo}`);
		return this.others.has(`${other.owner}/${other.repo}`);
	}

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

	// A call for another repository is noted with the repository after it.
	private of(other: RepositoryName | undefined): string {
		return other === undefined ? "" : ` @${other.owner}/${other.repo}`;
	}

	async getCommit(sha: string, other?: RepositoryName): Promise<GitCommit> {
		this.calls.push(`getCommit ${sha}${this.of(other)}`);
		if (other === undefined) return { sha, treeSha: T, parents: [] };
		// The tree of a commit of another repository is asked for by the commit, here.
		const commits = this.others.get(`${other.owner}/${other.repo}`);
		if (commits === undefined || !commits.has(sha)) throw new BackendError("not-found", "no such commit", 404);
		return { sha, treeSha: sha, parents: [] };
	}

	async getTree(sha: string, other?: RepositoryName): Promise<GitTreeItem[]> {
		this.calls.push(`getTree ${sha}${this.of(other)}`);
		const tree = other === undefined ? this.tree : this.others.get(`${other.owner}/${other.repo}`)?.get(sha);
		if (tree === undefined) throw new BackendError("not-found", "no such tree", 404);
		if (tree instanceof BackendError) throw tree;
		return tree;
	}

	async getBlob(sha: string, size?: number, other?: RepositoryName): Promise<Uint8Array> {
		this.calls.push(`getBlob ${sha} ${String(size)}${this.of(other)}`);
		const blob = this.blobs.get(sha);
		if (blob === undefined) throw new BackendError("not-found", "no such blob");
		if (blob instanceof BackendError) throw blob;
		return blob;
	}

	async getZip(sha: string, other?: RepositoryName): Promise<ArrayBuffer> {
		this.calls.push(`getZip ${sha}${this.of(other)}`);
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
					// Nothing says where it points to: there is no `.gitmodules`.
					{ path: "lib", kind: "submodule", hash: A, contents: { listed: false, reason: "not-supported" } },
				],
			},
		});
		expect(client.calls).toEqual(["resolveHead", `getCommit ${A}`, `getTree ${T}`]);
	});

	test("a head that is the known revision is answered without listing", async () => {
		const client = new FakeClient();
		expect(await new GitHubBackend(client).list({ revision: A, entries: [] })).toEqual({ changed: false });
		expect(client.calls).toEqual(["resolveHead"]);
	});

	test("a head that moved is listed", async () => {
		const client = new FakeClient();
		client.head = { status: "commit", sha: B };
		const listed = await new GitHubBackend(client).list({ revision: A, entries: [] });
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
		const listed = await new GitHubBackend(client).list({ revision: A, entries: [] });
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

describe("list, with a submodule", () => {
	const lib: RemoteEntry = { path: "lib", kind: "submodule", hash: C };
	const source = { submodule: "lib", repository: "octo/lib", revision: C };

	/** The `.gitmodules` of the tree, with this text. The client answers for its blob. */
	function gitmodules(client: FakeClient, text: string): GitTreeItem {
		client.blobs.set(M, strToU8(text));
		return { path: ".gitmodules", mode: "100644", type: "blob", sha: M, size: text.length };
	}

	/** A tree with `.gitmodules`, a note, and a submodule at `lib` that points to `commit` of `url`. */
	function withLib(client: FakeClient, url = "https://github.com/octo/lib.git", commit = C): void {
		client.tree = [
			gitmodules(client, `[submodule "lib"]\n\tpath = lib\n\turl = ${url}\n`),
			{ path: "a.md", mode: "100644", type: "blob", sha: B, size: 3 },
			{ path: "lib", mode: "160000", type: "commit", sha: commit },
		];
	}

	async function entriesOf(backend: GitHubBackend): Promise<readonly RemoteEntry[]> {
		const listed = await backend.list(null);
		if (!listed.changed) throw new Error("expected a listing");
		return listed.listing.entries;
	}

	/** The entry of the submodule at `lib`, as listed. */
	async function libOf(client: FakeClient): Promise<RemoteEntry | undefined> {
		return (await entriesOf(new GitHubBackend(client))).find((entry) => entry.path === "lib");
	}

	const first = ["resolveHead", `getCommit ${A}`, `getTree ${T}`];
	const readGitmodules = (text: string): string => `getBlob ${M} ${text.length}`;

	test("what the commit it points to holds is listed below it, and says where it is read from", async () => {
		const client = new FakeClient();
		withLib(client);
		client.others.set(
			"octo/lib",
			new Map([
				[
					C,
					[
						{ path: "docs", mode: "040000", type: "tree", sha: T },
						{ path: "docs/x.md", mode: "100644", type: "blob", sha: X, size: 5 },
						{ path: "README.md", mode: "100644", type: "blob", sha: B, size: 3 },
					],
				],
			]),
		);
		expect(await entriesOf(new GitHubBackend(client))).toEqual([
			{ path: ".gitmodules", kind: "file", hash: M, size: 69 },
			{ path: "a.md", kind: "file", hash: B, size: 3 },
			{ ...lib, contents: { listed: true, repository: "octo/lib" } },
			{ path: "lib/docs/x.md", kind: "file", hash: X, size: 5, source },
			{ path: "lib/README.md", kind: "file", hash: B, size: 3, source },
		]);
		// One request for `.gitmodules`, and two for the submodule, asked of the other repository.
		expect(client.calls).toEqual([
			...first,
			`getBlob ${M} 69`,
			`getCommit ${C} @octo/lib`,
			`getTree ${C} @octo/lib`,
		]);
	});

	test("the revision of the listing is the head of the remote, not the commit of the submodule", async () => {
		const client = new FakeClient();
		withLib(client);
		client.others.set("octo/lib", new Map([[C, []]]));
		const listed = await new GitHubBackend(client).list(null);
		expect(listed.changed && listed.listing.revision).toBe(A);
	});

	test("an empty commit is listed too: the submodule holds nothing", async () => {
		const client = new FakeClient();
		withLib(client);
		client.others.set("octo/lib", new Map([[C, []]]));
		const entries = await entriesOf(new GitHubBackend(client));
		expect(entries.map((entry) => entry.path)).toEqual([".gitmodules", "a.md", "lib"]);
		expect(entries[2]?.contents).toEqual({ listed: true, repository: "octo/lib" });
	});

	test("a symlink and an executable inside it are a symlink and a file, read from there as well", async () => {
		const client = new FakeClient();
		withLib(client);
		client.others.set(
			"octo/lib",
			new Map([
				[
					C,
					[
						{ path: "run.sh", mode: "100755", type: "blob", sha: X, size: 9 },
						{ path: "link", mode: "120000", type: "blob", sha: B, size: 6 },
					],
				],
			]),
		);
		expect((await entriesOf(new GitHubBackend(client))).slice(3)).toEqual([
			{ path: "lib/run.sh", kind: "file", hash: X, size: 9, source },
			{ path: "lib/link", kind: "symlink", hash: B, size: 6, source },
		]);
	});

	test("a submodule inside it is not listed, and is asked nothing of", async () => {
		const client = new FakeClient();
		withLib(client);
		client.others.set(
			"octo/lib",
			new Map([
				[
					C,
					[
						// Its own `.gitmodules` is a file like any other, and is not read.
						{ path: ".gitmodules", mode: "100644", type: "blob", sha: X, size: 7 },
						{ path: "deep", mode: "160000", type: "commit", sha: T },
						{ path: "x.md", mode: "100644", type: "blob", sha: B, size: 3 },
					],
				],
			]),
		);
		expect((await entriesOf(new GitHubBackend(client))).slice(2)).toEqual([
			{ ...lib, contents: { listed: true, repository: "octo/lib" } },
			{ path: "lib/.gitmodules", kind: "file", hash: X, size: 7, source },
			// Neither a source nor a repository: nothing was looked up.
			{ path: "lib/deep", kind: "submodule", hash: T, contents: { listed: false, reason: "nested" } },
			{ path: "lib/x.md", kind: "file", hash: B, size: 3, source },
		]);
		expect(client.calls.slice(4)).toEqual([`getCommit ${C} @octo/lib`, `getTree ${C} @octo/lib`]);
	});

	test("a submodule below a folder is listed below its whole path", async () => {
		const client = new FakeClient();
		client.tree = [
			gitmodules(client, '[submodule "lib"]\n\tpath = vendor/lib\n\turl = https://github.com/octo/lib\n'),
			{ path: "vendor", mode: "040000", type: "tree", sha: T },
			{ path: "vendor/lib", mode: "160000", type: "commit", sha: C },
		];
		client.others.set("octo/lib", new Map([[C, [{ path: "x.md", mode: "100644", type: "blob", sha: X, size: 5 }]]]));
		expect((await entriesOf(new GitHubBackend(client))).slice(1)).toEqual([
			{ path: "vendor/lib", kind: "submodule", hash: C, contents: { listed: true, repository: "octo/lib" } },
			{ path: "vendor/lib/x.md", kind: "file", hash: X, size: 5, source: { ...source, submodule: "vendor/lib" } },
		]);
	});

	test("a URL relative to the repository is one of the same owner", async () => {
		const client = new FakeClient();
		withLib(client, "../lib.git");
		client.others.set("octo/lib", new Map([[C, [{ path: "x.md", mode: "100644", type: "blob", sha: X, size: 5 }]]]));
		expect((await entriesOf(new GitHubBackend(client))).slice(2)).toEqual([
			{ ...lib, contents: { listed: true, repository: "octo/lib" } },
			{ path: "lib/x.md", kind: "file", hash: X, size: 5, source },
		]);
	});

	test("one that .gitmodules does not name is not supported, and nothing is asked of any repository", async () => {
		const client = new FakeClient();
		const text = '[submodule "other"]\n\tpath = other\n\turl = https://github.com/octo/other\n';
		client.tree = [gitmodules(client, text), { path: "lib", mode: "160000", type: "commit", sha: C }];
		expect(await libOf(client)).toEqual({ ...lib, contents: { listed: false, reason: "not-supported" } });
		expect(client.calls).toEqual([...first, readGitmodules(text)]);
	});

	test.each([
		"https://gitlab.com/octo/lib.git",
		"git@example.com:octo/lib.git",
		"/srv/git/lib.git",
		"https://github.com/octo/lib/tree/main",
	])("one that points to %s is not supported, and nothing is asked of any repository", async (url) => {
		const client = new FakeClient();
		const text = `[submodule "lib"]\n\tpath = lib\n\turl = ${url}\n`;
		client.tree = [gitmodules(client, text), { path: "lib", mode: "160000", type: "commit", sha: C }];
		expect(await libOf(client)).toEqual({ ...lib, contents: { listed: false, reason: "not-supported" } });
		expect(client.calls).toEqual([...first, readGitmodules(text)]);
	});

	test("only the .gitmodules at the root of the tree is read, and only as a file", async () => {
		const client = new FakeClient();
		client.tree = [
			{ path: ".gitmodules", mode: "120000", type: "blob", sha: M, size: 9 },
			{ path: "notes/.gitmodules", mode: "100644", type: "blob", sha: X, size: 9 },
			{ path: "lib", mode: "160000", type: "commit", sha: C },
		];
		expect(await libOf(client)).toEqual({ ...lib, contents: { listed: false, reason: "not-supported" } });
		expect(client.calls).toEqual(first);
	});

	test("a repository the token does not see is told apart from a missing commit by asking for the repository", async () => {
		const client = new FakeClient();
		withLib(client, "https://github.com/octo/private.git");
		expect(await libOf(client)).toEqual({
			...lib,
			contents: { listed: false, reason: "no-access", repository: "octo/private" },
		});
		expect(client.calls.slice(4)).toEqual([`getCommit ${C} @octo/private`, "sees octo/private"]);
	});

	test("a repository in sight that does not hold the commit", async () => {
		const client = new FakeClient();
		withLib(client);
		// It has another commit, and not the one the submodule points to.
		client.others.set("octo/lib", new Map([[T, []]]));
		expect(await libOf(client)).toEqual({
			...lib,
			contents: { listed: false, reason: "no-commit", repository: "octo/lib" },
		});
		expect(client.calls.slice(4)).toEqual([`getCommit ${C} @octo/lib`, "sees octo/lib"]);
	});

	test("a repository without commits does not hold it either, and is not asked for again", async () => {
		const client = new FakeClient();
		withLib(client);
		client.others.set("octo/lib", new Map([[C, new BackendError("other", "get tree: HTTP 409", 409)]]));
		expect((await libOf(client))?.contents).toEqual({ listed: false, reason: "no-commit", repository: "octo/lib" });
		expect(client.calls).not.toContain("sees octo/lib");
	});

	test("a repository that refuses the token is out of sight, and is not asked for again", async () => {
		const client = new FakeClient();
		withLib(client);
		client.others.set("octo/lib", new Map([[C, new BackendError("forbidden", "get tree: HTTP 403", 403)]]));
		expect((await libOf(client))?.contents).toEqual({ listed: false, reason: "no-access", repository: "octo/lib" });
		expect(client.calls).not.toContain("sees octo/lib");
	});

	test("a tree that was cut short is too large, and does not fail the listing", async () => {
		const client = new FakeClient();
		withLib(client);
		client.others.set("octo/lib", new Map([[C, new BackendError("incomplete-listing", "too large")]]));
		const entries = await entriesOf(new GitHubBackend(client));
		expect(entries.map((entry) => entry.path)).toEqual([".gitmodules", "a.md", "lib"]);
		expect(entries[2]?.contents).toEqual({ listed: false, reason: "too-large", repository: "octo/lib" });
	});

	test.each<[BackendErrorKind, number | undefined]>([
		["unreachable", undefined],
		["unauthorized", 401],
		["rate-limited", 403],
		["cancelled", undefined],
		["other", 500],
	])("a failure to find out (%s) fails the listing: nothing is known of the submodule", async (kind, status) => {
		const client = new FakeClient();
		withLib(client);
		client.others.set("octo/lib", new Map([[C, new BackendError(kind, "get tree: failed", status)]]));
		expect(await kindOf(new GitHubBackend(client).list(null))).toBe(kind);
	});

	test("a .gitmodules that cannot be read fails the listing", async () => {
		const client = new FakeClient();
		withLib(client);
		client.blobs.set(M, new BackendError("unreachable", "timeout"));
		expect(await kindOf(new GitHubBackend(client).list(null))).toBe("unreachable");
	});

	test("each submodule is looked up on its own, and one that is not listed leaves the others listed", async () => {
		const client = new FakeClient();
		const text =
			'[submodule "one"]\n\tpath = one\n\turl = ../one\n' +
			'[submodule "two"]\n\tpath = two\n\turl = ../two\n' +
			'[submodule "three"]\n\tpath = three\n\turl = https://gitlab.com/octo/three\n';
		client.tree = [
			gitmodules(client, text),
			{ path: "one", mode: "160000", type: "commit", sha: C },
			{ path: "three", mode: "160000", type: "commit", sha: C },
			{ path: "two", mode: "160000", type: "commit", sha: T },
		];
		client.others.set("octo/two", new Map([[T, [{ path: "x.md", mode: "100644", type: "blob", sha: X, size: 5 }]]]));
		expect((await entriesOf(new GitHubBackend(client))).slice(1)).toEqual([
			{ path: "one", kind: "submodule", hash: C, contents: { listed: false, reason: "no-access", repository: "octo/one" } },
			{ path: "three", kind: "submodule", hash: C, contents: { listed: false, reason: "not-supported" } },
			{ path: "two", kind: "submodule", hash: T, contents: { listed: true, repository: "octo/two" } },
			{
				path: "two/x.md",
				kind: "file",
				hash: X,
				size: 5,
				source: { submodule: "two", repository: "octo/two", revision: T },
			},
		]);
	});

	test("two submodules at the same commit of one repository are asked for once", async () => {
		const client = new FakeClient();
		const text = '[submodule "one"]\n\tpath = one\n\turl = ../lib\n[submodule "two"]\n\tpath = two\n\turl = ../lib\n';
		client.tree = [
			gitmodules(client, text),
			{ path: "one", mode: "160000", type: "commit", sha: C },
			{ path: "two", mode: "160000", type: "commit", sha: C },
		];
		client.others.set("octo/lib", new Map([[C, [{ path: "x.md", mode: "100644", type: "blob", sha: X, size: 5 }]]]));
		const entries = await entriesOf(new GitHubBackend(client));
		expect(entries.map((entry) => `${entry.path} ${entry.source?.submodule ?? "-"}`)).toEqual([
			".gitmodules -",
			"one -",
			"one/x.md one",
			"two -",
			"two/x.md two",
		]);
		expect(client.calls.filter((call) => call.endsWith("@octo/lib"))).toHaveLength(2);
	});

	test("a second listing by the same backend asks neither for .gitmodules nor of the other repository again", async () => {
		const client = new FakeClient();
		withLib(client);
		client.others.set("octo/lib", new Map([[C, [{ path: "x.md", mode: "100644", type: "blob", sha: X, size: 5 }]]]));
		const backend = new GitHubBackend(client);
		const before = await entriesOf(backend);
		client.calls.length = 0;
		expect(await entriesOf(backend)).toEqual(before);
		expect(client.calls).toEqual(first);
	});

	test("another backend asks again: what was read is kept by the one that read it", async () => {
		const client = new FakeClient();
		withLib(client);
		client.others.set("octo/lib", new Map([[C, []]]));
		await entriesOf(new GitHubBackend(client));
		client.calls.length = 0;
		await entriesOf(new GitHubBackend(client));
		expect(client.calls).toHaveLength(6);
	});

	test("a submodule that moved to another commit is asked for again, .gitmodules as it was is not", async () => {
		const client = new FakeClient();
		withLib(client);
		client.others.set(
			"octo/lib",
			new Map([
				[C, [{ path: "x.md", mode: "100644", type: "blob", sha: X, size: 5 }]],
				[T, [{ path: "y.md", mode: "100644", type: "blob", sha: B, size: 3 }]],
			]),
		);
		const backend = new GitHubBackend(client);
		await entriesOf(backend);
		client.calls.length = 0;
		// The same `.gitmodules`, and the submodule at another commit.
		withLib(client, "https://github.com/octo/lib.git", T);
		expect((await entriesOf(backend)).slice(2)).toEqual([
			{ path: "lib", kind: "submodule", hash: T, contents: { listed: true, repository: "octo/lib" } },
			{ path: "lib/y.md", kind: "file", hash: B, size: 3, source: { ...source, revision: T } },
		]);
		expect(client.calls).toEqual([...first, `getCommit ${T} @octo/lib`, `getTree ${T} @octo/lib`]);
	});

	test("a submodule that was not listed is asked for again by the next listing, and listed once it can be", async () => {
		const client = new FakeClient();
		withLib(client);
		const backend = new GitHubBackend(client);
		expect((await entriesOf(backend))[2]?.contents).toMatchObject({ listed: false, reason: "no-access" });

		// The token is given sight of the repository; the remote has not moved.
		client.others.set("octo/lib", new Map([[C, [{ path: "x.md", mode: "100644", type: "blob", sha: X, size: 5 }]]]));
		client.calls.length = 0;
		expect((await entriesOf(backend)).slice(2)).toEqual([
			{ ...lib, contents: { listed: true, repository: "octo/lib" } },
			{ path: "lib/x.md", kind: "file", hash: X, size: 5, source },
		]);
		expect(client.calls).toEqual([...first, `getCommit ${C} @octo/lib`, `getTree ${C} @octo/lib`]);
	});

	test("a tree without a submodule asks nothing more, though it has a .gitmodules", async () => {
		const client = new FakeClient();
		client.tree = [
			gitmodules(client, '[submodule "lib"]\n\tpath = lib\n\turl = ../lib\n'),
			{ path: "a.md", mode: "100644", type: "blob", sha: B, size: 3 },
		];
		const entries = await entriesOf(new GitHubBackend(client));
		expect(entries.map((entry) => entry.path)).toEqual([".gitmodules", "a.md"]);
		expect(client.calls).toEqual(first);
	});

	test("a head that is the known revision is answered without looking at any submodule", async () => {
		const client = new FakeClient();
		withLib(client);
		expect(await new GitHubBackend(client).list({ revision: A, entries: [] })).toEqual({ changed: false });
		expect(client.calls).toEqual(["resolveHead"]);
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

	test("an entry below a submodule is asked of the repository the submodule points to", async () => {
		const client = new FakeClient();
		client.blobs.set(B, new Uint8Array([1]));
		client.blobs.set(C, new Uint8Array([2, 3]));
		const source = { submodule: "lib", repository: "octo/lib", revision: T };
		const entries: RemoteEntry[] = [file("a.md", B, 1), { ...file("lib/x.md", C, 2), source }, { ...file("lib/y.md", B), source }];
		const fetched = await collect(new GitHubBackend(client).fetch(A, entries));
		expect(fetched).toEqual([
			{ entry: entries[0], content: new Uint8Array([1]) },
			{ entry: entries[1], content: new Uint8Array([2, 3]) },
			{ entry: entries[2], content: new Uint8Array([1]) },
		]);
		// By the hash of the blob, as any other; the commit of the submodule is not asked for.
		expect(client.calls).toEqual([`getBlob ${B} 1`, `getBlob ${C} 2 @octo/lib`, `getBlob ${B} undefined @octo/lib`]);
	});

	test("entries below two submodules are each asked of their own repository", async () => {
		const client = new FakeClient();
		client.blobs.set(B, new Uint8Array([1]));
		const entries: RemoteEntry[] = [
			{ ...file("one/x.md", B, 1), source: { submodule: "one", repository: "octo/one", revision: T } },
			{ ...file("two/x.md", B, 1), source: { submodule: "two", repository: "other/two", revision: T } },
		];
		await collect(new GitHubBackend(client).fetch(A, entries));
		expect(client.calls).toEqual([`getBlob ${B} 1 @octo/one`, `getBlob ${B} 1 @other/two`]);
	});

	test("a source that names no repository fails the fetch before anything is asked for", async () => {
		const client = new FakeClient();
		client.blobs.set(B, new Uint8Array([1]));
		const source = { submodule: "lib", repository: "not a repository", revision: T };
		const entries: RemoteEntry[] = [file("a.md", B, 1), { ...file("lib/x.md", B, 1), source }];
		expect(await kindOf(collect(new GitHubBackend(client).fetch(A, entries)))).toBe("other");
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

	describe("of a submodule", () => {
		const source = { submodule: "vendor/lib", repository: "octo/lib", revision: C };
		const top = `octo-lib-${C.slice(0, 7)}`;

		function zipOfLib(): Uint8Array {
			return zipSync({
				[`${top}/`]: new Uint8Array(),
				[`${top}/x.md`]: strToU8("alpha"),
				[`${top}/docs/y.md`]: strToU8("beta"),
			});
		}

		test("the zip of the commit the submodule points to, asked of the repository it points to", async () => {
			const client = new FakeClient();
			client.zip = zipOfLib();
			const archive = await new GitHubBackend(client).fetchArchive(A, source);
			// Not the revision of the listing, and nothing else is asked for.
			expect(client.calls).toEqual([`getZip ${C} @octo/lib`]);
			expect(archive.byteLength).toBe(client.zip.length);
		});

		test("it answers for the paths of the listing: below the folder of the submodule", async () => {
			const client = new FakeClient();
			client.zip = zipOfLib();
			const archive = await new GitHubBackend(client).fetchArchive(A, source);
			expect(archive.sizeOf("vendor/lib/x.md")).toBe(5);
			expect(archive.sizeOf("vendor/lib/docs/y.md")).toBe(4);
			expect(new TextDecoder().decode(archive.read("vendor/lib/x.md"))).toBe("alpha");
			expect(new TextDecoder().decode(archive.read("vendor/lib/docs/y.md"))).toBe("beta");
			// Below the submodule, and not in the zip.
			expect(archive.sizeOf("vendor/lib/z.md")).toBeNull();
		});

		test("it holds nothing of any other path, though the zip has a file of that name", async () => {
			const client = new FakeClient();
			client.zip = zipOfLib();
			const archive = await new GitHubBackend(client).fetchArchive(A, source);
			// As the other repository has them, a file of the remote itself, and a folder whose name only begins the same.
			for (const path of ["x.md", "docs/y.md", "a.md", "vendor/x.md", "vendor/library/x.md", "vendor/lib", `${top}/x.md`]) {
				expect(archive.sizeOf(path), path).toBeNull();
			}
			expect(() => archive.read("x.md")).toThrow(BackendError);
		});

		test("a source that names no repository fails, and nothing is asked for", async () => {
			const client = new FakeClient();
			client.zip = zipOfLib();
			const bad = { ...source, repository: "octo" };
			expect(await kindOf(new GitHubBackend(client).fetchArchive(A, bad))).toBe("other");
			expect(client.calls).toEqual([]);
		});

		test("a failure of the request is the client's, unchanged", async () => {
			const client = new FakeClient();
			client.zip = new BackendError("not-found", "get zip: HTTP 404", 404);
			expect(await kindOf(new GitHubBackend(client).fetchArchive(A, source))).toBe("not-found");
		});
	});
});
