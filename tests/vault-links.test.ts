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

import * as fs from "node:fs";
import { mkdtemp, mkdir, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createExclusion } from "../src/core/exclusion";
import { scanVault } from "../src/core/scan";
import { type FolderListing, RoutedVault } from "../src/core/vault-access";
import { linkPorts } from "../src/obsidian/vault-links";
import { FakeVaultPorts } from "./support/fake-vault-ports";

// On a real disk: a vault with a folder, a link to a folder outside it, a
// link to a file, a link to the vault itself, and a link whose target is
// gone. Symbolic links, which a test can make on a Mac and on Linux.
describe("the links of a vault on disk", () => {
	let root: string;
	let base: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "sync-evo-links-"));
		base = join(root, "vault");
		const outside = join(root, "outside");
		await mkdir(join(base, "notes"), { recursive: true });
		await mkdir(outside);
		await writeFile(join(outside, "a.md"), "outside");
		await writeFile(join(base, "a.md"), "a");
		await writeFile(join(base, "notes", "b.md"), "b");
		await symlink(outside, join(base, "Ext"), "dir");
		await symlink(join(outside, "a.md"), join(base, "notes", "linked.md"), "file");
		await symlink(base, join(base, "notes", "Loop"), "dir");
		await symlink(join(root, "nowhere"), join(base, "Gone"), "dir");
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test("the links right in a folder, the root given as / or as the empty path", async () => {
		const ports = linkPorts(fs, base);
		expect([...(await ports.linksIn("/"))].sort()).toEqual(["Ext", "Gone"]);
		expect([...(await ports.linksIn(""))].sort()).toEqual(["Ext", "Gone"]);
		expect([...(await ports.linksIn("notes"))].sort()).toEqual(["notes/Loop", "notes/linked.md"]);
	});

	test("whether a path is a link: to a folder, to a file, to nothing any more", async () => {
		const { isLink } = linkPorts(fs, base);
		expect(await isLink("Ext")).toBe(true);
		expect(await isLink("notes/linked.md")).toBe(true);
		expect(await isLink("notes/Loop")).toBe(true);
		expect(await isLink("Gone")).toBe(true);
		// What is reached through a link is no link itself.
		expect(await isLink("Ext/a.md")).toBe(false);
		expect(await isLink("notes")).toBe(false);
		expect(await isLink("a.md")).toBe(false);
		expect(await isLink("/")).toBe(false);
		expect(await isLink("")).toBe(false);
		// Nothing at the path is no link.
		expect(await isLink("missing.md")).toBe(false);
	});

	test("a folder that is not there fails, as its listing would", async () => {
		await expect(linkPorts(fs, base).linksIn("missing")).rejects.toThrow();
	});
});

// The listing of the app on a desktop (`FileSystemAdapter.list` of Obsidian
// 1.14): each name the folder holds is asked what it points to, so a link
// whose target is gone fails the whole listing; what comes back is spelled
// in NFC, with a space for a non-breaking one.
function appList(base: string): (folder: string) => Promise<FolderListing> {
	return async (folder) => {
		const from = folder === "/" ? "" : folder;
		const files: string[] = [];
		const folders: string[] = [];
		for (const name of await readdir(from === "" ? base : join(base, from))) {
			const path = from === "" ? name : `${from}/${name}`;
			const found = await stat(join(base, path));
			const spelled = path.replace(/\u00A0|\u202F/g, " ").normalize("NFC");
			if (found.isFile()) files.push(spelled);
			if (found.isDirectory()) folders.push(spelled);
		}
		return { files, folders };
	};
}

describe("a folder the app cannot list for a link whose target is gone", () => {
	let root: string;
	let base: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "sync-evo-listing-"));
		base = join(root, "vault");
		const outside = join(root, "outside");
		await mkdir(join(base, ".obsidian"), { recursive: true });
		await mkdir(join(base, "notes"));
		await mkdir(outside);
		await writeFile(join(outside, "x.md"), "outside");
		await writeFile(join(base, "a.md"), "a");
		// Spelled in NFD, and with a non-breaking space.
		await writeFile(join(base, "notes", "Cafe\u0301\u00A0b.md"), "b");
		await symlink(outside, join(base, "Ext"), "dir");
		await symlink(join(outside, "x.md"), join(base, "notes", "linked.md"), "file");
		await symlink(join(root, "nowhere"), join(base, "Gone"), "dir");
		await symlink(join(root, "nowhere.md"), join(base, "notes", "dang.md"), "file");
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	function vaultOf(): RoutedVault<string> {
		const ports = new FakeVaultPorts({ caseSensitive: false });
		return new RoutedVault(Object.assign(ports, { list: appList(base) }, linkPorts(fs, base)));
	}

	test("the app's listing fails, as on a Mac", async () => {
		await expect(appList(base)("/")).rejects.toThrow(/ENOENT/);
		await expect(appList(base)("notes")).rejects.toThrow(/ENOENT/);
	});

	test("it is listed from the disk as the app lists it, without the link whose target is gone", async () => {
		const sorted = (listing: FolderListing) => ({ files: [...listing.files].sort(), folders: [...listing.folders].sort() });
		const vault = vaultOf();
		expect(sorted(await vault.list("/"))).toEqual({ files: ["a.md"], folders: [".obsidian", "Ext", "notes"] });
		expect(sorted(await vault.list("notes"))).toEqual({ files: ["notes/Café b.md", "notes/linked.md"], folders: [] });
	});

	test("the scan goes through, and tells every link", async () => {
		const scan = await scanVault({
			lister: vaultOf(),
			exclusion: createExclusion({ configDir: ".obsidian", pluginDir: ".obsidian/plugins/sync-evo", gitignore: null }),
			remote: [],
			records: [],
		});
		expect(scan.paths.map((scanned) => scanned.path).sort()).toEqual(["a.md", "notes/Café b.md"]);
		expect([...scan.links].sort()).toEqual(["Ext", "Gone", "notes/dang.md", "notes/linked.md"]);
	});

	test("a folder that cannot be read from the disk either fails with what the app's listing said", async () => {
		const ports = new FakeVaultPorts({ caseSensitive: false });
		const list = async (folder: string): Promise<FolderListing> => {
			throw new Error(`the app cannot list ${folder}`);
		};
		const vault = new RoutedVault(Object.assign(ports, { list }, linkPorts(fs, base)));
		await expect(vault.list("missing")).rejects.toThrow("the app cannot list missing");
		// The disk can: it is listed from there.
		expect((await vault.list("notes")).files).toContain("notes/linked.md");
	});
});
