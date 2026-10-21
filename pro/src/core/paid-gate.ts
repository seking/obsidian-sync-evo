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

// The one part of the paid plan (`paid.ts`) that Dropbox and Google Drive
// share: what a sync is let do, decided before it starts; the key of this
// device, and the questions to Dodo about it (`license.ts`); and what this
// device remembers in between: when the count of each account started, and
// which warning was told.
//
// All of it is kept for the device, not for the vault: the key is bought
// once for every vault, and the count is of the account. And none of it in
// `data.json` (S-4).

import { isOwnClient } from "./gdrive/auth";
import type { HttpFunction } from "../../../src/core/http";
import {
	checkLicense,
	deactivateKey,
	licenseCheckDue,
	licenseCounts,
	type LicenseStanding,
	licenseStanding,
	parseLicense,
	type StoredLicense,
} from "./license";
import { dueWarning, type PaidStanding, paidStanding, type PaidSyncMode, type PaidVerdict, paidVerdict } from "./paid";
import type { BackendId, DeviceSettings } from "../../../src/core/settings";

/** Where the gate keeps what it remembers: values that JSON can hold, by key. */
export interface PaidStorage {
	read(key: string): unknown;
	/** `null` removes the value. */
	write(key: string, value: unknown): void;
}

/** The key of this device, and what Dodo last said of it. */
export const LICENSE_KEY = "sync-evo-license";
/** When the count of each account started, by `backend:account`. */
export const SINCE_KEY = "sync-evo-paid-since";
/** The warning last told for each account (`WARNING_DAYS`), by `backend:account`. */
export const TOLD_KEY = "sync-evo-paid-told";
/**
 * The account each connection is of, as the service named it, by a hash of
 * its refresh token (`connectionKey` in `paid-guard.ts`): `backend:account`.
 */
export const ACCOUNT_KEY = "sync-evo-paid-account";
/**
 * The account the service named for the one the settings name, where the
 * backend learned it (`accountLearned`): what the check before a sync
 * goes by, so that it and the backend agree.
 */
export const NAMED_KEY = "sync-evo-paid-named";

export interface PaidGateDeps {
	readonly storage: PaidStorage;
	readonly http: HttpFunction;
	/** The time of the key: its checks, and its days of grace (`license.ts`). */
	readonly now: () => number;
	/**
	 * The time the plan is decided by: the end of the free time, the
	 * warnings, the time of downloads alone. `now` when absent; ahead of it
	 * in a build to try the plan out (`PAID_CLOCK_OFFSET_DAYS`).
	 */
	readonly planNow?: () => number;
	/** `PAID_ENABLED_AT`, given so that the tests can set it. */
	readonly enabledAt: number | null;
	/** Where Dodo is asked (`DODO_LIVE_API`). */
	readonly api: string;
	/** Whether an activation is of a key of Sync Evo (`isSyncEvoKey`), given for the tests. */
	readonly sold?: (activation: { readonly businessId: string; readonly productId: string | null }) => boolean;
	/** A line for the log, in English. Never the key. */
	readonly log?: (line: string) => void;
}

/** What is decided for one sync before it starts. */
export interface PaidCheck {
	readonly standing: PaidStanding;
	readonly verdict: PaidVerdict;
	/** The days before the end of the free time to tell of now (`dueWarning`), or `null`. Remembered as told. */
	readonly warning: number | null;
	/** The time the plan was judged at (`planNow`), for the days a warning counts. */
	readonly now: number;
}

/**
 * The account the settings name: the service and its id of the account, or
 * `null` for none. Only for what the user is told before a sync; the
 * backends go by the account the service names (`paid-guard.ts`).
 */
export function namedAccount(settings: DeviceSettings): string | null {
	if (settings.backend === "dropbox") return settings.dropboxAccount === null ? null : `dropbox:${settings.dropboxAccount.id}`;
	if (settings.backend === "gdrive") return settings.gdriveAccount === null ? null : `gdrive:${settings.gdriveAccount.id}`;
	return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class PaidGate {
	private readonly deps: PaidGateDeps;
	/** Set while Dodo is being asked about the key, so that it is not asked twice at once. */
	private checking: Promise<void> | null = null;

	constructor(deps: PaidGateDeps) {
		this.deps = deps;
	}

	private planNow(): number {
		return (this.deps.planNow ?? this.deps.now)();
	}

	/** Whether the paid plan is switched on at all. While it is not, nothing here is stored, asked or shown. */
	get enabled(): boolean {
		return this.deps.enabledAt !== null;
	}

	/**
	 * Where the device stands, for these settings. Asks Dodo about the key
	 * behind it when that is due: the answer counts from the next sync on.
	 */
	standing(settings: DeviceSettings): PaidStanding {
		return this.standingOf({
			backend: settings.backend,
			account: this.accountOf(settings),
			ownClient: isOwnClient(settings.gdriveClientId),
			deviceName: settings.deviceName,
		});
	}

	/**
	 * Where the device stands with an account of a service: `standing`, from
	 * the facts themselves. `account` is `backend:account`, or `null` while
	 * it is not known; `ownClient`, whether Google Drive is reached through
	 * a client of the user's own.
	 */
	standingOf(facts: { readonly backend: BackendId; readonly account: string | null; readonly ownClient: boolean; readonly deviceName: string }): PaidStanding {
		const { enabledAt, now } = this.deps;
		if (enabledAt === null) return { status: "free" };
		const license = this.license();
		if (facts.backend !== "github" && licenseCheckDue(license, now())) void this.checkKey(facts.deviceName);
		return paidStanding({
			enabledAt,
			backend: facts.backend,
			ownClient: facts.ownClient,
			licensed: licenseCounts(licenseStanding(license, now())),
			since: facts.account === null ? null : this.since(facts.account),
			now: this.planNow(),
		});
	}

	/**
	 * What a sync of `mode` is let do, with these settings: decided once,
	 * before it starts (`paidVerdict`). A warning it answers is remembered
	 * as told.
	 */
	check(settings: DeviceSettings, mode: PaidSyncMode): PaidCheck {
		const standing = this.standing(settings);
		const verdict = paidVerdict(mode, standing);
		const account = this.accountOf(settings);
		const told = account === null ? null : this.told(account);
		const now = this.planNow();
		const warning = dueWarning(standing, told, now);
		if (warning !== null && account !== null) this.writeMap(TOLD_KEY, account, warning);
		return { standing, verdict, warning, now };
	}

	/** Whether a sync with these settings is to learn when the count of the account started: it is not known yet. */
	sinceWanted(settings: DeviceSettings): boolean {
		return this.sinceWantedOf(this.accountOf(settings));
	}

	/** Whether the start of the count of `account` (`backend:account`) is still to be learned. */
	sinceWantedOf(account: string | null): boolean {
		return this.enabled && account !== null && this.since(account) === null;
	}

	/**
	 * The count of the account of these settings started at `at`, as the
	 * service says. The earliest that was ever said is kept: the folder or
	 * file made again later does not start it again on this device.
	 */
	sinceLearned(settings: DeviceSettings, at: number): void {
		this.sinceLearnedOf(this.accountOf(settings), at);
	}

	/** `sinceLearned`, of `account` (`backend:account`). */
	sinceLearnedOf(account: string | null, at: number): void {
		if (!this.enabled || account === null) return;
		const known = this.since(account);
		if (known !== null && known <= at) return;
		this.writeMap(SINCE_KEY, account, at);
		// Another start is another end: what was told of the old one is not of it.
		this.writeMap(TOLD_KEY, account, null);
	}

	/** The account the connection of `connection` (a hash of its refresh token) was named to be of, or `null`. */
	accountOfConnection(connection: string): string | null {
		const value = this.readMap(ACCOUNT_KEY)[connection];
		return typeof value === "string" ? value : null;
	}

	/**
	 * The service named `account` for the connection of `connection`, which
	 * the settings call `named`: kept, so that it is not asked again, and
	 * so that the check before a sync goes by it as well.
	 */
	accountLearned(connection: string, account: string, named: string | null): void {
		if (!this.enabled) return;
		if (this.accountOfConnection(connection) !== account) this.writeText(ACCOUNT_KEY, connection, account);
		if (named !== null && this.readMap(NAMED_KEY)[named] !== account) this.writeText(NAMED_KEY, named, account);
	}

	/** The account of these settings: the one the service named for it where it was learned, or the one they name. */
	private accountOf(settings: DeviceSettings): string | null {
		const named = namedAccount(settings);
		if (named === null) return null;
		const learned = this.readMap(NAMED_KEY)[named];
		return typeof learned === "string" ? learned : named;
	}

	/** The key of this device and what Dodo said of it, or `null` for none. */
	license(): StoredLicense | null {
		return parseLicense(this.deps.storage.read(LICENSE_KEY));
	}

	licenseStanding(): LicenseStanding {
		return licenseStanding(this.license(), this.deps.now());
	}

	/**
	 * Takes the key typed in the settings: an empty one removes the key of
	 * this device, and ends its activation on Dodo. Another than the one
	 * kept ends the activation of that one, and is activated for this
	 * device, under `deviceName`. Never rejects.
	 */
	async setKey(typed: string, deviceName: string): Promise<LicenseStanding> {
		const key = typed.trim();
		const before = this.license();
		if (before !== null && before.key === key) {
			// The same key again: asked about at once when Dodo turned it
			// down or it has no activation yet, so that one who freed an
			// activation on Dodo does not wait for the next check. An
			// activation that was refused is tried again only so (`licenseCheckDue`).
			if (before.state !== "invalid" && before.instanceId !== null) return this.licenseStanding();
			await this.checking;
			const again: StoredLicense = before.instanceId === null ? { ...before, state: "unchecked", checkedAt: null } : before;
			this.deps.storage.write(LICENSE_KEY, again);
			await this.checkKey(deviceName);
			return this.licenseStanding();
		}
		await this.checking;
		if (before !== null && before.instanceId !== null) {
			// Dodo is told so that the activation is free for another device;
			// the key leaves this one whatever it answers.
			const told = await deactivateKey(this.deps.http, this.deps.api, before.key, before.instanceId);
			this.deps.log?.(`license: the activation of this device ${told ? "was ended" : "could not be ended"}`);
		}
		if (key === "") {
			this.deps.storage.write(LICENSE_KEY, null);
			return this.licenseStanding();
		}
		const fresh: StoredLicense = { key, instanceId: null, state: "unchecked", validAt: null, checkedAt: null };
		this.deps.storage.write(LICENSE_KEY, fresh);
		await this.checkKey(deviceName);
		return this.licenseStanding();
	}

	/** Asks Dodo about the key, once at a time. Never rejects. */
	checkKey(deviceName: string): Promise<void> {
		this.checking ??= this.ask(deviceName).finally(() => {
			this.checking = null;
		});
		return this.checking;
	}

	private async ask(deviceName: string): Promise<void> {
		const stored = this.license();
		if (stored === null) return;
		const { license, detail } = await checkLicense(this.deps.http, this.deps.api, stored, deviceName || "Sync Evo", this.deps.now(), this.deps.sold);
		// The key was changed or removed while Dodo was asked.
		if (this.license()?.key !== stored.key) return;
		this.deps.storage.write(LICENSE_KEY, license);
		this.deps.log?.(`license: ${license.state}${detail === null ? "" : ` (${detail})`}`);
	}

	private since(account: string): number | null {
		const value = this.readMap(SINCE_KEY)[account];
		return typeof value === "number" && Number.isFinite(value) ? value : null;
	}

	private told(account: string): number | null {
		const value = this.readMap(TOLD_KEY)[account];
		return typeof value === "number" ? value : null;
	}

	private readMap(key: string): Record<string, unknown> {
		const value = this.deps.storage.read(key);
		return isRecord(value) ? value : {};
	}

	private writeText(key: string, at: string, value: string): void {
		this.deps.storage.write(key, { ...this.readMap(key), [at]: value });
	}

	private writeMap(key: string, account: string, value: number | null): void {
		const map = { ...this.readMap(key) };
		if (value === null) delete map[account];
		else map[account] = value;
		this.deps.storage.write(key, map);
	}
}
