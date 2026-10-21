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

// Copies the built plugin into <vault>/.obsidian/plugins/<id>/.
// The vault path comes from the SYNC_EVO_VAULT environment variable, or from
// .env.local in the repository root (ignored by git).

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = join(root, ".env.local");

function fail(message) {
	console.error(`install:vault: ${message}`);
	process.exit(1);
}

// Values already in the environment win over the file.
if (!process.env.SYNC_EVO_VAULT && existsSync(envFile)) {
	process.loadEnvFile(envFile);
}

const configured = process.env.SYNC_EVO_VAULT;
if (!configured) {
	fail("set SYNC_EVO_VAULT to the vault folder, in the environment or in .env.local.");
}

const vault = resolve(configured.replace(/^~(?=$|\/)/, homedir()));
const configDir = join(vault, ".obsidian");
if (!existsSync(configDir) || !statSync(configDir).isDirectory()) {
	fail(`no .obsidian folder in ${vault}. Open the folder as a vault once, then try again.`);
}

if (!existsSync(join(root, "main.js"))) {
	fail("main.js not found. Run `npm run build` first.");
}

const { id } = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const target = join(configDir, "plugins", id);
mkdirSync(target, { recursive: true });

for (const name of ["main.js", "manifest.json", "styles.css"]) {
	const source = join(root, name);
	if (!existsSync(source)) continue; // styles.css is optional
	copyFileSync(source, join(target, name));
	console.log(`copied ${name}`);
}
console.log(`installed ${id} into ${target}`);
