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
import { mergedCopyPath } from "../src/core/conflict-name";
import { runPull } from "../src/core/pull";
import type { PullDeps, PullResult } from "../src/core/pull-io";
import { readBaseRevision } from "../src/core/state";
import { runSync, type SyncResult } from "../src/core/sync";
import { RoutedVault } from "../src/core/vault-access";
import { FakeVaultPorts } from "./support/fake-vault-ports";
import { MemoryBackend } from "./support/memory-backend";
import { MemoryStateStore } from "./support/memory-state-store";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const NFC = "が.md".normalize("NFC");
const NFD = "が.md".normalize("NFD");

function setup(caseSensitive: boolean): { ports: FakeVaultPorts; vault: RoutedVault<string> } {
	const ports = new FakeVaultPorts({ caseSensitive });
	return { ports, vault: new RoutedVault(ports) };
}

const mac = (): ReturnType<typeof setup> => setup(false);
const iphone = (): ReturnType<typeof setup> => setup(true);

/** A disk that does not tell the cases apart, with renames that refuse a change of case alone. */
function android(): ReturnType<typeof setup> {
	const ports = new FakeVaultPorts({ caseSensitive: false, refusesCaseRename: true });
	return { ports, vault: new RoutedVault(ports) };
}

const REFUSED = "Destination file already exists!";

async function failure(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
		return "resolved";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

describe("list", () => {
	test("the root is asked for as /, and listed from the root", async () => {
		const { ports, vault } = mac();
		ports.put("a.md", "a");
		ports.put("notes/b.md", "b");
		ports.put(".hidden.md", "h");
		const listed = await vault.list("/");
		expect([...listed.files].sort()).toEqual([".hidden.md", "a.md"]);
		expect([...listed.folders].sort()).toEqual([".obsidian", "notes"]);
		expect((await vault.list("notes")).files).toEqual(["notes/b.md"]);
	});

	test.each(["/", "./"])("a root put in front of the paths (%s) is dropped", async (prefix) => {
		const { ports, vault } = mac();
		ports.listPrefix = prefix;
		ports.put("notes/b.md", "b");
		expect([...(await vault.list("/")).folders].sort()).toEqual([".obsidian", "notes"]);
		expect((await vault.list("notes")).files).toEqual(["notes/b.md"]);
	});

	test("a platform that only takes the empty spelling of the root is asked again", async () => {
		const { ports, vault } = mac();
		ports.rootSpellings = [""];
		ports.put("a.md", "a");
		expect((await vault.list("/")).files).toEqual(["a.md"]);
	});

	test("a platform that refuses / as the root is asked again with the empty spelling", async () => {
		const { ports, vault } = mac();
		ports.put("a.md", "a");
		const list = ports.list.bind(ports);
		ports.list = async (folder) => {
			if (folder === "/") throw new Error("EINVAL: /");
			return list(folder);
		};
		expect((await vault.list("/")).files).toEqual(["a.md"]);
	});

	test("a root that cannot be listed under either spelling fails with what the first said", async () => {
		const { ports, vault } = mac();
		ports.list = async (folder) => {
			throw new Error(`EACCES: "${folder}"`);
		};
		expect(await failure(vault.list("/"))).toBe('EACCES: "/"');
	});

	test("a root refused as / and wrong as the empty spelling fails with what the first said", async () => {
		const { ports, vault } = mac();
		ports.list = async (folder) => {
			if (folder === "/") throw new Error("EINVAL: /");
			return { files: [], folders: [] };
		};
		expect(await failure(vault.list("/"))).toBe("EINVAL: /");
	});

	test("a root listing without the configuration folder is not believed", async () => {
		const { ports, vault } = mac();
		ports.rootSpellings = [];
		ports.put("a.md", "a");
		expect(await failure(vault.list("/"))).toContain("configuration folder");
	});

	test("the configuration folder is whatever the app calls it", async () => {
		const { ports, vault } = mac();
		ports.configDir = ".config";
		expect(await failure(vault.list("/"))).toContain("configuration folder");
		ports.putFolder(".config");
		expect((await vault.list("/")).folders).toContain(".config");
	});

	test("a folder that is not there fails", async () => {
		expect(await failure(mac().vault.list("nowhere"))).toContain("ENOTDIR");
	});
});

describe("stat and read", () => {
	test("ask the disk, also for a path the index does not hold", async () => {
		const { ports, vault } = mac();
		ports.put(".github/a.yml", "abc");
		expect(await vault.stat(".github/a.yml")).toMatchObject({ type: "file", size: 3 });
		expect(await vault.stat(".github")).toMatchObject({ type: "folder" });
		expect(await vault.stat("nothing.md")).toBeNull();
		expect(new TextDecoder().decode(await vault.read(".github/a.yml"))).toBe("abc");
	});
});

describe("write", () => {
	test("a new file is created through the index, with the folders on the way", async () => {
		const { ports, vault } = mac();
		await vault.write("notes/sub/a.md", bytes("new"));
		expect(ports.calls).toEqual(["createFolder notes", "createFolder notes/sub", "create notes/sub/a.md"]);
		expect(ports.text("notes/sub/a.md")).toBe("new");
	});

	test("a file of the index is modified", async () => {
		const { ports, vault } = mac();
		ports.put("notes/a.md", "old");
		await vault.write("notes/a.md", bytes("new"));
		expect(ports.calls).toEqual(["modify notes/a.md"]);
		expect(ports.text("notes/a.md")).toBe("new");
	});

	test("the folders with a . name that were there are looked for once in a sync, and again after a rename", async () => {
		const { ports, vault } = mac();
		await vault.write(".obsidian/plugins/x/a.js", bytes("a"));
		// Another vault of the same disk: the folders are there, and not known to it.
		const again = new RoutedVault(ports);
		const list = ports.list.bind(ports);
		const stat = ports.stat.bind(ports);
		let looks = 0;
		ports.list = (folder) => {
			looks += 1;
			return list(folder);
		};
		ports.stat = (path) => {
			looks += 1;
			return stat(path);
		};

		await again.write(".obsidian/plugins/x/b.js", bytes("b"));
		const first = looks;
		looks = 0;
		await again.write(".obsidian/plugins/x/c.js", bytes("c"));
		const second = looks;
		looks = 0;
		await again.rename(".obsidian/plugins/x/c.js", ".obsidian/plugins/x/d.js");
		const renamed = looks;

		expect(first).toBeGreaterThan(3);
		// The stat of the file itself only.
		expect(second).toBeLessThanOrEqual(2);
		// A rename forgets them, and finds them again for where it goes.
		expect(renamed).toBeGreaterThan(first);
		expect(ports.text(".obsidian/plugins/x/c.js")).toBeUndefined();
		expect(ports.text(".obsidian/plugins/x/d.js")).toBe("c");
	});

	test("a folder with a . name that was trashed or removed in the sync is made again for the next write", async () => {
		for (const removal of ["trash", "remove"] as const) {
			const { ports, vault } = iphone();
			await vault.write(".obsidian/plugins/x/a.js", bytes("a"));
			await vault.trash(".obsidian/plugins/x/a.js", "vault-trash");
			// Forgotten by the trash itself: the folder may go with what is
			// trashed, here by another hand.
			if (removal === "trash") await ports.rmdir(".obsidian/plugins/x");
			else expect(await vault.removeFolderIfEmpty(".obsidian/plugins/x")).toBe(true);
			ports.calls.length = 0;

			await vault.write(".obsidian/plugins/x/b.js", bytes("b"));

			expect(ports.calls).toEqual(["mkdir .obsidian/plugins/x", "writeBinary .obsidian/plugins/x/b.js"]);
			expect(ports.text(".obsidian/plugins/x/b.js")).toBe("b");
		}
	});

	test("a path with a . name goes to the disk, with its folders", async () => {
		const { ports, vault } = mac();
		await vault.write(".github/workflows/a.yml", bytes("new"));
		expect(ports.calls).toEqual(["mkdir .github", "mkdir .github/workflows", "writeBinary .github/workflows/a.yml"]);
		await vault.write(".github/workflows/a.yml", bytes("newer"));
		expect(ports.calls[ports.calls.length - 1]).toBe("writeBinary .github/workflows/a.yml");
		expect(ports.text(".github/workflows/a.yml")).toBe("newer");
	});

	test("the folders above a . name are made through the index, the ones from it on through the disk", async () => {
		const { ports, vault } = mac();
		await vault.write("notes/.x/a.md", bytes("new"));
		expect(ports.calls).toEqual(["createFolder notes", "mkdir notes/.x", "writeBinary notes/.x/a.md"]);
	});

	test("a file named with a . is written to the disk", async () => {
		const { ports, vault } = mac();
		await vault.write("notes/.hidden.md", bytes("new"));
		expect(ports.calls).toEqual(["createFolder notes", "writeBinary notes/.hidden.md"]);
	});

	test("where the cases are not told apart, a file under another spelling is modified, not created", async () => {
		const { ports, vault } = mac();
		ports.put("Notes/A.md", "old");
		await vault.write("notes/a.md", bytes("new"));
		expect(ports.calls).toEqual(["modify Notes/A.md"]);
		expect(ports.paths()).toEqual(["Notes/A.md"]);
		expect(ports.text("Notes/A.md")).toBe("new");
	});

	test("where the cases are not told apart, a new file goes into the folder as the disk spells it", async () => {
		const { ports, vault } = mac();
		ports.put("Notes/x.md", "x");
		await vault.write("notes/a.md", bytes("new"));
		expect(ports.calls).toEqual(["create Notes/a.md"]);
		expect(ports.indexedPaths()).toContain("Notes/a.md");
	});

	test("where the cases are told apart, a write never reaches the file of the other case", async () => {
		const { ports, vault } = iphone();
		ports.put("Notes.md", "theirs");
		await vault.write("notes.md", bytes("new"));
		expect(ports.calls).toEqual(["create notes.md"]);
		expect(ports.text("Notes.md")).toBe("theirs");
		expect(ports.text("notes.md")).toBe("new");

		await vault.write("Notes.md", bytes("newer"));
		expect(ports.calls[ports.calls.length - 1]).toBe("modify Notes.md");
		expect(ports.text("notes.md")).toBe("new");
	});

	test("where the cases are told apart, folders of both cases are kept apart", async () => {
		const { ports, vault } = iphone();
		ports.put("Notes/x.md", "x");
		await vault.write("notes/a.md", bytes("new"));
		expect(ports.calls).toEqual(["createFolder notes", "create notes/a.md"]);
		expect(ports.paths()).toEqual(["Notes/x.md", "notes/a.md"]);
	});

	test("a name in the other Unicode form is the file the index has in NFC", async () => {
		const { ports, vault } = mac();
		ports.put(NFC, "old");
		await vault.write(NFD, bytes("new"));
		expect(ports.calls).toEqual([`modify ${NFC}`]);
		expect(ports.paths()).toEqual([NFC]);
	});

	test("a file on disk that the index has not seen is written on the disk", async () => {
		const { ports, vault } = mac();
		ports.indexFollows = false;
		ports.put("a.md", "old");
		// The index is behind: it does not hold the file yet.
		(ports as unknown as { index: Map<string, string> }).index.clear();
		await vault.write("a.md", bytes("new"));
		expect(ports.calls).toEqual(["writeBinary a.md"]);
		expect(ports.text("a.md")).toBe("new");
	});

	test("a folder at the path fails the write", async () => {
		const { ports, vault } = mac();
		ports.put("a/b.md", "b");
		ports.put(".x/b.md", "b");
		expect(await failure(vault.write("a", bytes("new")))).toBe("a folder is at a");
		expect(await failure(vault.write("A", bytes("new")))).toBe("a folder is at A");
		expect(await failure(vault.write(".x", bytes("new")))).toBe("a folder is at .x");
		expect(ports.calls).toEqual([]);
	});

	test("a file where a folder is needed fails the write", async () => {
		const { ports, vault } = mac();
		ports.put("a", "file");
		expect(await failure(vault.write("a/b.md", bytes("new")))).toBe("a file is at a");
	});

	test("the bytes written are those of the view, not of the buffer behind it", async () => {
		const { ports, vault } = mac();
		const whole = bytes("xxnewxx");
		await vault.write("a.md", whole.subarray(2, 5));
		expect(ports.text("a.md")).toBe("new");
	});
});

describe("rename", () => {
	test("a file of the index is renamed through the index", async () => {
		const { ports, vault } = mac();
		ports.put("notes/a.md", "a");
		await vault.rename("notes/a.md", "notes/a.conflict-from-Mac-20261003-221500.md");
		expect(ports.calls).toEqual(["renameIndexed notes/a.md -> notes/a.conflict-from-Mac-20261003-221500.md"]);
	});

	test("a path with a . name is renamed on the disk", async () => {
		const { ports, vault } = mac();
		ports.put(".github/a.yml", "a");
		await vault.rename(".github/a.yml", ".github/b.yml");
		expect(ports.calls).toEqual(["renameOnDisk .github/a.yml -> .github/b.yml"]);
		expect(ports.paths()).toEqual([".github/b.yml"]);
	});

	test("the folders on the way to the new name are made", async () => {
		const { ports, vault } = mac();
		ports.put("a.md", "a");
		await vault.rename("a.md", "new/sub/a.md");
		expect(ports.calls).toEqual(["createFolder new", "createFolder new/sub", "renameIndexed a.md -> new/sub/a.md"]);
	});

	describe("where the cases are not told apart", () => {
		test("a change of case alone goes through, in one call", async () => {
			const { ports, vault } = mac();
			ports.put("notes.md", "a");
			await vault.rename("notes.md", "Notes.md");
			expect(ports.calls).toEqual(["renameIndexed notes.md -> Notes.md"]);
			expect(ports.paths()).toEqual(["Notes.md"]);
			expect(ports.text("Notes.md")).toBe("a");
		});

		test("so does that of a folder, with what is in it", async () => {
			const { ports, vault } = mac();
			ports.put("notes/a.md", "a");
			ports.put("notes/sub/b.md", "b");
			await vault.rename("notes", "Notes");
			expect(ports.calls).toEqual(["renameIndexed notes -> Notes"]);
			expect(ports.paths()).toEqual(["Notes/a.md", "Notes/sub/b.md"]);
		});

		test("and that of a path with a . name", async () => {
			const { ports, vault } = mac();
			ports.put(".github/a.yml", "a");
			await vault.rename(".github", ".GitHub");
			expect(ports.calls).toEqual(["renameOnDisk .github -> .GitHub"]);
			expect(ports.paths()).toEqual([".GitHub/a.yml"]);
		});

		test("a file whose folder alone differs in case is where it should be already", async () => {
			const { ports, vault } = mac();
			ports.put("notes/a.md", "a");
			await vault.rename("notes/a.md", "Notes/a.md");
			expect(ports.calls).toEqual([]);
			expect(ports.paths()).toEqual(["notes/a.md"]);
		});

		test("another file at the new name fails the rename, and nothing is replaced", async () => {
			const { ports, vault } = mac();
			ports.put("a.md", "mine");
			ports.put("b.md", "other");
			expect(await failure(vault.rename("a.md", "B.md"))).toBe("something is at B.md");
			expect(ports.calls).toEqual([]);
			expect(ports.text("a.md")).toBe("mine");
			expect(ports.text("b.md")).toBe("other");
		});

		test("the old spelling of a file that was renamed already still finds it, and nothing is done", async () => {
			const { ports, vault } = mac();
			ports.put("Notes.md", "a");
			await vault.rename("notes.md", "Notes.md");
			expect(ports.calls).toEqual([]);
		});
	});

	describe("where the cases are told apart", () => {
		test("a change of case is a rename like any other", async () => {
			const { ports, vault } = iphone();
			ports.put("notes.md", "a");
			await vault.rename("notes.md", "Notes.md");
			expect(ports.calls).toEqual(["renameIndexed notes.md -> Notes.md"]);
			expect(ports.paths()).toEqual(["Notes.md"]);
		});

		test("a file of the other case at the new name fails the rename, and nothing is replaced", async () => {
			const { ports, vault } = iphone();
			ports.put("notes.md", "mine");
			ports.put("Notes.md", "other");
			expect(await failure(vault.rename("notes.md", "Notes.md"))).toBe("something is at Notes.md");
			expect(ports.calls).toEqual([]);
			expect(ports.text("notes.md")).toBe("mine");
			expect(ports.text("Notes.md")).toBe("other");
		});

		test("so does a folder of the other case", async () => {
			const { ports, vault } = iphone();
			ports.put("notes/a.md", "mine");
			ports.put("Notes/x.md", "other");
			expect(await failure(vault.rename("notes", "Notes"))).toBe("something is at Notes");
			expect(ports.paths()).toEqual(["Notes/x.md", "notes/a.md"]);
		});

		test("so does a path with a . name, where the disk would replace without a word", async () => {
			const { ports, vault } = iphone();
			ports.put(".x/a.md", "mine");
			ports.put(".x/A.md", "other");
			expect(await failure(vault.rename(".x/a.md", ".x/A.md"))).toBe("something is at .x/A.md");
			expect(ports.text(".x/A.md")).toBe("other");
		});

		test("a file moves from the folder of one case to the folder of the other", async () => {
			const { ports, vault } = iphone();
			ports.put("notes/a.md", "a");
			ports.put("Notes/x.md", "x");
			await vault.rename("notes/a.md", "Notes/a.md");
			expect(ports.calls).toEqual(["renameIndexed notes/a.md -> Notes/a.md"]);
			expect(ports.paths()).toEqual(["Notes/a.md", "Notes/x.md"]);
		});

		test("the old spelling of a file that was renamed already finds nothing", async () => {
			const { ports, vault } = iphone();
			ports.put("Notes.md", "a");
			expect(await failure(vault.rename("notes.md", "Notes.md"))).toBe("nothing at notes.md");
			expect(ports.calls).toEqual([]);
		});
	});

	describe("where a change of case alone is refused", () => {
		test("a file is renamed in two calls, through a name of its own", async () => {
			const { ports, vault } = android();
			ports.put("notes.md", "a");
			await vault.rename("notes.md", "Notes.md");
			expect(ports.calls).toEqual([
				"renameIndexed notes.md -> Notes.md",
				"renameIndexed notes.md -> Notes.md.sync-evo-renaming",
				"renameIndexed Notes.md.sync-evo-renaming -> Notes.md",
			]);
			expect(ports.paths()).toEqual(["Notes.md"]);
			expect(ports.text("Notes.md")).toBe("a");
		});

		test("so is a folder, with what is in it", async () => {
			const { ports, vault } = android();
			ports.put("notes/a.md", "a");
			ports.put("notes/sub/b.md", "b");
			await vault.rename("notes", "Notes");
			expect(ports.calls).toEqual([
				"renameIndexed notes -> Notes",
				"renameIndexed notes -> Notes.sync-evo-renaming",
				"renameIndexed Notes.sync-evo-renaming -> Notes",
			]);
			expect(ports.paths()).toEqual(["Notes/a.md", "Notes/sub/b.md"]);
			expect(ports.folderPaths()).toEqual([".obsidian", "Notes", "Notes/sub"]);
		});

		test("and a path with a . name, on the disk all the way", async () => {
			const { ports, vault } = android();
			ports.put(".github/a.yml", "a");
			await vault.rename(".github", ".GitHub");
			expect(ports.calls).toEqual([
				"renameOnDisk .github -> .GitHub",
				"renameOnDisk .github -> .GitHub.sync-evo-renaming",
				"renameOnDisk .GitHub.sync-evo-renaming -> .GitHub",
			]);
			expect(ports.paths()).toEqual([".GitHub/a.yml"]);
		});

		test("a file in a folder of its own, the folder spelled as the disk has it", async () => {
			const { ports, vault } = android();
			ports.put("Notes/a.md", "a");
			await vault.rename("notes/a.md", "notes/A.md");
			expect(ports.calls).toEqual([
				"renameIndexed Notes/a.md -> Notes/A.md",
				"renameIndexed Notes/a.md -> Notes/A.md.sync-evo-renaming",
				"renameIndexed Notes/A.md.sync-evo-renaming -> Notes/A.md",
			]);
			expect(ports.paths()).toEqual(["Notes/A.md"]);
		});

		test("a rename that is no change of case is not tried again", async () => {
			const { ports, vault } = android();
			ports.put("a.md", "a");
			ports.before = (call) => {
				if (call === "renameIndexed") throw new Error("EBUSY");
			};
			expect(await failure(vault.rename("a.md", "b.md"))).toBe("EBUSY");
			expect(ports.calls).toEqual([]);
			expect(ports.paths()).toEqual(["a.md"]);
		});

		test("nor one onto another file that differs in case alone", async () => {
			const { ports, vault } = android();
			ports.put("a.md", "mine");
			ports.put("b.md", "other");
			expect(await failure(vault.rename("a.md", "B.md"))).toBe("something is at B.md");
			expect(ports.calls).toEqual([]);
		});

		test("a change of case that fails for another reason fails, and nothing is moved", async () => {
			const { ports, vault } = android();
			ports.put("notes.md", "a");
			ports.before = (call) => {
				if (call === "renameIndexed") throw new Error("EBUSY");
			};
			expect(await failure(vault.rename("notes.md", "Notes.md"))).toBe("EBUSY");
			expect(ports.calls).toEqual([]);
			expect(ports.paths()).toEqual(["notes.md"]);
		});

		test("when the second call fails, the file is given its old name back", async () => {
			const { ports, vault } = android();
			ports.put("notes.md", "a");
			ports.before = (call, path) => {
				if (path === "Notes.md.sync-evo-renaming -> Notes.md") throw new Error("EBUSY");
			};
			expect(await failure(vault.rename("notes.md", "Notes.md"))).toBe(REFUSED);
			expect(ports.calls).toEqual([
				"renameIndexed notes.md -> Notes.md",
				"renameIndexed notes.md -> Notes.md.sync-evo-renaming",
				"renameIndexed Notes.md.sync-evo-renaming -> notes.md",
			]);
			expect(ports.paths()).toEqual(["notes.md"]);
			expect(ports.text("notes.md")).toBe("a");
		});

		test("when that fails too, the file is left at the name between, for the next pull", async () => {
			const { ports, vault } = android();
			ports.put("notes.md", "a");
			ports.before = (call, path) => {
				if (path.startsWith("Notes.md.sync-evo-renaming ->")) throw new Error("EBUSY");
			};
			expect(await failure(vault.rename("notes.md", "Notes.md"))).toBe(REFUSED);
			expect(ports.paths()).toEqual(["Notes.md.sync-evo-renaming"]);
		});

		test("a name between that is there already is not replaced", async () => {
			const { ports, vault } = android();
			ports.put("notes.md", "a");
			ports.put("Notes.md.sync-evo-renaming", "left");
			expect(await failure(vault.rename("notes.md", "Notes.md"))).toBe(REFUSED);
			expect(ports.calls).toEqual(["renameIndexed notes.md -> Notes.md"]);
			expect(ports.text("notes.md")).toBe("a");
			expect(ports.text("Notes.md.sync-evo-renaming")).toBe("left");
		});
	});

	test("where a change of case goes through in one call, a refusal is not tried again", async () => {
		const { ports, vault } = iphone();
		ports.put("a.md", "a");
		ports.before = (call) => {
			if (call === "renameIndexed") throw new Error(REFUSED);
		};
		expect(await failure(vault.rename("a.md", "A.md"))).toBe(REFUSED);
		expect(ports.calls).toEqual([]);
	});

	test("nothing at the old name fails the rename", async () => {
		expect(await failure(mac().vault.rename("a.md", "b.md"))).toBe("nothing at a.md");
	});

	test("a rename the app refuses is a failure of the rename", async () => {
		const { ports, vault } = mac();
		ports.put("a.md", "a");
		ports.before = (call) => {
			if (call === "renameIndexed") throw new Error("Destination file already exists!");
		};
		expect(await failure(vault.rename("a.md", "b.md"))).toBe("Destination file already exists!");
		expect(ports.paths()).toEqual(["a.md"]);
	});
});

describe("trash", () => {
	test("an ordinary deletion of a file of the index is left to the app's setting", async () => {
		const { ports, vault } = mac();
		ports.trashSetting = "system";
		ports.put("a.md", "a");
		await vault.trash("a.md", "user-setting");
		expect(ports.calls).toEqual(["trashBySetting a.md"]);
		expect(ports.trashed).toEqual([{ path: "a.md", where: "system" }]);
	});

	test.each([
		["system", ["trashSystem .github/a.yml"], "system"],
		["local", ["trashLocal .github/a.yml"], "vault"],
		["none", ["remove .github/a.yml"], "gone"],
		[undefined, ["trashLocal .github/a.yml"], "vault"],
		["something new", ["trashLocal .github/a.yml"], "vault"],
	] as const)("an ordinary deletion of a . path with the setting %j", async (setting, calls, where) => {
		const { ports, vault } = mac();
		ports.trashSetting = setting;
		ports.put(".github/a.yml", "a");
		await vault.trash(".github/a.yml", "user-setting");
		expect(ports.calls).toEqual(calls);
		expect(ports.trashed).toEqual([{ path: ".github/a.yml", where }]);
	});

	test("without a system trash, a . path goes to .trash/", async () => {
		const { ports, vault } = mac();
		ports.trashSetting = "system";
		ports.hasSystemTrash = false;
		ports.put(".github/a.yml", "a");
		await vault.trash(".github/a.yml", "user-setting");
		expect(ports.calls).toEqual(["trashSystem .github/a.yml", "trashLocal .github/a.yml"]);
		expect(ports.trashed).toEqual([{ path: ".github/a.yml", where: "vault" }]);
	});

	test("a file moved away to protect it goes to .trash/, whatever the setting", async () => {
		for (const setting of ["system", "none", undefined]) {
			const { ports, vault } = mac();
			ports.trashSetting = setting;
			ports.put("a.md", "a");
			ports.put(".x/b.md", "b");
			await vault.trash("a.md", "vault-trash");
			await vault.trash(".x/b.md", "vault-trash");
			expect(ports.calls).toEqual(["trashToVault a.md", "trashLocal .x/b.md"]);
			expect(ports.trashed.map((item) => item.where)).toEqual(["vault", "vault"]);
		}
	});

	test("where the cases are not told apart, a file under another spelling is found in the index", async () => {
		const { ports, vault } = mac();
		ports.put("Notes/A.md", "a");
		await vault.trash("notes/a.md", "user-setting");
		expect(ports.calls).toEqual(["trashBySetting Notes/A.md"]);
	});

	test("where the cases are told apart, the file of the other case is not taken", async () => {
		const { ports, vault } = iphone();
		ports.put("Notes.md", "other");
		expect(await failure(vault.trash("notes.md", "user-setting"))).toBe("nothing at notes.md");
		expect(ports.text("Notes.md")).toBe("other");
	});

	test("a file the index has not seen is taken through the disk, by the setting", async () => {
		const { ports, vault } = mac();
		ports.trashSetting = "none";
		ports.indexFollows = false;
		ports.put("a.md", "a");
		(ports as unknown as { index: Map<string, string> }).index.clear();
		await vault.trash("a.md", "user-setting");
		expect(ports.calls).toEqual(["remove a.md"]);
	});

	test("nothing at the path fails", async () => {
		expect(await failure(mac().vault.trash(".x/a.md", "user-setting"))).toBe("nothing at .x/a.md");
		expect(await failure(mac().vault.trash("a.md", "vault-trash"))).toBe("nothing at a.md");
	});
});

describe("removeFolderIfEmpty", () => {
	test("an empty folder is removed", async () => {
		const { ports, vault } = mac();
		ports.putFolder("notes/sub");
		expect(await vault.removeFolderIfEmpty("notes/sub")).toBe(true);
		expect(ports.calls).toEqual(["rmdir notes/sub"]);
		expect(ports.folderPaths()).toEqual([".obsidian", "notes"]);
	});

	test("a folder with a file in it stays, also when the file is one the index does not hold", async () => {
		const { ports, vault } = mac();
		ports.put("notes/.hidden", "h");
		expect(await vault.removeFolderIfEmpty("notes")).toBe(false);
		expect(ports.calls).toEqual([]);
	});

	test("a folder with only a folder in it stays", async () => {
		const { ports, vault } = mac();
		ports.putFolder("notes/sub");
		expect(await vault.removeFolderIfEmpty("notes")).toBe(false);
	});

	test("no folder at the path is the answer yes", async () => {
		expect(await mac().vault.removeFolderIfEmpty("notes")).toBe(true);
	});

	test("a file at the path fails", async () => {
		const { ports, vault } = mac();
		ports.put("notes", "file");
		expect(await failure(vault.removeFolderIfEmpty("notes"))).toBe("a file is at notes");
	});

	test("a file that appears before the removal keeps the folder", async () => {
		const { ports, vault } = mac();
		ports.putFolder("notes");
		ports.before = (call) => {
			if (call !== "rmdir") return;
			ports.before = undefined;
			ports.put("notes/just-made.md", "typed");
		};
		expect(await vault.removeFolderIfEmpty("notes")).toBe(false);
		expect(ports.text("notes/just-made.md")).toBe("typed");
	});

	test("a removal that fails for another reason is thrown", async () => {
		const { ports, vault } = mac();
		ports.putFolder("notes");
		ports.before = (call) => {
			if (call === "rmdir") throw new Error("EPERM");
		};
		expect(await failure(vault.removeFolderIfEmpty("notes"))).toBe("EPERM");
	});
});

describe("saveOpenEditors", () => {
	const editor = (path: string, log: string[], fails = false) => ({
		path,
		save: async (): Promise<void> => {
			log.push(path);
			if (fails) throw new Error("could not save");
		},
	});

	test("no editor has the file open", async () => {
		const { ports, vault } = mac();
		const log: string[] = [];
		ports.editors = [editor("b.md", log)];
		expect(await vault.saveOpenEditors("a.md")).toBe("not-open");
		expect(log).toEqual([]);
	});

	test("every editor that has it open is saved", async () => {
		const { ports, vault } = mac();
		const log: string[] = [];
		ports.editors = [editor("notes/a.md", log), editor("b.md", log), editor("notes/a.md", log)];
		expect(await vault.saveOpenEditors("notes/a.md")).toBe("saved");
		expect(log).toEqual(["notes/a.md", "notes/a.md"]);
	});

	test("one that cannot save fails it, after the others were saved", async () => {
		const { ports, vault } = mac();
		const log: string[] = [];
		ports.editors = [editor("a.md", log, true), editor("a.md", log)];
		expect(await vault.saveOpenEditors("a.md")).toBe("failed");
		expect(log).toHaveLength(2);
	});

	test("an editor that has the file open under another spelling is saved too", async () => {
		const { ports, vault } = mac();
		const log: string[] = [];
		ports.editors = [editor("Notes/A.md", log), editor(NFC, log)];
		expect(await vault.saveOpenEditors("notes/a.md")).toBe("saved");
		expect(await vault.saveOpenEditors(NFD)).toBe("saved");
		expect(log).toEqual(["Notes/A.md", NFC]);
	});
});

// The pull itself, through the routing and the fake of the app: what the
// tests of the pull see with a vault in memory has to hold here too.
describe("a pull through the routing", () => {
	const paths = { configDir: ".obsidian", pluginDir: ".obsidian/plugins/sync-evo" };

	function harness(caseSensitive: boolean, refusesCaseRename = false) {
		const ports = new FakeVaultPorts({ caseSensitive, refusesCaseRename });
		const backend = new MemoryBackend();
		const store = new MemoryStateStore();
		let time = Date.UTC(2026, 9, 3, 12, 0, 0);
		const pullDeps = (): PullDeps => ({
			store,
			backend,
			vault: new RoutedVault(ports),
			paths,
			pluginId: "sync-evo",
			deviceName: "iPhone",
			now: () => time,
			confirm: async () => "proceed",
		});
		const pull = (over: Partial<PullDeps> = {}): Promise<PullResult> => {
			time += 60_000;
			return runPull({ ...pullDeps(), ...over });
		};
		const sync = (): Promise<SyncResult> => {
			time += 60_000;
			const pulling = pullDeps();
			return runSync({
				pull: pulling,
				push: {
					store,
					backend,
					vault: pulling.vault,
					paths,
					deviceName: "Android",
					now: () => time,
					addSection: false,
					confirm: async () => "proceed",
					askEmptyVault: async () => "delete",
				},
			});
		};
		return { ports, backend, store, pull, sync };
	}

	test.each([false, true])("a first fetch writes every file through the right way (case-sensitive: %s)", async (cs) => {
		const { ports, backend, store, pull } = harness(cs);
		backend.commit({
			"a.md": "a",
			"notes/b.md": "b",
			".github/workflows/c.yml": "c",
			"notes/.x/d.md": "d",
			".gitignore": "*.tmp\n",
		});
		const result = await pull();
		expect(result.outcome).toBe("completed");
		expect(result.counts.fetched).toBe(5);
		expect(ports.paths()).toEqual([".github/workflows/c.yml", ".gitignore", "a.md", "notes/.x/d.md", "notes/b.md"]);
		expect(ports.calls.filter((call) => call.startsWith("create "))).toEqual(["create a.md", "create notes/b.md"]);
		expect(await readBaseRevision(store)).toBe(backend.revision);

		// Nothing to do the second time.
		ports.calls.length = 0;
		expect((await pull()).counts).toEqual({ fetched: 0, deleted: 0, renamed: 0, conflicts: 0 });
		expect(ports.calls).toEqual([]);
	});

	test.each([false, true])("changes, deletions, and a conflict (case-sensitive: %s)", async (cs) => {
		const { ports, backend, pull } = harness(cs);
		ports.trashSetting = "system";
		backend.commit({ "a.md": "a1", "notes/b.md": "b1", ".x/c.md": "c1", "d.md": "d1" });
		await pull();

		ports.put("d.md", "mine");
		backend.commit({ "a.md": "a2", "notes/b.md": null, ".x/c.md": null, "d.md": "d2" });
		ports.calls.length = 0;
		const result = await pull();
		expect(result.outcome).toBe("completed");
		expect(result.counts).toEqual({ fetched: 2, deleted: 2, renamed: 0, conflicts: 1 });
		expect(ports.text("a.md")).toBe("a2");
		expect(ports.text("d.md")).toBe("d2");
		expect(ports.text(result.conflicts[0]?.copyPath ?? "")).toBe("mine");
		expect(ports.trashed).toEqual([
			{ path: ".x/c.md", where: "system" },
			{ path: "notes/b.md", where: "system" },
		]);
		expect(ports.calls).toContain("trashBySetting notes/b.md");
		expect(ports.calls).toContain("trashSystem .x/c.md");
		// The folders the deletions emptied are gone, and the copy has made its own, through the index.
		expect(result.conflicts[0]?.copyPath).toMatch(/^_conflicts\/\d{4}-\d{2}-\d{2} d \(.+\)\.md$/);
		expect(ports.folderPaths()).toEqual([".obsidian", "_conflicts"]);
		expect(ports.calls).toContain("createFolder _conflicts");
	});

	test.each(["system", "none", "local"])(
		"a conflict inside the configuration folder: to .trash/ of the vault, with the setting %j",
		async (setting) => {
			const { ports, backend, pull } = harness(false);
			ports.trashSetting = setting;
			backend.commit({ ".obsidian/app.json": "{}", "a.md": "a1" });
			await pull();

			ports.put(".obsidian/app.json", '{"mine":1}');
			backend.commit({ ".obsidian/app.json": '{"theirs":1}' });
			ports.calls.length = 0;
			const result = await pull();

			expect(result.outcome).toBe("completed");
			expect(result.replacedSettings).toEqual([".obsidian/app.json"]);
			expect(result.conflicts).toEqual([]);
			expect(ports.text(".obsidian/app.json")).toBe('{"theirs":1}');
			expect(ports.trashed).toEqual([{ path: ".obsidian/app.json", where: "vault" }]);
			expect(ports.calls).toContain("trashLocal .obsidian/app.json");
			expect(ports.paths()).toEqual([".obsidian/app.json", "a.md"]);
		},
	);

	test.each(["system", "none", "local"])(
		"a conflict that is merged: the content from before is written into its folder in .trash/ of the vault, with the setting %j",
		async (setting) => {
			const { ports, backend, pull } = harness(false);
			ports.trashSetting = setting;
			backend.commit({ "notes/a.md": "one\ntwo\nthree\n" });
			await pull();

			ports.put("notes/a.md", "one, here\ntwo\nthree\n");
			backend.commit({ "notes/a.md": "one\ntwo\nthree, there\n" });
			ports.calls.length = 0;
			const result = await pull({ mergeConflicts: true });

			expect(result.outcome).toBe("completed");
			// Two pulls, a minute each, from the start of the harness's clock.
			const kept = mergedCopyPath("notes/a.md", new Date(Date.UTC(2026, 9, 3, 12, 2, 0)));
			expect(kept).toMatch(/^\.trash\/\.sync-evo-merged\/2026-10-0[34] a\.md$/);
			expect(result.merged).toEqual([{ path: "notes/a.md", keptAt: kept }]);
			expect(ports.text("notes/a.md")).toBe("one, here\ntwo\nthree, there\n");
			expect(ports.text(kept)).toBe("one, here\ntwo\nthree\n");
			// Written there, on the disk: nothing is moved away, so the note
			// is never missing, and the setting for deleted files plays no part.
			expect(ports.trashed).toEqual([]);
			expect(ports.calls.filter((call) => /^(writeBinary|modify|create|mkdir) /.test(call))).toEqual([
				"mkdir .trash",
				"mkdir .trash/.sync-evo-merged",
				`writeBinary ${kept}`,
				"modify notes/a.md",
			]);

			// What is in the `.trash/` is not taken for a file of the vault.
			ports.calls.length = 0;
			const again = await pull({ mergeConflicts: true });
			expect(again).toMatchObject({ outcome: "completed", merged: [], conflicts: [] });
			expect(ports.text("notes/a.md")).toBe("one, here\ntwo\nthree, there\n");
		},
	);

	test("a folder renamed in case on the remote is renamed here, in one call, where the cases are not told apart", async () => {
		const { ports, backend, pull } = harness(false);
		backend.commit({ "notes/a.md": "a", "notes/b.md": "b" });
		await pull();
		backend.commit({ "notes/a.md": null, "notes/b.md": null, "Notes/a.md": "a", "Notes/b.md": "b" });
		ports.calls.length = 0;
		const result = await pull();
		expect(result.outcome).toBe("completed");
		expect(result.unwritable).toEqual([]);
		expect(ports.paths()).toEqual(["Notes/a.md", "Notes/b.md"]);
		expect(ports.calls).toEqual(["renameIndexed notes -> Notes"]);
		expect(ports.trashed).toEqual([]);
	});

	test("the same where the cases are told apart", async () => {
		const { ports, backend, pull } = harness(true);
		backend.commit({ "notes/a.md": "a", "notes/b.md": "b" });
		await pull();
		backend.commit({ "notes/a.md": null, "notes/b.md": null, "Notes/a.md": "a", "Notes/b.md": "b" });
		const result = await pull();
		expect(result.outcome).toBe("completed");
		expect(result.unwritable).toEqual([]);
		expect(ports.paths()).toEqual(["Notes/a.md", "Notes/b.md"]);
		expect(ports.trashed).toEqual([]);
	});

	describe("where a change of case alone is refused", () => {
		const remoteFiles = async (backend: MemoryBackend): Promise<string[]> => {
			const listed = await backend.list(null);
			if (!listed.changed) throw new Error("expected a listing");
			return listed.listing.entries.map((entry) => entry.path).sort();
		};

		test("a folder renamed in case on the remote is renamed here, in two calls", async () => {
			const { ports, backend, pull } = harness(false, true);
			backend.commit({ "notes/a.md": "a", "notes/b.md": "b" });
			await pull();
			backend.commit({ "notes/a.md": null, "notes/b.md": null, "Notes/a.md": "a", "Notes/b.md": "b" });
			ports.calls.length = 0;
			const result = await pull();
			expect(result.outcome).toBe("completed");
			expect(result.unwritable).toEqual([]);
			expect(ports.paths()).toEqual(["Notes/a.md", "Notes/b.md"]);
			expect(ports.calls).toEqual([
				"renameIndexed notes -> Notes",
				"renameIndexed notes -> Notes.sync-evo-renaming",
				"renameIndexed Notes.sync-evo-renaming -> Notes",
			]);
			expect(ports.trashed).toEqual([]);

			ports.calls.length = 0;
			expect((await pull()).counts).toEqual({ fetched: 0, deleted: 0, renamed: 0, conflicts: 0 });
			expect(ports.calls).toEqual([]);
		});

		test("so is a file", async () => {
			const { ports, backend, pull } = harness(false, true);
			backend.commit({ "notes.md": "a" });
			await pull();
			backend.commit({ "notes.md": null, "Notes.md": "a2" });
			const result = await pull();
			expect(result.outcome).toBe("completed");
			expect(result.unwritable).toEqual([]);
			expect(result.conflicts).toEqual([]);
			expect(ports.paths()).toEqual(["Notes.md"]);
			expect(ports.text("Notes.md")).toBe("a2");
		});

		test("a file of the vault is given the spelling of the remote's, in two calls", async () => {
			const { ports, backend, pull } = harness(false, true);
			backend.commit({ "a.md": "a" });
			await pull();
			ports.put("todo.md", "same");
			backend.commit({ "TODO.md": "same" });
			ports.calls.length = 0;
			const result = await pull();
			expect(result.outcome).toBe("completed");
			expect(result.unwritable).toEqual([]);
			expect(result.conflicts).toEqual([]);
			expect(ports.paths()).toEqual(["TODO.md", "a.md"]);
			expect(ports.calls).toEqual([
				"renameIndexed todo.md -> TODO.md",
				"renameIndexed todo.md -> TODO.md.sync-evo-renaming",
				"renameIndexed TODO.md.sync-evo-renaming -> TODO.md",
			]);
		});

		test.each([
			["a folder", "notes", "Notes"],
			["a file", "notes.md", "Notes.md"],
		])("%s left at the name between is given its name back by the next pull, which goes on with the rename", async (_, from, to) => {
			const { ports, backend, pull } = harness(false, true);
			const files: Record<string, string> = from === "notes" ? { "notes/a.md": "a", "notes/b.md": "b" } : { "notes.md": "a" };
			backend.commit(files);
			await pull();
			const renamed = Object.fromEntries(Object.entries(files).map(([path, text]) => [to + path.slice(from.length), text]));
			backend.commit({ ...Object.fromEntries(Object.keys(files).map((path) => [path, null])), ...renamed });
			// The pull stopped between the two calls.
			await ports.renameOnDisk(from, `${to}.sync-evo-renaming`);
			ports.calls.length = 0;

			const result = await pull();
			expect(result.outcome).toBe("completed");
			expect(result.unwritable).toEqual([]);
			expect(result.conflicts).toEqual([]);
			expect(result.notices).toEqual([]);
			expect(ports.calls).toEqual([`renameIndexed ${to}.sync-evo-renaming -> ${to}`]);
			expect(ports.paths()).toEqual(Object.keys(renamed).sort());
			expect(ports.trashed).toEqual([]);

			ports.calls.length = 0;
			expect((await pull()).counts).toEqual({ fetched: 0, deleted: 0, renamed: 0, conflicts: 0 });
			expect(ports.calls).toEqual([]);
		});

		test("a name between whose name is taken stays, is told once, and is not sent", async () => {
			const { ports, backend, sync } = harness(false, true);
			backend.commit({ "a.md": "a" });
			await sync();
			ports.put("Tools.sync-evo-renaming/x.md", "x");
			ports.put("tools/y.md", "y");
			ports.calls.length = 0;

			const first = await sync();
			expect(first.pull.outcome).toBe("completed");
			expect(first.pull.notices).toEqual([{ kind: "renaming-left", path: "Tools.sync-evo-renaming" }]);
			expect(ports.paths()).toEqual(["Tools.sync-evo-renaming/x.md", "a.md", "tools/y.md"]);
			expect(await remoteFiles(backend)).toEqual(["a.md", "tools/y.md"]);

			// Tried again, and not told again.
			const second = await sync();
			expect(second.pull.notices).toEqual([]);
			expect(ports.paths()).toEqual(["Tools.sync-evo-renaming/x.md", "a.md", "tools/y.md"]);

			// Given back once the name is free, and sent as the folder it is.
			await ports.renameOnDisk("tools", "other");
			await sync();
			expect(ports.paths()).toEqual(["Tools/x.md", "a.md", "other/y.md"]);
			expect(await remoteFiles(backend)).toEqual(["Tools/x.md", "a.md", "other/y.md"]);
		});

		test("so is a file left at the name between, and it is not sent", async () => {
			const { ports, backend, sync } = harness(false, true);
			backend.commit({ "a.md": "a" });
			await sync();
			ports.put("Notes.md.sync-evo-renaming", "n");
			ports.put("notes.md", "other");
			await sync();
			expect(await remoteFiles(backend)).toEqual(["a.md", "notes.md"]);
		});
	});

	test("a file renamed in case onto a name another file has, where the cases are told apart", async () => {
		const { ports, backend, pull } = harness(true);
		backend.commit({ "notes.md": "remote" });
		await pull();
		ports.put("Notes.md", "made here");
		backend.commit({ "notes.md": null, "Notes.md": "remote" });
		const result = await pull();
		expect(result.outcome).toBe("completed");
		expect(ports.text("Notes.md")).toBe("remote");
		expect(result.conflicts).toHaveLength(1);
		expect(ports.text(result.conflicts[0]?.copyPath ?? "")).toBe("made here");
		expect(ports.text("notes.md")).toBeUndefined();
	});
});

describe("links of the vault", () => {
	/** The vault of a desktop where these paths are links. `asked` notes every path asked about. */
	function linked(links: readonly string[], caseSensitive = false) {
		const ports = new FakeVaultPorts({ caseSensitive });
		const asked: string[] = [];
		const isLink = async (path: string): Promise<boolean> => {
			asked.push(path);
			return links.some((link) => link.toLowerCase() === path.toLowerCase());
		};
		return { ports, asked, vault: new RoutedVault(Object.assign(ports, { isLink })) };
	}

	test("nothing is written, renamed, or deleted at a link or below one", async () => {
		const { ports, vault } = linked(["Ext", "note.md"]);
		ports.put("Ext/x.md", "outside");
		ports.put("note.md", "outside");
		ports.put("a.md", "a");

		expect(await failure(vault.write("Ext/x.md", bytes("new")))).toBe("a link of the vault is at Ext");
		expect(await failure(vault.write("ext/sub/y.md", bytes("new")))).toBe("a link of the vault is at ext");
		expect(await failure(vault.write("note.md", bytes("new")))).toBe("a link of the vault is at note.md");
		expect(await failure(vault.trash("Ext/x.md", "user-setting"))).toBe("a link of the vault is at Ext");
		expect(await failure(vault.trash("note.md", "user-setting"))).toBe("a link of the vault is at note.md");
		expect(await failure(vault.rename("a.md", "Ext/a.md"))).toBe("a link of the vault is at Ext");
		expect(await failure(vault.rename("Ext/x.md", "x.md"))).toBe("a link of the vault is at Ext");
		expect(await failure(vault.removeFolderIfEmpty("Ext"))).toBe("a link of the vault is at Ext");

		expect(ports.calls).toEqual([]);
		expect(ports.text("Ext/x.md")).toBe("outside");
		expect(ports.text("note.md")).toBe("outside");
	});

	test("each folder on the way is asked once, and the path itself each time", async () => {
		const { asked, vault } = linked([]);
		await vault.write("notes/sub/a.md", bytes("a"));
		await vault.write("notes/sub/b.md", bytes("b"));
		await vault.trash("notes/sub/a.md", "user-setting");
		expect(asked).toEqual(["notes", "notes/sub", "notes/sub/a.md", "notes/sub/b.md", "notes/sub/a.md"]);
	});

	test("where links cannot be told, nothing is asked and everything is written", async () => {
		const { ports, vault } = mac();
		await vault.write("Ext/x.md", bytes("new"));
		expect(ports.text("Ext/x.md")).toBe("new");
	});

	test("a pull that was not told of a link the vault has refuses to write there, and says so", async () => {
		const ports = new FakeVaultPorts({ caseSensitive: false });
		const backend = new MemoryBackend();
		const store = new MemoryStateStore();
		const links = new Set<string>();
		Object.assign(ports, { isLink: async (path: string) => links.has(path) });
		let time = Date.UTC(2026, 9, 3, 12, 0, 0);
		const pull = (): Promise<PullResult> => {
			time += 60_000;
			return runPull({
				store,
				backend,
				vault: new RoutedVault(ports),
				paths: { configDir: ".obsidian", pluginDir: ".obsidian/plugins/sync-evo" },
				pluginId: "sync-evo",
				deviceName: "iPhone",
				now: () => time,
				confirm: async () => "proceed",
			});
		};
		backend.commit({ "a.md": "a", "note.md": "n" });
		await pull();
		// A file the scan does not tell from a link, as an index can hold one.
		links.add("note.md");
		backend.commit({ "note.md": "n2" });
		ports.calls.length = 0;

		const result = await pull();

		expect(result.outcome).toBe("completed");
		expect(ports.text("note.md")).toBe("n");
		expect(ports.calls).toEqual([]);
		expect(result.unwritable).toMatchObject([{ path: "note.md", reason: "write-failed" }]);
	});

	test("a folder whose links cannot be read fails as its listing does", async () => {
		const ports = new FakeVaultPorts({ caseSensitive: false });
		const linksIn = async (folder: string): Promise<readonly string[]> => {
			throw new Error(`EACCES: permission denied, scandir '/Users/me/vault/${folder}'`);
		};
		const vault = new RoutedVault(Object.assign(ports, { linksIn }));
		ports.putFolder("notes");
		// Listed again, and the listing goes through: the first failure is passed on.
		expect(await failure(vault.linksIn?.("notes") ?? Promise.resolve())).toBe(
			"EACCES: permission denied, scandir '/Users/me/vault/notes'",
		);
		// The listing fails too: its failure is the one told.
		expect(await failure(vault.linksIn?.("gone") ?? Promise.resolve())).toBe("ENOTDIR: gone");
	});
});
