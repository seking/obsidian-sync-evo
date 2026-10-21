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

import { createHash, randomBytes } from "node:crypto";
import { describe, expect, test } from "vitest";
import { gitBlobHash, HASH_CHUNK_BYTES, Sha1 } from "../src/core/hash";
import { blobHash, bytes } from "./support/memory-backend";

function nodeSha1(data: Uint8Array): string {
	return createHash("sha1").update(data).digest("hex");
}

describe("SHA-1", () => {
	test.each([
		["", "da39a3ee5e6b4b0d3255bfef95601890afd80709"],
		["abc", "a9993e364706816aba3e25717850c26c9cd0d89d"],
		[
			"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
			"84983e441c3bd26ebaae4aa1f95129e5e54670f1",
		],
	])("the known value of %j", (input, expected) => {
		expect(new Sha1().update(bytes(input)).digest()).toBe(expected);
	});

	test("a million times 'a'", () => {
		const data = new Uint8Array(1_000_000).fill(0x61);
		expect(new Sha1().update(data).digest()).toBe("34aa973cd4c4daa4f61eeb2bdbad27316534016f");
	});

	// Around the 64-byte block and the 56 bytes after which the length no
	// longer fits in the same block.
	test.each([1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000])(
		"%i random bytes give what Node gives",
		(length) => {
			const data = randomBytes(length);
			expect(new Sha1().update(data).digest()).toBe(nodeSha1(data));
		},
	);

	test("the pieces the input comes in do not matter", () => {
		const data = randomBytes(1000);
		for (const size of [1, 3, 63, 64, 65, 500]) {
			const sha1 = new Sha1();
			for (let offset = 0; offset < data.length; offset += size) sha1.update(data.subarray(offset, offset + size));
			expect(sha1.digest()).toBe(nodeSha1(data));
		}
	});
});

describe("the git blob hash", () => {
	test("empty content", async () => {
		expect(await gitBlobHash(new Uint8Array())).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
	});

	test("known values, as `git hash-object` gives them", async () => {
		expect(await gitBlobHash(bytes("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
		expect(await gitBlobHash(bytes("test content\n"))).toBe("d670460b4b4aece5915caf5c68d12f560a9fe3e4");
	});

	test("agrees with the hash the in-memory remote uses", async () => {
		for (const content of ["", "a", "# ノート\n\n本文\n", "x".repeat(100_000)]) {
			expect(await gitBlobHash(bytes(content))).toBe(blobHash(content));
		}
		const binary = randomBytes(70_000);
		expect(await gitBlobHash(binary)).toBe(blobHash(binary));
	});

	test("content inside a larger buffer is hashed on its own", async () => {
		const whole = randomBytes(300);
		const part = whole.subarray(100, 200);
		expect(await gitBlobHash(part)).toBe(blobHash(new Uint8Array(part)));
	});

	test.each([
		["one byte less than a piece", HASH_CHUNK_BYTES - 1, 0],
		["exactly one piece", HASH_CHUNK_BYTES, 0],
		["one byte more than a piece", HASH_CHUNK_BYTES + 1, 1],
		["exactly two pieces", 2 * HASH_CHUNK_BYTES, 1],
		["two pieces and a bit", 2 * HASH_CHUNK_BYTES + 100, 2],
	])("%s: the right hash, and control is given up between pieces only", async (_name, length, yields) => {
		const data = randomBytes(length);
		let count = 0;
		const hash = await gitBlobHash(data, async () => {
			count++;
		});
		expect(hash).toBe(blobHash(data));
		expect(count).toBe(yields);
	});

	test("without a way to give up control, large content is still hashed", async () => {
		const data = randomBytes(HASH_CHUNK_BYTES + 5);
		expect(await gitBlobHash(data)).toBe(blobHash(data));
	});

	test("the content is not changed", async () => {
		const data = randomBytes(1000);
		const copy = new Uint8Array(data);
		await gitBlobHash(data);
		expect(new Uint8Array(data)).toEqual(copy);
	});
});
