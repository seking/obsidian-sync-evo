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

import * as fs from "node:fs";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { linkPorts } from "../src/obsidian/vault-links";

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
