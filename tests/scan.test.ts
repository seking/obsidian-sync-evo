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

import { describe, expect, test } from "vitest";
import { createExclusion, type Exclusion } from "../src/core/exclusion";
import { withSection } from "../src/core/gitignore-section";
import { planSync, type SyncRecord } from "../src/core/plan";
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
		expect(await scan(vault)).toEqual({ paths: [], rootHasGit: false, links: [] });
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
	test("a matched folder is not entered", async () => {
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

	test("a matched folder is not entered, though the remote holds files in it and records do", async () => {
		const vault = new MemoryVault(["drafts/tracked.md", "drafts/new.md", "drafts/sub/deep.md", "notes/a.md"]);
		const result = await scan(vault, {
			gitignore: "/drafts/\n",
			known: ["drafts/tracked.md", "drafts/sub/deep.md"],
			recorded: ["drafts/new.md"],
		});
		expect(found(result)).toEqual(["notes/a.md"]);
		expect(vault.listed.sort()).toEqual(["/", "notes"]);
	});

	test("a matched file is not returned, though it is known", async () => {
		const vault = new MemoryVault(["a.png", "b.png", "notes/.DS_Store", ".obsidian/workspace.json", "c.md"]);
		const result = await scan(vault, { gitignore: "*.png\n", known: ["b.png", ".obsidian/workspace.json"], recorded: ["a.png"] });
		expect(found(result)).toEqual(["c.md"]);
	});

	test("what this device alone leaves out is not entered or returned either", async () => {
		const vault = new MemoryVault(["Attachments/a.pdf", "notes/b.png", "notes/c.md", ".obsidian/icon.png"]);
		const result = await scanVault({
			lister: vault,
			exclusion: createExclusion({
				configDir: ".obsidian",
				pluginDir: ownFolder,
				gitignore: null,
				device: { kinds: ["image"], folders: ["Attachments"] },
			}),
			remote: [{ path: "notes/b.png", kind: "file", hash: anyHash }],
			records: [],
		});
		// A kind is not left out inside the configuration folder.
		expect(found(result)).toEqual([".obsidian/icon.png", "notes/c.md"]);
		expect(vault.listed).not.toContain("Attachments");
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

	test("is left out where a rule matches the file it is a copy of, whatever is known", async () => {
		const vault = new MemoryVault(["drafts/a.md", draft, "notes/a.md", "img.png", image, "new.png"]);
		const result = await scan(vault, {
			gitignore: "/drafts/\n*.png\n",
			known: ["drafts/a.md", "img.png", draft],
			recorded: [image],
		});
		expect(found(result)).toEqual(["notes/a.md"]);
	});

	test("is returned where no rule matches the file it is a copy of, known or not", async () => {
		const copy = earlierCopyPath("notes/a.md", "iPhone", at);
		const vault = new MemoryVault(["notes/a.md", copy]);
		expect(found(await scan(vault))).toEqual(["notes/a.md", copy].sort());
	});

	test("one of a file in the configuration folder is returned only when it is known itself", async () => {
		const config = earlierCopyPath(".obsidian/app.json", "iPhone", at);
		const vault = new MemoryVault([".obsidian/app.json", config]);
		expect(found(await scan(vault, { known: [".obsidian/app.json"] }))).toEqual([".obsidian/app.json"]);
		expect(found(await scan(vault, { recorded: [config] }))).toEqual([".obsidian/app.json", config].sort());
	});
});

describe("the folder of the conflict copies", () => {
	const copy = "_conflicts/2026-10-11 a (iPhone).md";

	test("is entered though a rule matches it, and its copies are returned though none is known", async () => {
		const vault = new MemoryVault([copy, "_conflicts/2026-10-11 img (Mac).png", "b.md"]);
		for (const gitignore of ["_conflicts/\n", "/_conflicts\n", "_*\n", "*.md\n*.png\n_conflicts/\n"]) {
			const result = await scan(vault, { gitignore });
			expect(found(result)).toEqual([
				copy,
				"_conflicts/2026-10-11 img (Mac).png",
				...(gitignore.includes("*.md") ? [] : ["b.md"]),
			]);
		}
	});

	test("under a rule for the folder, a file that is not named like a copy and a folder below are left out as ever", async () => {
		const vault = new MemoryVault([
			copy,
			"_conflicts/notes.md",
			"_conflicts/kept.md",
			"_conflicts/sub/2026-10-11 a (iPhone).md",
			"_conflicts/sub/deep/x.md",
		]);
		const result = await scan(vault, { gitignore: "_conflicts/\n", known: ["_conflicts/kept.md"] });
		expect(found(result)).toEqual([copy]);
		expect(vault.listed).not.toContain("_conflicts/sub");
	});

	test("without a rule, everything in it is found like anywhere else", async () => {
		const vault = new MemoryVault([copy, "_conflicts/notes.md", "_conflicts/sub/x.md"]);
		expect(found(await scan(vault))).toEqual([copy, "_conflicts/notes.md", "_conflicts/sub/x.md"]);
	});

	test("a folder the vault spells otherwise is that folder", async () => {
		const vault = new MemoryVault(["_Conflicts/2026-10-11 a (iPhone).md", "_Conflicts/notes.md"]);
		expect(found(await scan(vault, { gitignore: "_conflicts/\n" }))).toEqual(["_Conflicts/2026-10-11 a (iPhone).md"]);
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
			"upload notes/a.md",
		]);
		// The remote holds the plugin's folder: skipped, and the caller can
		// tell. What the remote holds below a folder a rule matches is
		// skipped as excluded, with or without the vault side.
		expect(afterScan.skipped.map((skip) => `${skip.reason} ${skip.key} ${skip.remote.length}`)).toEqual([
			`own-folder ${ownFolder}/main.js 1`,
			"excluded drafts/tracked.md 1",
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
			gitignore: withSection(null, []),
		});
		expect(result.paths.every((entry) => entry.state === "present")).toBe(true);
		expect(found(result)).toEqual(["notes/.a.icloud.md", "notes/.hidden", "notes/x.icloud"]);
	});
});

describe("links of the vault", () => {
	/** A vault on a desktop, where these paths are links. */
	class LinkedVault extends MemoryVault {
		constructor(
			files: readonly string[],
			private readonly linkPaths: readonly string[],
		) {
			super(files);
		}
		async linksIn(folder: string): Promise<readonly string[]> {
			const inside = folder === "/" ? "" : `${folder}/`;
			return this.linkPaths.filter((link) => link.startsWith(inside) && !link.slice(inside.length).includes("/"));
		}
	}

	test("a link to a folder is not gone into, a link to a file is not listed, and both are told", async () => {
		const vault = new LinkedVault(["a.md", "Ext/x.md", "notes/b.md", "notes/linked.md", "notes/Loop/notes/b.md"], ["Ext", "notes/linked.md", "notes/Loop"]);
		const result = await scan(vault);
		expect(found(result)).toEqual(["a.md", "notes/b.md"]);
		expect([...result.links].sort()).toEqual(["Ext", "notes/Loop", "notes/linked.md"]);
		expect(vault.listed).not.toContain("Ext");
		expect(vault.listed).not.toContain("notes/Loop");
	});

	test("a link whose target is gone, which the listing leaves out, is told all the same", async () => {
		const result = await scan(new LinkedVault(["a.md", "notes/b.md"], ["Gone", "notes/gone.md", "Hidden"]), {
			gitignore: "Hidden\n",
		});
		expect(found(result)).toEqual(["a.md", "notes/b.md"]);
		expect([...result.links].sort()).toEqual(["Gone", "notes/gone.md"]);
	});

	test("a link a rule excludes is not told", async () => {
		const result = await scan(new LinkedVault(["a.md", "Ext/x.md"], ["Ext"]), { gitignore: "Ext/\n" });
		expect(found(result)).toEqual(["a.md"]);
		expect(result.links).toEqual([]);
	});

	test("the plan leaves a link, and what is below it, alone on every side, whatever the case", () => {
		const hash = blobHash("x");
		const plan = planSync({
			remote: [
				{ path: "projects/p.md", kind: "file", hash: blobHash("remote") },
				{ path: "Projects/new.md", kind: "file", hash },
			],
			local: [{ path: "b.md", hash }],
			records: [{ path: "Projects/p.md", kind: "file", hash }],
			exclusion: rules(null),
			links: ["Projects"],
		});
		expect(plan.actions.map((action) => [action.type, action.key])).toEqual([["upload", "b.md"]]);
		expect(plan.skipped.map((skip) => [skip.key, skip.reason])).toEqual([
			["Projects/new.md", "local-link"],
			["Projects/p.md", "local-link"],
			["projects/p.md", "local-link"],
		]);
		// Cut off like an excluded path, the record as it was.
		expect(plan.marks).toEqual([
			{ key: "Projects/p.md", record: { path: "Projects/p.md", kind: "file", hash }, wasExcluded: true },
		]);
	});

	test("a record that has the mark already is left as it is", () => {
		const record: SyncRecord = { path: "Projects/p.md", kind: "file", hash: blobHash("x"), wasExcluded: true };
		const plan = planSync({ remote: [], local: [], records: [record], exclusion: rules(null), links: ["Projects"] });
		expect(plan.actions).toEqual([]);
		expect(plan.marks).toEqual([]);
	});
});
