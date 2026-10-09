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
import { BackendError, type BackendErrorKind, type PushFile, type RemoteEntry } from "../src/core/backend";
import { COMMIT_BODY_LIMIT, commitMessage } from "../src/core/commit-message";
import {
	GitHubBackend,
	INLINE_FILE_BYTES,
	inlineText,
	TREE_CHUNK_BYTES,
	TREE_CHUNK_ENTRIES,
	TREE_CHUNK_INLINE_FILES,
} from "../src/core/github/backend";
import { GitHubClient } from "../src/core/github/client";
import { timerSleep } from "../src/core/github/timer-sleep";
import { runPull } from "../src/core/pull";
import { type PushDeps, type PushRunResult, runPush } from "../src/core/push";
import { PENDING_PUSH_KEY, readPendingPush } from "../src/core/push-pending";
import { pushReport } from "../src/core/push-report";
import { translatorFor } from "../src/core/i18n";
import { readBaseRevision, type StateStore } from "../src/core/state";
import { FakeGitHub, respond, type SentRequest } from "./support/fake-github";
import { blobHash, bytes, type FileContent } from "./support/memory-backend";
import { MemoryPullVault } from "./support/memory-pull-vault";
import { MemoryStateStore } from "./support/memory-state-store";

// The push of the GitHub backend, through the real client, against a fake of
// GitHub that answers at the level of HTTP.

function setup(signal?: AbortSignal) {
	const github = new FakeGitHub();
	const client = new GitHubClient({
		owner: "octo",
		repo: "notes",
		branch: "main",
		token: "github_pat_SECRET",
		http: github.http,
		now: Date.now,
		sleep: timerSleep,
		...(signal === undefined ? {} : { signal }),
	});
	const backend = new GitHubBackend(client, signal === undefined ? {} : { signal });
	return { github, backend };
}

async function entriesOf(backend: GitHubBackend): Promise<Map<string, RemoteEntry>> {
	const listed = await backend.list(null);
	if (!listed.changed) throw new Error("expected a listing");
	return new Map(listed.listing.entries.map((entry) => [entry.path, entry]));
}

function file(path: string, content: FileContent, replaces?: RemoteEntry): PushFile {
	const data = bytes(content);
	return {
		path,
		hash: blobHash(data),
		size: data.length,
		...(replaces === undefined ? {} : { replaces }),
		read: async () => data,
	};
}

function listed(entries: Map<string, RemoteEntry>, path: string): RemoteEntry {
	const entry = entries.get(path);
	if (entry === undefined) throw new Error(`not listed: ${path}`);
	return entry;
}

/** The entries of the trees that were sent, request by request. */
function sentTrees(github: FakeGitHub): { base: string; tree: Record<string, unknown>[] }[] {
	return github.requests
		.filter((request) => request.method === "POST" && request.path === "/git/trees")
		.map((request) => {
			const body = request.body as { base_tree: string; tree: Record<string, unknown>[] };
			return { base: body.base_tree, tree: body.tree };
		});
}

async function kindOf(promise: Promise<unknown>): Promise<BackendErrorKind | "resolved" | "not a BackendError"> {
	try {
		await promise;
		return "resolved";
	} catch (error) {
		return error instanceof BackendError ? error.kind : "not a BackendError";
	}
}

describe("the message of the commit", () => {
	test("the device, the counts by kind, and the paths in order", () => {
		expect(
			commitMessage("iPhone", [
				{ kind: "deleted", path: "notes/old.md" },
				{ kind: "added", path: "notes/new.md" },
				{ kind: "modified", path: "notes/edited.md" },
				{ kind: "added", path: "a.md" },
				{ kind: "added", path: "z.md" },
				{ kind: "modified", path: "b.md" },
			]),
		).toBe(
			[
				"Sync Evo: iPhone (3 added, 2 modified, 1 deleted)",
				"",
				"A  a.md",
				"M  b.md",
				"M  notes/edited.md",
				"A  notes/new.md",
				"D  notes/old.md",
				"A  z.md",
			].join("\n"),
		);
	});

	test("a kind that counts nothing is left out", () => {
		expect(commitMessage("Mac", [{ kind: "deleted", path: "a.md" }])).toBe("Sync Evo: Mac (1 deleted)\n\nD  a.md");
	});

	test("a path in Japanese is written as it is, without quotes or escapes", () => {
		const message = commitMessage("iPhone", [{ kind: "added", path: "日記/2026年10月 メモ.md" }]);
		expect(message).toBe("Sync Evo: iPhone (1 added)\n\nA  日記/2026年10月 メモ.md");
	});

	test("the body stops at fifty paths and counts the rest", () => {
		const changes = Array.from({ length: 53 }, (_, i) => ({
			kind: "added" as const,
			path: `n${String(i).padStart(2, "0")}.md`,
		}));
		const lines = commitMessage("iPhone", changes).split("\n");
		expect(lines[0]).toBe("Sync Evo: iPhone (53 added)");
		expect(lines.length).toBe(2 + COMMIT_BODY_LIMIT + 1);
		expect(lines[2]).toBe("A  n00.md");
		expect(lines[51]).toBe("A  n49.md");
		expect(lines[52]).toBe("... and 3 more");
	});

	test("a line break in the device name does not break the first line", () => {
		expect(commitMessage("my\nphone", [{ kind: "added", path: "a.md" }]).split("\n")[0]).toBe(
			"Sync Evo: my phone (1 added)",
		);
	});
});

describe("what is sent as text", () => {
	test("UTF-8 that comes back as the same bytes", () => {
		expect(inlineText(bytes("# 日本語\r\nline\n"))).toBe("# 日本語\r\nline\n");
		expect(inlineText(new Uint8Array())).toBe("");
	});

	test("not bytes that are no UTF-8, a byte order mark, or a control character", () => {
		expect(inlineText(new Uint8Array([0xff, 0xfe, 0x00]))).toBeNull();
		expect(inlineText(new Uint8Array([0xc3]))).toBeNull();
		expect(inlineText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBeNull();
		expect(inlineText(bytes("a\0b"))).toBeNull();
		expect(inlineText(bytes("a\u001bb"))).toBeNull();
		expect(inlineText(bytes("tab\there\r\n\fpage"))).toBe("tab\there\r\n\fpage");
	});
});

describe("a push to GitHub", () => {
	test("is one commit on the head: added, modified and deleted, with everything else as it was", async () => {
		const { github, backend } = setup();
		const base = github.commit({ "keep.md": "K", "edit.md": "E", "old.md": "O", "notes/日本語.md": "J" });
		const entries = await entriesOf(backend);
		github.requests.length = 0;

		const result = await backend.push({
			baseRevision: base,
			deviceName: "iPhone",
			writes: [file("edit.md", "E2", listed(entries, "edit.md")), file("notes/新しい.md", "N")],
			deletes: [listed(entries, "old.md")],
		});

		if (result.status !== "pushed") throw new Error("expected the push to go through");
		expect(github.head).toBe(result.revision);
		expect(result.written).toEqual([
			{ path: "edit.md", kind: "file", hash: blobHash("E2"), size: 2 },
			{ path: "notes/新しい.md", kind: "file", hash: blobHash("N"), size: 1 },
		]);
		expect([...github.files().keys()].sort()).toEqual(["edit.md", "keep.md", "notes/新しい.md", "notes/日本語.md"]);
		expect(github.text("edit.md")).toBe("E2");
		expect(github.text("notes/新しい.md")).toBe("N");

		const commit = github.headCommit();
		expect(commit?.parents).toEqual([base]);
		expect(commit?.message).toBe(
			["Sync Evo: iPhone (1 added, 1 modified, 1 deleted)", "", "M  edit.md", "A  notes/新しい.md", "D  old.md"].join(
				"\n",
			),
		);
		// Text goes inside the one tree: no blob is created.
		expect(github.writes()).toEqual(["POST /git/trees", "POST /git/commits", "PATCH /git/refs/heads/main"]);
		const move = github.requests.find((request) => request.method === "PATCH");
		expect((move?.body as { force: unknown }).force).toBe(false);
		// And then the tree of the new commit, for the listing: one request.
		const after = github.requests.slice(github.requests.findIndex((request) => request.method === "PATCH") + 1);
		expect(after.map((request) => `${request.method} ${request.path}`)).toEqual([
			`GET /git/trees/${github.headCommit()?.tree}?recursive=1`,
		]);
		const fresh = await entriesOf(backend);
		expect(result.listing?.revision).toBe(github.head);
		expect(new Map(result.listing?.entries.map((entry) => [entry.path, entry]))).toEqual(fresh);
	});

	test("text goes into the tree, and everything else as a blob", async () => {
		const { github, backend } = setup();
		const base = github.commit({ "a.md": "A" });
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
		const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x61]);

		const result = await backend.push({
			baseRevision: base,
			writes: [file("text.md", "text\r\n"), file("img.png", png), file("bom.txt", bom)],
			deletes: [],
		});

		expect(result.status).toBe("pushed");
		expect(github.writes().filter((line) => line === "POST /git/blobs").length).toBe(2);
		const [tree] = sentTrees(github);
		expect(tree?.tree).toEqual([
			{ path: "text.md", mode: "100644", type: "blob", content: "text\r\n" },
			{ path: "img.png", mode: "100644", type: "blob", sha: blobHash(png) },
			{ path: "bom.txt", mode: "100644", type: "blob", sha: blobHash(bom) },
		]);
		expect(github.blobs.get(github.files().get("img.png")?.sha ?? "")).toEqual(png);
		expect(github.blobs.get(github.files().get("bom.txt")?.sha ?? "")).toEqual(bom);
		expect(github.files().get("text.md")?.sha).toBe(blobHash("text\r\n"));
	});

	test("an executable stays one, any other mode becomes 100644, and a deletion carries the mode of the tree", async () => {
		const { github, backend } = setup();
		const base = github.commit({
			"run.sh": { content: "#!/bin/sh\n", mode: "100755" },
			"gone.sh": { content: "x", mode: "100755" },
			"odd.md": { content: "odd", mode: "100664" },
		});
		const entries = await entriesOf(backend);

		await backend.push({
			baseRevision: base,
			writes: [
				file("run.sh", "#!/bin/sh\necho\n", listed(entries, "run.sh")),
				file("odd.md", "odd2", listed(entries, "odd.md")),
				file("new.sh", "#!/bin/sh\n"),
			],
			deletes: [listed(entries, "gone.sh")],
		});

		const files = github.files();
		expect(files.get("run.sh")?.mode).toBe("100755");
		expect(files.get("odd.md")?.mode).toBe("100644");
		expect(files.get("new.sh")?.mode).toBe("100644");
		expect(sentTrees(github)[0]?.tree[0]).toEqual({ path: "gone.sh", mode: "100755", type: "blob", sha: null });
	});

	test("more text than one tree carries is a chain of trees, each on the one before, and no blobs", async () => {
		const { github, backend } = setup();
		const base = github.commit({ "a.md": "A" });
		const parentTree = github.headCommit()?.tree;
		const size = Math.floor(TREE_CHUNK_BYTES / 3) - 1000;
		const writes = Array.from({ length: 7 }, (_, i) => file(`big${i}.md`, String(i).repeat(size)));

		const result = await backend.push({ baseRevision: base, writes, deletes: [] });

		expect(result.status).toBe("pushed");
		const trees = sentTrees(github);
		expect(trees.map((sent) => sent.tree.length)).toEqual([3, 3, 1]);
		expect(trees[0]?.base).toBe(parentTree);
		// Each tree is built on the one the request before it made.
		const made = [...github.trees.keys()];
		expect(made).toContain(trees[1]?.base);
		expect(trees[1]?.base).not.toBe(parentTree);
		expect(trees[2]?.base).not.toBe(trees[1]?.base);
		expect(github.writes().includes("POST /git/blobs")).toBe(false);
		expect(github.writes().filter((line) => line === "POST /git/commits").length).toBe(1);
		expect([...github.files().keys()].sort()).toEqual(["a.md", ...writes.map((write) => write.path)]);
		expect(github.text("big6.md")?.length).toBe(size);
	});

	test("more small files than one tree carries the content of is a chain of trees", async () => {
		const { github, backend } = setup();
		const base = github.commit({ "a.md": "A" });
		const count = TREE_CHUNK_INLINE_FILES * 2 + 1;
		const writes = Array.from({ length: count }, (_, i) => file(`notes/n${i}.md`, `note ${i}`));

		const result = await backend.push({ baseRevision: base, writes, deletes: [] });

		expect(result.status).toBe("pushed");
		expect(sentTrees(github).map((sent) => sent.tree.length)).toEqual([
			TREE_CHUNK_INLINE_FILES,
			TREE_CHUNK_INLINE_FILES,
			1,
		]);
		expect(github.writes().includes("POST /git/blobs")).toBe(false);
		expect(github.writes().filter((line) => line === "POST /git/commits").length).toBe(1);
		expect(github.files().size).toBe(count + 1);
	});

	test("entries that carry no content are not counted as contents", async () => {
		const { github, backend } = setup();
		const count = TREE_CHUNK_INLINE_FILES * 2;
		const names = Array.from({ length: count }, (_, i) => `old/o${i}.md`);
		const base = github.commit(Object.fromEntries([["a.md", "A"], ...names.map((name) => [name, name])]));
		const entries = await entriesOf(backend);
		github.requests.length = 0;
		const deletes = names.map((path) => listed(entries, path));

		const result = await backend.push({ baseRevision: base, writes: [file("new.md", "n")], deletes });

		expect(result.status).toBe("pushed");
		expect(count + 1).toBeLessThan(TREE_CHUNK_ENTRIES);
		expect(sentTrees(github).map((sent) => sent.tree.length)).toEqual([count + 1]);
		expect([...github.files().keys()].sort()).toEqual(["a.md", "new.md"]);
	});

	test("more entries than one tree carries is a chain of trees, with no content among them", async () => {
		const { github, backend } = setup();
		const names = Array.from({ length: TREE_CHUNK_ENTRIES + 1 }, (_, i) => `old/o${i}.md`);
		const base = github.commit(Object.fromEntries([["a.md", "A"], ...names.map((name) => [name, "same"])]));
		const entries = await entriesOf(backend);
		github.requests.length = 0;

		const result = await backend.push({
			baseRevision: base,
			writes: [],
			deletes: names.map((path) => listed(entries, path)),
		});

		expect(result.status).toBe("pushed");
		expect(sentTrees(github).map((sent) => sent.tree.length)).toEqual([TREE_CHUNK_ENTRIES, 1]);
		expect([...github.files().keys()]).toEqual(["a.md"]);
	});

	test("an empty file goes as a blob, and many empty files as one", async () => {
		const { github, backend } = setup();
		const base = github.commit({ "a.md": "A" });
		const empty = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

		const result = await backend.push({
			baseRevision: base,
			writes: [file("empty.md", ""), file("notes/also-empty.md", ""), file("text.md", "t")],
			deletes: [],
		});

		if (result.status !== "pushed") throw new Error("expected the push to go through");
		expect(github.writes().filter((line) => line === "POST /git/blobs").length).toBe(1);
		const [tree] = sentTrees(github);
		expect(tree?.tree).toEqual([
			{ path: "empty.md", mode: "100644", type: "blob", sha: empty },
			{ path: "notes/also-empty.md", mode: "100644", type: "blob", sha: empty },
			{ path: "text.md", mode: "100644", type: "blob", content: "t" },
		]);
		expect(github.text("empty.md")).toBe("");
		expect(github.text("notes/also-empty.md")).toBe("");
		expect(result.written.slice(0, 2)).toEqual([
			{ path: "empty.md", kind: "file", hash: empty, size: 0 },
			{ path: "notes/also-empty.md", kind: "file", hash: empty, size: 0 },
		]);
	});

	test("a file GitHub refuses for its size is left out, told to the caller, and the rest is sent", async () => {
		const { github, backend } = setup();
		const base = github.commit({ "a.md": "A", "old.png": new Uint8Array([1, 0]) });
		const entries = await entriesOf(backend);
		const big = new Uint8Array([0x00, 0xff, 0x01]);
		const fine = new Uint8Array([0x00, 0xff, 0x02]);
		github.before = (request: SentRequest) =>
			request.method === "POST" && request.path === "/git/blobs" && JSON.stringify(request.body).includes("AP8B")
				? respond(422, {
						message:
							"Sorry, your input was too large to process. Consider creating the blob in a local clone of the repository and then pushing it to GitHub.",
					})
				: undefined;
		const refused: string[] = [];
		const told = (path: string, content: Uint8Array, replaces?: RemoteEntry): PushFile => ({
			...file(path, content, replaces),
			refused: (reason) => refused.push(`${path} ${reason}`),
		});

		const result = await backend.push({
			baseRevision: base,
			writes: [told("big.png", big), told("old.png", big, entries.get("old.png")), told("fine.png", fine), file("b.md", "B")],
			deletes: [],
		});

		expect(result.status).toBe("pushed");
		if (result.status !== "pushed") return;
		expect(refused).toEqual(["big.png too-large", "old.png too-large"]);
		expect(result.written.map((entry) => entry.path)).toEqual(["fine.png", "b.md"]);
		const files = github.files();
		expect([...files.keys()].sort()).toEqual(["a.md", "b.md", "fine.png", "old.png"]);
		// The file that was to be replaced stays as the remote had it.
		expect(files.get("old.png")?.sha).toBe(blobHash(new Uint8Array([1, 0])));
		expect(github.headCommit()?.message.split("\n")[0]).toBe("Sync Evo: unnamed device (2 added)");
	});

	test("a push whose only file GitHub refuses for its size makes no commit", async () => {
		const { github, backend } = setup();
		const base = github.commit({ "a.md": "A" });
		github.before = (request: SentRequest) =>
			request.method === "POST" && request.path === "/git/blobs" ? respond(422, { message: "Sorry, your input was too large to process." }) : undefined;
		let refused = 0;

		const result = await backend.push({
			baseRevision: base,
			writes: [{ ...file("big.png", new Uint8Array([0, 255])), refused: () => void (refused += 1) }],
			deletes: [],
		});

		expect(result.status).toBe("unchanged");
		expect(refused).toBe(1);
		expect(github.head).toBe(base);
	});

	test("two files of one content GitHub refuses are both left out, and the content is sent once", async () => {
		const { github, backend } = setup();
		const base = github.commit({ "a.md": "A" });
		github.before = (request: SentRequest) =>
			request.method === "POST" && request.path === "/git/blobs" ? respond(422, { message: "Sorry, your input was too large to process." }) : undefined;
		const refused: string[] = [];
		const big = new Uint8Array([0, 255]);
		const told = (path: string): PushFile => ({ ...file(path, big), refused: () => refused.push(path) });

		const result = await backend.push({ baseRevision: base, writes: [told("one.png"), told("two.png"), file("b.md", "B")], deletes: [] });

		expect(result.status).toBe("pushed");
		if (result.status !== "pushed") return;
		expect(refused).toEqual(["one.png", "two.png"]);
		expect(result.written.map((entry) => entry.path)).toEqual(["b.md"]);
		expect(github.writes().filter((line) => line === "POST /git/blobs").length).toBe(1);
	});

	/** What GitHub answers to a fine-grained token without the Workflows permission (measured 2026-10-09). */
	const refusesWorkflows = (request: SentRequest) => {
		if (request.method !== "POST" || request.path !== "/git/trees") return undefined;
		const tree = (request.body as { tree: { path: string; sha?: string | null }[] }).tree;
		return tree.some((entry) => entry.path.startsWith(".github/workflows/") && entry.sha !== null)
			? respond(403, { message: "Resource not accessible by personal access token" })
			: undefined;
	};

	test("workflow files a token may not write are left out, told to the caller, and the rest is sent", async () => {
		const { github, backend } = setup();
		const base = github.commit({ "a.md": "A", ".github/workflows/old.yml": "old", ".github/workflows/gone.yml": "gone" });
		const entries = await entriesOf(backend);
		github.before = refusesWorkflows;
		const refused: string[] = [];
		const told = (path: string, content: string, replaces?: RemoteEntry): PushFile => ({
			...file(path, content, replaces),
			refused: (reason) => refused.push(`${path} ${reason}`),
		});

		const result = await backend.push({
			baseRevision: base,
			writes: [
				told(".github/workflows/new.yml", "on: push\n"),
				told(".github/workflows/old.yml", "changed", entries.get(".github/workflows/old.yml")),
				told(".github/workflows/sub/README.md", "any file below the folder"),
				told(".GitHub/Workflows/x.yml", "not the folder GitHub means"),
				told(".github/other.yml", "beside the folder"),
				told("b.md", "B"),
			],
			deletes: [listed(entries, ".github/workflows/gone.yml")],
		});

		expect(result.status).toBe("pushed");
		if (result.status !== "pushed") return;
		expect(refused).toEqual([
			".github/workflows/new.yml workflows",
			".github/workflows/old.yml workflows",
			".github/workflows/sub/README.md workflows",
		]);
		expect(result.written.map((entry) => entry.path)).toEqual([".GitHub/Workflows/x.yml", ".github/other.yml", "b.md"]);
		// Removing a workflow file needs no permission, and went through.
		expect([...github.files().keys()].sort()).toEqual(
			[".GitHub/Workflows/x.yml", ".github/other.yml", ".github/workflows/old.yml", "a.md", "b.md"].sort(),
		);
		expect(github.text(".github/workflows/old.yml")).toBe("old");
		expect(github.headCommit()?.message.split("\n")[0]).toBe("Sync Evo: unnamed device (3 added, 1 deleted)");
	});

	test("a push of nothing but a workflow file the token may not write makes no commit, once a blob shows the token can write", async () => {
		const { github, backend } = setup();
		const base = github.commit({ "a.md": "A" });
		github.before = refusesWorkflows;
		let refused = 0;

		const result = await backend.push({
			baseRevision: base,
			writes: [{ ...file(".github/workflows/ci.yml", "on: push\n"), refused: () => void (refused += 1) }],
			deletes: [],
		});

		expect(result.status).toBe("unchanged");
		expect(refused).toBe(1);
		expect(github.head).toBe(base);
		expect(github.writes()).toEqual(["POST /git/trees", "POST /git/blobs"]);
	});

	test("a token that may not write at all fails the push, also when a workflow file is among the files", async () => {
		for (const writes of [
			[file(".github/workflows/ci.yml", "on: push\n"), file("b.md", "B")],
			[file(".github/workflows/ci.yml", "on: push\n")],
		]) {
			const { github, backend } = setup();
			const base = github.commit({ "a.md": "A" });
			github.before = (request: SentRequest) =>
				request.method === "POST" ? respond(403, { message: "Resource not accessible by personal access token" }) : undefined;

			expect(await kindOf(backend.push({ baseRevision: base, writes, deletes: [] }))).toBe("forbidden");
			expect(github.head).toBe(base);
		}
	});

	test("a later tree of nothing but workflow files is left out, and the commit is of the trees before it", async () => {
		const { github, backend } = setup();
		const base = github.commit({ "a.md": "A" });
		github.before = refusesWorkflows;
		const refused: string[] = [];
		// Two of these fill a tree, so the workflow file is alone in the third.
		const big = (letter: string) => letter.repeat(INLINE_FILE_BYTES - 10);

		const result = await backend.push({
			baseRevision: base,
			writes: [
				file("one.md", big("1")),
				file("two.md", big("2")),
				file("three.md", big("3")),
				file("four.md", big("4")),
				{ ...file(".github/workflows/ci.yml", big("w")), refused: () => refused.push("ci.yml") },
			],
			deletes: [],
		});

		expect(result.status).toBe("pushed");
		if (result.status !== "pushed") return;
		expect(refused).toEqual(["ci.yml"]);
		expect(result.written.map((entry) => entry.path)).toEqual(["one.md", "two.md", "three.md", "four.md"]);
		expect([...github.files().keys()].sort()).toEqual(["a.md", "four.md", "one.md", "three.md", "two.md"]);
		// Two trees that pass, the one that is refused, and the blob that shows the token can write.
		expect(github.writes()).toEqual([
			"POST /git/trees",
			"POST /git/trees",
			"POST /git/trees",
			"POST /git/blobs",
			"POST /git/commits",
			"PATCH /git/refs/heads/main",
		]);
	});

	test("an empty workflow file, which goes as a blob, is left out the same", async () => {
		const { github, backend } = setup();
		const base = github.commit({ "a.md": "A" });
		github.before = refusesWorkflows;
		let refused = 0;

		const result = await backend.push({
			baseRevision: base,
			writes: [{ ...file(".github/workflows/empty.yml", ""), refused: () => void (refused += 1) }, file("b.md", "B")],
			deletes: [],
		});

		expect(result.status).toBe("pushed");
		expect(refused).toBe(1);
		expect([...github.files().keys()].sort()).toEqual(["a.md", "b.md"]);
	});

	test("a second try that fails for another reason fails the push with that reason", async () => {
		const { github, backend } = setup();
		const base = github.commit({ "a.md": "A" });
		let trees = 0;
		github.before = (request: SentRequest) => {
			if (request.method !== "POST" || request.path !== "/git/trees") return undefined;
			trees += 1;
			return trees === 1 ? respond(403, { message: "Resource not accessible by personal access token" }) : respond(500, { message: "boom" });
		};
		let refused = 0;

		const push = backend.push({
			baseRevision: base,
			writes: [{ ...file(".github/workflows/ci.yml", "on: push\n"), refused: () => void (refused += 1) }, file("b.md", "B")],
			deletes: [],
		});

		expect(await kindOf(push)).toBe("unreachable");
		expect(refused).toBe(0);
		expect(github.head).toBe(base);
	});

	test("a refusal of a tree that names workflow files in words is handled the same, and stands when no such file is in the tree", async () => {
		const words = "refusing to allow a Personal Access Token to create or update workflow `.github/workflows/ci.yml` without `workflow` scope";
		const refuses = (request: SentRequest) => {
			if (request.method !== "POST" || request.path !== "/git/trees") return undefined;
			const tree = (request.body as { tree: { path: string }[] }).tree;
			return tree.some((entry) => entry.path.startsWith(".github/workflows/")) ? respond(404, { message: words }) : undefined;
		};
		const { github, backend } = setup();
		const base = github.commit({ "a.md": "A" });
		github.before = refuses;
		let refused = 0;
		const result = await backend.push({
			baseRevision: base,
			writes: [{ ...file(".github/workflows/ci.yml", "on: push\n"), refused: () => void (refused += 1) }, file("b.md", "B")],
			deletes: [],
		});
		expect(result.status).toBe("pushed");
		expect(refused).toBe(1);
		expect(github.text("b.md")).toBe("B");

		const other = setup();
		const otherBase = other.github.commit({ "a.md": "A" });
		other.github.before = (request: SentRequest) =>
			request.method === "POST" && request.path === "/git/trees" ? respond(404, { message: words }) : undefined;
		expect(await kindOf(other.backend.push({ baseRevision: otherBase, writes: [file("b.md", "B")], deletes: [] }))).toBe(
			"workflows-permission",
		);
	});

	test("a tree refused with no workflow file in it fails the push", async () => {
		const { github, backend } = setup();
		const base = github.commit({ "a.md": "A" });
		github.before = (request: SentRequest) =>
			request.method === "POST" && request.path === "/git/trees"
				? respond(403, { message: "Resource not accessible by personal access token" })
				: undefined;

		expect(await kindOf(backend.push({ baseRevision: base, writes: [file("b.md", "B")], deletes: [] }))).toBe("forbidden");
		expect(github.writes()).toEqual(["POST /git/trees"]);
	});

	test("a refusal that names workflow files where no file can be left out is told as that: the commit, or the branch", async () => {
		const steps = [
			["POST", "/git/commits"],
			["PATCH", "/git/refs/heads/main"],
		] as const;
		for (const [method, path] of steps) {
			const { github, backend } = setup();
			const base = github.commit({ "a.md": "A" });
			github.before = (request: SentRequest) =>
				request.method === method && request.path === path
					? respond(method === "PATCH" ? 422 : 404, {
							message:
								"refusing to allow a Personal Access Token to create or update workflow `.github/workflows/ci.yml` without `workflow` scope",
						})
					: undefined;
			let published = false;

			const push = backend.push({
				baseRevision: base,
				writes: [file(".github/workflows/ci.yml", "on: push\n")],
				deletes: [],
				onPublish: () => {
					published = true;
				},
			});

			expect(await kindOf(push)).toBe("workflows-permission");
			expect(github.head).toBe(base);
			// Only the request that moves the branch may have gone through.
			expect(published).toBe(method === "PATCH");
		}
	});

	test("the listing of the new commit that cannot be fetched does not fail the push", async () => {
		const { github, backend } = setup();
		const base = github.commit({ "a.md": "A" });
		let moved = false;
		github.before = (request: SentRequest) => {
			if (request.method === "PATCH") moved = true;
			return moved && request.method === "GET" ? new Error("offline") : undefined;
		};

		const result = await backend.push({ baseRevision: base, writes: [file("b.md", "B")], deletes: [] });

		expect(result.status).toBe("pushed");
		expect(result.status === "pushed" ? result.listing : null).toBeUndefined();
		expect(github.text("b.md")).toBe("B");
	});

	test("a text file too large for a tree goes as a blob", async () => {
		const { github, backend } = setup();
		const base = github.commit({ "a.md": "A" });
		const large = "x".repeat(INLINE_FILE_BYTES + 1);

		await backend.push({ baseRevision: base, writes: [file("large.md", large)], deletes: [] });

		expect(github.writes()).toEqual([
			"POST /git/blobs",
			"POST /git/trees",
			"POST /git/commits",
			"PATCH /git/refs/heads/main",
		]);
		expect(github.text("large.md")?.length).toBe(large.length);
	});

	test("a head that has moved is found before anything is sent", async () => {
		const { github, backend } = setup();
		const base = github.commit({ "a.md": "A" });
		const other = github.commit({ "b.md": "from a Mac" });
		github.requests.length = 0;

		const result = await backend.push({ baseRevision: base, writes: [file("c.md", "C")], deletes: [] });

		expect(result).toEqual({ status: "stale" });
		expect(github.writes()).toEqual([]);
		expect(github.head).toBe(other);
	});

	test("a head that moves while the push runs refuses the update, and nothing is forced", async () => {
		const { github, backend } = setup();
		const base = github.commit({ "a.md": "A" });
		let other = "";
		github.before = (request) => {
			if (request.method === "PATCH" && other === "") other = github.commit({ "b.md": "from a Mac" });
		};
		const pending: string[] = [];

		const result = await backend.push({
			baseRevision: base,
			writes: [file("c.md", "C")],
			deletes: [],
			beforePublish: async ({ revision }) => {
				pending.push(revision);
			},
		});

		expect(result).toEqual({ status: "stale" });
		expect(github.head).toBe(other);
		expect(github.files().has("c.md")).toBe(false);
		expect(pending.length).toBe(1);
		expect(github.writes().filter((line) => line.startsWith("PATCH")).length).toBe(1);
	});

	test("the commit is handed over after it is made and before the branch is moved", async () => {
		const { github, backend } = setup();
		const base = github.commit({ "a.md": "A" });
		const seen: unknown[] = [];

		const result = await backend.push({
			baseRevision: base,
			writes: [file("b.md", "B")],
			deletes: [],
			beforePublish: async ({ revision, written }) => {
				seen.push({ revision, written, known: github.commits.has(revision), head: github.head });
			},
		});

		if (result.status !== "pushed") throw new Error("expected the push to go through");
		expect(seen).toEqual([{ revision: result.revision, written: result.written, known: true, head: base }]);
	});

	test("an update whose answer is lost counts as done when the head is the new commit", async () => {
		const { github, backend } = setup();
		const base = github.commit({ "a.md": "A" });
		github.before = (request) => {
			if (request.method !== "PATCH") return undefined;
			// It arrives, and the answer does not.
			github.head = (request.body as { sha: string }).sha;
			return new Error("connection reset");
		};

		const result = await backend.push({ baseRevision: base, writes: [file("b.md", "B")], deletes: [] });

		expect(result.status).toBe("pushed");
		expect(github.text("b.md")).toBe("B");
	});

	test("an update that never arrives fails as unreachable, and the head is where it was", async () => {
		const { github, backend } = setup();
		const base = github.commit({ "a.md": "A" });
		github.before = (request) => (request.method === "PATCH" ? new Error("connection reset") : undefined);

		const push = backend.push({ baseRevision: base, writes: [file("b.md", "B")], deletes: [] });

		expect(await kindOf(push)).toBe("unreachable");
		expect(github.head).toBe(base);
	});

	test("content the remote already holds makes no commit", async () => {
		const { github, backend } = setup();
		const base = github.commit({ "a.md": "A" });
		const entries = await entriesOf(backend);
		github.requests.length = 0;

		const same = await backend.push({
			baseRevision: base,
			writes: [file("a.md", "A", listed(entries, "a.md"))],
			deletes: [],
		});
		const none = await backend.push({ baseRevision: base, writes: [], deletes: [] });

		expect(same).toEqual({ status: "unchanged" });
		expect(none).toEqual({ status: "unchanged" });
		expect(github.writes()).toEqual([]);
		expect(github.head).toBe(base);
	});

	test("what a file reads as is what is sent and reported, and a file that reads as nothing is left out", async () => {
		const { github, backend } = setup();
		const base = github.commit({ "a.md": "A" });
		const drifted: PushFile = { ...file("b.md", "planned"), read: async () => bytes("typed since") };
		const gone: PushFile = { ...file("c.md", "C"), read: async () => null };

		const result = await backend.push({ baseRevision: base, writes: [drifted, gone], deletes: [] });

		if (result.status !== "pushed") throw new Error("expected the push to go through");
		expect(result.written).toEqual([{ path: "b.md", kind: "file", hash: blobHash("typed since"), size: 11 }]);
		expect(github.text("b.md")).toBe("typed since");
		expect(github.files().has("c.md")).toBe(false);
		expect(github.headCommit()?.message).toBe("Sync Evo: unnamed device (1 added)\n\nA  b.md");
	});

	test("a push of files that all read as nothing makes no commit", async () => {
		const { github, backend } = setup();
		const base = github.commit({ "a.md": "A" });
		const gone: PushFile = { ...file("c.md", "C"), read: async () => null };
		expect(await backend.push({ baseRevision: base, writes: [gone], deletes: [] })).toEqual({ status: "unchanged" });
		expect(github.writes()).toEqual([]);
	});

	describe("refuses, with nothing sent,", () => {
		async function refused(
			remote: Parameters<FakeGitHub["commit"]>[0],
			request: (entries: Map<string, RemoteEntry>) => { writes?: PushFile[]; deletes?: RemoteEntry[] },
			kind: BackendErrorKind = "not-as-listed",
		): Promise<void> {
			const { github, backend } = setup();
			const base = github.commit(remote);
			const entries = await entriesOf(backend);
			const { writes = [], deletes = [] } = request(entries);
			expect(await kindOf(backend.push({ baseRevision: base, writes, deletes }))).toBe(kind);
			expect(github.writes()).toEqual([]);
			expect(github.head).toBe(base);
		}

		test("a file below a symlink", () =>
			refused({ link: { content: "../target", mode: "120000" } }, () => ({ writes: [file("link/a.md", "A")] })));

		test("a file at a symlink, as a new path or in its place", async () => {
			const link = { link: { content: "../target", mode: "120000" } };
			await refused(link, () => ({ writes: [file("link", "A")] }));
			await refused(link, (entries) => ({ writes: [file("link", "A", listed(entries, "link"))] }));
			await refused(link, (entries) => ({
				writes: [file("link", "A", { ...listed(entries, "link"), kind: "file" })],
			}));
		});

		test("the deletion of a symlink or a submodule", async () => {
			const remote = { link: { content: "../target", mode: "120000" }, lib: { submodule: "c".repeat(40) } };
			await refused(remote, (entries) => ({ deletes: [listed(entries, "link")] }));
			await refused(remote, (entries) => ({ deletes: [{ ...listed(entries, "link"), kind: "file" }] }));
			await refused(remote, (entries) => ({ deletes: [listed(entries, "lib")] }));
			await refused(remote, (entries) => ({ deletes: [{ ...listed(entries, "lib"), kind: "file" }] }));
		});

		test("a file at or below a submodule", async () => {
			const remote = { knowledge: { submodule: "c".repeat(40) } };
			await refused(remote, () => ({ writes: [file("knowledge/a.md", "A")] }));
			await refused(remote, () => ({ writes: [file("knowledge", "A")] }));
		});

		test("a file below a file, and a file where the remote has a folder", async () => {
			await refused({ a: "file" }, () => ({ writes: [file("a/b.md", "B")] }));
			await refused({ "d/x.md": "X", "d/y.md": "Y" }, () => ({ writes: [file("d", "file")] }));
			// Only one of the two files of the folder is deleted.
			await refused({ "d/x.md": "X", "d/y.md": "Y" }, (entries) => ({
				writes: [file("d", "file")],
				deletes: [listed(entries, "d/x.md")],
			}));
		});

		test("a new path the remote already holds", () => refused({ "a.md": "theirs" }, () => ({ writes: [file("a.md", "mine")] })));

		test("an entry to replace or delete that is not the one the tree holds", async () => {
			const other = (entry: RemoteEntry): RemoteEntry => ({ ...entry, hash: blobHash("something else") });
			await refused({ "a.md": "A" }, (entries) => ({ writes: [file("a.md", "A2", other(listed(entries, "a.md")))] }));
			await refused({ "a.md": "A" }, (entries) => ({ deletes: [other(listed(entries, "a.md"))] }));
			await refused({ "a.md": "A" }, () => ({
				deletes: [{ path: "never.md", kind: "file", hash: blobHash("x") }],
			}));
		});

		// The request contradicts itself: no listing would put that right.
		test("a path that is named twice, or is not a path", async () => {
			await refused(
				{ "a.md": "A" },
				(entries) => ({ writes: [file("a.md", "A2", listed(entries, "a.md"))], deletes: [listed(entries, "a.md")] }),
				"other",
			);
			await refused({ "a.md": "A" }, () => ({ writes: [file("b.md", "1"), file("b.md", "2")] }), "other");
			await refused({ "a.md": "A" }, () => ({ writes: [file("../b.md", "1")] }), "other");
		});
	});

	test("a symlink and a submodule are still there after a push, as they were", async () => {
		const { github, backend } = setup();
		const base = github.commit({
			".claude/skills": { content: "../skills", mode: "120000" },
			knowledge: { submodule: "c".repeat(40) },
			"a.md": "A",
		});
		const before = github.files();
		const entries = await entriesOf(backend);

		await backend.push({ baseRevision: base, writes: [file("a.md", "A2", listed(entries, "a.md"))], deletes: [] });

		expect(github.files().get(".claude/skills")).toEqual(before.get(".claude/skills"));
		expect(github.files().get("knowledge")).toEqual(before.get("knowledge"));
	});

	test("a file that became a folder, and a folder that became a file: the old side goes in a tree of its own first", async () => {
		const { github, backend } = setup();
		const base = github.commit({ a: "file", "d/x.md": "X", "keep.md": "K" });
		const entries = await entriesOf(backend);

		const result = await backend.push({
			baseRevision: base,
			writes: [file("a/b.md", "B"), file("d", "now a file")],
			deletes: [listed(entries, "a"), listed(entries, "d/x.md")],
		});

		expect(result.status).toBe("pushed");
		const trees = sentTrees(github);
		expect(trees.map((sent) => sent.tree.map((entry) => `${entry.sha === null ? "D" : "W"} ${String(entry.path)}`))).toEqual([
			["D a", "D d/x.md"],
			["W a/b.md", "W d"],
		]);
		expect([...github.files().keys()].sort()).toEqual(["a/b.md", "d", "keep.md"]);
	});

	test("a repository without commits is not pushed to", async () => {
		const { github, backend } = setup();
		expect(await kindOf(backend.push({ baseRevision: null, writes: [file("a.md", "A")], deletes: [] }))).toBe("other");
		expect(github.requests).toEqual([]);
	});

	describe("stopped", () => {
		test("before it began: nothing is asked or sent", async () => {
			const controller = new AbortController();
			const { github, backend } = setup(controller.signal);
			const base = github.commit({ "a.md": "A" });
			github.requests.length = 0;
			controller.abort();

			expect(await kindOf(backend.push({ baseRevision: base, writes: [file("b.md", "B")], deletes: [] }))).toBe(
				"cancelled",
			);
			expect(github.requests).toEqual([]);
		});

		test("between two trees: the next is not sent, and no commit is made", async () => {
			const controller = new AbortController();
			const { github, backend } = setup(controller.signal);
			const base = github.commit({ "a.md": "A" });
			const size = Math.floor(TREE_CHUNK_BYTES / 3) - 1000;
			github.before = (request: SentRequest) => {
				if (request.method === "POST" && request.path === "/git/trees") controller.abort();
			};

			const push = backend.push({
				baseRevision: base,
				writes: ["one", "two", "three", "four"].map((name, i) => file(`${name}.md`, String(i).repeat(size))),
				deletes: [],
			});

			expect(await kindOf(push)).toBe("cancelled");
			expect(github.writes()).toEqual(["POST /git/trees"]);
			expect(github.head).toBe(base);
		});

		test("after the commit was made: the branch is not moved", async () => {
			const controller = new AbortController();
			const { github, backend } = setup(controller.signal);
			const base = github.commit({ "a.md": "A" });
			let published = false;

			const push = backend.push({
				baseRevision: base,
				writes: [file("b.md", "B")],
				deletes: [],
				beforePublish: async () => controller.abort(),
				onPublish: () => {
					published = true;
				},
			});

			expect(await kindOf(push)).toBe("cancelled");
			expect(github.writes()).toEqual(["POST /git/trees", "POST /git/commits"]);
			expect(github.head).toBe(base);
			// Said only when the request that moves the branch is sent.
			expect(published).toBe(false);
		});

		test("while the branch is moved: the push has happened", async () => {
			const controller = new AbortController();
			const { github, backend } = setup(controller.signal);
			const base = github.commit({ "a.md": "A" });
			github.before = (request: SentRequest) => {
				if (request.method === "PATCH") controller.abort();
			};

			const result = await backend.push({ baseRevision: base, writes: [file("b.md", "B")], deletes: [] });

			expect(result.status).toBe("pushed");
			expect(github.text("b.md")).toBe("B");
		});
	});
});

describe("a pull and a push of a vault, against GitHub", () => {
	const nfd = "cafe\u0301";

	test("what the push records is what GitHub then lists: the next pull asks for no tree and changes nothing", async () => {
		const { github, backend } = setup();
		github.commit({
			"notes/a.md": "A",
			"old.md": "O",
			[`${nfd}/b.md`]: "B",
			"src/run.sh": { content: "#!/bin/sh\n", mode: "100755" },
			".claude/skills": { content: "../skills", mode: "120000" },
			knowledge: { submodule: "c".repeat(40) },
			"img.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00]),
		});
		let time = Date.UTC(2026, 9, 3, 12, 0, 0);
		const now = (): number => time;
		const store = new MemoryStateStore();
		const vault = new MemoryPullVault({ caseSensitive: true, now });
		const common = {
			store,
			backend,
			vault,
			paths: { configDir: ".obsidian", pluginDir: ".obsidian/plugins/sync-evo" },
			deviceName: "iPhone",
			now,
		};
		const pull = (): ReturnType<typeof runPull> => {
			time += 60_000;
			return runPull({ ...common, pluginId: "sync-evo", confirm: async () => "proceed" });
		};
		expect((await pull()).outcome).toBe("completed");
		const before = github.files();

		vault.put("notes/a.md", "A2");
		vault.put("src/run.sh", "#!/bin/sh\necho\n");
		vault.put(`caf\u00e9/${nfd}.md`, "new");
		vault.put("img2.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x01]));
		vault.remove("old.md");
		time += 60_000;
		const pushed = await runPush({ ...common, confirm: async () => "proceed" });

		expect(pushed).toMatchObject({ outcome: "pushed", counts: { added: 2, modified: 2, deleted: 1 } });
		const files = github.files();
		expect([...files.keys()].sort()).toEqual(
			[".claude/skills", `${nfd}/b.md`, `${nfd}/caf\u00e9.md`, "img.png", "img2.png", "knowledge", "notes/a.md", "src/run.sh"].sort(),
		);
		expect(files.get("src/run.sh")?.mode).toBe("100755");
		expect(files.get(".claude/skills")).toEqual(before.get(".claude/skills"));
		expect(files.get("knowledge")).toEqual(before.get("knowledge"));
		expect(github.headCommit()?.message.split("\n")[0]).toBe("Sync Evo: iPhone (2 added, 2 modified, 1 deleted)");

		// The listing the push stored is the one GitHub gives for its commit.
		const stored = await store.getListing();
		const fresh = await backend.list(null);
		if (!fresh.changed || stored === null) throw new Error("expected two listings");
		const sorted = (entries: readonly RemoteEntry[]): RemoteEntry[] =>
			[...entries].sort((a, b) => (a.path < b.path ? -1 : 1));
		expect(stored.revision).toBe(github.head);
		expect(sorted(stored.entries)).toEqual(sorted(fresh.listing.entries));
		expect(await readBaseRevision(store)).toBe(github.head);

		github.requests.length = 0;
		vault.log.length = 0;
		const again = await pull();
		expect(again).toMatchObject({ outcome: "completed", counts: { fetched: 0, deleted: 0, renamed: 0, conflicts: 0 } });
		expect(vault.log).toEqual([]);
		// One request, for the head: it has not moved.
		expect(github.requests.map((request) => `${request.method} ${request.path}`)).toEqual(["GET /git/ref/heads/main"]);
	});
});

describe("a push of a vault against GitHub, where it does not go as planned", () => {
	const t = translatorFor("en");

	/** A vault that is in sync with `files`, after one pull. */
	async function synced(files: Parameters<FakeGitHub["commit"]>[0], signal?: AbortSignal) {
		const { github, backend } = setup(signal);
		const base = github.commit(files);
		let time = Date.UTC(2026, 9, 3, 12, 0, 0);
		const now = (): number => time;
		const store = new MemoryStateStore();
		const vault = new MemoryPullVault({ caseSensitive: true, now });
		const common = {
			store,
			backend,
			vault,
			paths: { configDir: ".obsidian", pluginDir: ".obsidian/plugins/sync-evo" },
			deviceName: "iPhone",
			now,
		};
		const pull = (): ReturnType<typeof runPull> => {
			time += 60_000;
			return runPull({ ...common, pluginId: "sync-evo", confirm: async () => "proceed" });
		};
		const push = (overrides: Partial<PushDeps> = {}): Promise<PushRunResult> => {
			time += 60_000;
			return runPush({ ...common, confirm: async () => "proceed", ...overrides });
		};
		expect((await pull()).outcome).toBe("completed");
		return { github, backend, store, vault, base, pull, push };
	}

	const sorted = (entries: readonly RemoteEntry[]): RemoteEntry[] => [...entries].sort((a, b) => (a.path < b.path ? -1 : 1));

	test("content GitHub stores as other bytes than were sent: told, listed as GitHub holds it, and no later push is refused", async () => {
		const { github, backend, store, vault, pull, push } = await synced({ "a.md": "A\n", "keep.md": "K\n" });
		// A GitHub that turns the line ends of what it is sent as text.
		github.normalise = (content) => content.replace(/\r\n/g, "\n");
		vault.put("a.md", "A2\r\n");
		vault.put("b.md", "B\r\n");
		vault.put("c.md", "C\n");
		const logged: string[] = [];

		const pushed = await push({ log: (line) => logged.push(line) });

		expect(pushed).toMatchObject({ outcome: "pushed", counts: { added: 2, modified: 1 }, storedOtherwise: ["a.md", "b.md"] });
		expect(logged).toEqual(["push: GitHub stored other content than was sent: a.md, b.md"]);
		expect(pushReport(t, pushed, { sizeLimit: 50 * 1024 * 1024 }).details).toEqual([
			"GitHub stored 2 files with other content than this device sent. The next pull replaces the files on this device with GitHub's versions:\na.md\nb.md",
		]);

		// The listing is the tree of the commit, not what was sent.
		const stored = await store.getListing();
		const fresh = await backend.list(null);
		if (!fresh.changed || stored === null) throw new Error("expected two listings");
		expect(stored.revision).toBe(github.head);
		expect(sorted(stored.entries)).toEqual(sorted(fresh.listing.entries));
		expect(stored.entries.find((entry) => entry.path === "a.md")?.hash).toBe(blobHash("A2\n"));
		// The records are of what was sent, which is what the vault holds.
		const records = new Map((await store.readRecords()).map((record) => [record.path, record.hash]));
		expect(records.get("a.md")).toBe(blobHash("A2\r\n"));

		// A push right after is not refused; the files wait for a pull.
		expect((await push()).outcome).toBe("nothing-to-push");
		// The pull brings GitHub's version, with no conflict and no copy.
		const pulled = await pull();
		expect(pulled).toMatchObject({ outcome: "completed", counts: { fetched: 2, conflicts: 0 } });
		expect(vault.snapshot()).toEqual({ "a.md": "A2\n", "b.md": "B\n", "c.md": "C\n", "keep.md": "K\n" });

		// And an edit of such a file is sent like any other.
		vault.put("a.md", "A3\n");
		expect(await push()).toMatchObject({ outcome: "pushed", counts: { modified: 1 }, storedOtherwise: [] });
		expect(github.text("a.md")).toBe("A3\n");
	});

	test("an edit of such a file before the pull is not refused either: it is a conflict for the pull", async () => {
		const { github, vault, pull, push } = await synced({ "a.md": "A\n" });
		github.normalise = (content) => content.replace(/\r\n/g, "\n");
		vault.put("a.md", "A2\r\n");
		expect((await push()).storedOtherwise).toEqual(["a.md"]);
		github.normalise = undefined;

		vault.put("a.md", "A3\r\n");
		expect((await push()).outcome).toBe("nothing-to-push");
		expect((await pull()).counts.conflicts).toBe(1);
		expect(vault.text("a.md")).toBe("A2\n");
	});

	test("the branch is not moved, with an answer GitHub has never given: the push fails, stays remembered, and the next one sends it", async () => {
		const { github, store, vault, base, push } = await synced({ "a.md": "A" });
		vault.put("b.md", "B");
		github.before = (request: SentRequest) =>
			request.method === "PATCH" ? respond(422, { message: "Something GitHub has not said before" }) : undefined;

		await expect(push()).rejects.toMatchObject({ kind: "other" });

		expect(github.head).toBe(base);
		// The commit exists, and whether it became the head is not known here.
		const pending = await readPendingPush(store);
		expect(pending?.parent).toBe(base);
		expect(github.commits.has(pending?.revision ?? "")).toBe(true);
		expect((await store.readRecords()).map((record) => record.path)).toEqual(["a.md"]);

		github.before = undefined;
		const again = await push();
		expect(again).toMatchObject({ outcome: "pushed", recovered: null, counts: { added: 1 } });
		expect(await store.getMeta(PENDING_PUSH_KEY)).toBeUndefined();
		expect(github.headCommit()?.parents).toEqual([base]);
		expect(github.text("b.md")).toBe("B");
	});

	test("stopped once the commit is remembered and before the branch is moved: nothing is sent to the branch, and nothing stays remembered", async () => {
		const controller = new AbortController();
		const { github, store, vault, base, push } = await synced({ "a.md": "A" }, controller.signal);
		vault.put("b.md", "B");
		let remembered = false;
		const stopping = new Proxy(store, {
			get(target, name) {
				const value: unknown = Reflect.get(target, name, target);
				if (typeof value !== "function") return value;
				return async (...args: unknown[]): Promise<unknown> => {
					const result: unknown = await (value as (...rest: unknown[]) => unknown).apply(target, args);
					if (name === "setMeta" && args[0] === PENDING_PUSH_KEY) {
						remembered = true;
						controller.abort();
					}
					return result;
				};
			},
		}) as StateStore;

		const result = await push({ store: stopping, signal: controller.signal });

		expect(result.outcome).toBe("cancelled");
		expect(remembered).toBe(true);
		expect(github.writes()).toEqual(["POST /git/trees", "POST /git/commits"]);
		expect(github.head).toBe(base);
		expect(await store.getMeta(PENDING_PUSH_KEY)).toBeUndefined();
	});

	test("stopped while the branch is moved: the push has happened, and is recorded", async () => {
		const controller = new AbortController();
		const { github, store, vault, push } = await synced({ "a.md": "A" }, controller.signal);
		vault.put("b.md", "B");
		github.before = (request: SentRequest) => {
			if (request.method === "PATCH") controller.abort();
		};

		const result = await push({ signal: controller.signal });

		expect(result.outcome).toBe("pushed");
		expect(github.text("b.md")).toBe("B");
		expect(await store.getMeta(PENDING_PUSH_KEY)).toBeUndefined();
		expect(await readBaseRevision(store)).toBe(github.head);
		// The tree of the commit could not be asked for any more: no listing is kept.
		expect(await store.getListing()).toBeNull();
	});
});

describe("the first commit of a repository without commits", () => {
	test("is one file on the default branch, made with the one request that works there", async () => {
		const { github, backend } = setup();
		const content = bytes("private/\n");

		const started = await backend.start({ path: ".gitignore", content, deviceName: "iPhone" });

		expect(github.writes()).toEqual(["PUT /contents/.gitignore"]);
		const sent = github.requests.find((request) => request.method === "PUT")?.body as Record<string, unknown>;
		expect(sent).toMatchObject({ branch: "main", message: commitMessage("iPhone", [{ kind: "added", path: ".gitignore" }]) });
		expect(started).toEqual({
			status: "started",
			revision: github.head,
			entry: { path: ".gitignore", kind: "file", hash: blobHash(content), size: content.length },
		});
		expect(github.text(".gitignore")).toBe("private/\n");
		expect(github.headCommit()?.message.split("\n")[0]).toBe("Sync Evo: iPhone (1 added)");

		// And the rest goes on top of it, like any push.
		const pushed = await backend.push({ baseRevision: github.head, writes: [file("a.md", "A")], deletes: [] });
		expect(pushed.status).toBe("pushed");
		expect([...github.files().keys()].sort()).toEqual([".gitignore", "a.md"]);
	});

	test("an empty file can be the one", async () => {
		const { github, backend } = setup();
		const started = await backend.start({ path: ".gitignore", content: new Uint8Array() });
		expect(started.status).toBe("started");
		expect(github.text(".gitignore")).toBe("");
	});

	test("nothing is made on a branch that is not the default one", async () => {
		const { github, backend } = setup();
		github.defaultBranch = "trunk";

		expect(await backend.start({ path: ".gitignore", content: bytes("") })).toEqual({
			status: "other-branch",
			defaultBranch: "trunk",
		});

		expect(github.writes()).toEqual([]);
		expect(github.head).toBeNull();
	});

	test("another device made the first commit between the look at the head and the request: nothing is answered of it", async () => {
		const made: Record<string, string>[] = [{ "theirs.md": "T" }, { ".gitignore": "theirs\n" }];
		for (const theirs of made) {
			const { github, backend } = setup();
			github.before = (request) => {
				if (request.method === "PUT" && github.head === null) github.commit(theirs);
			};

			expect(await backend.start({ path: ".gitignore", content: bytes("mine\n") })).toEqual({ status: "stale" });

			// Their files are all there, whatever became of this one.
			for (const [path, content] of Object.entries(theirs)) expect(github.text(path)).toBe(content);
		}
	});

	test("nor in a repository that has a commit by now", async () => {
		const { github, backend } = setup();
		github.commit({ "theirs.md": "T" });

		expect(await backend.start({ path: ".gitignore", content: bytes("") })).toEqual({ status: "stale" });

		expect(github.writes()).toEqual([]);
	});
});
