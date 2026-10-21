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

import { expect, test } from "vitest";
import type { PushFile, RemoteEntry, RemoteListing } from "../src/core/backend";
import { blobHash, bytes, MemoryBackend } from "./support/memory-backend";

async function listing(backend: MemoryBackend): Promise<RemoteListing> {
	const result = await backend.list(null);
	if (!result.changed) throw new Error("expected a listing");
	return result.listing;
}

function pushFile(path: string, content: string): PushFile {
	const data = bytes(content);
	return { path, hash: blobHash(data), size: data.length, read: async () => data };
}

async function entryAt(backend: MemoryBackend, path: string): Promise<RemoteEntry> {
	const entry = (await listing(backend)).entries.find((candidate) => candidate.path === path);
	if (entry === undefined) throw new Error(`not listed: ${path}`);
	return entry;
}

function text(content: Uint8Array | undefined): string | undefined {
	return content === undefined ? undefined : new TextDecoder().decode(content);
}

test("hashes content the way git hashes a blob", async () => {
	const backend = new MemoryBackend();
	expect(await backend.hashContent(bytes(""))).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
	expect(await backend.hashContent(bytes("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
});

test("an empty remote has no revision and no entries", async () => {
	expect(await listing(new MemoryBackend())).toEqual({ revision: null, entries: [] });
});

test("the listing carries a hash that matches the content", async () => {
	const backend = new MemoryBackend();
	const revision = backend.commit({ "notes/a.md": "A" });
	expect(await listing(backend)).toEqual({
		revision,
		entries: [{ path: "notes/a.md", kind: "file", hash: blobHash("A"), size: 1 }],
	});
});

test("listing with the current revision answers unchanged; an older one lists again", async () => {
	const backend = new MemoryBackend();
	const first = backend.commit({ "a.md": "A" });
	expect(await backend.list({ revision: first, entries: [] })).toEqual({ changed: false });

	backend.commit({ "a.md": "A2" });
	const result = await backend.list({ revision: first, entries: [] });
	expect(result.changed).toBe(true);
});

test("fetch returns the content of a listing even after the remote moved on", async () => {
	const backend = new MemoryBackend();
	backend.commit({ "a.md": "A", "b.md": "B" });
	const { revision, entries } = await listing(backend);
	backend.commit({ "a.md": "A2", "b.md": null });

	const fetched = new Map<string, string | undefined>();
	for await (const file of backend.fetch(revision, entries)) {
		fetched.set(file.entry.path, text(file.content));
	}
	expect(fetched).toEqual(new Map([["a.md", "A"], ["b.md", "B"]]));
});

test("a content is found by its hash after the remote moved on, and not one the remote never held or has lost", async () => {
	const backend = new MemoryBackend();
	backend.commit({ "a.md": "A" });
	backend.commit({ "a.md": "A2" });

	expect(text((await backend.contentOf(blobHash("A"))) ?? new Uint8Array())).toBe("A");
	expect(await backend.contentOf(blobHash("never"))).toBeNull();
	backend.lostContents.add(blobHash("A"));
	expect(await backend.contentOf(blobHash("A"))).toBeNull();
	expect(backend.contentRequests).toEqual([blobHash("A"), blobHash("never"), blobHash("A")]);
});

test("a push on the current revision writes, deletes, leaves the rest, and moves the revision", async () => {
	const backend = new MemoryBackend();
	const base = backend.commit({ "keep.md": "K", "old.md": "O", "edit.md": "E" });

	const result = await backend.push({
		baseRevision: base,
		writes: [
			{ ...pushFile("edit.md", "E2"), replaces: await entryAt(backend, "edit.md") },
			pushFile("new.md", "N"),
		],
		deletes: [await entryAt(backend, "old.md")],
	});

	if (result.status !== "pushed") throw new Error("expected the push to go through");
	expect(result.revision).not.toBe(base);
	expect(result.revision).toBe(backend.revision);
	expect(result.written.map((entry) => entry.path)).toEqual(["edit.md", "new.md"]);
	expect(text(backend.read("keep.md"))).toBe("K");
	expect(text(backend.read("edit.md"))).toBe("E2");
	expect(text(backend.read("new.md"))).toBe("N");
	expect(backend.read("old.md")).toBeUndefined();
});

test("a push on an old revision is refused and changes nothing", async () => {
	const backend = new MemoryBackend();
	const base = backend.commit({ "a.md": "A" });
	const head = backend.commit({ "a.md": "theirs" });

	const result = await backend.push({
		baseRevision: base,
		writes: [pushFile("a.md", "mine")],
		deletes: [],
	});

	expect(result).toEqual({ status: "stale" });
	expect(backend.revision).toBe(head);
	expect(text(backend.read("a.md"))).toBe("theirs");
});

test("the first push to an empty remote uses no base revision", async () => {
	const backend = new MemoryBackend();
	const result = await backend.push({ baseRevision: null, writes: [pushFile("a.md", "A")], deletes: [] });
	expect(result.status).toBe("pushed");
	expect(text(backend.read("a.md"))).toBe("A");
});

test("a push with no base revision to a remote that has files is refused", async () => {
	const backend = new MemoryBackend();
	const head = backend.commit({ "a.md": "theirs" });

	const result = await backend.push({ baseRevision: null, writes: [pushFile("a.md", "mine")], deletes: [] });

	expect(result).toEqual({ status: "stale" });
	expect(backend.revision).toBe(head);
	expect(text(backend.read("a.md"))).toBe("theirs");
});

test("what a file reads as is what is sent, under the hash it has, and a file that reads as nothing is left out", async () => {
	const backend = new MemoryBackend();
	const base = backend.commit({ "a.md": "A" });
	// Planned as "B", and typed in since.
	const drifted: PushFile = { ...pushFile("b.md", "B"), read: async () => bytes("B, and more") };
	const gone: PushFile = { ...pushFile("c.md", "C"), read: async () => null };

	const result = await backend.push({ baseRevision: base, writes: [drifted, gone], deletes: [] });

	if (result.status !== "pushed") throw new Error("expected the push to go through");
	expect(result.written).toEqual([{ path: "b.md", kind: "file", hash: blobHash("B, and more"), size: 11 }]);
	expect(text(backend.read("b.md"))).toBe("B, and more");
	expect(backend.read("c.md")).toBeUndefined();
});

test("a new path that the remote already holds fails and changes nothing", async () => {
	const backend = new MemoryBackend();
	const base = backend.commit({ "a.md": "A" });
	await expect(backend.push({ baseRevision: base, writes: [pushFile("a.md", "mine")], deletes: [] })).rejects.toThrow(
		"a.md",
	);
	expect(backend.revision).toBe(base);
	expect(text(backend.read("a.md"))).toBe("A");
});

test("the revision is handed over before it is the head, with what it holds", async () => {
	const backend = new MemoryBackend();
	const base = backend.commit({ "a.md": "A" });
	const seen: unknown[] = [];

	const result = await backend.push({
		baseRevision: base,
		writes: [pushFile("b.md", "B")],
		deletes: [],
		beforePublish: async (pending) => {
			seen.push({ ...pending, head: backend.revision });
		},
	});

	if (result.status !== "pushed") throw new Error("expected the push to go through");
	expect(seen).toEqual([{ revision: result.revision, written: result.written, head: base }]);
	expect(backend.revision).toBe(result.revision);
});

test("a delete or a replacement that names an entry the remote does not hold fails", async () => {
	const backend = new MemoryBackend();
	const base = backend.commit({ "a.md": "A" });
	const other: RemoteEntry = { path: "a.md", kind: "file", hash: blobHash("not A") };

	await expect(backend.push({ baseRevision: base, writes: [], deletes: [other] })).rejects.toThrow("a.md");
	await expect(
		backend.push({ baseRevision: base, writes: [{ ...pushFile("a.md", "A2"), replaces: other }], deletes: [] }),
	).rejects.toThrow("a.md");

	expect(backend.revision).toBe(base);
	expect(text(backend.read("a.md"))).toBe("A");
});

test("a push with nothing in it, or with only what the remote holds, does not create a revision", async () => {
	const backend = new MemoryBackend();
	const base = backend.commit({ "a.md": "A" });
	expect(await backend.push({ baseRevision: base, writes: [], deletes: [] })).toEqual({ status: "unchanged" });
	const same = { ...pushFile("a.md", "A"), replaces: await entryAt(backend, "a.md") };
	expect(await backend.push({ baseRevision: base, writes: [same], deletes: [] })).toEqual({ status: "unchanged" });
	expect(backend.revision).toBe(base);
});

test("the base continues after ordinary commits and is reported rewritten after a force push", async () => {
	const backend = new MemoryBackend();
	const base = backend.commit({ "a.md": "A" });
	const next = backend.commit({ "b.md": "B" });
	expect(await backend.checkBase(base, next)).toBe("continues");

	const rewritten = backend.rewriteHistory({ "a.md": "A" });
	expect(await backend.checkBase(base, rewritten)).toBe("rewritten");
});
