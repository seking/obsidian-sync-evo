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

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const PADDING = 61; // "="

/**
 * Standard base64 with padding. Written here because the core has no `Buffer`,
 * and `btoa` takes a string: building that string with `String.fromCharCode`
 * over a whole file overflows the stack for files of a few megabytes.
 */
export function encodeBase64(data: Uint8Array): string {
	const codes = new Uint8Array(64);
	for (let i = 0; i < 64; i++) codes[i] = ALPHABET.charCodeAt(i);

	// The output is filled in as ASCII bytes and turned into a string in one
	// step, which neither recurses nor concatenates.
	const out = new Uint8Array(Math.ceil(data.length / 3) * 4);
	const whole = data.length - (data.length % 3);
	let o = 0;
	for (let i = 0; i < whole; i += 3) {
		const n = ((data[i] ?? 0) << 16) | ((data[i + 1] ?? 0) << 8) | (data[i + 2] ?? 0);
		out[o++] = codes[n >> 18] ?? 0;
		out[o++] = codes[(n >> 12) & 63] ?? 0;
		out[o++] = codes[(n >> 6) & 63] ?? 0;
		out[o++] = codes[n & 63] ?? 0;
	}
	const rest = data.length - whole;
	if (rest > 0) {
		const n = ((data[whole] ?? 0) << 16) | ((data[whole + 1] ?? 0) << 8);
		out[o++] = codes[n >> 18] ?? 0;
		out[o++] = codes[(n >> 12) & 63] ?? 0;
		out[o++] = rest === 2 ? (codes[(n >> 6) & 63] ?? 0) : PADDING;
		out[o++] = PADDING;
	}
	return new TextDecoder().decode(out);
}
