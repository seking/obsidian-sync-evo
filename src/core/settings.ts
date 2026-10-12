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
	readonly autoSync: AutoSyncSettings;
	readonly onConflict: ConflictHandling;
}

/**
 * What this device does with a file both sides have changed.
 *
 * - "copy": the remote's content goes to the file, and what the device had
 *   is kept beside it as a file of its own.
 * - "merge": the changes of both sides are put into the one file, line by
 *   line. A file that does not merge is kept as with "copy".
 */
export type ConflictHandling = "merge" | "copy";

/**
 * A merge, also for a device that stored its settings before there was the
 * choice. It can spoil a text without anyone noticing: what the file held
 * before is kept (`MERGED_FOLDER`), and the user can switch to a copy.
 */
export const DEFAULT_ON_CONFLICT: ConflictHandling = "merge";

/** What was stored as the handling of conflicts, or the default for anything that is neither of the two. */
export function conflictHandlingOf(value: unknown): ConflictHandling {
	return value === "merge" || value === "copy" ? value : DEFAULT_ON_CONFLICT;
}

/**
 * When this device syncs without being told to. Never, until the user
 * switches one of the first two on.
 */
export interface AutoSyncSettings {
	/**
	 * When the app starts, and when it comes back to the front from another
	 * app: on a phone the second is what happens, and the first is rare.
	 */
	readonly onStartup: boolean;
	readonly atInterval: boolean;
	/** In minutes, a whole number within the bounds (`clampInterval`). Kept while `atInterval` is off. */
	readonly intervalMinutes: number;
	/**
	 * Whether a sync that starts by itself also sends the changes of this
	 * device. Off, it only pulls, and a note that is half written is not
	 * committed behind the user's back.
	 */
	readonly sendsChanges: boolean;
}

export const DEFAULT_INTERVAL_MINUTES = 15;
/**
 * The shortest interval while automatic sync only pulls. A pull that finds
 * nothing new costs one request that is not counted against the quota.
 */
export const MIN_INTERVAL_MINUTES = 1;
/**
 * The shortest interval while automatic sync also sends. Not for the number
 * of requests: every push is a commit, and a shorter interval would fill
 * the history with commits of notes in the middle of being written.
 */
export const MIN_SENDING_INTERVAL_MINUTES = 5;
/** A day. Longer than that is no interval any more. */
export const MAX_INTERVAL_MINUTES = 1440;

export const DEFAULT_AUTO_SYNC: AutoSyncSettings = {
	onStartup: false,
	atInterval: false,
	intervalMinutes: DEFAULT_INTERVAL_MINUTES,
	sendsChanges: false,
};

/** The shortest interval there can be, by whether automatic sync sends. */
export function minIntervalMinutes(sendsChanges: boolean): number {
	return sendsChanges ? MIN_SENDING_INTERVAL_MINUTES : MIN_INTERVAL_MINUTES;
}

/**
 * The interval that is used for a number of minutes: a whole number within
 * the bounds. What is no number at all is the default.
 */
export function clampInterval(minutes: number, sendsChanges: boolean): number {
	if (!Number.isFinite(minutes)) return DEFAULT_INTERVAL_MINUTES;
	return Math.min(Math.max(Math.round(minutes), minIntervalMinutes(sendsChanges)), MAX_INTERVAL_MINUTES);
}

/**
 * What to store for the text typed into the interval field, or `null` to
 * store nothing and keep what was there: anything but a whole number of
 * minutes within the bounds. Not brought within them, unlike what is read
 * from storage: the user would find another number saved than the one typed.
 */
export function intervalToStore(typed: string, sendsChanges: boolean): number | null {
	const text = typed.trim();
	if (!/^\d+$/.test(text)) return null;
	const minutes = Number(text);
	return minutes >= minIntervalMinutes(sendsChanges) && minutes <= MAX_INTERVAL_MINUTES ? minutes : null;
}

/**
 * The settings with "also sends" switched. Switched on, an interval below
 * the bound for sending is raised to it; switched off, the interval stays.
 */
export function withSendsChanges(auto: AutoSyncSettings, sendsChanges: boolean): AutoSyncSettings {
	return { ...auto, sendsChanges, intervalMinutes: clampInterval(auto.intervalMinutes, sendsChanges) };
}

/**
 * The version of the stored form. It changes when a newer Sync Evo stores
 * something this code would misread. It only ever goes up, by whole numbers:
 * a version that is not a number above this one is not recognised as newer,
 * and is taken for nothing stored. A field that an older version must not
 * drop is such a change too: that version writes back the fields it knows.
 *
 * The settings of automatic sync were added without a change of it. A
 * version from before them drops them when it saves, and reads them as
 * absent: automatic sync is then off, which is where it starts and the safe
 * side. The handling of conflicts was added the same way: read as absent,
 * it is "copy".
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
	return {
		backend: "github",
		repository: "",
		branch: "main",
		tokenSecret: "",
		deviceName: defaultDeviceName,
		autoSync: DEFAULT_AUTO_SYNC,
		onConflict: DEFAULT_ON_CONFLICT,
	};
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
			autoSync: parseAutoSync(raw.autoSync),
			onConflict: conflictHandlingOf(raw.onConflict),
		},
	};
}

// A switch is on only when it was stored as on: anything else, from a
// version that knew no such switch or from a damaged value, is off.
function parseAutoSync(raw: unknown): AutoSyncSettings {
	if (!isRecord(raw)) return DEFAULT_AUTO_SYNC;
	const sendsChanges = raw.sendsChanges === true;
	const minutes = typeof raw.intervalMinutes === "number" ? raw.intervalMinutes : DEFAULT_INTERVAL_MINUTES;
	return {
		onStartup: raw.onStartup === true,
		atInterval: raw.atInterval === true,
		intervalMinutes: clampInterval(minutes, sendsChanges),
		sendsChanges,
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
		autoSync: {
			onStartup: settings.autoSync.onStartup,
			atInterval: settings.autoSync.atInterval,
			intervalMinutes: settings.autoSync.intervalMinutes,
			sendsChanges: settings.autoSync.sendsChanges,
		},
		onConflict: settings.onConflict,
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
// `\p{Cc}` is the control characters: U+0000 to U+001F and U+007F to U+009F.
const DEVICE_NAME_REJECTED = /[\p{Cc}\u2028\u2029*"\\/<>:|?#^[\]]/u;

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
