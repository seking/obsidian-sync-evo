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

// The test of the connection to Google Drive behind the button of the
// settings screen (`connection-check.ts`), with what only Google Drive
// fails with.

import { BackendError } from "../../../../src/core/backend";
import type { ConnectionCheck } from "../../../../src/core/connection-check";
import { DriveDuplicateFolderError, DriveFolderGoneError, GoogleClientSecretMissingError } from "./errors";

/**
 * Asks Google Drive about the folder of the vault, as a sync would find it
 * (`GDriveBackend`), with an access token taken again from the refresh token
 * (R-1): connected when it is there, empty when it is not yet. `find`
 * answers the id of the folder, or `null`. Never throws.
 */
export async function checkDriveFolder(find: () => Promise<string | null>): Promise<ConnectionCheck> {
	try {
		const id = await find();
		return id === null ? { status: "empty" } : { status: "connected", head: "" };
	} catch (error) {
		if (error instanceof DriveFolderGoneError) return { status: "failed", kind: "not-found", detail: error.message };
		if (error instanceof DriveDuplicateFolderError) return { status: "failed", kind: "other", detail: error.message, duplicate: error.folder };
		if (error instanceof GoogleClientSecretMissingError) {
			return { status: "failed", kind: "other", detail: error.message, noClientSecret: true, ...(error.own ? { ownClient: true as const } : {}) };
		}
		if (error instanceof BackendError) return { status: "failed", kind: error.kind, detail: error.message };
		return { status: "failed", kind: "other", detail: error instanceof Error ? error.message : String(error) };
	}
}
