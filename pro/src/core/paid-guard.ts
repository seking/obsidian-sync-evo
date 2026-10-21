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

// What a backend of Dropbox or Google Drive is let do under the paid plan
// (`paid.ts`), decided by the backend itself. The sync decides it as well
// before it starts, and tells the user (`PaidGate.check`); a backend that
// is asked anyway refuses. Here, and not in the sync, so that the refusal
// is part of the paid part of Sync Evo.
//
// Decided once for a backend, at its first call: a backend is made for
// each sync, and the plan is never changed in the middle of one.

import { BackendError } from "../../../src/core/backend";
import { failureLine } from "../../../src/core/failure-line";
import type { HttpFunction } from "../../../src/core/http";
import type { DeviceSettings } from "../../../src/core/settings";
import { appPaidGate } from "./app-gate";
import { DriveDuplicateFolderError, DriveFolderGoneError } from "./gdrive/errors";
import type { PaidStanding } from "./paid";
import { namedAccount, type PaidGate } from "./paid-gate";

/**
 * What a call does with the remote. "read": it lists or downloads, which
 * goes on for a while after the free time. "write": it uploads, which
 * does not.
 */
export type PaidAccess = "read" | "write";

/**
 * What the plan of a backend is decided by. None of it is read from the
 * settings: the service, and whether the client is the user's own, are
 * those of the client the backend is made with, and the account is the
 * one the service names.
 */
export interface PaidGuardDeps {
	readonly backend: "dropbox" | "gdrive";
	/**
	 * Google Drive through a client of the user's own: the client the
	 * tokens are taken with (`isOwnClient`).
	 */
	readonly ownClient: boolean;
	/** The refresh token of the client: what the account it is of is remembered by. */
	readonly refreshToken: string;
	/** Asks the service which account the client is of: its id of the account. Fails as the client does. */
	readonly askAccount: () => Promise<string>;
	/**
	 * Asks the service when the count of the free time of the account
	 * started: `null` when it cannot tell yet. Fails as the client does.
	 */
	readonly askSince: () => Promise<number | null>;
	/**
	 * The settings of the sync: for the name of the device, under which a
	 * key is activated, and for the check before a sync to learn the
	 * account they turned out to be of. Never what the plan is decided by.
	 */
	readonly settings: DeviceSettings;
	/** How the plan reaches Dodo (`PlanReach`). */
	readonly http: HttpFunction;
	/** A line for the log, in English. */
	readonly log?: (line: string) => void;
}

/** What a refresh token is remembered by: its SHA-256, in hex. Never the token itself. */
export async function connectionKey(refreshToken: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(refreshToken)));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Whether `standing` lets a call of `access` go to the remote. */
function allows(standing: PaidStanding, access: PaidAccess): boolean {
	switch (standing.status) {
		case "free":
		case "trial":
			return true;
		case "read-only":
			return access === "read";
		case "stopped":
			return false;
	}
}

function isCancelled(error: unknown): boolean {
	return error instanceof BackendError && error.kind === "cancelled";
}

export class PaidGuard {
	private readonly deps: PaidGuardDeps;
	/** Set once the service was asked which account the client is of (`account`). */
	private learningAccount: Promise<string> | null = null;
	/** Set once the service was asked when the count started (`learnSince`). */
	private learning: Promise<number | null> | null = null;
	/** Set at the first call: where the device stands, for every call after it. */
	private deciding: Promise<PaidStanding> | null = null;

	constructor(deps: PaidGuardDeps) {
		this.deps = deps;
	}

	/** The plan of the app: never one of the caller's. */
	private gate(): PaidGate {
		return appPaidGate({ http: this.deps.http, log: this.deps.log ?? (() => {}) });
	}

	/**
	 * The account the client is of (`backend:account`), as the service
	 * names it: remembered for the refresh token, and asked once where it
	 * is not. Fails when it could not be asked, as the listing would on the
	 * same network: a sync is never let through for want of the account.
	 */
	private account(): Promise<string> {
		this.learningAccount ??= this.learnAccount();
		return this.learningAccount;
	}

	private async learnAccount(): Promise<string> {
		const { backend, refreshToken, askAccount, settings } = this.deps;
		const gate = this.gate();
		const connection = await connectionKey(refreshToken);
		const known = gate.accountOfConnection(connection);
		if (known !== null) {
			gate.accountLearned(connection, known, namedAccount(settings));
			return known;
		}
		const account = `${backend}:${await askAccount()}`;
		gate.accountLearned(connection, account, namedAccount(settings));
		return account;
	}

	/**
	 * When the count of the account started, asked of the service once for
	 * this guard, and kept for the account the service names
	 * (`PaidGate.sinceLearnedOf`). `null` when the service cannot tell, or
	 * could not be asked: that fails nothing, and the next sync asks again.
	 * A stop, and what the lookup of the folder of the vault on Google Drive
	 * meets, fail as they are: the pull would meet them as well.
	 */
	learnSince(): Promise<number | null> {
		this.learning ??= this.learn();
		return this.learning;
	}

	private async learn(): Promise<number | null> {
		const { askSince, log } = this.deps;
		const gate = this.gate();
		// While the plan is off, nothing is kept, and no account is asked for.
		const account = gate.enabled ? await this.account() : null;
		let since: number | null;
		try {
			since = await askSince();
		} catch (error) {
			if (isCancelled(error)) throw error;
			if (error instanceof DriveFolderGoneError || error instanceof DriveDuplicateFolderError) throw error;
			log?.(`paid: the start of the free time could not be read: ${failureLine(error)}`);
			return null;
		}
		if (since !== null) gate.sinceLearnedOf(account, since);
		return since;
	}

	/**
	 * The service told when the count started, by the way (Google Drive's
	 * lookups, `onSince`): kept for the account, once it is known.
	 */
	sinceTold(at: number): void {
		this.learningAccount?.then(
			(account) => this.gate().sinceLearnedOf(account, at),
			// Failed where it is awaited, and told there.
			() => {},
		);
	}

	/**
	 * Fails with "paid-plan" when the paid plan does not let a call of
	 * `access` go to the remote now: after the free time, nothing is
	 * written; after the time for downloads, nothing is read either. The
	 * first call learns the account, and when its count started, where
	 * they are not known yet.
	 */
	async allow(access: PaidAccess): Promise<void> {
		this.deciding ??= this.decide();
		const standing = await this.deciding;
		if (allows(standing, access)) return;
		const refused = standing.status === "read-only" ? "nothing is uploaded" : "nothing is synced";
		throw new BackendError("paid-plan", `the free time of the paid plan is over: ${refused} (${standing.status})`);
	}

	/** What `work` answers, once a call of `access` is allowed (`allow`): for a call that answers an iterable at once. */
	async *iterate<T>(access: PaidAccess, work: () => AsyncIterable<T>): AsyncIterable<T> {
		await this.allow(access);
		yield* work();
	}

	private async decide(): Promise<PaidStanding> {
		const { backend, ownClient, settings } = this.deps;
		const gate = this.gate();
		if (!gate.enabled) return { status: "free" };
		const account = await this.account();
		if (gate.sinceWantedOf(account)) await this.learnSince();
		// Where the device stands, and nothing told: the warnings are the sync's.
		return gate.standingOf({ backend, account, ownClient, deviceName: settings.deviceName });
	}
}
