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

import { describe, expect, test } from "vitest";
import { NO_DEVICE_EXCLUSION } from "../src/core/device-exclusion";
import { BackendError, type BackendErrorKind, RateLimitedError } from "../src/core/backend";
import {
	type CheckOutcome,
	type CheckTarget,
	checkConnection,
	checkDropboxFolder,
	connectionCheckText,
	isSuccess,
	prepareCheck,
	runConnectionCheck,
} from "../src/core/connection-check";
import { DropboxApiError } from "../pro/src/core/dropbox/client";
import { GitHubClient, type HeadResult } from "../src/core/github/client";
import type { HttpRequest, HttpResponse } from "../src/core/http";
import { translatorFor } from "../src/core/i18n";
import { DEFAULT_AUTO_SYNC, type DeviceSettings } from "../src/core/settings";

const TOKEN = "github_pat_SECRET0123456789";
const A = "a".repeat(40);

const settings = (over: Partial<DeviceSettings> = {}): DeviceSettings => ({
	backend: "github",
	repository: "octo/notes",
	branch: "main",
	tokenSecret: "github-token",
	dropboxFolder: "",
	dropboxAccount: null,
	gdriveFolder: "",
	gdriveAccount: null,
	gdriveFolderId: null,
	deviceName: "Mac",
	autoSync: DEFAULT_AUTO_SYNC,
	onConflict: "copy",
	deviceExclusion: NO_DEVICE_EXCLUSION,
	exclusionChangeTold: true,
	...over,
});

/** A client whose head is what the test says: a result, or a failure to throw. */
const clientOf = (head: HeadResult | (() => never)) => ({
	resolveHead: async (): Promise<HeadResult> => (typeof head === "function" ? head() : head),
});

const failing = (error: unknown) =>
	clientOf(() => {
		throw error;
	});

describe("checking the connection", () => {
	test("a branch with a commit is connected", async () => {
		expect(await checkConnection(clientOf({ status: "commit", sha: A }))).toEqual({ status: "connected", head: A });
	});

	test("an empty repository is a result of its own, not a failure", async () => {
		const result = await checkConnection(clientOf({ status: "empty" }));
		expect(result).toEqual({ status: "empty" });
		expect(isSuccess(result)).toBe(true);
	});

	test.each<BackendErrorKind>([
		"unreachable",
		"unauthorized",
		"forbidden",
		"not-found",
		"branch-not-found",
		"workflows-permission",
		"incomplete-listing",
		"cancelled",
		"other",
	])("a failure of kind %s keeps its kind and message", async (kind) => {
		const result = await checkConnection(failing(new BackendError(kind, "resolve head: went wrong")));
		expect(result).toEqual({ status: "failed", kind, detail: "resolve head: went wrong" });
		expect(isSuccess(result)).toBe(false);
	});

	test("a rate limit is a failure of that kind", async () => {
		const result = await checkConnection(failing(new RateLimitedError(1_700_000_000_000, "resolve head: limited")));
		expect(result).toEqual({ status: "failed", kind: "rate-limited", detail: "resolve head: limited" });
	});

	test.each<[string, unknown, string]>([
		["an error that is not from the backend", new TypeError("bad thing"), "bad thing"],
		["text", "just text", "just text"],
		["nothing", undefined, "undefined"],
	])("%s that is thrown is a failure of kind other", async (_what, thrown, detail) => {
		expect(await checkConnection(failing(thrown))).toEqual({ status: "failed", kind: "other", detail });
	});
});

describe("preparing the check", () => {
	const secrets = (values: Record<string, string>) => (name: string) => values[name] ?? null;

	test("ready with a repository, a branch, and a secret that has a value", () => {
		expect(prepareCheck(settings(), secrets({ "github-token": TOKEN }))).toEqual({
			status: "ready",
			target: { owner: "octo", repo: "notes", branch: "main", token: TOKEN },
		});
	});

	test("the repository, branch, and token are taken trimmed and normalised", () => {
		const stored = settings({ repository: "https://github.com/octo/notes.git", branch: " work " });
		expect(prepareCheck(stored, secrets({ "github-token": `  ${TOKEN}\n` }))).toEqual({
			status: "ready",
			target: { owner: "octo", repo: "notes", branch: "work", token: TOKEN },
		});
	});

	test.each<[string, Partial<DeviceSettings>, Record<string, string>, string]>([
		["no repository", { repository: "" }, { "github-token": TOKEN }, "repository"],
		["a repository not in the form owner/name", { repository: "notes" }, { "github-token": TOKEN }, "repository"],
		["no branch", { branch: " " }, { "github-token": TOKEN }, "branch"],
		["no secret chosen", { tokenSecret: "" }, { "github-token": TOKEN }, "token-secret"],
		["a secret that does not exist", {}, {}, "token-value"],
		["a secret with an empty value", {}, { "github-token": "" }, "token-value"],
		["a secret with a value of spaces", {}, { "github-token": " \n" }, "token-value"],
		// The first thing missing is the one reported.
		["nothing at all", { repository: "", branch: "", tokenSecret: "" }, {}, "repository"],
	])("not ready with %s", (_what, over, values, reason) => {
		expect(prepareCheck(settings(over), secrets(values))).toEqual({ status: "not-ready", reason });
	});

	test("the secret is not read before one is chosen", () => {
		const read: string[] = [];
		prepareCheck(settings({ tokenSecret: "" }), (name) => {
			read.push(name);
			return TOKEN;
		});
		expect(read).toEqual([]);
	});
});

function json(status: number, body: unknown): HttpResponse {
	const bytes = new TextEncoder().encode(JSON.stringify(body));
	const copy = new ArrayBuffer(bytes.length);
	new Uint8Array(copy).set(bytes);
	return { status, headers: {}, body: copy };
}

/** The real client over scripted responses, built the way the plugin builds it. */
function run(script: (HttpResponse | Error)[], stored: DeviceSettings = settings()) {
	const requests: HttpRequest[] = [];
	const targets: CheckTarget[] = [];
	const sleeps: number[] = [];
	const outcome = runConnectionCheck(
		stored,
		() => TOKEN,
		(target) => {
			targets.push(target);
			return new GitHubClient({
				...target,
				http: async (request) => {
					requests.push(request);
					const step = script.shift();
					if (step === undefined) throw new Error(`unscripted request: ${request.url}`);
					if (step instanceof Error) throw step;
					return step;
				},
				now: () => 1_700_000_000_000,
				sleep: (ms) =>
					new Promise((resolve) => {
						sleeps.push(ms);
						// Long after any response, so that only a wait for a rate limit would be seen.
						setTimeout(resolve, 5_000);
					}),
				onRateLimit: () => false,
			});
		},
	);
	return { outcome, requests, targets, sleeps };
}

const REPO = "https://api.github.com/repos/octo/notes";
const ref = () => json(200, { ref: "refs/heads/main", object: { type: "commit", sha: A } });

describe("the whole check, through the GitHub client", () => {
	test("asks for the head of the branch with the token, and nothing else", async () => {
		const { outcome, requests } = run([ref()]);
		expect(await outcome).toEqual({ status: "connected", head: A });
		expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([`GET ${REPO}/git/ref/heads/main`]);
		expect(requests[0]?.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
	});

	test("an empty repository", async () => {
		const { outcome } = run([json(409, { message: "Git Repository is empty." })]);
		expect(await outcome).toEqual({ status: "empty" });
	});

	test.each<[string, HttpResponse[], BackendErrorKind, number]>([
		["a token GitHub refuses", [json(401, { message: "Bad credentials" })], "unauthorized", 1],
		["a token without the permission", [json(403, { message: "Resource not accessible by personal access token" })], "forbidden", 1],
		["a missing branch", [json(404, { message: "Not Found" }), json(200, { full_name: "octo/notes" })], "branch-not-found", 2],
		["a missing repository", [json(404, { message: "Not Found" }), json(404, { message: "Not Found" })], "not-found", 2],
		["a server error", [json(502, { message: "Bad Gateway" })], "unreachable", 1],
	])("%s", async (_what, script, kind, count) => {
		const { outcome, requests } = run(script);
		const result = await outcome;
		expect(result).toMatchObject({ status: "failed", kind });
		expect(requests.length).toBe(count);
		expect(JSON.stringify(result)).not.toContain(TOKEN);
	});

	test("no network", async () => {
		const { outcome } = run([new Error("net::ERR_INTERNET_DISCONNECTED")]);
		expect(await outcome).toMatchObject({ status: "failed", kind: "unreachable" });
	});

	test("a rate limit is reported at once, not waited out", async () => {
		const limited: HttpResponse = {
			...json(403, { message: "API rate limit exceeded" }),
			headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(1_700_000_000 + 1800) },
		};
		const { outcome, requests, sleeps } = run([limited]);
		expect(await outcome).toMatchObject({ status: "failed", kind: "rate-limited" });
		expect(requests.length).toBe(1);
		// The only sleep is the timeout of the one request.
		expect(sleeps.every((ms) => ms <= 60_000)).toBe(true);
	});

	test("settings that are not ready send nothing and build no client", async () => {
		const { outcome, requests, targets } = run([], settings({ repository: "notes" }));
		expect(await outcome).toEqual({ status: "not-ready", reason: "repository" });
		expect(requests).toEqual([]);
		expect(targets).toEqual([]);
	});

	test("a secret storage that throws is a failure, not a throw", async () => {
		const outcome = await runConnectionCheck(
			settings(),
			() => {
				throw new Error("storage is locked");
			},
			() => clientOf({ status: "empty" }),
		);
		expect(outcome).toEqual({ status: "failed", kind: "other", detail: "storage is locked" });
	});
});

describe("the text for each outcome", () => {
	const outcomes: [string, CheckOutcome][] = [
		["connected", { status: "connected", head: A }],
		["empty", { status: "empty" }],
		["unauthorized", { status: "failed", kind: "unauthorized", detail: "d" }],
		["forbidden", { status: "failed", kind: "forbidden", detail: "d" }],
		["not-found", { status: "failed", kind: "not-found", detail: "d" }],
		["branch-not-found", { status: "failed", kind: "branch-not-found", detail: "d" }],
		["unreachable", { status: "failed", kind: "unreachable", detail: "d" }],
		["rate-limited", { status: "failed", kind: "rate-limited", detail: "d" }],
		["other", { status: "failed", kind: "other", detail: "d" }],
		["no repository", { status: "not-ready", reason: "repository" }],
		["no branch", { status: "not-ready", reason: "branch" }],
		["no secret", { status: "not-ready", reason: "token-secret" }],
		["no value", { status: "not-ready", reason: "token-value" }],
	];
	const stored = settings({ repository: "https://github.com/octo/notes", branch: " work " });

	describe.each(["en", "ja"])("in %s", (language) => {
		const t = translatorFor(language);
		const textOf = (outcome: CheckOutcome): string => connectionCheckText(t, stored, outcome);

		test("every outcome has a text of its own, with every placeholder filled", () => {
			const texts = outcomes.map(([, outcome]) => textOf(outcome));
			expect(new Set(texts).size).toBe(outcomes.length);
			for (const text of texts) {
				expect(text.trim()).not.toBe("");
				expect(text).not.toMatch(/[{}]/);
			}
		});

		test("connected names the repository and the branch, as normalised", () => {
			const text = textOf({ status: "connected", head: A });
			expect(text).toContain("octo/notes");
			expect(text).toContain("work");
			expect(text).not.toContain("https://");
		});

		test("a missing branch names the branch", () => {
			expect(textOf({ status: "failed", kind: "branch-not-found", detail: "d" })).toContain("work");
		});

		test("lacking permission names the permission and the repository", () => {
			const text = textOf({ status: "failed", kind: "forbidden", detail: "d" });
			expect(text).toContain("Contents");
			expect(text).toContain("octo/notes");
		});

		test("a secret without a value names the secret", () => {
			expect(textOf({ status: "not-ready", reason: "token-value" })).toContain("github-token");
		});

		test.each<BackendErrorKind>(["other", "workflows-permission", "incomplete-listing", "cancelled"])(
			"a failure of kind %s shows its detail",
			(kind) => {
				expect(textOf({ status: "failed", kind, detail: "resolve head: 418" })).toContain("resolve head: 418");
			},
		);
	});

	test("the texts are Japanese in Japanese", () => {
		const en = translatorFor("en");
		const ja = translatorFor("ja");
		for (const [, outcome] of outcomes) {
			expect(connectionCheckText(ja, stored, outcome)).not.toBe(connectionCheckText(en, stored, outcome));
			expect(connectionCheckText(ja, stored, outcome)).toMatch(/[぀-ヿ一-鿿]/);
		}
	});

	test("an expired token and a token lacking permission read differently", () => {
		const t = translatorFor("en");
		const expired = connectionCheckText(t, stored, { status: "failed", kind: "unauthorized", detail: "d" });
		const lacking = connectionCheckText(t, stored, { status: "failed", kind: "forbidden", detail: "d" });
		expect(expired).toMatch(/expired/);
		expect(lacking).not.toMatch(/expired/);
		expect(lacking).toMatch(/permission/);
		expect(expired).not.toMatch(/permission/);
	});
});

describe("checking the connection to Dropbox", () => {
	const ACCOUNT = { id: "dbid:1", email: "a@example.com" };
	const REFRESH = "dropbox-refresh-SECRET";
	const dropbox = (over: Partial<DeviceSettings> = {}): DeviceSettings =>
		settings({ backend: "dropbox", dropboxFolder: "Vault", dropboxAccount: ACCOUNT, ...over });
	const noSecret = (): string | null => null;

	test("ready with a folder, an account, and a refresh token", () => {
		expect(prepareCheck(dropbox({ dropboxFolder: " Vault " }), noSecret, () => REFRESH)).toEqual({
			status: "ready",
			target: { kind: "dropbox", folder: "Vault", refreshToken: REFRESH },
		});
	});

	test.each<[string, Partial<DeviceSettings>, string | null, string]>([
		["no folder", { dropboxFolder: "" }, REFRESH, "dropbox-folder"],
		["a folder with a slash", { dropboxFolder: "a/b" }, REFRESH, "dropbox-folder"],
		["no account", { dropboxAccount: null }, REFRESH, "dropbox-account"],
		["no refresh token", {}, null, "dropbox-account"],
		["an empty refresh token", {}, "", "dropbox-account"],
		// The first thing missing is the one reported.
		["nothing at all", { dropboxFolder: "", dropboxAccount: null }, null, "dropbox-folder"],
	])("not ready with %s", (_what, over, token, reason) => {
		expect(prepareCheck(dropbox(over), noSecret, () => token)).toEqual({ status: "not-ready", reason });
	});

	test("without a way to read the refresh token, it is not connected", () => {
		expect(prepareCheck(dropbox(), noSecret)).toEqual({ status: "not-ready", reason: "dropbox-account" });
	});

	test("the refresh token is not read without an account", () => {
		let read = 0;
		prepareCheck(dropbox({ dropboxAccount: null }), noSecret, () => {
			read += 1;
			return REFRESH;
		});
		expect(read).toBe(0);
	});

	test("the whole check asks Dropbox about the folder, and builds no GitHub client", async () => {
		const targets: unknown[] = [];
		const outcome = await runConnectionCheck(
			dropbox(),
			noSecret,
			() => {
				throw new Error("no GitHub client for Dropbox");
			},
			{
				readToken: () => REFRESH,
				check: async (target) => {
					targets.push(target);
					return { status: "empty" };
				},
			},
		);
		expect(outcome).toEqual({ status: "empty" });
		expect(targets).toEqual([{ kind: "dropbox", folder: "Vault", refreshToken: REFRESH }]);
	});

	test("settings that are not ready ask Dropbox nothing", async () => {
		let asked = 0;
		const outcome = await runConnectionCheck(dropbox({ dropboxFolder: "" }), noSecret, () => clientOf({ status: "empty" }), {
			readToken: () => REFRESH,
			check: async () => {
				asked += 1;
				return { status: "empty" };
			},
		});
		expect(outcome).toEqual({ status: "not-ready", reason: "dropbox-folder" });
		expect(asked).toBe(0);
	});

	test("the whole check without a way to read the refresh token is not connected, and does not throw", async () => {
		expect(await runConnectionCheck(dropbox(), noSecret, () => clientOf({ status: "empty" }))).toEqual({
			status: "not-ready",
			reason: "dropbox-account",
		});
	});

	describe("asking about the folder", () => {
		const clientThat = (answer: () => unknown) => {
			const calls: [string, unknown][] = [];
			return {
				calls,
				client: {
					rpc: async (endpoint: string, arg: unknown): Promise<unknown> => {
						calls.push([endpoint, arg]);
						return answer();
					},
				},
			};
		};

		test("a folder that is there is connected, asked for by its path in the app folder", async () => {
			const { client, calls } = clientThat(() => ({ ".tag": "folder", name: "Vault" }));
			expect(await checkDropboxFolder(client, "Vault")).toEqual({ status: "connected", head: "" });
			expect(calls).toEqual([["files/get_metadata", { path: "/Vault" }]]);
		});

		test("a folder that is not there yet is empty, a result of its own", async () => {
			const { client } = clientThat(() => {
				throw new DropboxApiError("get metadata", "path/not_found/..");
			});
			const result = await checkDropboxFolder(client, "Vault");
			expect(result).toEqual({ status: "empty" });
			expect(isSuccess(result)).toBe(true);
		});

		test.each<[string, unknown, CheckOutcome]>([
			["another error of Dropbox", new DropboxApiError("get metadata", "path/malformed_path/"), { status: "failed", kind: "other", detail: "get metadata: path/malformed_path/" }],
			["a connection Dropbox refuses", new BackendError("unauthorized", "expired"), { status: "failed", kind: "unauthorized", detail: "expired" }],
			["no network", new BackendError("unreachable", "offline"), { status: "failed", kind: "unreachable", detail: "offline" }],
			["an error that is not from the backend", new TypeError("bad thing"), { status: "failed", kind: "other", detail: "bad thing" }],
		])("%s is a failure", async (_what, thrown, expected) => {
			const { client } = clientThat(() => {
				throw thrown;
			});
			expect(await checkDropboxFolder(client, "Vault")).toEqual(expected);
		});
	});

	describe("the texts", () => {
		const outcomes: [string, CheckOutcome][] = [
			["connected", { status: "connected", head: "" }],
			["empty", { status: "empty" }],
			["unauthorized", { status: "failed", kind: "unauthorized", detail: "d" }],
			["forbidden", { status: "failed", kind: "forbidden", detail: "d" }],
			["unreachable", { status: "failed", kind: "unreachable", detail: "d" }],
			["rate-limited", { status: "failed", kind: "rate-limited", detail: "d" }],
			["other", { status: "failed", kind: "other", detail: "d" }],
			["no folder", { status: "not-ready", reason: "dropbox-folder" }],
			["not connected", { status: "not-ready", reason: "dropbox-account" }],
		];

		test.each(["en", "ja"])("in %s, every outcome has a text of its own, with every placeholder filled", (language) => {
			const t = translatorFor(language);
			const texts = outcomes.map(([, outcome]) => connectionCheckText(t, dropbox(), outcome));
			expect(new Set(texts).size).toBe(outcomes.length);
			for (const text of texts) {
				expect(text.trim()).not.toBe("");
				expect(text).not.toMatch(/[{}]/);
			}
		});

		test("connected and empty name the folder in the app folder, and nothing of GitHub", () => {
			const t = translatorFor("en");
			for (const outcome of [{ status: "connected", head: "" }, { status: "empty" }] as const) {
				const text = connectionCheckText(t, dropbox(), outcome);
				expect(text).toContain("Apps/Sync Evo/Vault");
				expect(text).not.toContain("octo/notes");
			}
		});

		test("a refused connection and a lacking permission read as Dropbox's", () => {
			const t = translatorFor("en");
			expect(connectionCheckText(t, dropbox(), { status: "failed", kind: "unauthorized", detail: "d" })).toBe(
				t("check.dropbox.unauthorized"),
			);
			expect(connectionCheckText(t, dropbox(), { status: "failed", kind: "forbidden", detail: "d" })).toBe(
				t("check.dropbox.forbidden"),
			);
		});
	});
});

describe("checking the connection to Google Drive", () => {
	const ACCOUNT = { id: "perm1", email: "a@example.com" };
	const REFRESH = "google-refresh-SECRET";
	const drive = (over: Partial<DeviceSettings> = {}): DeviceSettings =>
		settings({ backend: "gdrive", gdriveFolder: "Vault", gdriveAccount: ACCOUNT, gdriveFolderId: "f1", ...over });
	const noSecret = (): string | null => null;

	test("ready with a folder, an account, and a refresh token, with the id of the folder kept", () => {
		expect(prepareCheck(drive({ gdriveFolder: " Vault " }), noSecret, () => null, () => REFRESH)).toEqual({
			status: "ready",
			target: { kind: "gdrive", folder: "Vault", folderId: "f1", refreshToken: REFRESH },
		});
	});

	test.each<[string, Partial<DeviceSettings>, string | null, string]>([
		["no folder", { gdriveFolder: "" }, REFRESH, "gdrive-folder"],
		["no account", { gdriveAccount: null }, REFRESH, "gdrive-account"],
		["no refresh token", {}, null, "gdrive-account"],
	])("not ready with %s", (_what, over, token, reason) => {
		expect(prepareCheck(drive(over), noSecret, () => REFRESH, () => token)).toEqual({ status: "not-ready", reason });
	});

	test("the whole check asks Google Drive, and neither GitHub nor Dropbox", async () => {
		const outcome = await runConnectionCheck(
			drive(),
			noSecret,
			() => {
				throw new Error("no GitHub client for Google Drive");
			},
			{
				readToken: () => REFRESH,
				check: () => Promise.reject(new Error("no Dropbox for Google Drive")),
			},
			{ readToken: () => REFRESH, check: async () => ({ status: "connected", head: "" }) },
		);
		expect(outcome).toEqual({ status: "connected", head: "" });
	});

	test.each(["en", "ja"])("in %s, every outcome has a text of its own, naming Google Drive and the folder", (language) => {
		const t = translatorFor(language, "Google Drive");
		const outcomes: CheckOutcome[] = [
			{ status: "connected", head: "" },
			{ status: "empty" },
			{ status: "failed", kind: "unauthorized", detail: "d" },
			{ status: "failed", kind: "forbidden", detail: "d" },
			{ status: "failed", kind: "not-found", detail: "d" },
			{ status: "failed", kind: "other", detail: "d", duplicate: "Sync Evo/Vault" },
			{ status: "failed", kind: "other", detail: "d" },
			{ status: "failed", kind: "other", detail: "d", noClientSecret: true },
			{ status: "failed", kind: "other", detail: "d", noClientSecret: true, ownClient: true },
			{ status: "not-ready", reason: "gdrive-folder" },
			{ status: "not-ready", reason: "gdrive-account" },
		];
		const texts = outcomes.map((outcome) => connectionCheckText(t, drive(), outcome));
		expect(new Set(texts).size).toBe(outcomes.length);
		for (const text of texts) expect(text).not.toMatch(/[{}]/);
		expect(texts[0]).toContain("Sync Evo/Vault");
		expect(texts[5]).toContain("Sync Evo/Vault");
	});
});
