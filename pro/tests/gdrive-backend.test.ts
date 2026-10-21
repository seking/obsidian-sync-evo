/*
 * Sync Evo
 * Copyright (C) 2026 seking
 *
 * This file is part of the paid part of Sync Evo (the folder pro/), which is
 * licensed under the Elastic License 2.0, not the AGPL. You may not move,
 * change, disable, or circumvent the license key functionality in it. See
 * pro/LICENSE for the full text.
 *
 * Source: https://github.com/seking/obsidian-sync-evo
 */

import { describe, expect, test } from "vitest";
import type { PushFile, PushRefusal, RemoteListing } from "../../src/core/backend";
import { decodeRevision, encodeRevision, GDriveBackend } from "../src/core/gdrive/backend";
import { DriveApiError } from "../src/core/gdrive/client";
import { DriveDuplicateFolderError, DriveFolderGoneError } from "../src/core/gdrive/errors";
import { FakeDrive } from "./support/fake-gdrive";
import { freeGuard } from "./support/paid";

function backend(drive: FakeDrive, folderId: string | null = null, found: string[] = []): GDriveBackend {
	return new GDriveBackend(drive, { folder: "Vault", folderId, onFolderFound: (id) => found.push(id), plan: freeGuard() });
}

/** Drive with the folder of the vault and some files in it, as another device left it. */
async function filled(files: Record<string, string>): Promise<FakeDrive> {
	const drive = new FakeDrive();
	drive.makeFolder("", "Sync Evo");
	drive.makeFolder("Sync Evo", "Vault");
	for (const [path, text] of Object.entries(files)) {
		const parts = path.split("/");
		for (let i = 1; i < parts.length; i++) {
			const folder = ["Sync Evo", "Vault", ...parts.slice(0, i)].join("/");
			if (drive.idOf(folder) === undefined) drive.makeFolder(["Sync Evo", "Vault", ...parts.slice(0, i - 1)].join("/"), parts[i - 1] as string);
		}
		await drive.put(`Sync Evo/Vault/${path}`, text);
	}
	return drive;
}

async function listing(remote: GDriveBackend, known: RemoteListing | null = null): Promise<RemoteListing> {
	const listed = await remote.list(known);
	if (!listed.changed) throw new Error("unchanged");
	return listed.listing;
}

function file(path: string, text: string, replaces?: PushFile["replaces"], refusals: PushRefusal[] = []): PushFile {
	const content = new TextEncoder().encode(text);
	return {
		path,
		hash: "",
		size: content.byteLength,
		...(replaces === undefined ? {} : { replaces }),
		read: async () => content,
		refused: (reason) => refusals.push(reason),
	};
}

describe("listing the folder of the vault on Google Drive", () => {
	test("is empty, without a revision, while there is no folder, and finds it by its name once there is", async () => {
		const drive = new FakeDrive();
		expect(await listing(backend(drive))).toEqual({ revision: null, entries: [] });
		const full = await filled({ "a.md": "A", "notes/b.md": "B" });
		const found: string[] = [];
		const listed = await listing(backend(full, null, found));
		expect(listed.entries.map((entry) => entry.path)).toEqual(["a.md", "notes/b.md"]);
		expect(found).toEqual([full.idOf("Sync Evo/Vault")]);
		// Each entry has the id of its file, and the SHA-256 of its content.
		expect(listed.entries[0]).toMatchObject({ id: full.idOf("Sync Evo/Vault/a.md"), size: 1 });
		expect(listed.entries[0]?.hash).toBe(await backend(full).hashContent(new TextEncoder().encode("A")));
	});

	test("reads every page, and fails rather than answer part of it", async () => {
		const drive = await filled({ "a.md": "A", "b.md": "B", "c/d.md": "D" });
		drive.pageSize = 2;
		expect((await listing(backend(drive))).entries.map((entry) => entry.path)).toEqual(["a.md", "b.md", "c/d.md"]);
		drive.incomplete = true;
		await expect(backend(drive).list(null)).rejects.toMatchObject({ kind: "incomplete-listing" });
	});

	test("fails for a file Drive gives no SHA-256 of, and leaves out a document of Google's own", async () => {
		const drive = await filled({ "a.md": "A" });
		drive.putDocument("Sync Evo/Vault", "Doc");
		expect((await listing(backend(drive))).entries.map((entry) => entry.path)).toEqual(["a.md"]);
		drive.noHash = true;
		await expect(backend(drive).list(null)).rejects.toMatchObject({ kind: "incomplete-listing" });
	});

	test("a file whose hash is not in the listing nor in the changes is asked for alone", async () => {
		const drive = await filled({ "a.md": "A" });
		drive.hashOnlyAlone = true;
		const remote = backend(drive);
		const first = await listing(remote);
		expect(first.entries[0]?.hash).toBe(await remote.hashContent(new TextEncoder().encode("A")));
		await drive.put("Sync Evo/Vault/b.md", "B");
		const next = await listing(remote, first);
		expect(next.entries.map((entry) => entry.hash)).toEqual([
			await remote.hashContent(new TextEncoder().encode("A")),
			await remote.hashContent(new TextEncoder().encode("B")),
		]);
	});

	test("stops at two folders of the name of Sync Evo, or of the vault", async () => {
		const drive = await filled({ "a.md": "A" });
		drive.makeFolder("Sync Evo", "Vault");
		await expect(backend(drive).list(null)).rejects.toBeInstanceOf(DriveDuplicateFolderError);
		const top = new FakeDrive();
		top.makeFolder("", "Sync Evo");
		top.makeFolder("", "Sync Evo");
		await expect(backend(top).list(null)).rejects.toMatchObject({ folder: "Sync Evo" });
	});

	test("a folder kept by its id that is gone, in the trash, or out of sight fails as gone", async () => {
		const drive = await filled({ "a.md": "A" });
		const id = drive.idOf("Sync Evo/Vault") as string;
		expect((await listing(backend(drive, id))).entries).toHaveLength(1);
		drive.trash("Sync Evo");
		await expect(backend(drive, id).list(null)).rejects.toBeInstanceOf(DriveFolderGoneError);
		await expect(backend(drive, "unknown").list(null)).rejects.toMatchObject({ folderId: "unknown" });
	});

	test("two folders of one name inside the vault both show, and their files of one name are two entries of one path", async () => {
		const drive = await filled({ "n/a.md": "A", "n/b.md": "B" });
		const second = drive.makeFolder("Sync Evo/Vault", "n");
		await drive.put("Sync Evo/Vault/n/a.md", "A elsewhere", { parent: second });
		await drive.put("Sync Evo/Vault/n/c.md", "C", { parent: second });
		const listed = await listing(backend(drive));
		expect(listed.entries.map((entry) => entry.path)).toEqual(["n/a.md", "n/a.md", "n/b.md", "n/c.md"]);
	});

	test("changes since the page token are laid on the listing; none is no change", async () => {
		const drive = await filled({ "a.md": "A", "b.md": "B" });
		const remote = backend(drive);
		const first = await listing(remote);
		expect(await remote.list(first)).toEqual({ changed: false });
		await drive.put("Sync Evo/Vault/a.md", "A2");
		drive.trash("Sync Evo/Vault/b.md");
		await drive.put("Sync Evo/Vault/c.md", "C");
		drive.calls.length = 0;
		const next = await listing(remote, first);
		expect(drive.calls).toEqual(["GET changes"]);
		expect(next.entries.map((entry) => entry.path)).toEqual(["a.md", "c.md"]);
		expect(next.revision).not.toBe(first.revision);
	});

	test("a folder made in the vault on Drive lists everything again, with what is in it", async () => {
		const drive = await filled({ "a.md": "A" });
		const remote = backend(drive);
		const first = await listing(remote);
		drive.makeFolder("Sync Evo/Vault", "x");
		await drive.put("Sync Evo/Vault/x/y.md", "Y");
		drive.calls.length = 0;
		const next = await listing(remote, first);
		expect(drive.calls).toContain("GET files");
		expect(next.entries.map((entry) => entry.path)).toEqual(["a.md", "x/y.md"]);
	});

	test("a revision holds the page token, the folder and its folders, and nothing else reads as one", () => {
		const state = { token: "7", root: "r", folders: new Map([["f", { parent: "r", name: "n" }]]) };
		expect(decodeRevision(encodeRevision(state))).toEqual(state);
		expect(decodeRevision("abc")).toBeNull();
		expect(decodeRevision("gdrive1:{")).toBeNull();
	});
});

describe("when the folder of Sync Evo was made, for the free time of the paid plan", () => {
	const MADE = Date.parse("2026-12-01T09:00:00Z");

	function told(drive: FakeDrive, folderId: string | null): { remote: GDriveBackend; since: number[] } {
		const since: number[] = [];
		return { remote: new GDriveBackend(drive, { folder: "Vault", folderId, onSince: (at) => since.push(at), plan: freeGuard() }), since };
	}

	test("is told by the lookups a sync makes anyway, with no request more", async () => {
		const drive = await filled({ "a.md": "A" });
		const id = drive.idOf("Sync Evo/Vault") as string;
		drive.now = MADE;
		const callsOf = async (remote: GDriveBackend): Promise<string[]> => {
			drive.calls.length = 0;
			await listing(remote);
			return [...drive.calls];
		};
		// By the name: the folder of Sync Evo is looked up.
		const byName = told(drive, null);
		expect(await callsOf(byName.remote)).toEqual(await callsOf(backend(drive)));
		expect(byName.since).toEqual([Date.parse("2027-01-10T00:00:00Z")]);
		// By the id kept: the folders of the same name are looked for, with it.
		const byId = told(drive, id);
		expect(await callsOf(byId.remote)).toEqual(await callsOf(backend(drive, id)));
		expect(byId.since).toEqual([Date.parse("2027-01-10T00:00:00Z")]);
	});

	test("is told of the folder the first upload makes", async () => {
		const drive = new FakeDrive();
		drive.now = MADE;
		const { remote, since } = told(drive, null);
		const started = await remote.start({ path: "a.md", content: new TextEncoder().encode("A") });
		expect(started.status).toBe("started");
		expect(since).toContain(MADE);
	});

	test("is asked of the folder by its id, for a sync that does not know it: also of one renamed on the web", async () => {
		const drive = await filled({ "a.md": "A" });
		const id = drive.idOf("Sync Evo/Vault") as string;
		drive.rename("Sync Evo", "Renamed");
		const remote = new GDriveBackend(drive, { folder: "Vault", folderId: id, plan: freeGuard() });
		drive.calls.length = 0;
		expect(await remote.topCreatedAt()).toBe(Date.parse("2027-01-10T00:00:00Z"));
		expect(drive.calls).toEqual(["GET file", "GET files", "GET file"]);
		// The listing that follows looks up nothing again.
		drive.calls.length = 0;
		await listing(remote);
		expect(drive.calls).toEqual(["GET startPageToken", "GET files"]);
	});

	test("is not asked of a folder by its id without a folder kept", async () => {
		const drive = await filled({ "a.md": "A" });
		drive.calls.length = 0;
		expect(await new GDriveBackend(drive, { folder: "Vault", folderId: null, plan: freeGuard() }).topCreatedAt()).toBeNull();
		expect(drive.calls).toEqual([]);
	});

	test("is not told while there is no folder of Sync Evo, nor of two of them", async () => {
		const none = told(new FakeDrive(), null);
		await listing(none.remote);
		expect(none.since).toEqual([]);
		const two = new FakeDrive();
		two.makeFolder("", "Sync Evo");
		two.makeFolder("", "Sync Evo");
		const both = told(two, null);
		await expect(both.remote.list(null)).rejects.toBeInstanceOf(DriveDuplicateFolderError);
		expect(both.since).toEqual([]);
	});
});

describe("pushing to Google Drive", () => {
	test("a file over its id, a new one in a new folder, and a deletion to the trash", async () => {
		const drive = await filled({ "a.md": "A", "b.md": "B" });
		const remote = backend(drive);
		const listed = await listing(remote);
		const [a, b] = listed.entries;
		const bId = b?.id as string;
		const pushed = await remote.push({
			baseRevision: listed.revision,
			writes: [file("a.md", "A2", a), file("new/deep/c.md", "C")],
			deletes: [b as NonNullable<typeof b>],
		});
		expect(pushed.status).toBe("pushed");
		expect(drive.tree("Sync Evo/Vault")).toEqual({ "a.md": "A2", "new/deep/c.md": "C" });
		expect(drive.idOf("Sync Evo/Vault/a.md")).toBe(a?.id);
		expect(drive.isTrashed(bId)).toBe(true);
		if (pushed.status !== "pushed") return;
		expect(pushed.written.map((entry) => entry.path)).toEqual(["a.md", "new/deep/c.md"]);
		expect(pushed.listing?.entries.map((entry) => entry.path)).toEqual(["a.md", "new/deep/c.md"]);
	});

	test("files in one new folder at once make the folder once", async () => {
		const drive = await filled({ "a.md": "A" });
		const remote = backend(drive);
		const listed = await listing(remote);
		await remote.push({
			baseRevision: listed.revision,
			writes: [file("f/1.md", "1"), file("f/2.md", "2"), file("f/3.md", "3")],
			deletes: [],
		});
		expect(drive.calls.filter((call) => call === "POST folder")).toHaveLength(1);
		expect(Object.keys(drive.tree("Sync Evo/Vault")).sort()).toEqual(["a.md", "f/1.md", "f/2.md", "f/3.md"]);
	});

	test("a folder another device made since is written into, not made again", async () => {
		const drive = await filled({ "a.md": "A" });
		const remote = backend(drive);
		const listed = await listing(remote);
		drive.makeFolder("Sync Evo/Vault", "f");
		await remote.push({ baseRevision: listed.revision, writes: [file("f/1.md", "1")], deletes: [] });
		expect(drive.calls.filter((call) => call === "POST folder")).toHaveLength(0);
		expect(drive.tree("Sync Evo/Vault")).toEqual({ "a.md": "A", "f/1.md": "1" });
	});

	test("the same content as listed is not sent", async () => {
		const drive = await filled({ "a.md": "A" });
		const remote = backend(drive);
		const listed = await listing(remote);
		drive.calls.length = 0;
		const pushed = await remote.push({ baseRevision: listed.revision, writes: [file("a.md", "A", listed.entries[0])], deletes: [] });
		// Written as the version that is there, as with Dropbox.
		expect(pushed.status === "pushed" && pushed.written).toEqual([listed.entries[0]]);
		expect(drive.calls).not.toContain("PATCH upload");
	});

	test("a file Drive has no room for is left out as such, and the rest is sent", async () => {
		const drive = await filled({ "a.md": "A" });
		const remote = backend(drive);
		const listed = await listing(remote);
		drive.beforeCall = (call) => {
			if (call === "POST upload") {
				drive.beforeCall = undefined;
				throw new DriveApiError("upload", 403, "storageQuotaExceeded", "");
			}
		};
		const refusals: PushRefusal[] = [];
		const pushed = await remote.push({
			baseRevision: listed.revision,
			writes: [file("big.md", "B", undefined, refusals), file("a.md", "A2", listed.entries[0])],
			deletes: [],
		});
		expect(refusals).toEqual(["no-space"]);
		expect(pushed.status).toBe("pushed");
		expect(drive.text("Sync Evo/Vault/a.md")).toBe("A2");
	});

	test("a file trashed on Drive since the listing is not trashed again, and counts as deleted", async () => {
		const drive = await filled({ "a.md": "A", "b.md": "B" });
		const remote = backend(drive);
		const listed = await listing(remote);
		drive.trash("Sync Evo/Vault/a.md");
		drive.calls.length = 0;
		const pushed = await remote.push({ baseRevision: listed.revision, writes: [], deletes: [listed.entries[0] as NonNullable<(typeof listed.entries)[0]>] });
		expect(pushed.status).toBe("pushed");
		expect(drive.calls).not.toContain("PATCH trash");
	});

	test("an untracking whose .gitignore Drive would not take deletes nothing", async () => {
		const drive = await filled({ ".gitignore": "x", "a.md": "A" });
		const remote = backend(drive);
		const listed = await listing(remote);
		const [gitignore, a] = listed.entries;
		await drive.put("Sync Evo/Vault/.gitignore", "changed elsewhere");
		const pushed = await remote.push({
			baseRevision: listed.revision,
			writes: [file(".gitignore", "x\na.md\n", gitignore)],
			deletes: [a as NonNullable<typeof a>],
			untrack: true,
		});
		expect(pushed.status).toBe("stale");
		expect(drive.text("Sync Evo/Vault/a.md")).toBe("A");
	});

	test("without a revision, or one of another folder, nothing is sent", async () => {
		const drive = await filled({ "a.md": "A" });
		const remote = backend(drive);
		expect(await remote.push({ baseRevision: null, writes: [file("b.md", "B")], deletes: [] })).toEqual({ status: "stale" });
		const other = encodeRevision({ token: "0", root: "elsewhere", folders: new Map() });
		expect(await remote.push({ baseRevision: other, writes: [file("b.md", "B")], deletes: [] })).toEqual({ status: "stale" });
	});

	test("an upload whose answer has no hash asks for the file once more, and the push lists nothing again for its new folder", async () => {
		const drive = await filled({ "a.md": "A" });
		const remote = backend(drive);
		const listed = await listing(remote);
		drive.hashOnlyAlone = true;
		drive.calls.length = 0;
		const pushed = await remote.push({ baseRevision: listed.revision, writes: [file("new/b.md", "B")], deletes: [] });
		expect(pushed.status === "pushed" && pushed.written[0]?.hash).toBe(await remote.hashContent(new TextEncoder().encode("B")));
		expect(pushed.status === "pushed" && pushed.listing?.entries.map((entry) => entry.path)).toEqual(["a.md", "new/b.md"]);
		// A listing of everything begins with a new page token.
		expect(drive.calls).not.toContain("GET startPageToken");
	});

	test("a folder made at the same moment by another device is the one kept, and the one made here goes to the trash", async () => {
		const drive = new FakeDrive();
		const found: string[] = [];
		let folders = 0;
		let theirs = "";
		drive.beforeCall = (call) => {
			// Right before this device makes the folder of the vault.
			if (call === "POST folder" && ++folders === 2) {
				drive.beforeCall = undefined;
				theirs = drive.makeFolder("Sync Evo", "Vault");
			}
		};
		const started = await backend(drive, null, found).start({ path: ".gitignore", content: new Uint8Array() });
		expect(started).toEqual({ status: "stale" });
		expect(found).toEqual([theirs]);
		expect(drive.calls).toContain("PATCH trash");
		// One folder of the name is left, and nothing was written into either.
		expect((await listing(backend(drive))).entries).toEqual([]);
		expect(drive.idOf("Sync Evo/Vault")).toBe(theirs);
	});

	test("the first file makes the folder of Sync Evo and of the vault, and tells the id", async () => {
		const drive = new FakeDrive();
		const found: string[] = [];
		const remote = backend(drive, null, found);
		const started = await remote.start({ path: ".gitignore", content: new TextEncoder().encode("") });
		expect(started.status).toBe("started");
		expect(found).toEqual([drive.idOf("Sync Evo/Vault")]);
		expect(drive.tree("Sync Evo/Vault")).toEqual({ ".gitignore": "" });
		// Another device that had not seen it finds it, and makes nothing.
		const late: string[] = [];
		expect(await backend(drive, null, late).start({ path: ".gitignore", content: new Uint8Array() })).toEqual({ status: "stale" });
		expect(late).toEqual(found);
		expect(drive.calls.filter((call) => call === "POST folder")).toHaveLength(2);
	});
});
