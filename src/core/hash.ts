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

// The hash git gives a blob, computed from the content of a vault file, on a
// SHA-1 written in plain JavaScript. WebCrypto is not used: it takes the
// whole input in one piece, so the header and the content would have to be
// copied into one buffer, which doubles the memory of the largest file on a
// phone. This one is fed in pieces, so there is no copy and only one way the
// hash is ever computed. It gave the same values as WebCrypto on an iPhone.

/**
 * How much content is hashed before control is handed back. A multiple of the
 * 64-byte block, so that no piece leaves a partial block to be copied.
 */
export const HASH_CHUNK_BYTES = 4 * 1024 * 1024;

const HEX = "0123456789abcdef";

function toHex(bytes: Uint8Array): string {
	let out = "";
	for (const byte of bytes) out += `${HEX[byte >>> 4] ?? ""}${HEX[byte & 15] ?? ""}`;
	return out;
}

/** SHA-1 that takes its input in any number of pieces. */
export class Sha1 {
	private h0 = 0x67452301 | 0;
	private h1 = 0xefcdab89 | 0;
	private h2 = 0x98badcfe | 0;
	private h3 = 0x10325476 | 0;
	private h4 = 0xc3d2e1f0 | 0;
	/** The bytes of a block that is not full yet. */
	private readonly block = new Uint8Array(64);
	private blockLength = 0;
	private total = 0;
	private readonly w = new Int32Array(80);

	update(data: Uint8Array): this {
		let offset = 0;
		const length = data.length;
		this.total += length;
		if (this.blockLength > 0) {
			const take = Math.min(64 - this.blockLength, length);
			this.block.set(data.subarray(0, take), this.blockLength);
			this.blockLength += take;
			offset = take;
			if (this.blockLength < 64) return this;
			this.process(this.block, 0);
			this.blockLength = 0;
		}
		// Whole blocks are read where they are, without going through `block`.
		for (; offset + 64 <= length; offset += 64) this.process(data, offset);
		if (offset < length) {
			this.block.set(data.subarray(offset), 0);
			this.blockLength = length - offset;
		}
		return this;
	}

	/** The hash as 40 hexadecimal digits. The instance cannot be used after this. */
	digest(): string {
		const total = this.total;
		const padding = new Uint8Array(((this.blockLength + 9 + 63) & ~63) - this.blockLength);
		padding[0] = 0x80;
		// The length in bits, as 64 bits. The bit operators work on 32, so the
		// upper half is taken by division.
		const view = new DataView(padding.buffer);
		view.setUint32(padding.length - 8, Math.floor(total / 0x20000000));
		view.setUint32(padding.length - 4, (total << 3) >>> 0);
		this.update(padding);

		const out = new Uint8Array(20);
		const words = new DataView(out.buffer);
		words.setInt32(0, this.h0);
		words.setInt32(4, this.h1);
		words.setInt32(8, this.h2);
		words.setInt32(12, this.h3);
		words.setInt32(16, this.h4);
		return toHex(out);
	}

	private process(data: Uint8Array, start: number): void {
		const w = this.w;
		let offset = start;
		for (let i = 0; i < 16; i++) {
			w[i] =
				((data[offset] ?? 0) << 24) |
				((data[offset + 1] ?? 0) << 16) |
				((data[offset + 2] ?? 0) << 8) |
				(data[offset + 3] ?? 0);
			offset += 4;
		}
		for (let i = 16; i < 80; i++) {
			const x = (w[i - 3] ?? 0) ^ (w[i - 8] ?? 0) ^ (w[i - 14] ?? 0) ^ (w[i - 16] ?? 0);
			w[i] = (x << 1) | (x >>> 31);
		}

		let a = this.h0;
		let b = this.h1;
		let c = this.h2;
		let d = this.h3;
		let e = this.h4;
		for (let i = 0; i < 80; i++) {
			let f: number;
			let k: number;
			if (i < 20) {
				f = (b & c) | (~b & d);
				k = 0x5a827999;
			} else if (i < 40) {
				f = b ^ c ^ d;
				k = 0x6ed9eba1;
			} else if (i < 60) {
				f = (b & c) | (b & d) | (c & d);
				k = 0x8f1bbcdc;
			} else {
				f = b ^ c ^ d;
				k = 0xca62c1d6;
			}
			const t = (((a << 5) | (a >>> 27)) + f + e + k + (w[i] ?? 0)) | 0;
			e = d;
			d = c;
			c = (b << 30) | (b >>> 2);
			b = a;
			a = t;
		}
		this.h0 = (this.h0 + a) | 0;
		this.h1 = (this.h1 + b) | 0;
		this.h2 = (this.h2 + c) | 0;
		this.h3 = (this.h3 + d) | 0;
		this.h4 = (this.h4 + e) | 0;
	}
}

function blobHeader(length: number): Uint8Array {
	const text = `blob ${length}\0`;
	const out = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
	return out;
}

/**
 * The hash git gives a blob with this content: the same value a tree lists
 * for the file.
 *
 * `yieldControl` is awaited between pieces of `HASH_CHUNK_BYTES`, so that a
 * file of tens of megabytes does not hold the screen still while it is
 * hashed. Content that fits in one piece is hashed without any wait: almost
 * every file is that small, and a wait per file would cost more than the
 * hashing. Without `yieldControl` nothing is waited for at all.
 *
 * The content must not change while this runs; the caller owns it.
 */
export async function gitBlobHash(content: Uint8Array, yieldControl?: () => Promise<void>): Promise<string> {
	const sha1 = new Sha1().update(blobHeader(content.length));
	for (let offset = 0; offset < content.length; offset += HASH_CHUNK_BYTES) {
		if (offset > 0 && yieldControl !== undefined) await yieldControl();
		// A view on the same bytes, not a copy.
		sha1.update(content.subarray(offset, offset + HASH_CHUNK_BYTES));
	}
	return sha1.digest();
}
