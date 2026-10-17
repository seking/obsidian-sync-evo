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

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { FetchedFile, PushFile, PushRefusal, RemoteEntry, RemoteListing } from "../src/core/backend";
import { DropboxBackend } from "../src/core/dropbox/backend";
import { DropboxApiError } from "../src/core/dropbox/client";
import { DROPBOX_BLOCK_BYTES, dropboxContentHash } from "../src/core/dropbox/content-hash";
import { FakeDropbox } from "./support/fake-dropbox";

const ROOT = "/Vault";

function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

function harness(): { dropbox: FakeDropbox; backend: DropboxBackend } {
	const dropbox = new FakeDropbox();
	return { dropbox, backend: new DropboxBackend(dropbox, { folder: "Vault" }) };
}

async function listing(backend: DropboxBackend, known: RemoteListing | null = null): Promise<RemoteListing> {
	const listed = await backend.list(known);
	if (!listed.changed) throw new Error("expected a listing");
	return listed.listing;
}

function paths(listing: RemoteListing): string[] {
	return listing.entries.map((entry) => entry.path);
}

function entryOf(listing: RemoteListing, path: string): RemoteEntry {
	const entry = listing.entries.find((e) => e.path === path);
	if (entry === undefined) throw new Error(`not listed: ${path}`);
	return entry;
}

function write(path: string, text: string, replaces?: RemoteEntry): PushFile & { refusals: PushRefusal[] } {
	const refusals: PushRefusal[] = [];
	return {
		path,
		hash: "",
		size: text.length,
		...(replaces === undefined ? {} : { replaces }),
		read: () => Promise.resolve(bytes(text)),
		refused: (reason) => {
			refusals.push(reason);
		},
		refusals,
	};
}

async function all(iterable: AsyncIterable<FetchedFile>): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for await (const item of iterable) out[item.entry.path] = new TextDecoder().decode(item.content);
	return out;
}

describe("the content hash of Dropbox", () => {
	function reference(content: Uint8Array): string {
		const blocks: Buffer[] = [];
		for (let start = 0; start < content.length; start += DROPBOX_BLOCK_BYTES) {
			blocks.push(createHash("sha256").update(content.subarray(start, start + DROPBOX_BLOCK_BYTES)).digest());
		}
		return createHash("sha256").update(Buffer.concat(blocks)).digest("hex");
	}

	test("of nothing is the SHA-256 of nothing", async () => {
		expect(await dropboxContentHash(new Uint8Array())).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	});

	test.each([1, DROPBOX_BLOCK_BYTES - 1, DROPBOX_BLOCK_BYTES, DROPBOX_BLOCK_BYTES + 1, 2 * DROPBOX_BLOCK_BYTES + 123])(
		"of %i bytes is the hash of the hashes of its 4 MB blocks",
		async (length) => {
			const content = new Uint8Array(length);
			for (let i = 0; i < length; i++) content[i] = (i * 31 + 7) & 0xff;
			expect(await dropboxContentHash(content)).toBe(reference(content));
		},
	);
});

describe("listing a folder of Dropbox", () => {
	test("a folder that is not there is an empty remote without a revision", async () => {
		const { backend } = harness();
		expect(await backend.list(null)).toEqual({ changed: true, listing: { revision: null, entries: [] } });
	});

	test("lists the files below the folder, by the path below it, with their hash, size and version", async () => {
		const { dropbox, backend } = harness();
		const rev = await dropbox.put("/Vault/Notes/a.md", "A");
		await dropbox.put("/Vault/b.md", "BB");
		await dropbox.put("/Other/c.md", "C");
		const listed = await listing(backend);
		expect(listed.revision).not.toBeNull();
		expect(listed.entries).toEqual([
			{ path: "Notes/a.md", kind: "file", hash: await dropboxContentHash(bytes("A")), size: 1, version: rev },
			{ path: "b.md", kind: "file", hash: await dropboxContentHash(bytes("BB")), size: 2, version: expect.any(String) },
		]);
	});

	test("reads every page, and a page that fails fails it all", async () => {
		const { dropbox, backend } = harness();
		for (let i = 0; i < 5; i++) await dropbox.put(`/Vault/${i}.md`, `${i}`);
		dropbox.pageSize = 2;
		expect(paths(await listing(backend))).toEqual(["0.md", "1.md", "2.md", "3.md", "4.md"]);

		let pages = 0;
		dropbox.beforeCall = (endpoint) => {
			if (endpoint === "files/list_folder/continue" && ++pages === 2) throw new Error("the connection dropped");
		};
		await expect(backend.list(null)).rejects.toThrow("the connection dropped");
	});

	test("answers that nothing changed from a cursor nothing happened after, without listing", async () => {
		const { dropbox, backend } = harness();
		await dropbox.put("/Vault/a.md", "A");
		const first = await listing(backend);
		dropbox.calls.length = 0;
		expect(await backend.list(first)).toEqual({ changed: false });
		expect(dropbox.calls).toEqual(["files/list_folder/continue"]);
	});

	test("lays the changes since the cursor on the listing it is given", async () => {
		const { dropbox, backend } = harness();
		await dropbox.put("/Vault/a.md", "A");
		await dropbox.put("/Vault/old/x.md", "X");
		await dropbox.put("/Vault/old/y.md", "Y");
		const first = await listing(backend);

		await dropbox.put("/Vault/a.md", "A2");
		await dropbox.put("/Vault/new.md", "N");
		dropbox.delete("/Vault/old");
		await dropbox.put("/Other/z.md", "Z");
		dropbox.calls.length = 0;
		const next = await listing(backend, first);

		expect(dropbox.calls).toEqual(["files/list_folder/continue"]);
		expect(paths(next)).toEqual(["a.md", "new.md"]);
		expect(entryOf(next, "a.md").hash).toBe(await dropboxContentHash(bytes("A2")));
		expect(next.revision).not.toBe(first.revision);
	});

	test("a folder deleted and made again holds only what came after", async () => {
		const { dropbox, backend } = harness();
		await dropbox.put("/Vault/f/a.md", "A");
		await dropbox.put("/Vault/f/b.md", "B");
		const first = await listing(backend);
		dropbox.delete("/Vault/f");
		await dropbox.put("/Vault/f/b.md", "B2");
		expect(paths(await listing(backend, first))).toEqual(["f/b.md"]);
	});

	test("a cursor Dropbox will not go on from lists the folder again", async () => {
		const { dropbox, backend } = harness();
		await dropbox.put("/Vault/a.md", "A");
		const first = await listing(backend);
		await dropbox.put("/Vault/b.md", "B");
		dropbox.expired.add(first.revision ?? "");
		dropbox.calls.length = 0;
		expect(paths(await listing(backend, first))).toEqual(["a.md", "b.md"]);
		expect(dropbox.calls).toEqual(["files/list_folder/continue", "files/list_folder"]);
	});

	test("the folders above a file are spelled as the listing has them, not as the new file's path spells them", async () => {
		const { dropbox, backend } = harness();
		await dropbox.put("/Vault/Notes/a.md", "A");
		const first = await listing(backend);
		// Dropbox keeps the folder as `Notes`, and may answer the parent
		// of a new file as it was written.
		await dropbox.put("/Vault/notes/b.md", "B");
		expect(paths(await listing(backend, first))).toEqual(["Notes/a.md", "Notes/b.md"]);
	});

	test("a deletion spelled in another case still deletes", async () => {
		const { dropbox, backend } = harness();
		await dropbox.put("/Vault/Notes/a.md", "A");
		const first = await listing(backend);
		dropbox.delete("/vault/NOTES/A.md");
		expect(paths(await listing(backend, first))).toEqual([]);
	});

	test("the folder of the vault deleted is an empty remote", async () => {
		const { dropbox, backend } = harness();
		await dropbox.put("/Vault/a.md", "A");
		const first = await listing(backend);
		dropbox.delete("/Vault");
		expect(await backend.list(first)).toEqual({ changed: true, listing: { revision: null, entries: [] } });
	});

	test("reads every page of the changes", async () => {
		const { dropbox, backend } = harness();
		await dropbox.put("/Vault/a.md", "A");
		const first = await listing(backend);
		for (let i = 0; i < 5; i++) await dropbox.put(`/Vault/${i}.md`, `${i}`);
		dropbox.pageSize = 2;
		expect(paths(await listing(backend, first))).toEqual(["0.md", "1.md", "2.md", "3.md", "4.md", "a.md"]);
	});

	test("a file Dropbox cannot download is left out, and the folder is asked without such files", async () => {
		const { dropbox, backend } = harness();
		await dropbox.put("/Vault/a.md", "A");
		const asked: Record<string, unknown>[] = [];
		dropbox.beforeCall = (endpoint, arg) => {
			if (endpoint === "files/list_folder") asked.push(arg);
		};
		const real = dropbox.rpc.bind(dropbox);
		dropbox.rpc = async (endpoint, arg) => {
			const answer = (await real(endpoint, arg)) as { entries?: unknown[] };
			if (endpoint === "files/list_folder" && answer.entries !== undefined) {
				answer.entries.push({ ".tag": "file", name: "doc.paper", path_lower: "/vault/doc.paper", path_display: "/Vault/doc.paper", rev: "r", size: 0, is_downloadable: false });
			}
			return answer;
		};
		expect(paths(await listing(backend))).toEqual(["a.md"]);
		expect(asked[0]).toMatchObject({ include_non_downloadable_files: false });
	});
});

describe("fetching from Dropbox", () => {
	test("each file as the version the listing named, also when it changed since", async () => {
		const { dropbox, backend } = harness();
		await dropbox.put("/Vault/a.md", "A");
		await dropbox.put("/Vault/b.md", "B");
		const listed = await listing(backend);
		await dropbox.put("/Vault/a.md", "A2");
		expect(await all(backend.fetch(listed.revision, listed.entries))).toEqual({ "a.md": "A", "b.md": "B" });
	});
});

describe("pushing to Dropbox", () => {
	test("writes new and changed files, deletes, and answers the listing after it", async () => {
		const { dropbox, backend } = harness();
		await dropbox.put("/Vault/a.md", "A");
		await dropbox.put("/Vault/gone.md", "G");
		const listed = await listing(backend);

		const result = await backend.push({
			baseRevision: listed.revision,
			writes: [write("a.md", "A2", entryOf(listed, "a.md")), write("new.md", "N")],
			deletes: [entryOf(listed, "gone.md")],
		});

		expect(dropbox.tree(ROOT)).toEqual({ "a.md": "A2", "new.md": "N" });
		if (result.status !== "pushed") throw new Error(result.status);
		expect(result.written.map((entry) => [entry.path, entry.hash])).toEqual([
			["a.md", await dropboxContentHash(bytes("A2"))],
			["new.md", await dropboxContentHash(bytes("N"))],
		]);
		expect(result.kept).toBeUndefined();
		expect(result.listing && paths(result.listing)).toEqual(["a.md", "new.md"]);
		expect(result.revision).toBe(result.listing?.revision);
		// The listing goes on from there.
		expect(await backend.list(result.listing ?? null)).toEqual({ changed: false });
	});

	test("what another device changed first is neither written over nor deleted, and the rest goes on", async () => {
		const { dropbox, backend } = harness();
		await dropbox.put("/Vault/a.md", "A");
		await dropbox.put("/Vault/b.md", "B");
		const listed = await listing(backend);
		await dropbox.put("/Vault/a.md", "A, from another device");
		await dropbox.put("/Vault/b.md", "B, from another device");
		await dropbox.put("/Vault/new.md", "N, from another device");

		const a = write("a.md", "A2", entryOf(listed, "a.md"));
		const added = write("new.md", "N, from this device");
		const c = write("c.md", "C");
		const result = await backend.push({ baseRevision: listed.revision, writes: [a, added, c], deletes: [entryOf(listed, "b.md")] });

		expect(a.refusals).toEqual(["changed"]);
		expect(added.refusals).toEqual(["changed"]);
		expect(dropbox.tree(ROOT)).toEqual({
			"a.md": "A, from another device",
			"b.md": "B, from another device",
			"c.md": "C",
			"new.md": "N, from another device",
		});
		if (result.status !== "pushed") throw new Error(result.status);
		expect(result.written.map((entry) => entry.path)).toEqual(["c.md"]);
		expect(result.kept).toEqual([entryOf(listed, "b.md")]);
	});

	test("a push the remote took none of is unchanged, with the deletes it kept", async () => {
		const { dropbox, backend } = harness();
		await dropbox.put("/Vault/b.md", "B");
		const listed = await listing(backend);
		await dropbox.put("/Vault/b.md", "B2");
		expect(await backend.push({ baseRevision: listed.revision, writes: [], deletes: [entryOf(listed, "b.md")] })).toEqual({
			status: "unchanged",
			kept: [entryOf(listed, "b.md")],
		});
	});

	test("a file deleted already is no failure, and a content the remote holds already is not written", async () => {
		const { dropbox, backend } = harness();
		await dropbox.put("/Vault/a.md", "A");
		await dropbox.put("/Vault/b.md", "B");
		const listed = await listing(backend);
		dropbox.delete("/Vault/b.md");
		dropbox.calls.length = 0;
		const result = await backend.push({
			baseRevision: listed.revision,
			writes: [write("a.md", "A", entryOf(listed, "a.md"))],
			deletes: [entryOf(listed, "b.md")],
		});
		expect(dropbox.calls).not.toContain("files/upload");
		expect(result.status).toBe("pushed");
	});

	test("a rename to another case deletes the old spelling before it writes the new one", async () => {
		const { dropbox, backend } = harness();
		await dropbox.put("/Vault/Note.md", "A");
		const listed = await listing(backend);
		const result = await backend.push({
			baseRevision: listed.revision,
			writes: [write("note.md", "A")],
			deletes: [entryOf(listed, "Note.md")],
		});
		expect(result.status).toBe("pushed");
		expect(dropbox.tree(ROOT)).toEqual({ "note.md": "A" });
	});

	test("an untracking whose .gitignore another device changed first deletes nothing", async () => {
		const { dropbox, backend } = harness();
		await dropbox.put("/Vault/.gitignore", "old");
		await dropbox.put("/Vault/drafts/a.md", "A");
		const listed = await listing(backend);
		await dropbox.put("/Vault/.gitignore", "another device's");
		const result = await backend.push({
			baseRevision: listed.revision,
			writes: [write(".gitignore", "drafts/", entryOf(listed, ".gitignore"))],
			deletes: [entryOf(listed, "drafts/a.md")],
			untrack: true,
		});
		expect(result).toEqual({ status: "stale" });
		expect(dropbox.tree(ROOT)).toEqual({ ".gitignore": "another device's", "drafts/a.md": "A" });
	});

	test("an untracking writes the .gitignore before it deletes", async () => {
		const { dropbox, backend } = harness();
		await dropbox.put("/Vault/.gitignore", "old");
		await dropbox.put("/Vault/drafts/a.md", "A");
		const listed = await listing(backend);
		const order: string[] = [];
		dropbox.beforeCall = (endpoint) => {
			if (endpoint !== "files/list_folder/continue") order.push(endpoint);
		};
		await backend.push({
			baseRevision: listed.revision,
			writes: [write(".gitignore", "drafts/", entryOf(listed, ".gitignore"))],
			deletes: [entryOf(listed, "drafts/a.md")],
			untrack: true,
		});
		expect(order).toEqual(["files/upload", "files/delete_v2"]);
	});

	test("a file another device wrote over right after it was written is not answered as written", async () => {
		const { dropbox, backend } = harness();
		await dropbox.put("/Vault/a.md", "A");
		const listed = await listing(backend);
		dropbox.beforeCall = async (endpoint) => {
			if (endpoint === "files/list_folder/continue") {
				dropbox.beforeCall = undefined;
				await dropbox.put("/Vault/a.md", "A, from another device");
			}
		};
		const result = await backend.push({ baseRevision: listed.revision, writes: [write("a.md", "A2", entryOf(listed, "a.md"))], deletes: [] });
		if (result.status !== "pushed") throw new Error(result.status);
		expect(result.written).toEqual([]);
	});

	test("a file the account has no room for is left out, and the rest goes on", async () => {
		const { dropbox, backend } = harness();
		await dropbox.put("/Vault/x.md", "X");
		const listed = await listing(backend);
		dropbox.beforeEntry = (endpoint, path) => {
			if (path === "/Vault/big.bin") throw new DropboxApiError(endpoint, "path/insufficient_space/..");
		};
		const big = write("big.bin", "BIG");
		const result = await backend.push({ baseRevision: listed.revision, writes: [big, write("a.md", "A")], deletes: [] });
		expect(big.refusals).toEqual(["no-space"]);
		expect(result.status === "pushed" && result.written.map((entry) => entry.path)).toEqual(["a.md"]);
	});

	test("a push whose listing after it cannot be taken answers no listing, and the base revision", async () => {
		const { dropbox, backend } = harness();
		await dropbox.put("/Vault/x.md", "X");
		const listed = await listing(backend);
		dropbox.beforeCall = (endpoint) => {
			if (endpoint === "files/list_folder/continue") throw new Error("the connection dropped");
		};
		const result = await backend.push({ baseRevision: listed.revision, writes: [write("a.md", "A")], deletes: [] });
		expect(result).toMatchObject({ status: "pushed", revision: listed.revision });
		expect(result.status === "pushed" && result.listing).toBeUndefined();
	});

	test("stopped while the contents are sent, writes nothing", async () => {
		const dropbox = new FakeDropbox();
		const controller = new AbortController();
		const backend = new DropboxBackend(dropbox, { folder: "Vault", signal: controller.signal });
		await dropbox.put("/Vault/x.md", "X");
		const listed = await listing(backend);
		const first = write("a.md", "A");
		const stopping: PushFile = { ...first, read: () => (controller.abort(), Promise.resolve(bytes("A"))) };
		await expect(
			backend.push({ baseRevision: listed.revision, writes: [stopping, write("b.md", "B")], deletes: [] }),
		).rejects.toMatchObject({ kind: "cancelled" });
		expect(dropbox.tree(ROOT)).toEqual({ "x.md": "X" });
		expect(dropbox.calls).not.toContain("files/upload_session/finish_batch_v2");
	});

	test("one file is written by its own call; several are sent into sessions and committed in one call", async () => {
		const { dropbox, backend } = harness();
		await dropbox.put("/Vault/x.md", "X");
		let listed = await listing(backend);
		dropbox.calls.length = 0;
		await backend.push({ baseRevision: listed.revision, writes: [write("a.md", "A")], deletes: [] });
		expect(dropbox.calls).toEqual(["files/upload", "files/list_folder/continue"]);

		listed = await listing(backend);
		dropbox.calls.length = 0;
		const result = await backend.push({ baseRevision: listed.revision, writes: [write("b.md", "B"), write("c.md", "C"), write("d.md", "D")], deletes: [] });
		expect(dropbox.calls).toEqual([
			"files/upload_session/start",
			"files/upload_session/start",
			"files/upload_session/start",
			"files/upload_session/finish_batch_v2",
			"files/list_folder/continue",
		]);
		expect(dropbox.tree(ROOT)).toEqual({ "a.md": "A", "b.md": "B", "c.md": "C", "d.md": "D", "x.md": "X" });
		expect(result.status === "pushed" && result.written.map((entry) => entry.path)).toEqual(["b.md", "c.md", "d.md"]);
	});

	test("the contents on their way are bounded by their bytes, and one larger than the bound goes alone", async () => {
		const dropbox = new FakeDropbox();
		const backend = new DropboxBackend(dropbox, { folder: "Vault", maxConcurrentFetchBytes: 2 });
		await dropbox.put("/Vault/x.md", "X");
		const listed = await listing(backend);
		let now = 0;
		const most: Record<string, number> = {};
		// The first content waits until the second is on its way too, or for
		// a while when it does not come: so that both are seen at once
		// however long the hashing between them takes.
		let second = (): void => {};
		const both = new Promise<void>((resolve) => {
			second = resolve;
			setTimeout(resolve, 1000);
		});
		dropbox.beforeCall = async (endpoint, arg) => {
			if (endpoint !== "files/upload_session/start") return;
			now += 1;
			const name = String(arg.content_hash);
			most[name] = now;
			if (now === 2) second();
			if (Object.keys(most).length === 1) await both;
			else await new Promise((resolve) => setTimeout(resolve, 1));
			now -= 1;
		};
		await backend.push({ baseRevision: listed.revision, writes: [write("a.md", "A"), write("b.md", "B"), write("big.md", "BIG"), write("c.md", "C")], deletes: [] });
		// a and b together (2 bytes), big alone, then c.
		const at = async (text: string): Promise<number | undefined> => most[await dropboxContentHash(bytes(text))];
		expect([await at("A"), await at("B"), await at("BIG"), await at("C")]).toEqual([1, 2, 1, 1]);
		expect(dropbox.tree(ROOT)).toEqual({ "a.md": "A", "b.md": "B", "big.md": "BIG", "c.md": "C", "x.md": "X" });
	});

	test("an entry of the commit that met another write is committed again from its session, after a wait", async () => {
		const { dropbox, backend } = harness();
		await dropbox.put("/Vault/x.md", "X");
		const listed = await listing(backend);
		let busy = 2;
		dropbox.beforeEntry = (endpoint, path) => {
			if (path === "/Vault/b.md" && busy-- > 0) throw new DropboxApiError(endpoint, "too_many_write_operations/");
		};
		const result = await backend.push({ baseRevision: listed.revision, writes: [write("a.md", "A"), write("b.md", "B")], deletes: [] });
		expect(dropbox.calls.filter((call) => call === "files/upload_session/start")).toHaveLength(2);
		expect(dropbox.calls.filter((call) => call === "files/upload_session/finish_batch_v2")).toHaveLength(3);
		expect(dropbox.waits).toEqual([1000, 2000]);
		expect(dropbox.lines).toEqual([
			"dropbox: files/upload_session/finish_batch_v2: 1 of 2 files met too_many_write_operations, waiting 1000 ms (retry 1 of 5)",
			"dropbox: files/upload_session/finish_batch_v2: 1 of 1 files met too_many_write_operations, waiting 2000 ms (retry 2 of 5)",
		]);
		expect(dropbox.tree(ROOT)).toEqual({ "a.md": "A", "b.md": "B", "x.md": "X" });
		expect(result.status === "pushed" && result.written.map((entry) => entry.path)).toEqual(["a.md", "b.md"]);
	});

	test("several files are deleted in one call, asked on until it is done, each guarded by its version", async () => {
		const { dropbox, backend } = harness();
		await dropbox.put("/Vault/a.md", "A");
		await dropbox.put("/Vault/b.md", "B");
		await dropbox.put("/Vault/c.md", "C");
		await dropbox.put("/Vault/d.md", "D");
		const listed = await listing(backend);
		await dropbox.put("/Vault/b.md", "B, from another device");
		dropbox.delete("/Vault/c.md");
		dropbox.deleteChecks = 2;
		dropbox.calls.length = 0;
		const result = await backend.push({
			baseRevision: listed.revision,
			writes: [],
			deletes: [entryOf(listed, "a.md"), entryOf(listed, "b.md"), entryOf(listed, "c.md"), entryOf(listed, "d.md")],
		});
		expect(dropbox.calls).toEqual([
			"files/delete_batch",
			"files/delete_batch/check",
			"files/delete_batch/check",
			"files/delete_batch/check",
			"files/list_folder/continue",
		]);
		expect(dropbox.tree(ROOT)).toEqual({ "b.md": "B, from another device" });
		expect(result.status === "pushed" && result.kept).toEqual([entryOf(listed, "b.md")]);
	});

	test("a file of a delete of several that met another write is deleted by its own call", async () => {
		const { dropbox, backend } = harness();
		await dropbox.put("/Vault/a.md", "A");
		await dropbox.put("/Vault/b.md", "B");
		const listed = await listing(backend);
		dropbox.beforeEntry = (endpoint, path) => {
			if (path === "/Vault/b.md") throw new DropboxApiError(endpoint, "too_many_write_operations/");
		};
		await backend.push({ baseRevision: listed.revision, writes: [], deletes: [entryOf(listed, "a.md"), entryOf(listed, "b.md")] });
		expect(dropbox.calls).toContain("files/delete_v2");
		expect(dropbox.tree(ROOT)).toEqual({});
	});
});

describe("starting a folder on Dropbox", () => {
	test("writes the first file, which makes the folder, and answers a revision to push on", async () => {
		const { dropbox, backend } = harness();
		const result = await backend.start({ path: ".gitignore", content: bytes("rules") });
		if (result.status !== "started") throw new Error(result.status);
		expect(dropbox.tree(ROOT)).toEqual({ ".gitignore": "rules" });
		expect(result.entry.path).toBe(".gitignore");
		expect(result.listing && paths(result.listing)).toEqual([".gitignore"]);
		const pushed = await backend.push({ baseRevision: result.revision, writes: [write("a.md", "A")], deletes: [] });
		expect(pushed.status === "pushed" && pushed.listing && paths(pushed.listing)).toEqual([".gitignore", "a.md"]);
	});

	test("a folder another device started first is stale", async () => {
		const { dropbox, backend } = harness();
		await dropbox.put("/Vault/.gitignore", "theirs");
		expect(await backend.start({ path: ".gitignore", content: bytes("rules") })).toEqual({ status: "stale" });
	});
});

describe("the content a file had before, for a merge", () => {
	test("is found among the versions of the file by its hash", async () => {
		const { dropbox, backend } = harness();
		await dropbox.put("/Vault/a.md", "base");
		await dropbox.put("/Vault/a.md", "theirs");
		const content = await backend.contentOf(await dropboxContentHash(bytes("base")), "a.md");
		expect(content && new TextDecoder().decode(content)).toBe("base");
	});

	test("is none when no version has the hash, or the file has no versions", async () => {
		const { dropbox, backend } = harness();
		await dropbox.put("/Vault/a.md", "theirs");
		expect(await backend.contentOf(await dropboxContentHash(bytes("base")), "a.md")).toBeNull();
		expect(await backend.contentOf(await dropboxContentHash(bytes("base")), "missing.md")).toBeNull();
	});
});
