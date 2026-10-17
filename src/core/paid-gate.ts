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
import type { HttpFunction } from "./github/http";
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
import type { DeviceSettings } from "./settings";

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

export interface PaidGateDeps {
	readonly storage: PaidStorage;
	readonly http: HttpFunction;
	readonly now: () => number;
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
}

/** The account the count is of: the service and its id of the account, or `null` for none. */
function accountOf(settings: DeviceSettings): string | null {
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

	/** Whether the paid plan is switched on at all. While it is not, nothing here is stored, asked or shown. */
	get enabled(): boolean {
		return this.deps.enabledAt !== null;
	}

	/**
	 * Where the device stands, for these settings. Asks Dodo about the key
	 * behind it when that is due: the answer counts from the next sync on.
	 */
	standing(settings: DeviceSettings): PaidStanding {
		const { enabledAt, now } = this.deps;
		if (enabledAt === null) return { status: "free" };
		const license = this.license();
		if (settings.backend !== "github" && licenseCheckDue(license, now())) void this.checkKey(settings.deviceName);
		const account = accountOf(settings);
		return paidStanding({
			enabledAt,
			backend: settings.backend,
			ownClient: isOwnClient(settings.gdriveClientId),
			licensed: licenseCounts(licenseStanding(license, now())),
			since: account === null ? null : this.since(account),
			now: now(),
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
		const account = accountOf(settings);
		const told = account === null ? null : this.told(account);
		const warning = dueWarning(standing, told, this.deps.now());
		if (warning !== null && account !== null) this.writeMap(TOLD_KEY, account, warning);
		return { standing, verdict, warning };
	}

	/** Whether a sync with these settings is to learn when the count of the account started: it is not known yet. */
	sinceWanted(settings: DeviceSettings): boolean {
		const account = accountOf(settings);
		return this.enabled && account !== null && this.since(account) === null;
	}

	/**
	 * The count of the account of these settings started at `at`, as the
	 * service says. The earliest that was ever said is kept: the folder or
	 * file made again later does not start it again on this device.
	 */
	sinceLearned(settings: DeviceSettings, at: number): void {
		const account = accountOf(settings);
		if (!this.enabled || account === null) return;
		const known = this.since(account);
		if (known !== null && known <= at) return;
		this.writeMap(SINCE_KEY, account, at);
		// Another start is another end: what was told of the old one is not of it.
		this.writeMap(TOLD_KEY, account, null);
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

	private writeMap(key: string, account: string, value: number | null): void {
		const map = { ...this.readMap(key) };
		if (value === null) delete map[account];
		else map[account] = value;
		this.deps.storage.write(key, map);
	}
}
