/*
 * Sync Evo
 * Copyright (C) 2026 seking
 *
 * This file is free software, licensed under the GNU Affero General Public
 * License, version 3, as part of Sync Evo. It comes with ABSOLUTELY NO
 * WARRANTY. See LICENSE-AGPL for the full text, and LICENSE for the parts of
 * Sync Evo under other terms.
 *
 * Source: https://github.com/seking/obsidian-sync-evo
 */

// The line a sync that failed leaves in the log: what failed, in one line,
// so that a log copied for a report shows it. The notice says it to the
// user in words of their own; this says it to whoever reads the report.

import { BackendError, RateLimitedError } from "./backend";
import { logTime } from "./log-ring";

/**
 * The kind of the error and what the remote answered: the status, and
 * Google's reason or Dropbox's `error_summary` (`remoteReason`). Not the
 * message of an answer of the remote, which may hold its body; a line must
 * never carry the token. A request that got no answer says why
 * (`BackendError.detail`). A rate limit says until when, with the message
 * the client made of it, which holds no body. An error that is not of the
 * remote (the vault, a bug) says only its name: its message may name a
 * file of the vault, or a path on the device, and the log is copied into
 * reports.
 */
export function failureLine(error: unknown): string {
	if (error instanceof RateLimitedError) return `${error.name} until ${logTime(error.waitUntil)}: ${error.message}`;
	if (error instanceof BackendError) {
		const status = error.status === undefined ? "" : `, HTTP ${error.status}`;
		const reason = error.remoteReason === "" ? "" : ` ${error.remoteReason}`;
		return `${error.name} ${error.kind}${status}${reason}${error.detail === undefined ? "" : `: ${error.detail}`}`;
	}
	return error instanceof Error ? error.name : typeof error;
}
