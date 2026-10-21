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

// Reading a zip that is in memory, one entry at a time. The directory at the
// end of the zip says where each entry is; an entry is inflated when it is
// asked for and never before, so that the zip and one content are all that
// is in memory. Nothing is inflated ahead, and nothing is kept.
//
// Only what a zip made by `git archive` needs is read: entries that are
// stored or deflated, and the zip64 fields of an archive with more than
// 65,535 entries or 4 GB. The sizes and the place of an entry are taken from
// the directory alone, so an entry written with a data descriptor (its sizes
// after its data, and zeros in its own header) reads like any other. The
// attributes of an entry are not looked at: a symlink is in such a zip as an
// entry whose content is where it points, and reads as a plain file. Which
// entries are files is for the caller to know, from the listing.

import { inflateSync } from "fflate";
import type { ArchiveContents } from "./backend";

export interface ZipEntry {
	/** The name as the zip has it, with `/` between the folders. A folder ends with `/`. */
	readonly name: string;
	/** 0 for stored, 8 for deflated. Anything else cannot be read. */
	readonly method: number;
	readonly encrypted: boolean;
	readonly compressedSize: number;
	/** The size of the content, in bytes. */
	readonly size: number;
	/** Where the entry's own header starts. */
	readonly headerOffset: number;
}

const END_SIGNATURE = 0x06054b50;
const END64_LOCATOR_SIGNATURE = 0x07064b50;
const END64_SIGNATURE = 0x06064b50;
const DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

const END_LENGTH = 22;
const END64_LOCATOR_LENGTH = 20;
const DIRECTORY_HEADER_LENGTH = 46;
const LOCAL_HEADER_LENGTH = 30;
/** The longest comment the end of a zip can carry. GitHub puts the commit there. */
const MAX_COMMENT_LENGTH = 0xffff;
const ZIP64_EXTRA_ID = 1;

const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;

function viewOf(zip: Uint8Array): DataView {
	return new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
}

// A number of 8 bytes, as far as a JavaScript number holds one exactly. A zip
// that needs more than that is not one that fits in memory.
function uint64(view: DataView, offset: number): number {
	const high = view.getUint32(offset + 4, true);
	if (high > 0x1fffff) throw new Error("zip: a size or an offset is out of range");
	return high * 0x100000000 + view.getUint32(offset, true);
}

/**
 * The entries of a zip, in the order of its directory. Throws when the bytes
 * are not a zip that can be read: cut short, or without its directory.
 */
export function readZipDirectory(zip: Uint8Array): ZipEntry[] {
	const view = viewOf(zip);
	// The end record is the last thing in the zip, but for a comment of a
	// length only the record itself tells.
	let end = -1;
	const lowest = Math.max(zip.length - END_LENGTH - MAX_COMMENT_LENGTH, 0);
	for (let at = zip.length - END_LENGTH; at >= lowest; at--) {
		if (view.getUint32(at, true) !== END_SIGNATURE) continue;
		if (at + END_LENGTH + view.getUint16(at + 20, true) > zip.length) continue;
		end = at;
		break;
	}
	if (end < 0) throw new Error("zip: no end of the directory");

	let count = view.getUint16(end + 10, true);
	let directorySize = view.getUint32(end + 12, true);
	let directoryOffset = view.getUint32(end + 16, true);
	// The largest value of a field stands for "see the zip64 record", but it
	// is also a value a zip can simply have: 65,535 entries, for one. Only the
	// locator right before the end record tells the two apart. Without one,
	// the values are taken as they are.
	const locator = end - END64_LOCATOR_LENGTH;
	if (
		(count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) &&
		locator >= 0 &&
		view.getUint32(locator, true) === END64_LOCATOR_SIGNATURE
	) {
		const end64 = uint64(view, locator + 8);
		if (end64 + 56 > zip.length || view.getUint32(end64, true) !== END64_SIGNATURE) {
			throw new Error("zip: no zip64 end of the directory");
		}
		count = uint64(view, end64 + 32);
		directorySize = uint64(view, end64 + 40);
		directoryOffset = uint64(view, end64 + 48);
	}
	if (directoryOffset + directorySize > zip.length) throw new Error("zip: the directory is cut short");

	const decoder = new TextDecoder();
	const entries: ZipEntry[] = [];
	let at = directoryOffset;
	for (let index = 0; index < count; index++) {
		if (at + DIRECTORY_HEADER_LENGTH > zip.length || view.getUint32(at, true) !== DIRECTORY_SIGNATURE) {
			throw new Error("zip: the directory is damaged");
		}
		const flags = view.getUint16(at + 8, true);
		const method = view.getUint16(at + 10, true);
		let compressedSize = view.getUint32(at + 20, true);
		let size = view.getUint32(at + 24, true);
		const nameLength = view.getUint16(at + 28, true);
		const extraLength = view.getUint16(at + 30, true);
		const commentLength = view.getUint16(at + 32, true);
		let headerOffset = view.getUint32(at + 42, true);
		const nameStart = at + DIRECTORY_HEADER_LENGTH;
		const extraStart = nameStart + nameLength;
		const next = extraStart + extraLength + commentLength;
		if (next > zip.length) throw new Error("zip: the directory is damaged");

		// The zip64 field holds, in this order, only the values that did not
		// fit in the 4 bytes above.
		for (let extra = extraStart; extra + 4 <= extraStart + extraLength; ) {
			const id = view.getUint16(extra, true);
			const length = view.getUint16(extra + 2, true);
			let value = extra + 4;
			if (id === ZIP64_EXTRA_ID && value + length <= extraStart + extraLength) {
				const take = (): number => {
					if (value + 8 > extra + 4 + length) throw new Error("zip: the directory is damaged");
					value += 8;
					return uint64(view, value - 8);
				};
				if (size === 0xffffffff) size = take();
				if (compressedSize === 0xffffffff) compressedSize = take();
				if (headerOffset === 0xffffffff) headerOffset = take();
			}
			extra += 4 + length;
		}

		entries.push({
			// git writes a path as the bytes it has, which are UTF-8 whether
			// or not the entry says so.
			name: decoder.decode(zip.subarray(nameStart, extraStart)),
			method,
			encrypted: (flags & 1) !== 0,
			compressedSize,
			size,
			headerOffset,
		});
		at = next;
	}
	return entries;
}

/**
 * The content of one entry. A stored entry is answered as a view into the
 * zip, without a copy; a deflated one is inflated into a buffer of exactly
 * its size. Throws when the entry cannot be read or holds less than the
 * directory says. Data that holds more is cut at that size without a word:
 * the content is not checked here, and the caller has a hash to check it by.
 */
export function readZipEntry(zip: Uint8Array, entry: ZipEntry): Uint8Array {
	if (entry.encrypted) throw new Error(`zip: an encrypted entry: ${entry.name}`);
	const view = viewOf(zip);
	const header = entry.headerOffset;
	if (header + LOCAL_HEADER_LENGTH > zip.length || view.getUint32(header, true) !== LOCAL_SIGNATURE) {
		throw new Error(`zip: no entry where the directory says: ${entry.name}`);
	}
	// The name and the extra field are given again in the entry's own
	// header, and need not have the lengths the directory has for them.
	const start = header + LOCAL_HEADER_LENGTH + view.getUint16(header + 26, true) + view.getUint16(header + 28, true);
	const end = start + entry.compressedSize;
	if (end > zip.length) throw new Error(`zip: an entry is cut short: ${entry.name}`);
	const data = zip.subarray(start, end);

	let content: Uint8Array;
	if (entry.method === METHOD_STORED) content = data;
	else if (entry.method !== METHOD_DEFLATED) {
		throw new Error(`zip: compression method ${entry.method} is not supported: ${entry.name}`);
	}
	// Nothing to inflate, and no buffer of no length to hand over for it.
	else if (entry.size === 0) content = new Uint8Array(0);
	// Into a buffer of the size that is known, so that none is grown and
	// copied on the way.
	else {
		const out = new Uint8Array(entry.size);
		// Whatever the inflating throws is told as a fault of the zip. Data
		// that holds more than the size can end in a RangeError, which would
		// otherwise read as memory that could not be had.
		try {
			content = inflateSync(data, { out });
		} catch (error) {
			throw new Error(`zip: an entry cannot be inflated: ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (content.length !== entry.size) throw new Error(`zip: an entry has not the size it should have: ${entry.name}`);
	return content;
}

export interface OpenZipOptions {
	/**
	 * Whether every entry is below one folder that is not part of its path:
	 * a zip of a commit has `<owner>-<repo>-<sha>/` there. The first name of
	 * each entry is then left out, whatever it is.
	 */
	readonly stripTopFolder?: boolean;
}

/**
 * A zip as the contents of an archive. Only its directory is read here. The
 * zip is held for as long as what is answered is.
 */
export function openZip(zip: Uint8Array, options: OpenZipOptions = {}): ArchiveContents {
	const byPath = new Map<string, ZipEntry>();
	for (const entry of readZipDirectory(zip)) {
		let path = entry.name;
		if (path.endsWith("/")) continue;
		if (options.stripTopFolder === true) {
			const slash = path.indexOf("/");
			if (slash < 0) continue;
			path = path.slice(slash + 1);
		}
		if (path !== "") byPath.set(path, entry);
	}
	return {
		byteLength: zip.length,
		sizeOf: (path) => byPath.get(path)?.size ?? null,
		read: (path) => {
			const entry = byPath.get(path);
			if (entry === undefined) throw new Error(`zip: no such entry: ${path}`);
			return readZipEntry(zip, entry);
		},
	};
}
