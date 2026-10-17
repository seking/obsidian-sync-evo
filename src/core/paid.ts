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

// The paid plan of Dropbox and Google Drive (T082): GitHub is free for good;
// Dropbox and Google Drive are free for the first three months, and then
// need a license key, one for both. Nothing of it is decided or shown until
// the day it is switched on is set here (`PAID_ENABLED_AT`).
//
// The three months are counted per account of the service, from a time the
// service keeps: on Google Drive the folder `Sync Evo` at the top, made by
// the first sync of the account; on Dropbox a file Sync Evo puts at the top
// of its app folder (`dropbox/since.ts`); and never from before the day
// the plan was switched on (`countStart`). What decides is the clock of the
// device. Turning it back, deleting that folder or file, or another account
// starts the count again: that is accepted, as the check of the key is, on
// a device whose code anyone can change. It asks honest users to pay.

import type { Translate } from "./i18n";
import type { LicenseStanding } from "./license";
import type { BackendId } from "./settings";

/**
 * The day the paid plan was switched on, in milliseconds since the epoch,
 * or `null` while it is not: nothing is then decided, stored or shown, and
 * Sync Evo works as it did before. The one value to set, in the version
 * that switches it on (T082).
 */
export const PAID_ENABLED_AT: number | null = null;

/** How long Dropbox and Google Drive are free, from the start of the count of an account. */
export const FREE_MONTHS = 3;
/** How long, after the free time, a device still downloads, with the uploads stopped. */
export const READ_ONLY_DAYS = 30;
/** How many days before the end of the free time it is told, each once. */
export const WARNING_DAYS: readonly number[] = [14, 7];

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `time` that many months later, at the same time of day. A day the month
 * does not have is its last day: three months after 30 November is the end
 * of February, and not a day in March.
 */
export function addMonths(time: number, months: number): number {
	const at = new Date(time);
	const day = at.getUTCDate();
	at.setUTCDate(1);
	at.setUTCMonth(at.getUTCMonth() + months);
	const last = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0)).getUTCDate();
	at.setUTCDate(Math.min(day, last));
	return at.getTime();
}

/**
 * When the count of an account starts: when the service says the account
 * began to sync with Sync Evo, but never before the plan was switched on.
 * Every account, of Google Drive or of Dropbox, has its three months from
 * that day at the least, however long it synced before (2026-10-18).
 */
export function countStart(since: number, enabledAt: number): number {
	return Math.max(since, enabledAt);
}

/** When the free time of an account ends: three months after the count started (`countStart`). */
export function freeUntil(since: number, enabledAt: number): number {
	return addMonths(countStart(since, enabledAt), FREE_MONTHS);
}

/** What the paid plan is decided from, for one sync. */
export interface PaidFacts {
	/** `PAID_ENABLED_AT`, given so that the tests can set it. */
	readonly enabledAt: number | null;
	readonly backend: BackendId;
	/**
	 * Google Drive through a client of the user's own: the project of
	 * Sync Evo is not used, and there is nothing to pay for.
	 */
	readonly ownClient: boolean;
	/** Whether this device holds a key that counts (`licenseCounts`). */
	readonly licensed: boolean;
	/** When the count of the account started, as far as this device knows, or `null` while it does not. */
	readonly since: number | null;
	readonly now: number;
}

/**
 * Where the device stands with the paid plan.
 *
 * - "free": nothing applies: the plan is off, the service is GitHub, the
 *   client is the user's own, or the device holds a key.
 * - "trial": within the free time. `endsAt` is `null` while the start of
 *   the count is not known yet: the sync that learns it goes ahead.
 * - "read-only": the free time is over. Downloads go on until `stopsAt`;
 *   nothing is uploaded.
 * - "stopped": that time is over too. Nothing syncs.
 */
export type PaidStanding =
	| { readonly status: "free" }
	| { readonly status: "trial"; readonly endsAt: number | null }
	| { readonly status: "read-only"; readonly endedAt: number; readonly stopsAt: number }
	| { readonly status: "stopped"; readonly endedAt: number };

const FREE: PaidStanding = { status: "free" };

export function paidStanding(facts: PaidFacts): PaidStanding {
	if (facts.enabledAt === null || facts.backend === "github" || facts.licensed) return FREE;
	if (facts.backend === "gdrive" && facts.ownClient) return FREE;
	if (facts.since === null) return { status: "trial", endsAt: null };
	const endsAt = freeUntil(facts.since, facts.enabledAt);
	if (facts.now < endsAt) return { status: "trial", endsAt };
	const stopsAt = endsAt + READ_ONLY_DAYS * DAY_MS;
	if (facts.now < stopsAt) return { status: "read-only", endedAt: endsAt, stopsAt };
	return { status: "stopped", endedAt: endsAt };
}

/** The kinds of sync, as `SyncRunner` names them. */
export type PaidSyncMode = "sync" | "pull" | "push" | "first-fetch" | "untrack";

/**
 * What a sync does under the paid plan. `mode`: the sync that runs, or
 * `null` when none does. `note`: what the user is told about it, or
 * `null` for nothing.
 */
export interface PaidVerdict {
	readonly mode: PaidSyncMode | null;
	readonly note: "read-only" | "stopped" | null;
}

/**
 * Decided before a sync starts, never in the middle of one. After the free
 * time, a download still runs for a while, so that what another device
 * sent just before is not left behind: a sync becomes a download, which
 * writes nothing to the remote. What sends is not run: an upload, and an
 * untracking, which removes files from the remote. A first upload into a
 * folder that is not there yet is part of an upload.
 */
export function paidVerdict(mode: PaidSyncMode, standing: PaidStanding): PaidVerdict {
	switch (standing.status) {
		case "free":
		case "trial":
			return { mode, note: null };
		case "read-only":
			if (mode === "sync") return { mode: "pull", note: "read-only" };
			if (mode === "pull" || mode === "first-fetch") return { mode, note: "read-only" };
			return { mode: null, note: "read-only" };
		case "stopped":
			return { mode: null, note: "stopped" };
	}
}

/**
 * The number of days before the end of the free time that is to be told
 * now (`WARNING_DAYS`), or `null`. `told`: the one last told for this
 * account, or `null`. Only the nearest that has come is told: a device
 * that was not used for a week is not told of two weeks after it was told
 * of one.
 */
export function dueWarning(standing: PaidStanding, told: number | null, now: number): number | null {
	if (standing.status !== "trial" || standing.endsAt === null) return null;
	const left = standing.endsAt - now;
	const come = [...WARNING_DAYS].sort((a, b) => a - b).find((days) => left <= days * DAY_MS);
	if (come === undefined) return null;
	return told === null || told > come ? come : null;
}

/** The day of `time` on the device, as "2027-01-17". */
export function dayOf(time: number): string {
	const at = new Date(time);
	const two = (value: number): string => String(value).padStart(2, "0");
	return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
}

/**
 * What a sync is told with, when the paid plan changed what it does or
 * keeps it from running (`PaidVerdict.note`), or `null` when it did not.
 */
export function paidNoteText(t: Translate, verdict: PaidVerdict, standing: PaidStanding): string | null {
	if (standing.status === "stopped") return t("paid.stopped", { ended: dayOf(standing.endedAt) });
	if (standing.status !== "read-only" || verdict.note === null) return null;
	const dates = { ended: dayOf(standing.endedAt), stops: dayOf(standing.stopsAt) };
	return verdict.mode === null ? t("paid.readOnly.blocked", dates) : t("paid.readOnly.pulling", dates);
}

/** The warning of the end of the free time, `days` before it (`dueWarning`). */
export function paidWarningText(t: Translate, standing: PaidStanding, days: number): string | null {
	if (standing.status !== "trial" || standing.endsAt === null) return null;
	return t("paid.warning", { count: days, date: dayOf(standing.endsAt) });
}

/** What the settings show of the paid plan: where the device stands, and its key. */
export interface PaidInfo {
	readonly standing: PaidStanding;
	readonly license: LicenseStanding;
	/** The key this device holds, or "". */
	readonly key: string;
	/** Google Drive through a client of the user's own (`isOwnClient`). */
	readonly ownClient: boolean;
}

/** The lines the settings show under the field of the key, in order. */
export function paidStatusLines(t: Translate, info: PaidInfo): string[] {
	if (info.ownClient) return [t("settings.license.ownClient")];
	const lines: string[] = [];
	const { license, standing } = info;
	if (license.status === "valid") lines.push(t("settings.license.valid"));
	else if (license.status === "grace") lines.push(t("settings.license.grace", { since: dayOf(license.since), until: dayOf(license.until) }));
	else if (license.status === "unconfirmed") lines.push(t("settings.license.unconfirmed"));
	else if (license.status === "invalid") lines.push(t("settings.license.invalid"));
	switch (standing.status) {
		case "free":
			break;
		case "trial":
			lines.push(standing.endsAt === null ? t("settings.license.trialUnknown") : t("settings.license.trial", { date: dayOf(standing.endsAt) }));
			break;
		case "read-only":
			lines.push(t("settings.license.readOnly", { ended: dayOf(standing.endedAt), stops: dayOf(standing.stopsAt) }));
			break;
		case "stopped":
			lines.push(t("settings.license.stopped", { ended: dayOf(standing.endedAt) }));
			break;
	}
	return lines;
}
