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

// The settings one device keeps for one vault, and the rules about them that
// need no screen: what is stored, which values are accepted, and whether a
// change of them is a change of where the vault syncs to.

/** The remotes there are. Only one for now; the field is kept so that adding one is not a change of format. */
export type BackendId = "github";

export interface DeviceSettings {
	readonly backend: BackendId;
	/** `owner/name`, or whatever was typed while it is not yet in that form. */
	readonly repository: string;
	readonly branch: string;
	/**
	 * The name of a secret in the app's secret storage, never the token
	 * itself. The settings are kept where every vault on the device can read
	 * them, and a name gives nothing away.
	 */
	readonly tokenSecret: string;
	readonly deviceName: string;
}

/**
 * The version of the stored form. It changes when a newer Sync Evo stores
 * something this code would misread. It only ever goes up, by whole numbers:
 * a version that is not a number above this one is not recognised as newer,
 * and is taken for nothing stored.
 */
export const SETTINGS_VERSION = 1;

export interface StoredSettings extends DeviceSettings {
	readonly version: typeof SETTINGS_VERSION;
}

export type ParsedSettings =
	| { readonly status: "ok"; readonly settings: DeviceSettings }
	/**
	 * What is stored was written in a later version of the format. The caller
	 * must neither sync from it nor write over it unless the user says so: a
	 * newer Sync Evo has put there what this one cannot keep.
	 */
	| { readonly status: "newer-version" };

export function defaultSettings(defaultDeviceName: string): DeviceSettings {
	return { backend: "github", repository: "", branch: "main", tokenSecret: "", deviceName: defaultDeviceName };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads what was stored. Never throws: the settings are read while the plugin
 * loads, and a throw there would leave the user without the screen to fix them.
 */
export function parseSettings(raw: unknown, defaultDeviceName: string): ParsedSettings {
	const defaults = defaultSettings(defaultDeviceName);
	if (isRecord(raw) && typeof raw.version === "number" && raw.version > SETTINGS_VERSION) {
		return { status: "newer-version" };
	}
	// Nothing stored, or something no version of Sync Evo writes. The second
	// is taken for the first: none of it can be trusted, and without a
	// connection nothing syncs until the user has entered one again.
	if (!isRecord(raw) || raw.version !== SETTINGS_VERSION) return { status: "ok", settings: defaults };

	const text = (value: unknown, fallback: string): string => (typeof value === "string" ? value : fallback);
	const deviceName = text(raw.deviceName, "").trim();
	return {
		status: "ok",
		settings: {
			backend: defaults.backend,
			// Stored in its form or not at all, like the screen does it.
			repository: normalizeRepository(text(raw.repository, "")) ?? defaults.repository,
			branch: branchToStore(text(raw.branch, "")) ?? defaults.branch,
			tokenSecret: text(raw.tokenSecret, defaults.tokenSecret),
			deviceName: deviceNameProblem(deviceName) === null ? deviceName : defaults.deviceName,
		},
	};
}

export function serializeSettings(settings: DeviceSettings): StoredSettings {
	// Field by field, so that nothing else an object happens to carry is stored.
	return {
		version: SETTINGS_VERSION,
		backend: settings.backend,
		repository: settings.repository,
		branch: settings.branch,
		tokenSecret: settings.tokenSecret,
		deviceName: settings.deviceName,
	};
}

export interface RepositoryName {
	readonly owner: string;
	readonly repo: string;
}

// GitHub allows fewer characters in an owner than in a repository name. The
// wider set is used for both: the point is to keep out what cannot be a name
// at all, and GitHub answers for the rest.
const NAME_PART = /^[A-Za-z0-9._-]+$/;

/**
 * Reads `owner/name`, or the address of the repository as copied from the
 * browser. `null` for anything else.
 */
export function parseRepository(text: string): RepositoryName | null {
	let rest = text.trim().replace(/^https?:\/\/(?:www\.)?github\.com\//i, "");
	if (rest.endsWith("/")) rest = rest.slice(0, -1);
	// The clone address ends in `.git`, and no repository name can.
	if (rest.toLowerCase().endsWith(".git")) rest = rest.slice(0, -4);

	const parts = rest.split("/");
	const [owner, repo] = parts;
	if (parts.length !== 2 || owner === undefined || repo === undefined) return null;
	if (!NAME_PART.test(owner) || !NAME_PART.test(repo)) return null;
	// These would change which path of the API a request goes to.
	if (owner === "." || owner === ".." || repo === "." || repo === "..") return null;
	return { owner, repo };
}

/** The form a repository is stored in, or `null` when the text does not name one. */
export function normalizeRepository(text: string): string | null {
	const name = parseRepository(text);
	return name === null ? null : `${name.owner}/${name.repo}`;
}

/**
 * What to store for the text typed into the repository field: the repository
 * in its stored form, "" for a field left empty, or `null` to store nothing
 * and keep what was there. Text that names no repository is not stored: it
 * would count as no connection, and correcting it as a new one, so a slip of
 * the finger would cost the sync state of the very repository it was.
 * Emptying the field is the way to remove the connection on purpose.
 */
export function repositoryToStore(typed: string): string | null {
	return typed.trim() === "" ? "" : normalizeRepository(typed);
}

/**
 * What to store for the text typed into the branch field, or `null` to store
 * nothing and keep what was there. A field left empty is not stored, for the
 * reason a mistyped repository is not: it would count as no connection. Any
 * other text may be the name of a branch, so it is stored as it is.
 */
export function branchToStore(typed: string): string | null {
	const branch = typed.trim();
	return branch === "" ? null : branch;
}

export type DeviceNameProblem = "empty" | "invalid-character";

// The device name becomes part of the name of a file kept from a conflict and
// of the first line of a commit. So it takes no line break or other control
// character, nothing a file name cannot have on some platform, and nothing
// Obsidian does not allow in the name of a note.
const DEVICE_NAME_REJECTED = /[\u0000-\u001f\u007f-\u009f\u2028\u2029*"\\/<>:|?#^[\]]/;

/** What is wrong with a device name, judged on the name as it would be stored: trimmed. */
export function deviceNameProblem(name: string): DeviceNameProblem | null {
	const trimmed = name.trim();
	if (trimmed === "") return "empty";
	return DEVICE_NAME_REJECTED.test(trimmed) ? "invalid-character" : null;
}

/** The fields of the app's `Platform` that tell the kind of device. */
export interface PlatformKind {
	readonly isIosApp: boolean;
	readonly isAndroidApp: boolean;
	readonly isPhone: boolean;
	readonly isTablet: boolean;
	readonly isMacOS: boolean;
	readonly isWin: boolean;
	readonly isLinux: boolean;
}

export type DefaultDeviceName = "iPhone" | "iPad" | "Android" | "Mac" | "Windows" | "Linux";

export function defaultDeviceName(platform: PlatformKind): DefaultDeviceName {
	// The mobile apps come first: on an iPhone `isMacOS` is true as well
	// (measured on a device), so asking for the desktop systems first would
	// name every iPhone "Mac".
	//
	// `isPhone` and `isTablet` are only looked at inside the iOS app. They are
	// about the size of the screen, and the desktop app sets them too while it
	// emulates mobile.
	if (platform.isIosApp) return platform.isPhone ? "iPhone" : "iPad";
	if (platform.isAndroidApp) return "Android";
	if (platform.isMacOS) return "Mac";
	if (platform.isWin) return "Windows";
	// Also the answer when no field is true. The desktop app is built for
	// three systems, and one that is neither macOS nor Windows is running the
	// Linux build, whatever it calls itself. The name is only a default that
	// the user can change.
	return "Linux";
}

/** Where the vault syncs to. `repository` is always in the form `owner/name`. */
export interface Connection {
	readonly backend: BackendId;
	readonly repository: string;
	readonly branch: string;
}

/**
 * The connection the settings describe, or `null` while they describe none:
 * the repository is not in the form `owner/name`, or there is no branch.
 * Sync must not start without one.
 *
 * The token is not part of it. A connection with no token fails when it is
 * used, and replacing an expired token must not look like a new connection.
 */
export function connectionOf(settings: DeviceSettings): Connection | null {
	const repository = normalizeRepository(settings.repository);
	const branch = settings.branch.trim();
	if (repository === null || branch === "") return null;
	return { backend: settings.backend, repository, branch };
}

export type ConnectionChange =
	| "none"
	/**
	 * From no connection to one. The sync state is discarded for this as well,
	 * even when the connection is the one from some time before: nothing says
	 * that a state left behind belongs to it.
	 */
	| "set"
	| "changed"
	| "cleared";

export function connectionChange(before: Connection | null, after: Connection | null): ConnectionChange {
	if (before === null) return after === null ? "none" : "set";
	if (after === null) return "cleared";
	// GitHub takes owner and repository names in any case, so a change of case
	// alone still names the same repository and must not cost the sync state.
	// Branch names differ by case.
	const same =
		before.backend === after.backend &&
		before.repository.toLowerCase() === after.repository.toLowerCase() &&
		before.branch === after.branch;
	return same ? "none" : "changed";
}
