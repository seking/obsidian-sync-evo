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
import { createExclusion, type Exclusion } from "../src/core/exclusion";
import { planSync } from "../src/core/plan";
import { scanVault, type ScanResult, placeholderTarget } from "../src/core/scan";
import { blobHash } from "./support/memory-backend";
import { MemoryVault } from "./support/memory-vault";
import { earlierCopyPath } from "./support/earlier-copy-name";

const ownFolder = ".obsidian/plugins/sync-evo";

function rules(gitignore: string | null): Exclusion {
	return createExclusion({ configDir: ".obsidian", pluginDir: ownFolder, gitignore });
}

interface Options {
	gitignore?: string | null;
	/** Files the remote holds. */
	known?: readonly string[];
	/** Files that have a record and are not on the remote. */
	recorded?: readonly string[];
	/** Paths the records hold as symlinks. */
	symlinks?: readonly string[];
}

const anyHash = blobHash("content");

function scan(vault: MemoryVault, options: Options = {}): Promise<ScanResult> {
	return scanVault({
		lister: vault,
		exclusion: rules(options.gitignore ?? null),
		remote: (options.known ?? []).map((path) => ({ path, kind: "file", hash: anyHash })),
		records: [
			...(options.recorded ?? []).map((path) => ({ path, kind: "file" as const, hash: anyHash })),
			...(options.symlinks ?? []).map((path) => ({ path, kind: "symlink" as const, hash: anyHash })),
		],
	});
}

function found(result: ScanResult): string[] {
	return result.paths.map((entry) => entry.path).sort();
}

describe("what the scan finds", () => {
	test("every file of every folder, names that start with a dot included", async () => {
		const vault = new MemoryVault([
			"a.md",
			"notes/b.md",
			"notes/deep/er/c.md",
			".gitignore",
			".gitmodules",
			".github/workflows/ci.yml",
			"notes/.hidden.md",
			"notes/.x/d.md",
			".obsidian/app.json",
		]);
		const result = await scan(vault);
		expect(found(result)).toEqual([
			".github/workflows/ci.yml",
			".gitignore",
			".gitmodules",
			".obsidian/app.json",
			"a.md",
			"notes/.hidden.md",
			"notes/.x/d.md",
			"notes/b.md",
			"notes/deep/er/c.md",
		]);
		expect(result.rootHasGit).toBe(false);
	});

	test("each is present, under the path as it was returned and its NFC key", async () => {
		const nfc = "ガイド/が.md";
		const nfd = nfc.normalize("NFD");
		const result = await scan(new MemoryVault([nfd]));
		expect(result.paths).toEqual([{ path: nfd, key: nfc, state: "present" }]);
	});

	test("an empty vault has nothing, and only the root is listed", async () => {
		const vault = new MemoryVault([]);
		expect(await scan(vault)).toEqual({ paths: [], rootHasGit: false });
		expect(vault.listed).toEqual(["/"]);
	});

	test("a lister that names the root in what it returns gives the same paths", async () => {
		for (const prefix of ["/", "./"]) {
			const result = await scan(new MemoryVault(["a.md", "notes/b.md", ".git/HEAD"], prefix));
			expect(found(result)).toEqual(["a.md", "notes/b.md"]);
			expect(result.rootHasGit).toBe(true);
		}
	});

	test("a folder that cannot be listed fails the scan instead of looking empty", async () => {
		const vault = new MemoryVault(["a.md", "notes/b.md"]);
		const failing = {
			list: (folder: string) => (folder === "notes" ? Promise.reject(new Error("EIO")) : vault.list(folder)),
		};
		await expect(
			scanVault({ lister: failing, exclusion: rules(null), remote: [], records: [] }),
		).rejects.toThrow("EIO");
	});
});

describe("the two things that are never synced", () => {
	// Every line that could bring them back, and both known to the remote.
	const options: Options = {
		gitignore: "!.git/\n!/.obsidian/plugins/\n!/.obsidian/plugins/sync-evo/\n",
		known: [".git/HEAD", `${ownFolder}/main.js`, "sub/.git/config"],
	};

	test("a .git folder at the root is reported, and neither entered nor returned", async () => {
		const vault = new MemoryVault([".git/HEAD", ".git/objects/ab/cd", "a.md", ".gitignore", ".github/a.yml"]);
		const result = await scan(vault, options);
		expect(result.rootHasGit).toBe(true);
		expect(found(result)).toEqual([".github/a.yml", ".gitignore", "a.md"]);
		expect(vault.listed.filter((folder) => folder.startsWith(".git/") || folder === ".git")).toEqual([]);
	});

	test("a .git file at the root (a work tree whose repository is elsewhere) is reported too", async () => {
		const result = await scan(new MemoryVault([".git", "a.md"]), options);
		expect(result.rootHasGit).toBe(true);
		expect(found(result)).toEqual(["a.md"]);
	});

	test("a .git further down is left out but is not the root's", async () => {
		const vault = new MemoryVault(["sub/.git/config", "sub/a.md", "other/.git"]);
		const result = await scan(vault, options);
		expect(result.rootHasGit).toBe(false);
		expect(found(result)).toEqual(["sub/a.md"]);
		expect(vault.listed).not.toContain("sub/.git");
	});

	test("the plugin's own folder is neither entered nor returned, while its neighbours are", async () => {
		const vault = new MemoryVault([
			`${ownFolder}/main.js`,
			`${ownFolder}/manifest.json`,
			`${ownFolder}/sub/x.js`,
			".obsidian/plugins/dataview/main.js",
			".obsidian/app.json",
		]);
		const result = await scan(vault, options);
		expect(found(result)).toEqual([".obsidian/app.json", ".obsidian/plugins/dataview/main.js"]);
		expect(vault.listed).toContain(".obsidian/plugins");
		expect(vault.listed.filter((folder) => folder.startsWith(ownFolder))).toEqual([]);
	});

	test("in any case of the letters", async () => {
		const vault = new MemoryVault([".GIT/HEAD", ".obsidian/plugins/Sync-Evo/main.js", "a.md"]);
		const result = await scan(vault, options);
		expect(result.rootHasGit).toBe(true);
		expect(found(result)).toEqual(["a.md"]);
	});
});

describe("what the rules leave out", () => {
	test("a matched folder with nothing known below it is not entered", async () => {
		const vault = new MemoryVault([
			"drafts/a.md",
			"drafts/sub/b.md",
			".obsidian/plugins/dataview/main.js",
			".trash/old.md",
			"notes/c.md",
		]);
		const result = await scan(vault, { gitignore: "/drafts/\n" });
		expect(found(result)).toEqual(["notes/c.md"]);
		expect(vault.listed.sort()).toEqual([".obsidian", "/", "notes"]);
	});

	test("a matched folder with something known below it is entered, and only the known files are returned", async () => {
		const vault = new MemoryVault([
			"drafts/tracked.md",
			"drafts/new.md",
			"drafts/sub/deep.md",
			"drafts/other/new.md",
		]);
		const result = await scan(vault, {
			gitignore: "/drafts/\n",
			known: ["drafts/tracked.md", "drafts/sub/deep.md", "drafts/deleted-here.md"],
		});
		expect(found(result)).toEqual(["drafts/sub/deep.md", "drafts/tracked.md"]);
		expect(vault.listed).toContain("drafts/sub");
		expect(vault.listed).not.toContain("drafts/other");
	});

	test("a matched file is returned only when it is known", async () => {
		const vault = new MemoryVault(["a.png", "b.png", "notes/.DS_Store", ".obsidian/workspace.json", "c.md"]);
		const result = await scan(vault, { gitignore: "*.png\n", known: ["b.png", ".obsidian/workspace.json"] });
		expect(found(result)).toEqual([".obsidian/workspace.json", "b.png", "c.md"]);
	});

	test("a folder is known by a path below it, not by a name that only starts the same", async () => {
		const vault = new MemoryVault(["drafts/a.md"]);
		const result = await scan(vault, { gitignore: "/drafts/\n", known: ["drafts-old/a.md", "drafts.md"] });
		expect(found(result)).toEqual([]);
		expect(vault.listed).toEqual(["/"]);
	});

	test("known is asked without regard to case or normalization, so nothing synced is missed", async () => {
		const nfc = "ガイド";
		const vault = new MemoryVault(["Drafts/A.md", `${nfc.normalize("NFD")}/が.md`.normalize("NFD")]);
		const result = await scan(vault, {
			gitignore: `/drafts/\n/${nfc}/\n`,
			known: ["drafts/a.md", `${nfc}/が.md`],
		});
		expect(result.paths.map((entry) => entry.key).sort()).toEqual(["Drafts/A.md", `${nfc}/が.md`].sort());
	});

	test("a rule in NFC prunes a folder returned in NFD", async () => {
		const nfc = "ガイド";
		const vault = new MemoryVault([`${nfc.normalize("NFD")}/a.md`, "b.md"]);
		const result = await scan(vault, { gitignore: `/${nfc}/\n` });
		expect(found(result)).toEqual(["b.md"]);
		expect(vault.listed).toEqual(["/"]);
	});

	test("the root .gitignore is always returned, and one in a subfolder changes nothing", async () => {
		const vault = new MemoryVault([".gitignore", "notes/.gitignore", "notes/a.png"]);
		const result = await scan(vault, { gitignore: ".*\n" });
		expect(found(result)).toEqual([".gitignore", "notes/a.png"]);
		// `notes/.gitignore` is matched by `.*` of the root; the `*.png` it
		// would hold is never read.
	});
});

describe("a copy kept from a conflict, of the earlier form beside its file", () => {
	const at = new Date(2026, 9, 3, 22, 15, 0);
	const draft = earlierCopyPath("drafts/a.md", "iPhone", at);
	const image = earlierCopyPath("img.png", "iPhone", at);

	test("is returned when the file it is a copy of is known, though a rule matches it", async () => {
		const vault = new MemoryVault(["drafts/a.md", draft, "drafts/new.md", "img.png", image, "new.png"]);
		const result = await scan(vault, { gitignore: "/drafts/\n*.png\n", known: ["drafts/a.md", "img.png"] });
		expect(found(result)).toEqual(["drafts/a.md", draft, "img.png", image].sort());
	});

	test("is left out when the file it is a copy of only has a record: the remote deleted it", async () => {
		const vault = new MemoryVault(["img.png", image]);
		const result = await scan(vault, { gitignore: "*.png\n", recorded: ["img.png"] });
		expect(found(result)).toEqual(["img.png"]);
	});

	test("a file known only by its record is still found, and so is what lies in a folder known only by records", async () => {
		const vault = new MemoryVault(["drafts/a.md", "drafts/new.md", "b.png"]);
		const result = await scan(vault, { gitignore: "/drafts/\n*.png\n", recorded: ["drafts/a.md", "b.png"] });
		expect(found(result)).toEqual(["b.png", "drafts/a.md"]);
	});

	test("is left out when the file it is a copy of is not known", async () => {
		const vault = new MemoryVault([draft, image, "drafts/sub/x.md", "b.md"]);
		const result = await scan(vault, { gitignore: "/drafts/\n*.png\n", known: ["drafts/sub/x.md"] });
		expect(found(result)).toEqual(["b.md", "drafts/sub/x.md"]);
	});

	test("and the decision then sends it", async () => {
		const exclusion = rules("/drafts/\n*.png\n");
		const hash = blobHash("theirs");
		const remote = [
			{ path: "drafts/a.md", kind: "file" as const, hash },
			{ path: "img.png", kind: "file" as const, hash },
		];
		const scanned = await scanVault({
			lister: new MemoryVault(["drafts/a.md", draft, "img.png", image]),
			exclusion,
			remote,
			records: remote,
		});
		const local = scanned.paths.map(({ path }) => ({ path, hash: path.includes(".conflict-from-") ? blobHash("mine") : hash }));
		const plan = planSync({ remote, local, records: remote, exclusion });
		expect(plan.actions.map((action) => `${action.type} ${action.key}`)).toEqual([`upload ${draft}`, `upload ${image}`]);
		expect(plan.skipped).toEqual([]);
	});
});

describe("the folder of the conflict copies", () => {
	const copy = "_conflicts/20261011 a (iPhone).md";

	test("is entered though a rule matches it, and its copies are returned though none is known", async () => {
		const vault = new MemoryVault([copy, "_conflicts/20261011 img (Mac).png", "b.md"]);
		for (const gitignore of ["_conflicts/\n", "/_conflicts\n", "_*\n", "*.md\n*.png\n_conflicts/\n"]) {
			const result = await scan(vault, { gitignore });
			expect(found(result)).toEqual([
				copy,
				"_conflicts/20261011 img (Mac).png",
				...(gitignore.includes("*.md") ? [] : ["b.md"]),
			]);
		}
	});

	test("under a rule for the folder, a file that is not named like a copy and a folder below are left out as ever", async () => {
		const vault = new MemoryVault([
			copy,
			"_conflicts/notes.md",
			"_conflicts/kept.md",
			"_conflicts/sub/20261011 a (iPhone).md",
			"_conflicts/sub/deep/x.md",
		]);
		const result = await scan(vault, { gitignore: "_conflicts/\n", known: ["_conflicts/kept.md"] });
		expect(found(result)).toEqual([copy, "_conflicts/kept.md"]);
		expect(vault.listed).not.toContain("_conflicts/sub");
	});

	test("without a rule, everything in it is found like anywhere else", async () => {
		const vault = new MemoryVault([copy, "_conflicts/notes.md", "_conflicts/sub/x.md"]);
		expect(found(await scan(vault))).toEqual([copy, "_conflicts/notes.md", "_conflicts/sub/x.md"]);
	});

	test("a folder the vault spells otherwise is that folder", async () => {
		const vault = new MemoryVault(["_Conflicts/20261011 a (iPhone).md", "_Conflicts/notes.md"]);
		expect(found(await scan(vault, { gitignore: "_conflicts/\n" }))).toEqual(["_Conflicts/20261011 a (iPhone).md"]);
	});

	test("and the decision then sends the copy, whatever the rules say", async () => {
		const exclusion = rules("_conflicts/\n*.md\n");
		const scanned = await scanVault({ lister: new MemoryVault([copy]), exclusion, remote: [], records: [] });
		const local = scanned.paths.map(({ path }) => ({ path, hash: blobHash("mine") }));
		const plan = planSync({ remote: [], local, records: [], exclusion });
		expect(plan.actions.map((action) => `${action.type} ${action.key}`)).toEqual([`upload ${copy}`]);
		expect(plan.skipped).toEqual([]);
	});
});

describe("symlinks the records hold", () => {
	test("the scan does not go below one", async () => {
		const vault = new MemoryVault(["link/a.md", "link/sub/b.md", "linked/c.md", "notes/link/d.md"]);
		const result = await scan(vault, { symlinks: ["link"] });
		expect(found(result)).toEqual(["linked/c.md", "notes/link/d.md"]);
		expect(vault.listed.filter((folder) => folder === "link" || folder.startsWith("link/"))).toEqual([]);
	});

	test("at any depth, and in either normalization", async () => {
		const nfc = ".claude/が";
		const vault = new MemoryVault([`${nfc.normalize("NFD")}/SKILL.md`, ".claude/settings.json"]);
		const result = await scan(vault, { symlinks: [nfc] });
		expect(found(result)).toEqual([".claude/settings.json"]);
	});
});

describe("the scan and the decision together", () => {
	test("what the scan leaves out is what the decision would have turned away", async () => {
		const files = [
			"notes/a.md",
			"drafts/new.md",
			"drafts/tracked.md",
			".obsidian/workspace.json",
			".obsidian/app.json",
			".obsidian/plugins/dataview/main.js",
			`${ownFolder}/main.js`,
			".git/HEAD",
			".trash/old.md",
			"img/IMG_1.PNG",
		];
		const hash = blobHash("same");
		const remote = [
			{ path: "drafts/tracked.md", kind: "file" as const, hash },
			{ path: `${ownFolder}/main.js`, kind: "file" as const, hash: blobHash("another device") },
		];
		const exclusion = rules("/drafts/\n*.png\n");

		const scanned = await scanVault({ lister: new MemoryVault(files), exclusion, remote, records: [] });
		const local = (paths: readonly string[]) => paths.map((path) => ({ path, hash }));
		const afterScan = planSync({ remote, local: local(scanned.paths.map((entry) => entry.path)), records: [], exclusion });
		const withoutScan = planSync({ remote, local: local(files), records: [], exclusion });

		expect(afterScan.actions).toEqual(withoutScan.actions);
		expect(afterScan.actions.map((action) => `${action.type} ${action.key}`)).toEqual([
			"upload .obsidian/app.json",
			"update-record drafts/tracked.md",
			"upload notes/a.md",
		]);
		// The remote holds the plugin's folder: skipped, and the caller can tell.
		expect(afterScan.skipped.map((skip) => `${skip.reason} ${skip.key} ${skip.remote.length}`)).toEqual([
			`own-folder ${ownFolder}/main.js 1`,
		]);
		expect(scanned.rootHasGit).toBe(true);
	});
});

describe("the placeholder a cloud drive leaves for a file it took off the device", () => {
	test("stands for the file: listed under the name of the file, as a placeholder", async () => {
		const vault = new MemoryVault(["a.md", "notes/.big.md.icloud", ".root.pdf.icloud"]);
		const result = await scan(vault, { known: ["notes/big.md"] });
		expect(result.paths.slice().sort((a, b) => (a.path < b.path ? -1 : 1))).toEqual([
			{ path: "a.md", key: "a.md", state: "present" },
			{ path: "notes/big.md", key: "notes/big.md", state: "placeholder" },
			// Also one that was never synced: it is a file of the vault all the same.
			{ path: "root.pdf", key: "root.pdf", state: "placeholder" },
		]);
	});

	test("beside the file itself, the file is what is listed", async () => {
		const result = await scan(new MemoryVault(["notes/big.md", "notes/.big.md.icloud"]));
		expect(result.paths).toEqual([{ path: "notes/big.md", key: "notes/big.md", state: "present" }]);
	});

	test("not for a file a rule leaves out", async () => {
		const result = await scan(new MemoryVault(["drafts/.x.md.icloud", ".trash/.y.md.icloud"]), { gitignore: "/drafts/\n" });
		expect(result.paths).toEqual([]);
	});

	test("a name that only ends in .icloud, or only starts with a dot, is no placeholder", async () => {
		const names = ["notes/x.icloud", "notes/.hidden", "notes/.icloud", "notes/...icloud", "notes/.a.icloud.md"];
		expect(names.map(placeholderTarget)).toEqual([null, null, null, null, null]);
		expect(placeholderTarget("notes/.big.md.icloud")).toBe("notes/big.md");
		expect(placeholderTarget(".a.icloud")).toBe("a");

		const result = await scan(new MemoryVault(["notes/x.icloud", "notes/.hidden", "notes/.a.icloud.md"]), {
			known: ["notes/x.icloud"],
		});
		expect(result.paths.every((entry) => entry.state === "present")).toBe(true);
		expect(found(result)).toEqual(["notes/.a.icloud.md", "notes/.hidden", "notes/x.icloud"]);
	});
});
