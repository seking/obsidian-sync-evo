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

import { describe, expect, test } from "vitest";
import { BackendError, RateLimitedError, requestFailedDetail } from "../src/core/backend";
import { DropboxApiError } from "../src/core/dropbox/client";
import { failureLine } from "../src/core/failure-line";
import { DriveApiError } from "../src/core/gdrive/client";
import { DriveDailyLimitError } from "../src/core/gdrive/errors";

// A local time, so that the text is the same in whatever time zone the tests run.
const at = (hours: number, minutes: number, seconds: number): number => new Date(2026, 9, 17, hours, minutes, seconds).getTime();

describe("the line of a sync that failed", () => {
	test("a rate limit says until when, and what the client made of it", () => {
		const limited = new RateLimitedError(at(14, 3, 12), "GET /drive/v3/files: Google Drive asked to wait (HTTP 403 userRateLimitExceeded)");
		expect(failureLine(limited)).toBe(
			"RateLimitedError until 10-17 14:03:12: GET /drive/v3/files: Google Drive asked to wait (HTTP 403 userRateLimitExceeded)",
		);
		const daily = new DriveDailyLimitError(at(16, 0, 0), at(9, 0, 0), "GET /drive/v3/files: the requests of the day to Google Drive have run out");
		expect(failureLine(daily)).toMatch(/^DriveDailyLimitError until 10-17 16:00:00: /);
	});

	test("an answer of the remote says its kind, its status and its reason, and not its body", () => {
		expect(failureLine(new DriveApiError("GET /drive/v3/files", 500, "backendError", "Bearer ya29.secret"))).toBe(
			"DriveApiError unreachable, HTTP 500 backendError",
		);
		expect(failureLine(new DropboxApiError("files/upload", "path/insufficient_space/.."))).toBe(
			"DropboxApiError other, HTTP 409 path/insufficient_space/..",
		);
		expect(failureLine(new BackendError("forbidden", "create blob: HTTP 403: body with sl.secret", 403))).toBe("BackendError forbidden, HTTP 403");
		expect(failureLine(new BackendError("unreachable", "files/list_folder: the request failed: /Vault/a.md"))).toBe("BackendError unreachable");
	});

	test("a request that got no answer says why, as the client put it", () => {
		const timeout = new BackendError("unreachable", "files/list_folder: no response within 60000 ms", undefined, "no response within 60000 ms");
		expect(failureLine(timeout)).toBe("BackendError unreachable: no response within 60000 ms");
		const failed = new BackendError("unreachable", "x", undefined, requestFailedDetail("net::ERR_CONNECTION_RESET"));
		expect(failureLine(failed)).toBe("BackendError unreachable: the request failed: net::ERR_CONNECTION_RESET");
	});

	test("what the platform said of a request that failed goes only when it is plain words", () => {
		expect(requestFailedDetail("net::ERR_INTERNET_DISCONNECTED")).toBe("the request failed: net::ERR_INTERNET_DISCONNECTED");
		expect(requestFailedDetail("Request failed, status 0")).toBe("the request failed: Request failed, status 0");
		for (const said of [
			"https://www.googleapis.com/drive/v3/files?q=name%3D'Vault'",
			"ENOENT: no such file, open '/storage/emulated/0/Vault/a.md'",
			"bad header Bearer [token]",
			"cannot read note.md",
			"x".repeat(121),
		]) {
			expect(requestFailedDetail(said)).toBe("the request failed");
		}
	});

	test("an error that is not of the remote says only its name: its message may name a file", () => {
		expect(failureLine(new TypeError("No free name for a copy of Private/diary.md"))).toBe("TypeError");
		expect(failureLine(new Error("zip: an encrypted entry: secret.md"))).toBe("Error");
		expect(failureLine("odd")).toBe("string");
	});
});
