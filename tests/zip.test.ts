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

import { readFileSync } from "node:fs";
import { deflateSync, strToU8, zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { openZip, readZipDirectory, readZipEntry } from "../src/core/zip";
import { blobHash } from "./support/memory-backend";

const text = (content: Uint8Array): string => new TextDecoder().decode(content);

describe("reading a zip", () => {
	test("the directory lists every entry, and each is read on its own", () => {
		const zip = zipSync({
			"top/": new Uint8Array(),
			"top/a.md": strToU8("alpha"),
			"top/notes/b.md": [strToU8("stored as it is"), { level: 0 }],
			"top/empty.md": new Uint8Array(),
		});
		const entries = readZipDirectory(zip);
		expect(entries.map((entry) => `${entry.name} ${entry.method} ${entry.size}`)).toEqual([
			"top/ 8 0",
			"top/a.md 8 5",
			"top/notes/b.md 0 15",
			"top/empty.md 8 0",
		]);
		expect(entries.slice(1).map((entry) => text(readZipEntry(zip, entry)))).toEqual(["alpha", "stored as it is", ""]);
	});

	test("content that deflates well comes back whole", () => {
		const content = strToU8("0123456789".repeat(50_000));
		const zip = zipSync({ "big.txt": content });
		expect(zip.length).toBeLessThan(content.length / 10);
		const [entry] = readZipDirectory(zip);
		expect(entry?.size).toBe(content.length);
		expect(readZipEntry(zip, entry as NonNullable<typeof entry>)).toEqual(content);
	});

	test("a name that is not ASCII is read as UTF-8", () => {
		const zip = zipSync({ "top/ノート/メモ.md": strToU8("x") });
		expect(readZipDirectory(zip).map((entry) => entry.name)).toEqual(["top/ノート/メモ.md"]);
	});

	test("a zip that is a view into a larger buffer reads the same", () => {
		const zip = zipSync({ "a.md": strToU8("alpha") });
		const padded = new Uint8Array(zip.length + 7);
		padded.set(zip, 7);
		const view = padded.subarray(7);
		expect(text(openZip(view).read("a.md"))).toBe("alpha");
	});

	test("a comment at the end, as a host writes the commit there, is skipped", () => {
		const zip = zipSync({ "a.md": strToU8("alpha") }, { comment: "0123456789abcdef0123456789abcdef01234567" });
		expect(text(openZip(zip).read("a.md"))).toBe("alpha");
	});

	test("the sizes come from the directory: an entry written with a data descriptor reads like any other", () => {
		const zip = zipSync({ "a.md": strToU8("alpha alpha alpha alpha") });
		const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
		// The entry's own header as a streaming writer leaves it: the flag
		// set, and zeros where the checksum and the sizes would be.
		view.setUint16(6, view.getUint16(6, true) | 8, true);
		view.setUint32(14, 0, true);
		view.setUint32(18, 0, true);
		view.setUint32(22, 0, true);
		expect(text(openZip(zip).read("a.md"))).toBe("alpha alpha alpha alpha");
	});

	test("7,000 entries are listed, and one of them is read without the others", () => {
		const files: Record<string, Uint8Array> = {};
		for (let i = 0; i < 7000; i++) files[`top/notes/${i}.md`] = strToU8(`note ${i}`);
		const archive = openZip(zipSync(files), { stripTopFolder: true });
		expect(archive.sizeOf("notes/6999.md")).toBe(9);
		expect(text(archive.read("notes/4321.md"))).toBe("note 4321");
	});

	test("a zip64 directory is read", () => {
		const zip = zip64Of("top/a.md", strToU8("alpha"));
		expect(readZipDirectory(zip)).toEqual([
			{ name: "top/a.md", method: 0, encrypted: false, compressedSize: 5, size: 5, headerOffset: 0 },
		]);
		expect(text(openZip(zip, { stripTopFolder: true }).read("a.md"))).toBe("alpha");
	});

	test("65,535 entries without a zip64 directory are that many entries, and no sign of one", () => {
		const files: Record<string, Uint8Array> = {};
		for (let i = 0; i < 0xffff; i++) files[`${i}`] = new Uint8Array();
		const zip = zipSync(files, { level: 0 });
		// The count in the end record is the value that also stands for
		// "see the zip64 record", and there is none before it.
		const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
		const end = zip.length - 22;
		expect(view.getUint32(end, true)).toBe(0x06054b50);
		expect(view.getUint16(end + 10, true)).toBe(0xffff);
		expect(view.getUint32(end - 20, true)).not.toBe(0x07064b50);

		const entries = readZipDirectory(zip);
		expect(entries).toHaveLength(0xffff);
		expect(entries[0xfffe]?.name).toBe("65534");
	});

	test("a zip64 locator that points at no zip64 record fails", () => {
		const zip = zip64Of("top/a.md", strToU8("alpha"));
		const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
		// Where the locator says the record is.
		view.setUint32(zip.length - 22 - 20 + 8, 0, true);
		expect(() => readZipDirectory(zip)).toThrow("zip: no zip64 end of the directory");
	});

	test("bytes that are not a zip, or a zip cut short, fail", () => {
		expect(() => readZipDirectory(new Uint8Array())).toThrow("zip:");
		expect(() => readZipDirectory(strToU8("<html>Moved</html>".repeat(10)))).toThrow("zip:");
		const zip = zipSync({ "a.md": strToU8("alpha"), "b.md": strToU8("beta") });
		expect(() => readZipDirectory(zip.subarray(0, zip.length - 30))).toThrow("zip:");
	});

	test("an entry that is not where or what the directory says fails", () => {
		const content = strToU8("0123456789".repeat(100));
		const zip = zipSync({ "a.txt": content });
		const [entry] = readZipDirectory(zip) as [ReturnType<typeof readZipDirectory>[number]];
		expect(() => readZipEntry(zip, { ...entry, size: entry.size + 1 })).toThrow();
		// Data that holds more than the size is cut there and not noticed
		// here. The caller hashes what it gets.
		expect(readZipEntry(zip, { ...entry, size: entry.size - 1 })).toEqual(content.subarray(0, content.length - 1));
		expect(() => readZipEntry(zip, { ...entry, headerOffset: 3 })).toThrow("zip:");
		expect(() => readZipEntry(zip, { ...entry, method: 12 })).toThrow("not supported");
		expect(() => readZipEntry(zip, { ...entry, encrypted: true })).toThrow("encrypted");
		expect(() => readZipEntry(zip, { ...entry, compressedSize: zip.length })).toThrow("cut short");
	});

	test("data that overruns the size in a stored block is a fault of the zip, not a RangeError", () => {
		// A deflate stream of one stored block: inflating it into a buffer
		// that is too short throws a RangeError inside the library.
		const data = deflateSync(new Uint8Array(10).fill(65), { level: 0 });
		const zip = new Uint8Array(30 + data.length);
		new DataView(zip.buffer).setUint32(0, 0x04034b50, true);
		zip.set(data, 30);
		const [like] = readZipDirectory(zipSync({ "a.txt": strToU8("0123456789".repeat(100)) })) as [
			ReturnType<typeof readZipDirectory>[number],
		];
		const entry = { ...like, headerOffset: 0, compressedSize: data.length, size: 5 };
		let thrown: unknown;
		try {
			readZipEntry(zip, entry);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect(thrown).not.toBeInstanceOf(RangeError);
		expect((thrown as Error).message).toContain("cannot be inflated");
	});
});

describe("a zip as the contents of an archive", () => {
	const zip = zipSync({
		"owner-repo-abc/": new Uint8Array(),
		"owner-repo-abc/a.md": strToU8("alpha"),
		"owner-repo-abc/notes/": new Uint8Array(),
		"owner-repo-abc/notes/b.md": strToU8("beta!"),
		"stray.md": strToU8("outside the folder"),
	});

	test("the top folder is left out of every path, whatever it is called", () => {
		const archive = openZip(zip, { stripTopFolder: true });
		expect(archive.byteLength).toBe(zip.length);
		expect(archive.sizeOf("a.md")).toBe(5);
		expect(text(archive.read("notes/b.md"))).toBe("beta!");
		expect(archive.sizeOf("owner-repo-abc/a.md")).toBeNull();
	});

	test("folders, and what is not below the top folder, are not paths of it", () => {
		const archive = openZip(zip, { stripTopFolder: true });
		expect(archive.sizeOf("notes")).toBeNull();
		expect(archive.sizeOf("notes/")).toBeNull();
		expect(archive.sizeOf("stray.md")).toBeNull();
		expect(archive.sizeOf("")).toBeNull();
		expect(() => archive.read("stray.md")).toThrow("no such entry");
	});

	test("without a top folder the names are the paths", () => {
		const archive = openZip(zip);
		expect(archive.sizeOf("stray.md")).toBe(18);
		expect(archive.sizeOf("owner-repo-abc/a.md")).toBe(5);
	});

	// Neither is in a zip of a commit, which has one top folder and every
	// path once. Written down as it is today, so that a change shows.
	test("two entries that come to the same path: the later one of the directory is read", () => {
		const twice = zipSync({
			"one/a.md": strToU8("first"),
			"two/a.md": strToU8("the second"),
			"one/b.md": strToU8("only once"),
		});
		const archive = openZip(twice, { stripTopFolder: true });
		expect(archive.sizeOf("a.md")).toBe(10);
		expect(text(archive.read("a.md"))).toBe("the second");
		expect(text(archive.read("b.md"))).toBe("only once");
	});

	test("an entry with no folder above it is no path of a zip with a top folder", () => {
		const flat = zipSync({ "a.md": strToU8("alpha"), "top/b.md": strToU8("beta") });
		const archive = openZip(flat, { stripTopFolder: true });
		expect(archive.sizeOf("a.md")).toBeNull();
		expect(() => archive.read("a.md")).toThrow("no such entry");
		expect(text(archive.read("b.md"))).toBe("beta");
	});
});

// `fixtures/git-archive.zip` is what git itself writes, and what a host hands
// out as the zip of a commit: the zips of the other tests are fflate's. It is
// committed as it was made, once, with git 2.50.1, and `git-archive.json`
// beside it has the commit, the prefix, and each entry of the tree with the
// hash and the size `git ls-tree -r -l` lists for it. Made in an empty
// repository, with
// `core.precomposeunicode=false` on every command (on a Mac git otherwise
// composes the names) and no working tree, so that no file system got to
// change the bytes of a name:
//
//   git hash-object -w --stdin < content                     (per entry)
//   printf '<mode> <sha>\t<path>\n' | git update-index --index-info
//   git commit-tree $(git write-tree) -m fixture
//   git archive --format=zip --prefix=owner-repo-<sha, 7 digits>/ <commit>
//
// Mode 100644 for the files and 120000 for the symlink, whose content is
// where it points. `assets/noise.bin` is 256 bytes that do not shrink.
describe("a zip made by git archive", () => {
	interface Listed {
		readonly path: string;
		readonly kind: "file" | "symlink";
		readonly hash: string;
		readonly size: number;
	}
	const fixture = (name: string): Uint8Array => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
	const zip = new Uint8Array(fixture("git-archive.zip"));
	const listing = JSON.parse(new TextDecoder().decode(fixture("git-archive.json"))) as {
		readonly commit: string;
		readonly prefix: string;
		readonly entries: readonly Listed[];
	};
	const files = listing.entries.filter((entry) => entry.kind === "file");
	const listed = (path: string): Listed => {
		const entry = listing.entries.find((item) => item.path === path);
		if (entry === undefined) throw new Error(`not in the fixture: ${path}`);
		return entry;
	};

	test("the fixture holds what it is there for", () => {
		const paths = files.map((entry) => entry.path);
		const composed = "\u30ce\u30fc\u30c8/\u30ac\u30a4\u30c9.md";
		const decomposed = "\u30ce\u30fc\u30c8/\u30c6\u3099\u30cf\u3099\u30a4\u30b9.md";
		// A Japanese name in each form, an empty file, nested folders.
		expect(paths).toContain(composed);
		expect(composed.normalize("NFC")).toBe(composed);
		expect(paths).toContain(decomposed);
		expect(decomposed.normalize("NFD")).toBe(decomposed);
		expect(decomposed.normalize("NFC")).not.toBe(decomposed);
		expect(listed("empty.md").size).toBe(0);
		expect(paths).toContain("a/b/c/deep.md");

		// Every entry is below the one folder; git wrote folders as entries,
		// one file deflated, and the binary as it is.
		const entries = readZipDirectory(zip);
		expect(entries.every((entry) => entry.name.startsWith(listing.prefix))).toBe(true);
		const method = (path: string): number | undefined =>
			entries.find((entry) => entry.name === listing.prefix + path)?.method;
		expect(method("a/b/c/")).toBe(0);
		expect(method("a/b/c/deep.md")).toBe(8);
		expect(method("assets/noise.bin")).toBe(0);
		expect(entries.filter((entry) => !entry.name.endsWith("/"))).toHaveLength(listing.entries.length);
	});

	test("every file is read with the size and the blob hash of the tree", () => {
		const archive = openZip(zip, { stripTopFolder: true });
		expect(archive.byteLength).toBe(zip.length);
		expect(files).toHaveLength(7);
		for (const entry of files) {
			expect(archive.sizeOf(entry.path), entry.path).toBe(entry.size);
			expect(blobHash(archive.read(entry.path)), entry.path).toBe(entry.hash);
		}
	});

	test("a name is the bytes git has: neither form of it is turned into the other", () => {
		const archive = openZip(zip, { stripTopFolder: true });
		for (const entry of files) {
			for (const form of ["NFC", "NFD"] as const) {
				const other = entry.path.normalize(form);
				if (other !== entry.path) expect(archive.sizeOf(other), `${entry.path} as ${form}`).toBeNull();
			}
		}
	});

	test("a folder is no path, and the symlink is an entry like a file, with where it points as content", () => {
		const archive = openZip(zip, { stripTopFolder: true });
		expect(archive.sizeOf("a/b")).toBeNull();
		expect(archive.sizeOf("a/b/")).toBeNull();
		// Nothing here tells it from a file. The listing does, and the pull
		// asks for no path the listing calls a symlink.
		const link = listed("link-to-readme");
		expect(link.kind).toBe("symlink");
		expect(archive.sizeOf(link.path)).toBe(link.size);
		expect(text(archive.read(link.path))).toBe("README.md");
		expect(blobHash(archive.read(link.path))).toBe(link.hash);
	});

	test("the commit is in the comment at the end, which is skipped", () => {
		expect(text(zip.subarray(zip.length - 40))).toBe(listing.commit);
	});
});

/** A zip of one stored entry whose directory is written the zip64 way, as for an archive past the old limits. */
function zip64Of(name: string, content: Uint8Array): Uint8Array {
	const nameBytes = strToU8(name);
	const local = new DataView(new ArrayBuffer(30));
	local.setUint32(0, 0x04034b50, true);
	local.setUint16(4, 45, true);
	local.setUint32(18, content.length, true);
	local.setUint32(22, content.length, true);
	local.setUint16(26, nameBytes.length, true);

	const directory = new DataView(new ArrayBuffer(46));
	directory.setUint32(0, 0x02014b50, true);
	directory.setUint16(4, 45, true);
	directory.setUint16(6, 45, true);
	directory.setUint32(20, 0xffffffff, true);
	directory.setUint32(24, 0xffffffff, true);
	directory.setUint16(28, nameBytes.length, true);
	directory.setUint16(30, 28, true);
	directory.setUint32(42, 0xffffffff, true);
	const extra = new DataView(new ArrayBuffer(28));
	extra.setUint16(0, 1, true);
	extra.setUint16(2, 24, true);
	extra.setUint32(4, content.length, true);
	extra.setUint32(12, content.length, true);
	extra.setUint32(20, 0, true);

	const directoryOffset = 30 + nameBytes.length + content.length;
	const directorySize = 46 + nameBytes.length + 28;
	const end64 = new DataView(new ArrayBuffer(56));
	end64.setUint32(0, 0x06064b50, true);
	end64.setUint32(4, 44, true);
	end64.setUint16(12, 45, true);
	end64.setUint16(14, 45, true);
	end64.setUint32(24, 1, true);
	end64.setUint32(32, 1, true);
	end64.setUint32(40, directorySize, true);
	end64.setUint32(48, directoryOffset, true);
	const locator = new DataView(new ArrayBuffer(20));
	locator.setUint32(0, 0x07064b50, true);
	locator.setUint32(8, directoryOffset + directorySize, true);
	locator.setUint32(16, 1, true);
	const end = new DataView(new ArrayBuffer(22));
	end.setUint32(0, 0x06054b50, true);
	end.setUint16(8, 0xffff, true);
	end.setUint16(10, 0xffff, true);
	end.setUint32(12, 0xffffffff, true);
	end.setUint32(16, 0xffffffff, true);

	const parts = [local, nameBytes, content, directory, nameBytes, extra, end64, locator, end].map((part) =>
		part instanceof Uint8Array ? part : new Uint8Array(part.buffer),
	);
	const zip = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let at = 0;
	for (const part of parts) {
		zip.set(part, at);
		at += part.length;
	}
	return zip;
}
