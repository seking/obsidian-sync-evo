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

// Telling a text file from any other by its bytes, never by its name. In one
// place, because two things go by it and must agree: whether a push sends a
// content as text (`github/backend.ts`), and whether a conflict may be merged
// line by line (`merge.ts`).

/**
 * Whether a text has a control character other than a tab, a line end or a
 * form feed. The codes are compared one by one: a pattern that names control
 * characters is what the automated review of plugins objects to.
 */
function hasControlCharacter(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code <= 0x08 || code === 0x0b || (code >= 0x0e && code <= 0x1f)) return true;
	}
	return false;
}

/**
 * The content as text, when sending it as text gives back these very
 * bytes: it is UTF-8, and encoding what was decoded makes no difference.
 * `null` for everything else, which goes as a blob: bytes that are not
 * UTF-8, a byte order mark (dropped by decoding), and control characters
 * other than tabs and line ends. A NUL marks a file as binary wherever git
 * looks at it; and each such character is six bytes in the body of the
 * request, which the size of a tree is not reckoned with.
 */
export function inlineText(content: Uint8Array): string | null {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(content);
	} catch {
		return null;
	}
	if (hasControlCharacter(text)) return null;
	const again = new TextEncoder().encode(text);
	if (again.length !== content.length) return null;
	for (let i = 0; i < again.length; i++) {
		if (again[i] !== content[i]) return null;
	}
	return text;
}
