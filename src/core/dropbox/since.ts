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

// When an account of Dropbox began to sync with Sync Evo, for the free time
// of the paid plan (`paid.ts`). A folder of Dropbox has no time it was made,
// so Sync Evo puts a small file at the top of its app folder, beside the
// folders of the vaults, the first time it looks for one, and goes by the
// time Dropbox gives that file (`server_modified`), which no device's clock
// can change. Per account and not per vault: a new name of the folder of a
// vault does not start the count again. Deleting the file does, which is
// accepted.

import { BackendError } from "../backend";
import { DROPBOX_SINCE_FILE } from "../settings";
import { DropboxApiError } from "./client";

/** The name of the file, at the top of the app folder (`DROPBOX_SINCE_FILE`). */
export const SINCE_FILE = DROPBOX_SINCE_FILE;

/** The calls of the client the file is read and written with. */
export interface SinceClient {
	rpc(endpoint: string, arg: unknown): Promise<unknown>;
	upload(arg: unknown, content: Uint8Array): Promise<unknown>;
}

function serverModified(what: string, json: unknown): number {
	const value = typeof json === "object" && json !== null ? (json as Record<string, unknown>).server_modified : undefined;
	const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
	if (!Number.isFinite(time)) throw new BackendError("other", `${what}: the response is not in the expected form`);
	return time;
}

/**
 * When the count of the account started: the time of the file, made now
 * when there is none. Two devices that make it at the same moment do not
 * write over each other: it is sent so that an existing file is left as it
 * is (`mode: add` without a new name), and the one that loses reads the
 * winner's. Fails as the client does.
 */
export async function dropboxSince(client: SinceClient, now: () => number): Promise<number> {
	const path = `/${SINCE_FILE}`;
	try {
		return serverModified("read the start of the free time", await client.rpc("files/get_metadata", { path }));
	} catch (error) {
		if (!(error instanceof BackendError && error.kind === "not-found")) throw error;
	}
	// What is in it is for whoever opens it; only its time is read.
	const content = new TextEncoder().encode(`Sync Evo began to sync with this Dropbox account on ${new Date(now()).toISOString()}.\n`);
	try {
		return serverModified(
			"write the start of the free time",
			await client.upload({ path, mode: "add", autorename: false, mute: true, strict_conflict: false }, content),
		);
	} catch (error) {
		if (!(error instanceof DropboxApiError && error.is("path", "conflict"))) throw error;
	}
	return serverModified("read the start of the free time", await client.rpc("files/get_metadata", { path }));
}
