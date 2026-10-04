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

import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("src/core only imports from inside itself", () => {
	const root = new URL("../src/core/", import.meta.url);
	const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((name) =>
		name.endsWith(".ts"),
	);
	expect(files.length).toBeGreaterThan(0);

	const outside: string[] = [];
	for (const file of files) {
		const source = readFileSync(new URL(file, root), "utf8");
		const depth = file.split(/[\\/]/).length - 1;
		// A reference directive pulls in types (Node's, for one) without an import.
		if (/^\s*\/\/\/\s*<reference\b/m.test(source)) outside.push(`${file}: <reference>`);

		// Comments are dropped so that prose such as `from "somewhere"` is not
		// taken for an import. Rough on purpose: a `//` only counts at the start
		// of a line or after a space, which keeps URLs inside strings whole.
		const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
		for (const match of code.matchAll(/\b(?:from|import|require)\s*\(?\s*(["'`])(.*?)\1/g)) {
			const specifier = match[2] ?? "";
			const climbs = specifier.split("/").filter((part) => part === "..").length;
			if (!specifier.startsWith(".") || climbs > depth) outside.push(`${file}: ${specifier}`);
		}
	}
	expect(outside).toEqual([]);
});
