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

// The test of the connection behind the button of the settings screen: what
// is asked of the remote, and the text for each way it can turn out. The
// screen only supplies the token and the client, and shows the text.

import { BackendError, type BackendErrorKind } from "./backend";
import { DriveDuplicateFolderError, DriveFolderGoneError, GoogleClientSecretMissingError } from "./gdrive/errors";
import type { GitHubClient } from "./github/client";
import type { Translate } from "./i18n";
import { type DeviceSettings, dropboxFolderToStore, parseRepository } from "./settings";

export type ConnectionCheck =
	| { readonly status: "connected"; readonly head: string }
	/** The repository has no commit yet. A new repository starts like this, so it is not a failure. */
	| { readonly status: "empty" }
	| {
			readonly status: "failed";
			readonly kind: BackendErrorKind;
			readonly detail: string;
			/** Of Google Drive: the folder there is more than one of (`DriveDuplicateFolderError`). */
			readonly duplicate?: string;
			/** Of Google Drive: the build has no client secret (`GoogleClientSecretMissingError`). */
			readonly noClientSecret?: true;
	  };

/**
 * Asks for the head of the branch, the one call that tells apart everything
 * the user can have got wrong: the token, its permission, the repository,
 * and the branch. Never throws.
 */
export async function checkConnection(client: Pick<GitHubClient, "resolveHead">): Promise<ConnectionCheck> {
	try {
		const head = await client.resolveHead();
		return head.status === "empty" ? { status: "empty" } : { status: "connected", head: head.sha };
	} catch (error) {
		if (error instanceof BackendError) return { status: "failed", kind: error.kind, detail: error.message };
		return { status: "failed", kind: "other", detail: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * What the settings lack for a request to be worth sending. "dropbox-folder":
 * no folder of the vault on Dropbox is set. "dropbox-account": this device
 * is not connected to Dropbox, or no longer.
 */
export type NotReadyReason =
	| "repository"
	| "branch"
	| "token-secret"
	| "token-value"
	| "dropbox-folder"
	| "dropbox-account"
	| "gdrive-folder"
	| "gdrive-account";

export interface GitHubCheckTarget {
	readonly kind?: "github";
	readonly owner: string;
	readonly repo: string;
	readonly branch: string;
	readonly token: string;
}

export interface DropboxCheckTarget {
	readonly kind: "dropbox";
	readonly folder: string;
	readonly refreshToken: string;
}

export interface DriveCheckTarget {
	readonly kind: "gdrive";
	readonly folder: string;
	/** The id of the folder this device keeps (`DeviceSettings.gdriveFolderId`). */
	readonly folderId: string | null;
	readonly refreshToken: string;
	/** `DeviceSettings.gdriveClientId`. */
	readonly clientId?: string;
}

export type CheckTarget = GitHubCheckTarget | DropboxCheckTarget | DriveCheckTarget;

export type CheckPreparation =
	| { readonly status: "ready"; readonly target: CheckTarget }
	| { readonly status: "not-ready"; readonly reason: NotReadyReason };

/**
 * Gathers what a request needs. `readSecret` answers the value stored under
 * a name, or `null` when there is none; it is only called once the rest is
 * in place.
 */
export function prepareCheck(
	settings: DeviceSettings,
	readSecret: (name: string) => string | null,
	readDropboxToken: () => string | null = () => null,
	readDriveToken: () => string | null = () => null,
): CheckPreparation {
	if (settings.backend === "gdrive") {
		const folder = dropboxFolderToStore(settings.gdriveFolder);
		if (folder === null) return { status: "not-ready", reason: "gdrive-folder" };
		const refreshToken = settings.gdriveAccount === null ? null : readDriveToken();
		if (refreshToken === null || refreshToken === "") return { status: "not-ready", reason: "gdrive-account" };
		return {
			status: "ready",
			target: {
				kind: "gdrive",
				folder,
				folderId: settings.gdriveFolderId,
				refreshToken,
				...(settings.gdriveClientId === undefined ? {} : { clientId: settings.gdriveClientId }),
			},
		};
	}
	if (settings.backend === "dropbox") {
		const folder = dropboxFolderToStore(settings.dropboxFolder);
		if (folder === null) return { status: "not-ready", reason: "dropbox-folder" };
		const refreshToken = settings.dropboxAccount === null ? null : readDropboxToken();
		if (refreshToken === null || refreshToken === "") return { status: "not-ready", reason: "dropbox-account" };
		return { status: "ready", target: { kind: "dropbox", folder, refreshToken } };
	}
	const repository = parseRepository(settings.repository);
	if (repository === null) return { status: "not-ready", reason: "repository" };
	const branch = settings.branch.trim();
	if (branch === "") return { status: "not-ready", reason: "branch" };
	if (settings.tokenSecret === "") return { status: "not-ready", reason: "token-secret" };
	// A secret can be deleted from the app's own screen after it was chosen here.
	const token = (readSecret(settings.tokenSecret) ?? "").trim();
	if (token === "") return { status: "not-ready", reason: "token-value" };
	return { status: "ready", target: { owner: repository.owner, repo: repository.repo, branch, token } };
}

export type CheckOutcome = ConnectionCheck | { readonly status: "not-ready"; readonly reason: NotReadyReason };

/**
 * The whole test: prepare, then ask. `clientFor` is called at most once.
 * Never throws, so that the screen always has a text to show.
 */
export async function runConnectionCheck(
	settings: DeviceSettings,
	readSecret: (name: string) => string | null,
	clientFor: (target: GitHubCheckTarget) => Pick<GitHubClient, "resolveHead">,
	dropbox?: {
		readonly readToken: () => string | null;
		/** Asks Dropbox about the folder; never throws. */
		readonly check: (target: DropboxCheckTarget) => Promise<ConnectionCheck>;
	},
	gdrive?: {
		readonly readToken: () => string | null;
		/** Asks Google Drive about the folder; never throws. */
		readonly check: (target: DriveCheckTarget) => Promise<ConnectionCheck>;
	},
): Promise<CheckOutcome> {
	try {
		const prepared = prepareCheck(settings, readSecret, dropbox?.readToken, gdrive?.readToken);
		if (prepared.status === "not-ready") return prepared;
		const { target } = prepared;
		if (target.kind === "gdrive") {
			if (gdrive === undefined) return { status: "failed", kind: "other", detail: "no way to reach Google Drive" };
			return await gdrive.check(target);
		}
		if (target.kind === "dropbox") {
			if (dropbox === undefined) return { status: "failed", kind: "other", detail: "no way to reach Dropbox" };
			return await dropbox.check(target);
		}
		return await checkConnection(clientFor(target));
	} catch (error) {
		return { status: "failed", kind: "other", detail: error instanceof Error ? error.message : String(error) };
	}
}

/** Whether the outcome is one to show as good news. */
export function isSuccess(outcome: CheckOutcome): boolean {
	return outcome.status === "connected" || outcome.status === "empty";
}

/**
 * Asks Dropbox about the folder of the vault, with an access token taken
 * again from the refresh token (R-4): connected when it is there, empty
 * when it is not yet, which the first upload makes it. Never throws.
 */
export async function checkDropboxFolder(
	client: { rpc(endpoint: string, arg: unknown): Promise<unknown> },
	folder: string,
): Promise<ConnectionCheck> {
	try {
		await client.rpc("files/get_metadata", { path: `/${folder}` });
		return { status: "connected", head: "" };
	} catch (error) {
		if (error instanceof BackendError) {
			return error.kind === "not-found" ? { status: "empty" } : { status: "failed", kind: error.kind, detail: error.message };
		}
		return { status: "failed", kind: "other", detail: error instanceof Error ? error.message : String(error) };
	}
}

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
		if (error instanceof GoogleClientSecretMissingError) return { status: "failed", kind: "other", detail: error.message, noClientSecret: true };
		if (error instanceof BackendError) return { status: "failed", kind: error.kind, detail: error.message };
		return { status: "failed", kind: "other", detail: error instanceof Error ? error.message : String(error) };
	}
}

/** The text to show for an outcome. `settings` are the ones the test was run with. */
export function connectionCheckText(t: Translate, settings: DeviceSettings, outcome: CheckOutcome): string {
	if (settings.backend === "dropbox") return dropboxCheckText(t, settings, outcome);
	if (settings.backend === "gdrive") return driveCheckText(t, settings, outcome);
	const parsed = parseRepository(settings.repository);
	const repository = parsed === null ? settings.repository.trim() : `${parsed.owner}/${parsed.repo}`;
	const branch = settings.branch.trim();

	if (outcome.status === "connected") return t("check.connected", { repository, branch });
	if (outcome.status === "empty") return t("check.empty", { repository });
	if (outcome.status === "not-ready") {
		switch (outcome.reason) {
			case "repository":
				return t("check.noRepository");
			case "branch":
				return t("check.noBranch");
			case "token-secret":
				return t("check.noTokenSecret");
			case "token-value":
				return t("check.noTokenValue", { name: settings.tokenSecret });
			// Of Dropbox: not met with GitHub chosen.
			case "dropbox-folder":
				return t("check.dropbox.noFolder");
			case "dropbox-account":
				return t("check.dropbox.notConnected");
			case "gdrive-folder":
				return t("check.gdrive.noFolder");
			case "gdrive-account":
				return t("check.gdrive.notConnected");
		}
	}
	switch (outcome.kind) {
		case "unauthorized":
			return t("check.unauthorized");
		case "forbidden":
			return t("check.forbidden", { repository });
		case "not-found":
			return t("check.notFound", { repository });
		case "branch-not-found":
			return t("check.branchNotFound", { repository, branch });
		case "unreachable":
			return t("check.unreachable");
		case "rate-limited":
			return t("check.rateLimited");
		// The kinds a read of the head does not produce, and "other". The
		// detail is in English and for developers, but it is all there is to
		// go on. They are listed, with no `default`, so that a kind added
		// later fails the type check here until it is given a text.
		case "incomplete-listing":
		case "workflows-permission":
		case "too-large":
		case "not-as-listed":
		case "cancelled":
		case "other":
			return t("check.other", { detail: outcome.detail });
		default:
			return unhandled(outcome.kind);
	}
}

function dropboxCheckText(t: Translate, settings: DeviceSettings, outcome: CheckOutcome): string {
	const folder = settings.dropboxFolder.trim();
	if (outcome.status === "connected") return t("check.dropbox.connected", { folder });
	if (outcome.status === "empty") return t("check.dropbox.empty", { folder });
	if (outcome.status === "not-ready") {
		return outcome.reason === "dropbox-folder" ? t("check.dropbox.noFolder") : t("check.dropbox.notConnected");
	}
	switch (outcome.kind) {
		case "unauthorized":
			return t("check.dropbox.unauthorized");
		case "forbidden":
			return t("check.dropbox.forbidden");
		case "unreachable":
			return t("check.unreachable");
		case "rate-limited":
			return t("check.rateLimited");
		default:
			return t("check.other", { detail: outcome.detail });
	}
}

function driveCheckText(t: Translate, settings: DeviceSettings, outcome: CheckOutcome): string {
	const folder = settings.gdriveFolder.trim();
	if (outcome.status === "connected") return t("check.gdrive.connected", { folder });
	if (outcome.status === "empty") return t("check.gdrive.empty", { folder });
	if (outcome.status === "not-ready") {
		return outcome.reason === "gdrive-folder" ? t("check.gdrive.noFolder") : t("check.gdrive.notConnected");
	}
	if (outcome.duplicate !== undefined) return t("gdrive.duplicateFolder", { folder: outcome.duplicate });
	if (outcome.noClientSecret === true) return t("gdrive.noClientSecret");
	switch (outcome.kind) {
		case "unauthorized":
			return t("check.gdrive.unauthorized");
		case "forbidden":
			return t("check.gdrive.forbidden");
		case "not-found":
			return t("gdrive.folderGone", { folder });
		case "unreachable":
			return t("check.unreachable");
		case "rate-limited":
			return t("check.rateLimited");
		default:
			return t("check.other", { detail: outcome.detail });
	}
}

/** Reached only by a kind the types do not know of. Still answers a text, since the screen has to show one. */
function unhandled(kind: never): string {
	return String(kind);
}
