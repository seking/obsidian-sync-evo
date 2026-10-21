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

// The one paid plan of the app (`paid-gate.ts`): when it was switched on,
// where it keeps what it remembers, and the clock it is decided by are set
// here, and are not for the rest of the plugin to choose. The settings, the
// check before a sync, and the backends of Dropbox and Google Drive
// (`paid-guard.ts`) all go by this one.

import type { HttpFunction } from "../../../src/core/http";
import { DODO_API } from "./license";
import { DAY_MS, PAID_CLOCK_OFFSET_DAYS, PAID_ENABLED_AT } from "./paid";
import { PaidGate } from "./paid-gate";
import { windowStorage } from "./paid-storage";

/**
 * How the plan reaches Dodo, and where it writes its lines: the app's own.
 * Nothing the plan is decided by. Taken from the first that asks for the
 * plan, which is the plugin as it starts (`paid-plan.ts` in `pro/src/obsidian`).
 */
export interface PlanReach {
	readonly http: HttpFunction;
	readonly log: (line: string) => void;
}

let gate: PaidGate | null = null;

/** The plan of the app, made when it is first asked for. */
export function appPaidGate(reach: PlanReach): PaidGate {
	gate ??= new PaidGate({
		storage: windowStorage,
		http: reach.http,
		now: Date.now,
		// Ahead of the clock only in a build to try the plan out.
		planNow: () => Date.now() + PAID_CLOCK_OFFSET_DAYS * DAY_MS,
		enabledAt: PAID_ENABLED_AT,
		api: DODO_API,
		log: reach.log,
	});
	return gate;
}
