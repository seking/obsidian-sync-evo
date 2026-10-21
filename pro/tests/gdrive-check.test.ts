/*
 * Sync Evo
 * Copyright (C) 2026 seking
 *
 * This file is part of the paid part of Sync Evo (the folder pro/), which is
 * licensed under the Elastic License 2.0, not the AGPL. You may not move,
 * change, disable, or circumvent the license key functionality in it. See
 * pro/LICENSE for the full text.
 *
 * Source: https://github.com/seking/obsidian-sync-evo
 */

import { describe, expect, test } from "vitest";
import { BackendError } from "../../src/core/backend";
import type { CheckOutcome } from "../../src/core/connection-check";
import { checkDriveFolder } from "../src/core/gdrive/check";
import { DriveDuplicateFolderError, DriveFolderGoneError, GoogleClientSecretMissingError } from "../src/core/gdrive/errors";

describe("checking the connection to Google Drive", () => {
	test.each<[string, () => Promise<string | null>, CheckOutcome]>([
		["a folder that is there", async () => "f1", { status: "connected", head: "" }],
		["no folder yet", async () => null, { status: "empty" }],
		["a folder that is gone", () => Promise.reject(new DriveFolderGoneError("f1", "gone")), { status: "failed", kind: "not-found", detail: "the folder of the vault on Google Drive is gone: gone" }],
		[
			"two folders of the name",
			() => Promise.reject(new DriveDuplicateFolderError("Sync Evo/Vault")),
			{ status: "failed", kind: "other", detail: "more than one folder Sync Evo/Vault on Google Drive", duplicate: "Sync Evo/Vault" },
		],
		["a connection Google refuses", () => Promise.reject(new BackendError("unauthorized", "x")), { status: "failed", kind: "unauthorized", detail: "x" }],
		[
			"a build without the client secret",
			() => Promise.reject(new GoogleClientSecretMissingError()),
			{ status: "failed", kind: "other", detail: "this build of Sync Evo has no client secret of Google", noClientSecret: true },
		],
		[
			"a client of the user's own without its secret",
			() => Promise.reject(new GoogleClientSecretMissingError(true)),
			{ status: "failed", kind: "other", detail: "no client secret of the user's own Google client", noClientSecret: true, ownClient: true },
		],
	])("%s", async (_what, find, expected) => {
		expect(await checkDriveFolder(find)).toEqual(expected);
	});
});
