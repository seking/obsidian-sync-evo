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

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { expect, test } from "vitest";

// The boundary keeps `obsidian` and the APIs of Node out of the core, so that
// it runs on a phone and in the tests alike. A package that is JavaScript
// alone and uses neither does not cross it. Each one is named here.
const ALLOWED_PACKAGES: readonly string[] = ["fflate", "ignore", "node-diff3"];

/**
 * What each file under `folder` (from the root of the repository) imports
 * from outside the folders of `inside`, as "file: specifier". Packages other
 * than those named above count as outside.
 */
function importsOutside(folder: string, inside: readonly string[]): string[] {
	const root = new URL(`../${folder}/`, import.meta.url);
	const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".ts"));
	expect(files.length).toBeGreaterThan(0);

	const outside: string[] = [];
	for (const file of files) {
		const source = readFileSync(new URL(file, root), "utf8");
		// A reference directive pulls in types (Node's, for one) without an import.
		if (/^\s*\/\/\/\s*<reference\b/m.test(source)) outside.push(`${file}: <reference>`);

		// Comments are dropped so that prose such as `from "somewhere"` is not
		// taken for an import. Rough on purpose: a `//` only counts at the start
		// of a line or after a space, which keeps URLs inside strings whole.
		const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
		for (const match of code.matchAll(/\b(?:from|import|require)\s*\(?\s*(["'`])(.*?)\1/g)) {
			const specifier = match[2] ?? "";
			if (ALLOWED_PACKAGES.includes(specifier)) continue;
			// Where it points, from the root of the repository.
			const target = specifier.startsWith(".") ? normalize(join(folder, dirname(file), specifier)) : null;
			if (target === null || !inside.some((place) => target === place || target.startsWith(`${place}/`))) {
				outside.push(`${file}: ${specifier}`);
			}
		}
	}
	return outside;
}

test("src/core only imports from inside itself, and the packages named above", () => {
	// Never from the paid part (`pro/`) either: the core is whole without it.
	expect(importsOutside("src/core", ["src/core"])).toEqual([]);
});

test("pro/src/core only imports from inside itself, src/core, and the packages named above", () => {
	expect(importsOutside("pro/src/core", ["pro/src/core", "src/core"])).toEqual([]);
});
