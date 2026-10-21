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

import { deviceNetwork } from "../../../src/obsidian/http";
import { log } from "../../../src/obsidian/log";
import { appPaidGate } from "../core/app-gate";
import type { PaidGate } from "../core/paid-gate";

/**
 * The paid plan of Dropbox and Google Drive (T082) for this app: what a
 * sync is let do, and the license key of this device (`app-gate.ts`).
 * Does nothing while the plan is not switched on (`PAID_ENABLED_AT`).
 */
export function paidGate(): PaidGate {
	return appPaidGate({ http: (request) => deviceNetwork().http(request), log });
}
