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

import { expect, test } from "vitest";
import { nextBetaVersion } from "../scripts/beta-version.mjs";

test("the first beta of a version is beta.1", () => {
	expect(nextBetaVersion("0.0.1", [])).toBe("0.0.1-beta.1");
	expect(nextBetaVersion("0.0.1", ["0.0.1", "0.0.0-beta.4"])).toBe("0.0.1-beta.1");
});

test("the beta number is compared as a number, not as a string", () => {
	expect(nextBetaVersion("0.0.1", ["0.0.1-beta.2", "0.0.1-beta.10"])).toBe("0.0.1-beta.11");
	expect(nextBetaVersion("0.0.1", ["0.0.1-beta.10", "0.0.1-beta.2"])).toBe("0.0.1-beta.11");
});

test("betas of another version are not counted", () => {
	expect(nextBetaVersion("0.0.1", ["0.0.1-beta.2", "0.0.2-beta.5", "10.0.1-beta.7"])).toBe(
		"0.0.1-beta.3",
	);
});

test("tags that are not exactly <version>-beta.<N> are ignored", () => {
	const tags = ["0.0.1-beta.1", "v0.0.1-beta.6", "0.0.1-beta.4.1", "0.0.1-beta.x", "0.0.1-beta."];
	expect(nextBetaVersion("0.0.1", tags)).toBe("0.0.1-beta.2");
});
