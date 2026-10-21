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

import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

function readJson(name: string): Record<string, unknown> {
	const url = new URL(`../${name}`, import.meta.url);
	return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>;
}

test("manifest keeps the fixed id and name, and its version is consistent", () => {
	const manifest = readJson("manifest.json");
	const versions = readJson("versions.json");
	const pkg = readJson("package.json");

	// The id cannot change once the plugin is published.
	expect(manifest.id).toBe("sync-evo");
	expect(manifest.name).toBe("Sync Evo");
	expect(manifest.isDesktopOnly).toBe(false);

	expect(pkg.version).toBe(manifest.version);
	expect(versions[manifest.version as string]).toBe(manifest.minAppVersion);
});
