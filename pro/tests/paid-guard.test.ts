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

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { BackendError, type Backend, type FetchedFile, type PushFile, type RemoteListing } from "../../src/core/backend";
import { DropboxBackend } from "../src/core/dropbox/backend";
import { dropboxSince } from "../src/core/dropbox/since";
import { GDriveBackend } from "../src/core/gdrive/backend";
import { DAY_MS } from "../src/core/paid";
import { ACCOUNT_KEY, FIRST_SEEN_KEY, LICENSE_KEY, NAMED_KEY, SINCE_KEY } from "../src/core/paid-gate";
import { connectionKey, PaidGuard } from "../src/core/paid-guard";
import { FakeDropbox } from "./support/fake-dropbox";
import { FakeDrive } from "./support/fake-gdrive";
import { paidSettings, stubLocalStorage } from "./support/paid";

// The paid plan as the backends of Dropbox and Google Drive keep it
// themselves, with no sync around them to decide it first (T084): what a
// change to the rest of the plugin cannot take away.

// Long enough ago that the end of the free time is three months after the
// start of the count.
const ENABLED = vi.hoisted(() => Date.now() - 400 * 24 * 60 * 60 * 1000);

// The plan switched on, as in the version that switches it on.
vi.mock("../src/core/paid", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/core/paid")>()),
	PAID_ENABLED_AT: ENABLED,
}));

/** A start of the count whose free time ended `daysAgo` days ago, or ends in minus that many. */
function sinceEnded(daysAgo: number): number {
	const since = new Date(Date.now() - daysAgo * DAY_MS);
	since.setUTCMonth(since.getUTCMonth() - 3);
	return since.getTime();
}

const READ_ONLY = 10;
const STOPPED = 60;
const TRIAL = -30;
const REFRESH = "refresh-SECRET";

type Service = "dropbox" | "gdrive";

/** The account each fake is of, as its service names it. */
const ACCOUNT: Record<Service, string> = { dropbox: "dropbox:dbid:1", gdrive: "gdrive:perm1" };

let stored = new Map<string, string>();

const read = (key: string): unknown => JSON.parse(stored.get(key) ?? "null");

/**
 * The local storage of a device that knows the account of the connection,
 * and when its count started (`since`), each unless `null`.
 */
async function known(service: Service, since: number | null, account: string | null = ACCOUNT[service]): Promise<void> {
	if (account !== null) stored.set(ACCOUNT_KEY, JSON.stringify({ [await connectionKey(REFRESH)]: account }));
	if (since !== null) stored.set(SINCE_KEY, JSON.stringify({ [ACCOUNT[service]]: since }));
}

function guardOf(service: Service, askAccount: () => Promise<string>, askSince: () => Promise<number | null>, ownClient = false, log?: (line: string) => void) {
	return new PaidGuard({
		backend: service,
		ownClient,
		refreshToken: REFRESH,
		askAccount,
		askSince,
		settings: paidSettings(service),
		http: () => Promise.reject(new Error("offline")),
		...(log === undefined ? {} : { log }),
	});
}

/** Dropbox with one file in the folder of the vault, and its backend. `since`: what Dropbox says of the start of the count. */
async function dropboxOf(since: number | null = null) {
	const dropbox = new FakeDropbox();
	await dropbox.put("/Vault/a.md", "A");
	dropbox.calls.length = 0;
	const client = {
		// The file of the start, as Dropbox answers for it; the rest as the fake does.
		rpc: async (endpoint: string, arg: unknown) =>
			endpoint === "files/get_metadata" && since !== null ? { name: ".sync-evo-since", server_modified: new Date(since).toISOString() } : dropbox.rpc(endpoint, arg),
		upload: (arg: unknown, content: Uint8Array) => dropbox.upload(arg, content),
	};
	const plan = guardOf(
		"dropbox",
		async () => ((await dropbox.rpc("users/get_current_account", null)) as { account_id: string }).account_id,
		() => dropboxSince(client, Date.now),
	);
	return { remote: new DropboxBackend(dropbox, { folder: "Vault", plan }), calls: dropbox.calls };
}

/** Google Drive with one file in the folder of the vault, kept by its id, made at `madeAt`, and its backend. */
async function driveOf(madeAt = Date.parse("2027-01-10T00:00:00Z"), ownClient = false) {
	const drive = new FakeDrive();
	drive.now = madeAt;
	drive.makeFolder("", "Sync Evo");
	const id = drive.makeFolder("Sync Evo", "Vault");
	await drive.put("Sync Evo/Vault/a.md", "A");
	drive.calls.length = 0;
	const plan: PaidGuard = guardOf(
		"gdrive",
		async () => ((await drive.getJson("https://www.googleapis.com/drive/v3/about?fields=user(permissionId)")) as { user: { permissionId: string } }).user.permissionId,
		() => remote.topCreatedAt(),
		ownClient,
	);
	const remote: GDriveBackend = new GDriveBackend(drive, { folder: "Vault", folderId: id, plan });
	return { remote, calls: drive.calls };
}

const remoteOf = (service: Service) => (service === "dropbox" ? dropboxOf() : driveOf());

/** What a write of the vault sends: one new file. */
function newFile(path: string): PushFile {
	const content = new TextEncoder().encode("new");
	return { path, hash: "", size: content.byteLength, read: async () => content };
}

async function listingOf(remote: Backend): Promise<RemoteListing> {
	const listed = await remote.list(null);
	if (!listed.changed) throw new Error("unchanged");
	return listed.listing;
}

async function fetched(remote: Backend, listing: RemoteListing): Promise<FetchedFile[]> {
	const files: FetchedFile[] = [];
	for await (const file of remote.fetch(listing.revision, listing.entries)) files.push(file);
	return files;
}

async function refusal(work: Promise<unknown>): Promise<string> {
	const error = await work.then(
		() => null,
		(thrown: unknown) => thrown,
	);
	return error instanceof BackendError ? error.kind : String(error);
}

/** Whether anything was sent that writes: an upload, a commit, a folder made, a delete. */
const wrote = (calls: readonly string[]): boolean => calls.some((call) => /upload|finish_batch|delete|^POST|^PATCH/.test(call));

beforeEach(() => {
	stored = stubLocalStorage();
	// A device that has run the plan since it was switched on: no days of a late install.
	stored.set(FIRST_SEEN_KEY, JSON.stringify({ enabledAt: ENABLED, at: ENABLED }));
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe.each<Service>(["dropbox", "gdrive"])("the backend of %s, with the plan switched on", (service) => {
	test("after the free time, it lists and downloads, and refuses to upload", async () => {
		await known(service, sinceEnded(READ_ONLY));
		const { remote, calls } = await remoteOf(service);
		const listing = await listingOf(remote);
		expect(listing.entries.map((entry) => entry.path)).toEqual(["a.md"]);
		expect((await fetched(remote, listing)).map((file) => file.entry.path)).toEqual(["a.md"]);
		expect(await refusal(remote.push({ baseRevision: listing.revision, writes: [newFile("b.md")], deletes: [] }))).toBe("paid-plan");
		expect(await refusal(remote.start?.({ path: "b.md", content: new TextEncoder().encode("B") }) ?? Promise.resolve())).toBe("paid-plan");
		expect(wrote(calls)).toBe(false);
	});

	test("30 days after, it refuses to list as well, and asks the service nothing", async () => {
		await known(service, sinceEnded(STOPPED));
		const { remote, calls } = await remoteOf(service);
		expect(await refusal(remote.list(null))).toBe("paid-plan");
		expect(await refusal(fetched(remote, { revision: null, entries: [{ path: "a.md", kind: "file", hash: "", id: "x" }] }))).toBe("paid-plan");
		expect(await refusal(remote.push({ baseRevision: "r", writes: [newFile("b.md")], deletes: [] }))).toBe("paid-plan");
		expect(calls).toEqual([]);
	});

	test("the account is asked of the service, and not taken from the settings: the count of that one decides", async () => {
		await known(service, sinceEnded(STOPPED), null);
		const { remote, calls } = await remoteOf(service);
		expect(await refusal(remote.list(null))).toBe("paid-plan");
		expect(calls).toEqual([service === "dropbox" ? "users/get_current_account" : "GET about"]);
		// Kept for the connection, and for the check before a sync, which goes by it as well.
		expect(read(ACCOUNT_KEY)).toEqual({ [await connectionKey(REFRESH)]: ACCOUNT[service] });
		expect(read(NAMED_KEY)).toEqual({ [ACCOUNT[service]]: ACCOUNT[service] });
		// Not asked again by the next sync.
		const again = await remoteOf(service);
		expect(await refusal(again.remote.list(null))).toBe("paid-plan");
		expect(again.calls).toEqual([]);
	});

	test.each<[string, number, boolean]>([
		["within the free time", sinceEnded(TRIAL), false],
		["with a license key that counts", sinceEnded(STOPPED), true],
	])("%s, everything goes through", async (_what, since, licensed) => {
		await known(service, since);
		if (licensed) stored.set(LICENSE_KEY, JSON.stringify({ key: "KEY", instanceId: "lki_1", state: "valid", validAt: Date.now(), checkedAt: Date.now() }));
		const { remote, calls } = await remoteOf(service);
		const listing = await listingOf(remote);
		expect(await fetched(remote, listing)).toHaveLength(1);
		const pushed = await remote.push({ baseRevision: listing.revision, writes: [newFile("b.md")], deletes: [] });
		expect(pushed.status).toBe("pushed");
		expect(wrote(calls)).toBe(true);
	});
});

describe("the start of the count, not known yet", () => {
	/** A start of the count long enough ago that nothing syncs any more. */
	const LONG_AGO = Date.now() - 200 * DAY_MS;

	test("Dropbox: the guard reads it from the file at the top of the app folder first, keeps it, and decides with it", async () => {
		await known("dropbox", null);
		const { remote, calls } = await dropboxOf(LONG_AGO);
		expect(await refusal(remote.list(null))).toBe("paid-plan");
		expect(read(SINCE_KEY)).toEqual({ [ACCOUNT.dropbox]: LONG_AGO });
		expect(calls).toEqual([]);
	});

	test("Google Drive: the guard asks when the folder Sync Evo was made first, keeps it, and decides with it", async () => {
		await known("gdrive", null);
		const { remote, calls } = await driveOf(LONG_AGO);
		expect(await refusal(remote.list(null))).toBe("paid-plan");
		expect(read(SINCE_KEY)).toEqual({ [ACCOUNT.gdrive]: LONG_AGO });
		// The folder by its id, the folders of the same name, and the folder Sync Evo: no listing.
		expect(calls).toEqual(["GET file", "GET files", "GET file"]);
		expect(await refusal(remote.push({ baseRevision: "r", writes: [newFile("b.md")], deletes: [] }))).toBe("paid-plan");
	});

	test("an account that cannot be read fails the call, as the listing would, and nothing is sent", async () => {
		const dropbox = new FakeDropbox();
		await dropbox.put("/Vault/a.md", "A");
		dropbox.calls.length = 0;
		let asked = 0;
		const offline = async (): Promise<never> => {
			asked += 1;
			throw new BackendError("unreachable", "offline");
		};
		const remote = new DropboxBackend(dropbox, { folder: "Vault", plan: guardOf("dropbox", offline, offline) });
		expect(await refusal(remote.list(null))).toBe("unreachable");
		expect(await refusal(remote.push({ baseRevision: "r", writes: [newFile("b.md")], deletes: [] }))).toBe("unreachable");
		expect(asked).toBe(1);
		expect(dropbox.calls).toEqual([]);
	});

	test("a start that cannot be read is logged once, and the sync goes on as within the free time", async () => {
		await known("dropbox", null);
		const lines: string[] = [];
		const dropbox = new FakeDropbox();
		await dropbox.put("/Vault/a.md", "A");
		let asked = 0;
		const offline = async (): Promise<never> => {
			asked += 1;
			throw new BackendError("unreachable", "offline");
		};
		const plan = guardOf("dropbox", offline, offline, false, (line) => lines.push(line));
		const remote = new DropboxBackend(dropbox, { folder: "Vault", plan });
		const listing = await listingOf(remote);
		expect(await plan.learnSince()).toBeNull();
		await remote.push({ baseRevision: listing.revision, writes: [newFile("b.md")], deletes: [] });
		expect(asked).toBe(1);
		expect(lines).toEqual(["paid: the start of the free time could not be read: BackendError unreachable"]);
	});

	test("a stop while it is asked for ends the call as stopped", async () => {
		await known("dropbox", null);
		const stop = () => Promise.reject(new BackendError("cancelled", "stopped"));
		const remote = new DropboxBackend(new FakeDropbox(), { folder: "Vault", plan: guardOf("dropbox", stop, stop) });
		expect(await refusal(remote.list(null))).toBe("cancelled");
	});
});

test("Google Drive through a client of the user's own is free, after the free time too", async () => {
	await known("gdrive", sinceEnded(STOPPED));
	const { remote, calls } = await driveOf(undefined, true);
	const listing = await listingOf(remote);
	const pushed = await remote.push({ baseRevision: listing.revision, writes: [newFile("b.md")], deletes: [] });
	expect(pushed.status).toBe("pushed");
	expect(wrote(calls)).toBe(true);
});
