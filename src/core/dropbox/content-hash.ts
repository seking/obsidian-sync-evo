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

// Dropbox's `content_hash`, computed from the content of a vault file: the
// SHA-256 of each 4 MB block, put one after another, and the SHA-256 of that,
// in hex. An empty file has no block, so its hash is the SHA-256 of nothing.
// https://docs.dropboxapi.com/dropbox-api/docs/technical-reference/content-hash
//
// WebCrypto takes each block where it is (a view, no copy), so unlike the
// hash of a git blob (`hash.ts`) nothing has to be written by hand.

export const DROPBOX_BLOCK_BYTES = 4 * 1024 * 1024;

const HEX = "0123456789abcdef";

function toHex(bytes: Uint8Array): string {
	let out = "";
	for (const byte of bytes) out += `${HEX[byte >>> 4] ?? ""}${HEX[byte & 15] ?? ""}`;
	return out;
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>));
}

/**
 * The `content_hash` of `content`. `yieldControl` is awaited between the
 * blocks of a large file, so that hashing it does not hold up the app.
 */
export async function dropboxContentHash(content: Uint8Array, yieldControl?: () => Promise<void>): Promise<string> {
	const blocks = Math.ceil(content.length / DROPBOX_BLOCK_BYTES);
	const joined = new Uint8Array(blocks * 32);
	for (let i = 0; i < blocks; i++) {
		if (i > 0) await yieldControl?.();
		const start = i * DROPBOX_BLOCK_BYTES;
		joined.set(await sha256(content.subarray(start, Math.min(content.length, start + DROPBOX_BLOCK_BYTES))), i * 32);
	}
	return toHex(await sha256(joined));
}
