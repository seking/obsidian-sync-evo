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
import { expect, test } from "vitest";

// Each file says at its top which license it is under (see LICENSE): the
// files under pro/ the Elastic License 2.0, all others the AGPL.
const AGPL = [
	" * This file is free software, licensed under the GNU Affero General Public",
	" * License, version 3, as part of Sync Evo. It comes with ABSOLUTELY NO",
	" * WARRANTY. See LICENSE-AGPL for the full text, and LICENSE for the parts of",
	" * Sync Evo under other terms.",
].join("\n");
const ELASTIC = [
	" * This file is part of the paid part of Sync Evo (the folder pro/), which is",
	" * licensed under the Elastic License 2.0, not the AGPL. You may not move,",
	" * change, disable, or circumvent the license key functionality in it. See",
	" * pro/LICENSE for the full text.",
].join("\n");

const root = new URL("../", import.meta.url);

/** The code files under `folder` (from the root of the repository), or the file itself. */
function codeFiles(folder: string): string[] {
	if (/\.m?[jt]s$/.test(folder)) return [folder];
	return readdirSync(new URL(`${folder}/`, root), { recursive: true, encoding: "utf8" })
		.filter((name) => /\.m?[jt]s$/.test(name))
		.map((name) => `${folder}/${name}`);
}

/** The files among `files` whose header is not `header`. */
function without(files: readonly string[], header: string): string[] {
	expect(files.length).toBeGreaterThan(0);
	return files.filter((file) => !readFileSync(new URL(file, root), "utf8").slice(0, 600).includes(header));
}

test("the files outside pro/ carry the AGPL header", () => {
	const files = ["src", "tests", "scripts", "esbuild.config.mjs", "eslint.config.mjs"].flatMap(codeFiles);
	expect(without(files, AGPL)).toEqual([]);
});

test("the files under pro/ carry the Elastic License 2.0 header", () => {
	expect(without(codeFiles("pro"), ELASTIC)).toEqual([]);
});
