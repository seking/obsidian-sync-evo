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
import { DropboxApiError } from "../src/core/dropbox/client";
import { dropboxSince, SINCE_FILE, type SinceClient } from "../src/core/dropbox/since";
import { dropboxFolderToStore } from "../../src/core/settings";

const MADE = "2027-01-10T09:00:00Z";
const OTHER = "2027-01-10T08:59:59Z";

/** The app folder of Dropbox, as far as the file of the free time goes: what is in it, and the calls. */
function appFolder(options: { file?: string; another?: string } = {}) {
	const calls: { endpoint: string; arg: unknown }[] = [];
	let file = options.file;
	const client: SinceClient = {
		rpc: async (endpoint, arg) => {
			calls.push({ endpoint, arg });
			if (file === undefined) throw new DropboxApiError(endpoint, "path/not_found/..");
			return { name: SINCE_FILE, server_modified: file };
		},
		upload: async (arg) => {
			calls.push({ endpoint: "files/upload", arg });
			// Another device made it in between.
			if (options.another !== undefined) {
				file = options.another;
				throw new DropboxApiError("files/upload", "path/conflict/file/..");
			}
			file = MADE;
			return { name: SINCE_FILE, server_modified: MADE };
		},
	};
	return { client, calls };
}

describe("the start of the free time of a Dropbox account", () => {
	test("is the time Dropbox gives the file, when there is one: nothing is written", async () => {
		const { client, calls } = appFolder({ file: MADE });
		expect(await dropboxSince(client, () => 0)).toBe(Date.parse(MADE));
		expect(calls).toEqual([{ endpoint: "files/get_metadata", arg: { path: "/.sync-evo-since" } }]);
	});

	test("is now on Dropbox's clock, when there is none: the file is made without writing over another", async () => {
		const { client, calls } = appFolder();
		expect(await dropboxSince(client, () => 0)).toBe(Date.parse(MADE));
		expect(calls[1]).toEqual({
			endpoint: "files/upload",
			arg: { path: "/.sync-evo-since", mode: "add", autorename: false, mute: true, strict_conflict: false },
		});
	});

	test("is the other device's, when it made the file in the same moment", async () => {
		const { client, calls } = appFolder({ another: OTHER });
		expect(await dropboxSince(client, () => 0)).toBe(Date.parse(OTHER));
		expect(calls.map((call) => call.endpoint)).toEqual(["files/get_metadata", "files/upload", "files/get_metadata"]);
	});

	test("fails as the client does for anything else", async () => {
		const offline: SinceClient = {
			rpc: () => Promise.reject(new BackendError("unreachable", "offline")),
			upload: () => Promise.reject(new Error("never")),
		};
		await expect(dropboxSince(offline, () => 0)).rejects.toMatchObject({ kind: "unreachable" });
		const odd: SinceClient = { rpc: async () => ({ name: SINCE_FILE }), upload: () => Promise.reject(new Error("never")) };
		await expect(dropboxSince(odd, () => 0)).rejects.toMatchObject({ kind: "other" });
	});

	test("is in a file whose name no folder of a vault can have, in any case", () => {
		expect(dropboxFolderToStore(".sync-evo-since")).toBeNull();
		expect(dropboxFolderToStore(" .Sync-Evo-Since ")).toBeNull();
		expect(dropboxFolderToStore(".sync-evo")).toBe(".sync-evo");
	});
});
