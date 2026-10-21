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

import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

// The ESLint part of the automated review on community.obsidian.md, which
// reads the code that ships: the plugin's sources and `package.json`. The
// tests and the build scripts run on Node and are left out. The review also
// looks at `styles.css` and at the release itself, which this does not.
export default defineConfig([
	globalIgnores(["main.js", "tests/", "pro/tests/", "scripts/", "esbuild.config.mjs"]),
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: ["eslint.config.mjs"],
				},
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
]);
