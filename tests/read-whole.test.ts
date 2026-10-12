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
import { readWhole, ShortReadError, type VaultStat } from "../src/core/pull-io";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const file = (size: number, mtime = 1): VaultStat => ({ type: "file", mtime, size });

/** A vault that answers each read and each second look with the next of what it was given. */
function vaultOf(reads: readonly string[], looks: readonly (VaultStat | null)[] = []) {
	const calls: string[] = [];
	let read = 0;
	let look = 0;
	return {
		calls,
		async stat(): Promise<VaultStat | null> {
			calls.push("stat");
			return looks[look++] ?? null;
		},
		async read(): Promise<Uint8Array> {
			calls.push("read");
			return bytes(reads[read++] ?? "");
		},
	};
}

describe("reading a file whole", () => {
	test("a read as long as the file is said to be is taken, with one read and no second look", async () => {
		const vault = vaultOf(["whole"]);
		const stat = file(5);

		const result = await readWhole(vault, "a.md", stat);

		expect(new TextDecoder().decode(result.content)).toBe("whole");
		expect(result.stat).toBe(stat);
		expect(vault.calls).toEqual(["read"]);
	});

	test("a read that gives a part of the file, twice, is no content at all", async () => {
		const vault = vaultOf(["wh", "wh"], [file(5)]);

		await expect(readWhole(vault, "a.md", file(5))).rejects.toBeInstanceOf(ShortReadError);
		expect(vault.calls).toEqual(["read", "stat", "read"]);
	});

	test("an empty answer for a file that is not empty is no content either", async () => {
		const vault = vaultOf(["", ""], [file(5)]);

		await expect(readWhole(vault, "a.md", file(5))).rejects.toBeInstanceOf(ShortReadError);
	});

	test("a file written between the look and the read is read again, and goes with the second look", async () => {
		const vault = vaultOf(["longer now", "longer now"], [file(10, 2)]);

		const result = await readWhole(vault, "a.md", file(5, 1));

		expect(new TextDecoder().decode(result.content)).toBe("longer now");
		expect(result.stat).toEqual(file(10, 2));
	});

	test("a file that is gone at the second look is not read again", async () => {
		const vault = vaultOf(["wh"], [null]);

		await expect(readWhole(vault, "a.md", file(5))).rejects.toBeInstanceOf(ShortReadError);
		expect(vault.calls).toEqual(["read", "stat"]);
	});

	test("what the vault throws is thrown on", async () => {
		const vault = {
			stat: async () => file(5),
			read: async (): Promise<Uint8Array> => {
				throw new Error("EIO");
			},
		};

		await expect(readWhole(vault, "a.md", file(5))).rejects.toThrow("EIO");
	});
});
