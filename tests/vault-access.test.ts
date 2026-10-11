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
import { runPull } from "../src/core/pull";
import type { PullDeps, PullResult } from "../src/core/pull-io";
import { readBaseRevision } from "../src/core/state";
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

	function harness(caseSensitive: boolean) {
		const ports = new FakeVaultPorts({ caseSensitive });
		const backend = new MemoryBackend();
		const store = new MemoryStateStore();
		let time = Date.UTC(2026, 9, 3, 12, 0, 0);
		const pull = (over: Partial<PullDeps> = {}): Promise<PullResult> => {
			time += 60_000;
			return runPull({
				store,
				backend,
				vault: new RoutedVault(ports),
				paths,
				pluginId: "sync-evo",
				deviceName: "iPhone",
				now: () => time,
				confirm: async () => "proceed",
				...over,
			});
		};
		return { ports, backend, store, pull };
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
		expect(result.conflicts[0]?.copyPath).toMatch(/^_conflicts\/\d{8} d \(.+\)\.md$/);
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
