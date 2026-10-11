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

import { Buffer } from "node:buffer";
import { describe, expect, test } from "vitest";
import { BackendError, type BackendErrorKind, RateLimitedError } from "../src/core/backend";
import { encodeBase64 } from "../src/core/github/base64";
import {
	GitHubClient,
	type GitHubClientOptions,
	HeadMemory,
	isWorkflowsRefusal,
	type RateLimitNotice,
} from "../src/core/github/client";
import type { HttpRequest, HttpResponse } from "../src/core/github/http";
import { timerSleep } from "../src/core/github/timer-sleep";

const TOKEN = "github_pat_SECRET0123456789";
const REPO = "https://api.github.com/repos/octo/notes";
const START = 1_700_000_000_000;

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

/**
 * A clock that only moves when a sleep ends. A sleep ends on the next
 * macrotask, so a response that is already there always wins the race against
 * the timeout, and a request that never answers always loses it.
 */
class FakeTime {
	current = START;
	/** The sleeps that ran to their end, in order. A cancelled timeout is not one. */
	readonly sleeps: number[] = [];
	/** Extra time each sleep takes, like a timer that stood still in the background. */
	overshoot = 0;

	readonly now = (): number => this.current;

	readonly sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
		new Promise((resolve) => {
			setTimeout(() => {
				if (signal?.aborted) return;
				this.sleeps.push(ms);
				this.current += ms + this.overshoot;
				resolve();
			}, 0);
		});

	get slept(): number {
		return this.sleeps.reduce((sum, ms) => sum + ms, 0);
	}
}

/** What the fake answers one request with: a response, a failure to connect, or silence. */
type Step = HttpResponse | Error | "hang";

class FakeHttp {
	readonly requests: (HttpRequest & { at: number })[] = [];
	private readonly script: Step[];
	private readonly time: FakeTime;

	constructor(time: FakeTime, script: Step[]) {
		this.time = time;
		this.script = [...script];
	}

	readonly send = async (request: HttpRequest): Promise<HttpResponse> => {
		this.requests.push({ ...request, at: this.time.current });
		const step = this.script.shift();
		if (step === undefined) throw new Error(`unscripted request: ${request.method} ${request.url}`);
		if (step === "hang") return new Promise(() => {});
		if (step instanceof Error) throw step;
		return step;
	};

	request(index: number): HttpRequest & { at: number } {
		const request = this.requests[index];
		if (request === undefined) throw new Error(`no request ${index}`);
		return request;
	}

	body(index: number): unknown {
		return JSON.parse(this.request(index).body ?? "null");
	}
}

function buffer(data: Uint8Array): ArrayBuffer {
	const copy = new ArrayBuffer(data.length);
	new Uint8Array(copy).set(data);
	return copy;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
	return { status, headers, body: buffer(new TextEncoder().encode(JSON.stringify(body))) };
}

function raw(status: number, body: Uint8Array | string, headers: Record<string, string> = {}): HttpResponse {
	return { status, headers, body: buffer(typeof body === "string" ? new TextEncoder().encode(body) : body) };
}

function setup(script: Step[], options: Partial<GitHubClientOptions> = {}) {
	const time = new FakeTime();
	const http = new FakeHttp(time, script);
	const client = new GitHubClient({
		owner: "octo",
		repo: "notes",
		branch: "main",
		token: TOKEN,
		http: http.send,
		now: time.now,
		sleep: time.sleep,
		...options,
	});
	return { client, http, time };
}

async function failureOf(promise: Promise<unknown>): Promise<BackendError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof BackendError) return error;
		throw error;
	}
	throw new Error("expected a failure");
}

async function kindOf(promise: Promise<unknown>): Promise<BackendErrorKind> {
	return (await failureOf(promise)).kind;
}

const ref = (sha: string) => json(200, { ref: "refs/heads/main", object: { type: "commit", sha } });
const notFound = () => json(404, { message: "Not Found" });

describe("requests", () => {
	test("every call carries the token, the media type, and the API version", async () => {
		const { client, http } = setup([ref(A)]);
		await client.resolveHead();
		expect(http.request(0).method).toBe("GET");
		expect(http.request(0).headers).toEqual({
			Authorization: `Bearer ${TOKEN}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			// A read must not be answered from the app's HTTP cache.
			"Cache-Control": "no-cache",
		});
		expect(http.request(0).body).toBeUndefined();
	});

	test("owner and repository are encoded, and the branch per path segment", async () => {
		const { client, http } = setup([ref(A), json(200, {})], {
			owner: "o/x",
			repo: "my notes",
			branch: "feature/new idea#1",
		});
		await client.resolveHead();
		await client.updateRef(B);
		const repo = "https://api.github.com/repos/o%2Fx/my%20notes";
		expect(http.request(0).url).toBe(`${repo}/git/ref/heads/feature/new%20idea%231`);
		expect(http.request(1).url).toBe(`${repo}/git/refs/heads/feature/new%20idea%231`);
	});

	test("a value that is not a sha never reaches a URL", async () => {
		const { client, http } = setup([]);
		expect(await kindOf(client.getTree("main"))).toBe("other");
		expect(await kindOf(client.getZip("../../other/repo"))).toBe("other");
		expect(await kindOf(client.isAncestor(A, "HEAD"))).toBe("other");
		expect(http.requests).toEqual([]);
	});
});

describe("resolveHead", () => {
	test("answers the commit the branch points at", async () => {
		const { client, http } = setup([ref(A)]);
		expect(await client.resolveHead()).toEqual({ status: "commit", sha: A });
		expect(http.request(0).url).toBe(`${REPO}/git/ref/heads/main`);
	});

	test("an empty repository is a result, not a failure", async () => {
		const { client, http } = setup([json(409, { message: "Git Repository is empty." })]);
		expect(await client.resolveHead()).toEqual({ status: "empty" });
		expect(http.requests.length).toBe(1);
	});

	test("a missing branch is told from a missing repository by asking for the repository", async () => {
		const missingBranch = setup([notFound(), json(200, { full_name: "octo/notes" })]);
		expect(await kindOf(missingBranch.client.resolveHead())).toBe("branch-not-found");
		expect(missingBranch.http.request(1).url).toBe(REPO);

		const missingRepository = setup([notFound(), notFound()]);
		expect(await kindOf(missingRepository.client.resolveHead())).toBe("not-found");
		expect(missingRepository.http.requests.length).toBe(2);
	});

	test("a refused token is unauthorized, a token without access is forbidden", async () => {
		const expired = setup([json(401, { message: "Bad credentials" })]);
		expect(await kindOf(expired.client.resolveHead())).toBe("unauthorized");

		const noAccess = setup([
			json(403, { message: "Resource not accessible by personal access token" }, { "x-ratelimit-remaining": "4999" }),
		]);
		expect(await kindOf(noAccess.client.resolveHead())).toBe("forbidden");
		expect(noAccess.time.sleeps).toEqual([]);
	});

	test("a failure of the second request is reported as what it is", async () => {
		const { client } = setup([notFound(), json(401, { message: "Bad credentials" })]);
		expect(await kindOf(client.resolveHead())).toBe("unauthorized");
	});

	test("another 409, a server error, and an unreadable answer are not taken for a result", async () => {
		expect(await kindOf(setup([json(409, { message: "Conflict" })]).client.resolveHead())).toBe("other");
		expect(await kindOf(setup([json(502, { message: "Bad Gateway" })]).client.resolveHead())).toBe("unreachable");
		expect(await kindOf(setup([raw(200, "<html>")]).client.resolveHead())).toBe("other");
		expect(await kindOf(setup([json(200, { object: { type: "commit", sha: "abc" } })]).client.resolveHead())).toBe("other");
		expect(await kindOf(setup([json(200, { object: { type: "tag", sha: A } })]).client.resolveHead())).toBe("other");
	});
});

describe("reading", () => {
	test("getCommit answers the tree and the parents", async () => {
		const { client, http } = setup([json(200, { sha: A, tree: { sha: B }, parents: [{ sha: C }], message: "m" })]);
		expect(await client.getCommit(A)).toEqual({ sha: A, treeSha: B, parents: [C] });
		expect(http.request(0).url).toBe(`${REPO}/git/commits/${A}`);
	});

	test("getCommit refuses a response without a readable tree or parents", async () => {
		expect(await kindOf(setup([json(200, { sha: A, tree: {}, parents: [] })]).client.getCommit(A))).toBe("other");
		expect(await kindOf(setup([json(200, { sha: A, tree: { sha: B }, parents: [{}] })]).client.getCommit(A))).toBe("other");
		expect(await kindOf(setup([json(200, [])]).client.getCommit(A))).toBe("other");
		expect(await kindOf(setup([notFound()]).client.getCommit(A))).toBe("not-found");
	});

	test("getTree lists every item of the recursive tree", async () => {
		const { client, http } = setup([
			json(200, {
				sha: B,
				truncated: false,
				tree: [
					{ path: "a.md", mode: "100644", type: "blob", sha: A, size: 3, url: "x" },
					{ path: "dir", mode: "040000", type: "tree", sha: B },
					{ path: "sub", mode: "160000", type: "commit", sha: C },
				],
			}),
		]);
		expect(await client.getTree(B)).toEqual([
			{ path: "a.md", mode: "100644", type: "blob", sha: A, size: 3 },
			{ path: "dir", mode: "040000", type: "tree", sha: B },
			{ path: "sub", mode: "160000", type: "commit", sha: C },
		]);
		expect(http.request(0).url).toBe(`${REPO}/git/trees/${B}?recursive=1`);
	});

	test("a truncated tree fails as an incomplete listing instead of returning a part", async () => {
		const { client } = setup([
			json(200, { sha: B, truncated: true, tree: [{ path: "a.md", mode: "100644", type: "blob", sha: A, size: 3 }] }),
		]);
		expect(await kindOf(client.getTree(B))).toBe("incomplete-listing");
	});

	test("a tree that does not say it is complete, or has an unreadable item, fails", async () => {
		const item = { path: "a.md", mode: "100644", type: "blob", sha: A, size: 3 };
		expect(await kindOf(setup([json(200, { tree: [item] })]).client.getTree(B))).toBe("other");
		expect(await kindOf(setup([json(200, { truncated: false })]).client.getTree(B))).toBe("other");
		for (const broken of [{ ...item, sha: "123" }, { ...item, type: "link" }, { ...item, path: 1 }, { ...item, size: "3" }, null]) {
			const { client } = setup([json(200, { truncated: false, tree: [item, broken] })]);
			expect(await kindOf(client.getTree(B))).toBe("other");
		}
	});

	test("getBlob asks for the raw bytes and returns them untouched", async () => {
		const content = new Uint8Array([0, 255, 10, 13, 128]);
		const { client, http } = setup([raw(200, content)]);
		expect(await client.getBlob(A)).toEqual(content);
		expect(http.request(0).url).toBe(`${REPO}/git/blobs/${A}`);
		expect(http.request(0).headers.Accept).toBe("application/vnd.github.raw+json");
		expect(http.request(0).headers.Authorization).toBe(`Bearer ${TOKEN}`);
	});

	test("getZip asks by commit and returns the body", async () => {
		const content = new Uint8Array([80, 75, 3, 4]);
		const { client, http } = setup([raw(200, content)]);
		expect(new Uint8Array(await client.getZip(A))).toEqual(content);
		expect(http.request(0).url).toBe(`${REPO}/zipball/${A}`);
	});

	test("a redirect that was not followed is a failure, with no second request", async () => {
		const { client, http } = setup([raw(302, "", { location: "https://codeload.github.com/x" })]);
		const failure = await failureOf(client.getZip(A));
		expect(failure.kind).toBe("other");
		// The status goes along: it is what tells this from any other
		// failure of the kind.
		expect(failure.status).toBe(302);
		expect(http.requests.length).toBe(1);
	});

	test("a failure that is an answer carries its status, and one that is not carries none", async () => {
		expect((await failureOf(setup([json(422, { message: "Unprocessable" })]).client.getZip(A))).status).toBe(422);
		expect((await failureOf(setup([notFound()]).client.getZip(A))).status).toBe(404);
		expect((await failureOf(setup([]).client.getZip("not a sha"))).status).toBeUndefined();
	});
});

describe("writing", () => {
	test("createBlob sends the content as base64", async () => {
		const { client, http } = setup([json(201, { sha: A, url: "x" })]);
		expect(await client.createBlob(new Uint8Array([0, 255, 254]))).toBe(A);
		expect(http.request(0).method).toBe("POST");
		expect(http.request(0).url).toBe(`${REPO}/git/blobs`);
		expect(http.request(0).headers["Content-Type"]).toBe("application/json");
		expect(http.body(0)).toEqual({ content: "AP/+", encoding: "base64" });
	});

	test("createBlob tells a content GitHub finds too large apart from the other refusals", async () => {
		const tooLarge = "Sorry, your input was too large to process. Consider creating the blob in a local clone of the repository and then pushing it to GitHub.";
		expect(await kindOf(setup([json(422, { message: tooLarge })]).client.createBlob(new Uint8Array([1])))).toBe("too-large");
		expect(await kindOf(setup([json(413, { message: "" })]).client.createBlob(new Uint8Array([1])))).toBe("too-large");
		expect(await kindOf(setup([json(422, { message: "Validation Failed" })]).client.createBlob(new Uint8Array([1])))).toBe("other");
		// Only a blob: a tree that is too large is not one file to leave out.
		expect(await kindOf(setup([json(422, { message: tooLarge })]).client.createTree(B, []))).toBe("other");
	});

	test("createTree lays inline content, blobs, and removals over the base tree", async () => {
		const { client, http } = setup([json(201, { sha: C })]);
		const sha = await client.createTree(B, [
			{ path: "notes/a.md", mode: "100644", content: "text" },
			{ path: "run.sh", mode: "100755", sha: A },
			{ path: "old.md", mode: "100644", sha: null },
		]);
		expect(sha).toBe(C);
		expect(http.request(0).url).toBe(`${REPO}/git/trees`);
		expect(http.body(0)).toEqual({
			base_tree: B,
			tree: [
				{ path: "notes/a.md", mode: "100644", type: "blob", content: "text" },
				{ path: "run.sh", mode: "100755", type: "blob", sha: A },
				{ path: "old.md", mode: "100644", type: "blob", sha: null },
			],
		});
	});

	test("a removal carries the mode the entry had, whatever kind of entry it was", async () => {
		const { client, http } = setup([json(201, { sha: C })]);
		await client.createTree(B, [
			{ path: "run.sh", mode: "100755", sha: null },
			{ path: "link", mode: "120000", sha: null },
			{ path: "sub", mode: "160000", sha: null },
		]);
		expect(http.body(0)).toEqual({
			base_tree: B,
			tree: [
				{ path: "run.sh", mode: "100755", type: "blob", sha: null },
				{ path: "link", mode: "120000", type: "blob", sha: null },
				{ path: "sub", mode: "160000", type: "commit", sha: null },
			],
		});
	});

	test("createCommit names no author", async () => {
		const { client, http } = setup([json(201, { sha: C })]);
		expect(await client.createCommit({ message: "Sync Evo: iPhone (1 added)", tree: B, parents: [A] })).toBe(C);
		expect(http.request(0).url).toBe(`${REPO}/git/commits`);
		expect(http.body(0)).toEqual({ message: "Sync Evo: iPhone (1 added)", tree: B, parents: [A] });
	});

	test("a write answered with anything but a created object fails", async () => {
		expect(await kindOf(setup([json(200, { sha: C })]).client.createCommit({ message: "m", tree: B, parents: [] }))).toBe("other");
		expect(await kindOf(setup([json(201, { sha: "x" })]).client.createBlob(new Uint8Array()))).toBe("other");
		expect(await kindOf(setup([json(422, { message: "Invalid tree info" })]).client.createTree(B, []))).toBe("other");
		expect(await kindOf(setup([notFound()]).client.createTree(B, []))).toBe("not-found");
	});

	test("updateRef moves the branch without force", async () => {
		const { client, http } = setup([json(200, { ref: "refs/heads/main", object: { sha: C } })]);
		expect(await client.updateRef(C)).toEqual({ status: "updated" });
		expect(http.request(0).method).toBe("PATCH");
		expect(http.request(0).url).toBe(`${REPO}/git/refs/heads/main`);
		expect(http.body(0)).toEqual({ sha: C, force: false });
	});

	test("a rejected fast-forward is answered as stale, and nothing is sent again", async () => {
		const { client, http } = setup([json(422, { message: "Update is not a fast forward" })]);
		expect(await client.updateRef(C)).toEqual({ status: "stale" });
		expect(http.requests.length).toBe(1);
	});

	test("another rejection of updateRef is a failure, not stale", async () => {
		expect(await kindOf(setup([json(422, { message: "Object does not exist" })]).client.updateRef(C))).toBe("other");
		expect(await kindOf(setup([json(403, { message: "Resource not accessible" })]).client.updateRef(C))).toBe("forbidden");
	});

	test("a branch deleted before updateRef is a missing branch", async () => {
		const { client, http } = setup([json(422, { message: "Reference does not exist" })]);
		const error = await failureOf(client.updateRef(C));
		expect(error.kind).toBe("branch-not-found");
		expect(http.requests.length).toBe(1);
	});

	test("a write refused over workflow files is told apart", async () => {
		const message = "refusing to allow a Personal Access Token to create or update workflow `.github/workflows/ci.yml` without `workflow` scope";
		expect(await kindOf(setup([json(422, { message })]).client.updateRef(C))).toBe("workflows-permission");
		expect(await kindOf(setup([json(404, { message })]).client.createTree(B, []))).toBe("workflows-permission");
		expect(await kindOf(setup([json(403, { message })]).client.createCommit({ message: "m", tree: B, parents: [A] }))).toBe(
			"workflows-permission",
		);
	});

	test("the workflows check goes by status and wording only", () => {
		expect(isWorkflowsRefusal(403, "refusing to allow a Personal Access Token to create or update workflow")).toBe(true);
		// What a fine-grained token without the permission is told: not by this.
		expect(isWorkflowsRefusal(403, "Resource not accessible by personal access token")).toBe(false);
		expect(isWorkflowsRefusal(404, "Not Found")).toBe(false);
		expect(isWorkflowsRefusal(500, "workflow")).toBe(false);
	});

	test("a read is never reported as a workflows refusal", async () => {
		const { client } = setup([json(404, { message: "workflow not found" })]);
		expect(await kindOf(client.getCommit(A))).toBe("not-found");
	});
});

describe("isAncestor", () => {
	const compare = (status: unknown) => json(200, { status, ahead_by: 1, behind_by: 0, commits: [] });

	test("asks for the comparison with the smallest page", async () => {
		const { client, http } = setup([compare("ahead")]);
		await client.isAncestor(A, B);
		expect(http.request(0).url).toBe(`${REPO}/compare/${A}...${B}?per_page=1`);
	});

	test.each([
		["ahead", true],
		["identical", true],
		["diverged", false],
		["behind", false],
	])("status %s answers %s", async (status, expected) => {
		expect(await setup([compare(status)]).client.isAncestor(A, B)).toBe(expected);
	});

	const head = json(200, { sha: B, tree: { sha: C }, parents: [] });

	test("a base commit the remote does not have is not an ancestor", async () => {
		const { client, http } = setup([notFound(), head]);
		expect(await client.isAncestor(A, B)).toBe(false);
		expect(http.request(1).url).toBe(`${REPO}/git/commits/${B}`);
	});

	test("histories with nothing in common are not an ancestor", async () => {
		const unrelated = json(404, { message: `No common ancestor between ${A} and ${B}.` });
		expect(await setup([unrelated, head]).client.isAncestor(A, B)).toBe(false);
	});

	test("a 404 is not taken for an answer when the head cannot be read either", async () => {
		expect(await kindOf(setup([notFound(), notFound()]).client.isAncestor(A, B))).toBe("not-found");
		expect(await kindOf(setup([notFound(), json(503, {})]).client.isAncestor(A, B))).toBe("unreachable");
		expect(await kindOf(setup([notFound(), new Error("offline")]).client.isAncestor(A, B))).toBe("unreachable");
	});

	test("a failure to find out is thrown, never answered as not an ancestor", async () => {
		expect(await kindOf(setup([json(500, { message: "Server Error" })]).client.isAncestor(A, B))).toBe("unreachable");
		expect(await kindOf(setup([json(503, {})]).client.isAncestor(A, B))).toBe("unreachable");
		expect(await kindOf(setup([new Error("offline")]).client.isAncestor(A, B))).toBe("unreachable");
		expect(await kindOf(setup(["hang"]).client.isAncestor(A, B))).toBe("unreachable");
		expect(await kindOf(setup([compare("sideways")]).client.isAncestor(A, B))).toBe("other");
		expect(await kindOf(setup([compare(undefined)]).client.isAncestor(A, B))).toBe("other");
		expect(await kindOf(setup([raw(200, "not json")]).client.isAncestor(A, B))).toBe("other");
		expect(await kindOf(setup([json(401, { message: "Bad credentials" })]).client.isAncestor(A, B))).toBe("unauthorized");
	});
});

describe("rate limits", () => {
	const primary = (resetSeconds: number) =>
		json(
			403,
			{ message: "API rate limit exceeded for user ID 1." },
			// Mixed case on purpose: the platforms do not agree on it.
			{ "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(resetSeconds) },
		);
	/** The same, with the time GitHub's clock showed when it answered. */
	const primaryAt = (resetSeconds: number, date: string) => {
		const response = primary(resetSeconds);
		return { ...response, headers: { ...response.headers, Date: date } };
	};
	const FIVE_MINUTES = 300_000;
	const secondary = (retryAfter?: number) =>
		json(
			403,
			{ message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." },
			retryAfter === undefined ? {} : { "Retry-After": String(retryAfter) },
		);

	test("a primary limit is waited out until the reset time, then the call succeeds", async () => {
		const { client, http, time } = setup([primary(START / 1000 + 90), ref(A)]);
		expect(await client.resolveHead()).toEqual({ status: "commit", sha: A });
		// 90 seconds to the reset, plus the margin.
		expect(time.slept).toBe(91_000);
		expect(http.request(1).at).toBe(START + 91_000);
		expect(http.request(1).url).toBe(http.request(0).url);
		// Slept in slices, so that the clock is read again in between.
		expect(Math.max(...time.sleeps)).toBeLessThanOrEqual(10_000);
	});

	test("a secondary limit is waited out for the time in retry-after", async () => {
		const { client, http, time } = setup([secondary(7), json(201, { sha: A })]);
		expect(await client.createBlob(new Uint8Array([1]))).toBe(A);
		expect(time.sleeps).toEqual([8_000]);
		// The write is repeated as it was.
		expect(http.request(1).method).toBe("POST");
		expect(http.request(1).body).toBe(http.request(0).body);
	});

	test("a 429 is handled like a 403", async () => {
		const limited = json(429, { message: "Too Many Requests" }, { "retry-after": "2" });
		const { client, time } = setup([limited, ref(A)]);
		expect(await client.resolveHead()).toEqual({ status: "commit", sha: A });
		expect(time.slept).toBe(3_000);

		const bare = setup([json(429, {}), ref(A)]);
		await bare.client.resolveHead();
		expect(bare.time.slept).toBe(61_000);
	});

	test("a secondary limit that names no time is waited out for a minute", async () => {
		const { client, time } = setup([secondary(), ref(A)]);
		expect(await client.resolveHead()).toEqual({ status: "commit", sha: A });
		expect(time.slept).toBe(61_000);
	});

	test("the wait ends by the clock, not by the count of sleeps", async () => {
		const { client, http, time } = setup([primary(START / 1000 + 3600), ref(A)]);
		// Each timer takes two hours longer than asked, as after a spell in the background.
		time.overshoot = 7_200_000;
		await client.resolveHead();
		expect(time.sleeps).toEqual([10_000]);
		expect(http.requests.length).toBe(2);
	});

	test("a reset time already past by the device clock is retried after the margin only", async () => {
		const { client, time } = setup([primary(START / 1000 - 30), ref(A)]);
		await client.resolveHead();
		expect(time.sleeps).toEqual([1_000]);
	});

	test("a device clock that runs behind does not lengthen the wait", async () => {
		// GitHub's clock is five minutes ahead of the device's, and the reset is 90 seconds away.
		const github = START + FIVE_MINUTES;
		const { client, http, time } = setup([primaryAt(github / 1000 + 90, new Date(github).toUTCString()), ref(A)]);
		expect(await client.resolveHead()).toEqual({ status: "commit", sha: A });
		expect(time.slept).toBe(91_000);
		expect(http.requests.length).toBe(2);
	});

	test("a device clock that runs ahead does not cut the wait short", async () => {
		// By the device clock alone this reset is already three and a half minutes past.
		const github = START - FIVE_MINUTES;
		const { client, http, time } = setup([primaryAt(github / 1000 + 90, new Date(github).toUTCString()), ref(A)]);
		expect(await client.resolveHead()).toEqual({ status: "commit", sha: A });
		expect(time.slept).toBe(91_000);
		expect(http.requests.length).toBe(2);
	});

	test("the time to wait until is given on the device clock", async () => {
		const github = START - FIVE_MINUTES;
		const { client } = setup([primaryAt(github / 1000 + 90, new Date(github).toUTCString())], {
			onRateLimit: () => false,
		});
		const error = await failureOf(client.resolveHead());
		expect((error as RateLimitedError).waitUntil).toBe(START + 91_000);
	});

	test("without a readable date header the reset is read against the device clock", async () => {
		const missing = setup([primary(START / 1000 + 90), ref(A)]);
		await missing.client.resolveHead();
		expect(missing.time.slept).toBe(91_000);

		for (const date of ["", "garbage", "0x"]) {
			const { client, time } = setup([primaryAt(START / 1000 + 90, date), ref(A)]);
			await client.resolveHead();
			expect(time.slept).toBe(91_000);
		}
	});

	test("retry-after is a duration and ignores the date header", async () => {
		const limited = json(429, {}, { "retry-after": "7", date: new Date(START + FIVE_MINUTES).toUTCString() });
		const { client, time } = setup([limited, ref(A)]);
		await client.resolveHead();
		expect(time.slept).toBe(8_000);
	});

	test("an exhausted quota that names no reset time is waited out for a minute", async () => {
		const notices: RateLimitNotice[] = [];
		const limited = json(403, { message: "Forbidden" }, { "x-ratelimit-remaining": "0" });
		const { client, time } = setup([limited, ref(A)], {
			onRateLimit: (notice) => {
				notices.push(notice);
				return true;
			},
		});
		expect(await client.resolveHead()).toEqual({ status: "commit", sha: A });
		expect(notices).toEqual([{ kind: "primary", until: START + 61_000, stated: false, retries: 0 }]);
		expect(time.slept).toBe(61_000);
	});

	test("the caller is told how many times the request was already retried", async () => {
		const retries: number[] = [];
		const { client, http } = setup([secondary(1), secondary(1), secondary(1), ref(A)], {
			onRateLimit: (notice) => {
				retries.push(notice.retries);
				return true;
			},
		});
		expect(await client.resolveHead()).toEqual({ status: "commit", sha: A });
		expect(retries).toEqual([0, 1, 2]);
		expect(http.requests.length).toBe(4);
	});

	test("a time further away than two hours is not waited for", async () => {
		const notices: RateLimitNotice[] = [];
		const { client, http, time } = setup([secondary(3 * 3600), ref(A)], {
			onRateLimit: (notice) => {
				notices.push(notice);
				return true;
			},
		});
		const error = await failureOf(client.resolveHead());
		expect(error).toBeInstanceOf(RateLimitedError);
		expect((error as RateLimitedError).waitUntil).toBe(START + 3 * 3600_000 + 1000);
		// Not even asked: the answer would not change anything.
		expect(notices).toEqual([]);
		expect(time.sleeps).toEqual([]);
		expect(http.requests.length).toBe(1);
	});

	test("a time just under two hours away is waited for", async () => {
		const { client, time } = setup([secondary(7000), ref(A)]);
		expect(await client.resolveHead()).toEqual({ status: "commit", sha: A });
		expect(time.slept).toBe(7_001_000);
	});

	test("cancelling during a wait ends it, and the held request is not sent again", async () => {
		const stop = new AbortController();
		const { client, http, time } = setup([primary(START / 1000 + 90), json(200, {})], { signal: stop.signal });
		const promise = client.updateRef(A);
		// Stops after the first slice of the wait has passed.
		const watch = setInterval(() => {
			if (time.sleeps.length >= 1) stop.abort();
		}, 0);
		try {
			expect(await kindOf(promise)).toBe("cancelled");
		} finally {
			clearInterval(watch);
		}
		expect(time.slept).toBeLessThan(91_000);
		expect(http.requests.length).toBe(1);
	});

	test("cancelling ends a wait without waiting for the slice to pass", async () => {
		const stop = new AbortController();
		const signals: (AbortSignal | undefined)[] = [];
		const { client, http } = setup([primary(START / 1000 + 90), ref(A)], {
			signal: stop.signal,
			// A timer that stands still, as in the background.
			sleep: (_ms, signal) => {
				signals.push(signal);
				return new Promise(() => {});
			},
		});
		const promise = client.resolveHead();
		setTimeout(() => stop.abort(), 5);
		expect(await kindOf(promise)).toBe("cancelled");
		expect(http.requests.length).toBe(1);
		// The request's timeout and the slice of the wait: both timers were dropped.
		expect(signals.map((signal) => signal?.aborted)).toEqual([true, true]);
	});

	test("nothing is sent once cancelled", async () => {
		const stop = new AbortController();
		stop.abort();
		const { client, http } = setup([ref(A)], { signal: stop.signal });
		expect(await kindOf(client.resolveHead())).toBe("cancelled");
		expect(http.requests.length).toBe(0);
	});

	test("the caller can decline to wait, and gets the time to wait until", async () => {
		const notices: RateLimitNotice[] = [];
		const { client, http, time } = setup([primary(START / 1000 + 600), ref(A)], {
			onRateLimit: (notice) => {
				notices.push(notice);
				return false;
			},
		});
		const error = await failureOf(client.getTree(B));
		expect(error.kind).toBe("rate-limited");
		expect(error).toBeInstanceOf(RateLimitedError);
		expect((error as RateLimitedError).waitUntil).toBe(START + 601_000);
		expect(notices).toEqual([{ kind: "primary", until: START + 601_000, stated: true, retries: 0 }]);
		expect(time.sleeps).toEqual([]);
		expect(http.requests.length).toBe(1);
	});

	test("a caller that agrees, even asynchronously, gets the wait", async () => {
		const { client, time } = setup([secondary(1), ref(A)], { onRateLimit: async () => true });
		expect(await client.resolveHead()).toEqual({ status: "commit", sha: A });
		expect(time.slept).toBe(2_000);
	});

	test("one request is not retried without end", async () => {
		const { client, http, time } = setup([secondary(1), secondary(1), secondary(1), secondary(1), ref(A)]);
		const error = await failureOf(client.resolveHead());
		expect(error.kind).toBe("rate-limited");
		expect((error as RateLimitedError).waitUntil).toBe(time.current + 2_000);
		// The first attempt and three retries.
		expect(http.requests.length).toBe(4);

		const once = setup([secondary(1), secondary(1), ref(A)], { maxRateLimitRetries: 1 });
		expect(await kindOf(once.client.resolveHead())).toBe("rate-limited");
		expect(once.http.requests.length).toBe(2);
	});

	test("a limit that names no time is waited out with waits that double", async () => {
		const { client, time } = setup([secondary(), secondary(), secondary(), secondary(), secondary(), json(201, { sha: A })]);
		expect(await client.createBlob(new Uint8Array([1]))).toBe(A);
		// 1, 2, 4, 8 and 16 minutes, each with the margin: more retries than
		// the cap on limits that name their time allows.
		expect(time.slept).toBe((1 + 2 + 4 + 8 + 16) * 60_000 + 5 * 1000);
	});

	test("the caller is told the doubled time", async () => {
		const notices: RateLimitNotice[] = [];
		const { client } = setup([secondary(), secondary(), ref(A)], {
			onRateLimit: (notice) => {
				notices.push(notice);
				return true;
			},
		});
		await client.resolveHead();
		expect(notices).toEqual([
			{ kind: "secondary", until: START + 61_000, stated: false, retries: 0 },
			{ kind: "secondary", until: START + 61_000 + 121_000, stated: false, retries: 1 },
		]);
	});

	test("a limit that names no time is given up on after an hour of waiting", async () => {
		const refusals = Array.from({ length: 8 }, () => secondary());
		const { client, http, time } = setup(refusals);
		const error = await failureOf(client.createBlob(new Uint8Array([1])));
		expect(error).toBeInstanceOf(RateLimitedError);
		// 1 + 2 + 4 + 8 + 16 + 32 minutes is the first total past the hour.
		expect(time.slept).toBe(63 * 60_000 + 6 * 1000);
		expect(http.requests.length).toBe(7);
		expect((error as RateLimitedError).waitUntil).toBe(time.current + 61_000);
	});

	test("the two kinds of limit are counted apart", async () => {
		// Three limits with a time use up their cap; the ones without do not count toward it.
		const { client } = setup([secondary(), secondary(1), secondary(), secondary(1), secondary(1), ref(A)]);
		expect(await client.resolveHead()).toEqual({ status: "commit", sha: A });
	});

	test("the count of retries starts over with each request", async () => {
		const { client, http } = setup([secondary(1), ref(A), secondary(1), ref(B)], { maxRateLimitRetries: 1 });
		await client.resolveHead();
		expect(await client.resolveHead()).toEqual({ status: "commit", sha: B });
		expect(http.requests.length).toBe(4);
	});

	test("the zip waits out a limit as well", async () => {
		const { client, time } = setup([primary(START / 1000 + 5), raw(200, new Uint8Array([80, 75]))]);
		expect((await client.getZip(A)).byteLength).toBe(2);
		expect(time.slept).toBe(6_000);
	});

	describe("requests at the same time", () => {
		const blob = () => raw(200, new Uint8Array([1]));
		const RESET = START + 91_000;

		test("the caller is asked once for the limit they hit together, and all of them continue", async () => {
			const notices: RateLimitNotice[] = [];
			const limited = [primary(START / 1000 + 90), primary(START / 1000 + 90), primary(START / 1000 + 90)];
			const { client, http } = setup([...limited, blob(), blob(), blob()], {
				onRateLimit: (notice) => {
					notices.push(notice);
					return true;
				},
			});
			const blobs = await Promise.all([client.getBlob(A), client.getBlob(B), client.getBlob(C)]);
			expect(blobs).toHaveLength(3);
			expect(notices).toEqual([{ kind: "primary", until: RESET, stated: true, retries: 0 }]);
			expect(http.requests.length).toBe(6);
			for (const index of [3, 4, 5]) expect(http.request(index).at).toBeGreaterThanOrEqual(RESET);
		});

		test("an answer that takes a moment is shared too", async () => {
			let asked = 0;
			const limited = [primary(START / 1000 + 90), primary(START / 1000 + 90), primary(START / 1000 + 90)];
			const { client } = setup([...limited, blob(), blob(), blob()], {
				onRateLimit: async () => {
					asked += 1;
					await new Promise((resolve) => setTimeout(resolve, 0));
					return true;
				},
			});
			await Promise.all([client.getBlob(A), client.getBlob(B), client.getBlob(C)]);
			expect(asked).toBe(1);
		});

		test("a request that was not sent yet waits for the limit another one hit", async () => {
			const { client, http, time } = setup([primary(START / 1000 + 90), blob(), blob()]);
			const first = client.getBlob(A);
			// The first has been refused and is waiting.
			while (time.sleeps.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
			expect(http.requests.length).toBe(1);
			await Promise.all([first, client.getBlob(B)]);
			expect(http.requests.length).toBe(3);
			expect(http.request(1).at).toBeGreaterThanOrEqual(RESET);
			expect(http.request(2).at).toBeGreaterThanOrEqual(RESET);
		});

		test("a limit that ends later than the wait agreed to is asked about again", async () => {
			const untils: number[] = [];
			const { client } = setup([secondary(5), secondary(60), blob(), blob()], {
				onRateLimit: (notice) => {
					untils.push(notice.until);
					return true;
				},
			});
			await Promise.all([client.getBlob(A), client.getBlob(B)]);
			expect(untils).toEqual([START + 6_000, START + 61_000]);
		});

		/**
		 * A client whose clock is `step` ms further each time it is read, so
		 * that the responses of requests sent together are read at different
		 * times, as they are when they come in one after the other.
		 */
		function setupApart(script: Step[], step: number) {
			const time = new FakeTime();
			const http = new FakeHttp(time, script);
			const notices: RateLimitNotice[] = [];
			let reads = 0;
			const client = new GitHubClient({
				owner: "octo",
				repo: "notes",
				branch: "main",
				token: TOKEN,
				http: http.send,
				now: () => time.current + step * reads++,
				sleep: time.sleep,
				onRateLimit: (notice) => {
					notices.push(notice);
					return true;
				},
			});
			return { client, http, notices };
		}

		test("responses that put the end of one limit at slightly different times ask once", async () => {
			// GitHub's clock, in whole seconds, moved on before the last
			// answer, and the device read each a few hundred ms apart: the
			// same reset lands on three times of the device clock.
			const reset = START / 1000 + 90;
			const limited = [
				primaryAt(reset, new Date(START).toUTCString()),
				primaryAt(reset, new Date(START).toUTCString()),
				primaryAt(reset, new Date(START + 1000).toUTCString()),
			];
			const { client, http, notices } = setupApart([...limited, blob(), blob(), blob()], 300);
			const blobs = await Promise.all([client.getBlob(A), client.getBlob(B), client.getBlob(C)]);
			expect(blobs).toHaveLength(3);
			expect(notices).toHaveLength(1);
			expect(http.requests.length).toBe(6);
			for (const index of [3, 4, 5]) expect(http.request(index).at).toBeGreaterThanOrEqual(START + 90_000);
		});

		test("16 requests refused by a secondary limit ask once, and all of them continue", async () => {
			const count = 16;
			const script = [
				...Array.from({ length: count }, () => secondary(30)),
				...Array.from({ length: count }, () => blob()),
			];
			// `retry-after` counts from when each response is read: 16 ends,
			// spread over most of a second.
			const { client, http, notices } = setupApart(script, 50);
			const shas = Array.from({ length: count }, (_, index) => index.toString(16).padStart(40, "0"));
			const blobs = await Promise.all(shas.map((sha) => client.getBlob(sha)));
			expect(blobs).toHaveLength(count);
			expect(notices).toHaveLength(1);
			expect(notices[0]?.kind).toBe("secondary");
			expect(http.requests.length).toBe(count * 2);
			for (let index = count; index < count * 2; index++) {
				expect(http.request(index).at).toBeGreaterThanOrEqual(START + 30_000);
			}
		});

		test("a wait that has passed holds no one back", async () => {
			const { client, http, time } = setup([secondary(5), blob(), blob()]);
			await client.getBlob(A);
			const slept = time.slept;
			await client.getBlob(B);
			expect(time.slept).toBe(slept);
			expect(http.requests.length).toBe(3);
		});

		test("declining fails each of them, and holds no one back", async () => {
			const limited = [primary(START / 1000 + 90), primary(START / 1000 + 90), blob()];
			const { client, http, time } = setup(limited, { onRateLimit: () => false });
			const failures = await Promise.all([failureOf(client.getBlob(A)), failureOf(client.getBlob(B))]);
			expect(failures.map((failure) => (failure as RateLimitedError).waitUntil)).toEqual([RESET, RESET]);
			// The next one is sent at once: nothing was agreed to.
			await client.getBlob(C);
			expect(time.sleeps).toEqual([]);
			expect(http.requests.length).toBe(3);
		});

		test("cancelling ends the wait of a request that was not sent yet, and it is not sent", async () => {
			const stop = new AbortController();
			const { client, http, time } = setup([primary(START / 1000 + 90), blob(), blob()], { signal: stop.signal });
			const first = kindOf(client.getBlob(A));
			while (time.sleeps.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
			const second = kindOf(client.getBlob(B));
			stop.abort();
			expect(await Promise.all([first, second])).toEqual(["cancelled", "cancelled"]);
			expect(http.requests.length).toBe(1);
		});
	});
});

describe("the quota", () => {
	const quota = (remaining: number, resetSeconds: number, more: Record<string, string> = {}) => ({
		"X-RateLimit-Limit": "5000",
		"X-RateLimit-Remaining": String(remaining),
		"X-RateLimit-Reset": String(resetSeconds),
		...more,
	});
	const head = (headers: Record<string, string>) =>
		json(200, { ref: "refs/heads/main", object: { type: "commit", sha: A } }, headers);
	const RESET_SECONDS = START / 1000 + 1800;

	test("is not known before a response reports it", async () => {
		const { client } = setup([ref(A)]);
		expect(client.quota).toBeNull();
		await client.resolveHead();
		expect(client.quota).toBeNull();
	});

	test("is what the last response reported, without a request of its own", async () => {
		const { client, http } = setup([head(quota(4321, RESET_SECONDS)), head(quota(4320, RESET_SECONDS))]);
		await client.resolveHead();
		expect(client.quota).toEqual({ remaining: 4321, resetAt: START + 1_800_000, limit: 5000 });
		await client.resolveHead();
		expect(client.quota?.remaining).toBe(4320);
		expect(http.requests.length).toBe(2);
	});

	test("the limit is left out when the response does not name it", async () => {
		const headers = { "x-ratelimit-remaining": "7", "x-ratelimit-reset": String(RESET_SECONDS) };
		const { client } = setup([head(headers)]);
		await client.resolveHead();
		expect(client.quota).toEqual({ remaining: 7, resetAt: START + 1_800_000 });
	});

	test("the reset is given on the device clock", async () => {
		// GitHub's clock is five minutes ahead of the device's.
		const github = START + 300_000;
		const headers = quota(10, github / 1000 + 1800, { Date: new Date(github).toUTCString() });
		const { client } = setup([head(headers)]);
		await client.resolveHead();
		expect(client.quota?.resetAt).toBe(START + 1_800_000);
	});

	test("a response that reports none leaves the last one standing", async () => {
		const { client } = setup([head(quota(10, RESET_SECONDS)), ref(B), head({ "x-ratelimit-remaining": "9" })]);
		await client.resolveHead();
		await client.resolveHead();
		await client.resolveHead();
		expect(client.quota?.remaining).toBe(10);
	});

	test("the quota of another resource is not this one", async () => {
		const { client } = setup([
			head(quota(10, RESET_SECONDS, { "X-RateLimit-Resource": "core" })),
			head(quota(3, RESET_SECONDS, { "X-RateLimit-Resource": "search" })),
		]);
		await client.resolveHead();
		await client.resolveHead();
		expect(client.quota?.remaining).toBe(10);
	});

	test("a failure reports it like any other response", async () => {
		const { client } = setup([json(404, { message: "Not Found" }, quota(42, RESET_SECONDS))]);
		expect(await kindOf(client.getBlob(A))).toBe("not-found");
		expect(client.quota?.remaining).toBe(42);
	});

	test("a refusal for the limit reports that nothing is left", async () => {
		const refused = json(403, { message: "API rate limit exceeded" }, quota(0, RESET_SECONDS));
		const { client } = setup([refused], { onRateLimit: () => false });
		expect(await kindOf(client.resolveHead())).toBe("rate-limited");
		expect(client.quota).toEqual({ remaining: 0, resetAt: START + 1_800_000, limit: 5000 });
	});
});

describe("timeouts and connection failures", () => {
	test("a request that gets no answer fails as unreachable after the API timeout", async () => {
		const { client, time } = setup(["hang"]);
		expect(await kindOf(client.getCommit(A))).toBe("unreachable");
		expect(time.sleeps).toEqual([60_000]);

		const short = setup(["hang"], { apiTimeoutMs: 5_000 });
		expect(await kindOf(short.client.updateRef(A))).toBe("unreachable");
		expect(short.time.sleeps).toEqual([5_000]);
	});

	test("a blob is given longer by its size, at 50 KB a second", async () => {
		const small = setup(["hang"]);
		expect(await kindOf(small.client.getBlob(A))).toBe("unreachable");
		expect(small.time.sleeps).toEqual([60_000]);

		const large = setup(["hang"]);
		expect(await kindOf(large.client.getBlob(A, 50_000_000))).toBe("unreachable");
		expect(large.time.sleeps).toEqual([60_000 + 1_000_000]);
	});

	test("a write is given longer by the size of its body", async () => {
		const blob = setup(["hang"]);
		const content = new Uint8Array(3_000_000);
		expect(await kindOf(blob.client.createBlob(content))).toBe("unreachable");
		// Base64 makes four bytes of three.
		const body = JSON.stringify({ content: "A".repeat(4_000_000), encoding: "base64" }).length;
		expect(blob.time.sleeps).toEqual([60_000 + Math.ceil(body / 50)]);

		const tree = setup(["hang"]);
		const text = "x".repeat(1_000_000);
		expect(await kindOf(tree.client.createTree(B, [{ path: "a.md", mode: "100644", content: text }]))).toBe("unreachable");
		expect(tree.time.sleeps[0]).toBeGreaterThan(60_000 + 20_000);
	});

	test("the size of a body is counted in bytes, not characters", async () => {
		const change = (content: string) => [{ path: "a.md", mode: "100644" as const, content }];
		const ascii = setup(["hang"]);
		await kindOf(ascii.client.createTree(B, change("x".repeat(1_000_000))));
		const kana = setup(["hang"]);
		await kindOf(kana.client.createTree(B, change("あ".repeat(1_000_000))));
		const emoji = setup(["hang"]);
		await kindOf(emoji.client.createTree(B, change("😀".repeat(1_000_000))));
		// Three bytes a character, and four: 2,000,000 and 3,000,000 more bytes at 50 KB a second.
		expect((kana.time.sleeps[0] ?? 0) - (ascii.time.sleeps[0] ?? 0)).toBe(40_000);
		expect((emoji.time.sleeps[0] ?? 0) - (ascii.time.sleeps[0] ?? 0)).toBe(60_000);
	});

	test("the listing of a tree is given as long as the zip", async () => {
		const { client, time } = setup(["hang"]);
		expect(await kindOf(client.getTree(A))).toBe("unreachable");
		expect(time.sleeps).toEqual([600_000]);
	});

	test("the zip is given much longer", async () => {
		const { client, time } = setup(["hang"]);
		expect(await kindOf(client.getZip(A))).toBe("unreachable");
		expect(time.sleeps).toEqual([600_000]);

		const short = setup(["hang"], { zipTimeoutMs: 20_000, apiTimeoutMs: 5_000 });
		expect(await kindOf(short.client.getZip(A))).toBe("unreachable");
		expect(short.time.sleeps).toEqual([20_000]);
	});

	test("an answered request leaves no timer running", async () => {
		const { client, time } = setup([ref(A)]);
		await client.resolveHead();
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(time.sleeps).toEqual([]);
		expect(time.current).toBe(START);
	});

	test("a request that throws fails as unreachable", async () => {
		expect(await kindOf(setup([new Error("net::ERR_INTERNET_DISCONNECTED")]).client.resolveHead())).toBe("unreachable");
		expect(await kindOf(setup([new Error("offline")]).client.updateRef(A))).toBe("unreachable");
	});
});

describe("timerSleep", () => {
	const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

	/** Whether the sleep has resolved, read without waiting for it. */
	function watch(sleep: Promise<void>): { done: boolean } {
		const state = { done: false };
		void sleep.then(() => {
			state.done = true;
		});
		return state;
	}

	/** A signal that counts the abort listeners still attached to it. */
	function counted(controller: AbortController): { signal: AbortSignal; listeners: () => number } {
		const signal = controller.signal;
		const add = signal.addEventListener.bind(signal);
		const remove = signal.removeEventListener.bind(signal);
		const attached = new Set<unknown>();
		signal.addEventListener = (type: string, listener: EventListenerOrEventListenerObject | null, options?: unknown) => {
			if (type === "abort") attached.add(listener);
			add(type, listener as EventListener, options as AddEventListenerOptions);
		};
		signal.removeEventListener = (type: string, listener: EventListenerOrEventListenerObject | null, options?: unknown) => {
			if (type === "abort") attached.delete(listener);
			remove(type, listener as EventListener, options as EventListenerOptions);
		};
		return { signal, listeners: () => attached.size };
	}

	test("resolves once the time has passed, and not before", async () => {
		const state = watch(timerSleep(40));
		await pause(5);
		expect(state.done).toBe(false);
		await pause(80);
		expect(state.done).toBe(true);
	});

	test("a sleep that ran to its end leaves no listener on the signal", async () => {
		const controller = new AbortController();
		const { signal, listeners } = counted(controller);
		const sleep = timerSleep(10, signal);
		expect(listeners()).toBe(1);
		await sleep;
		expect(listeners()).toBe(0);
		// Aborting afterwards finds nothing to do.
		controller.abort();
	});

	test("aborted while it runs, it drops the timer and never resolves", async () => {
		const controller = new AbortController();
		const { signal, listeners } = counted(controller);
		const state = watch(timerSleep(30, signal));
		await pause(5);
		controller.abort();
		expect(listeners()).toBe(0);
		await pause(80);
		expect(state.done).toBe(false);
	});

	test("with a signal that is already aborted, it starts no timer and never resolves", async () => {
		const controller = new AbortController();
		controller.abort();
		const { signal, listeners } = counted(controller);
		const state = watch(timerSleep(10, signal));
		expect(listeners()).toBe(0);
		await pause(60);
		expect(state.done).toBe(false);
	});
});

describe("the token", () => {
	test("never appears in the message of a failure", async () => {
		const echo = `no access for Bearer ${TOKEN}`;
		const failures = [
			await failureOf(setup([new Error(echo)]).client.resolveHead()),
			await failureOf(setup([json(401, { message: echo })]).client.resolveHead()),
			await failureOf(setup([json(403, { message: echo })]).client.getTree(A)),
			await failureOf(setup([json(404, { message: `workflow ${echo}` })]).client.createTree(A, [])),
			await failureOf(setup([json(500, { message: echo })]).client.getZip(A)),
			await failureOf(setup(["hang"]).client.getBlob(A)),
			await failureOf(setup([json(403, { message: echo }, { "retry-after": "1" })], { onRateLimit: () => false }).client.getBlob(A)),
			await failureOf(setup([json(200, { nothing: TOKEN })]).client.getCommit(A)),
		];
		for (const failure of failures) {
			expect(failure.message).not.toContain(TOKEN);
			expect(failure.message).not.toBe("");
		}
	});
});

describe("encodeBase64", () => {
	const ascii = (text: string) => new TextEncoder().encode(text);

	test("matches the vectors of RFC 4648", () => {
		expect(encodeBase64(ascii(""))).toBe("");
		expect(encodeBase64(ascii("f"))).toBe("Zg==");
		expect(encodeBase64(ascii("fo"))).toBe("Zm8=");
		expect(encodeBase64(ascii("foo"))).toBe("Zm9v");
		expect(encodeBase64(ascii("foob"))).toBe("Zm9vYg==");
		expect(encodeBase64(ascii("fooba"))).toBe("Zm9vYmE=");
		expect(encodeBase64(ascii("foobar"))).toBe("Zm9vYmFy");
	});

	test("uses the standard alphabet for the high values", () => {
		expect(encodeBase64(new Uint8Array([251, 255, 254]))).toBe("+//+");
		expect(encodeBase64(new Uint8Array([255, 255]))).toBe("//8=");
	});

	test("encodes a view onto part of a larger buffer", () => {
		const whole = ascii("xxfoobarxx");
		expect(encodeBase64(whole.subarray(2, 8))).toBe("Zm9vYmFy");
	});

	test("encodes several megabytes without overflowing the stack", () => {
		for (const length of [5 * 1024 * 1024, 5 * 1024 * 1024 + 1, 5 * 1024 * 1024 + 2]) {
			const data = new Uint8Array(length);
			// Every byte value, in an order that does not repeat with the groups of three.
			for (let i = 0; i < length; i++) data[i] = (i * 31 + (i >> 8)) & 255;
			expect(encodeBase64(data) === Buffer.from(data).toString("base64")).toBe(true);
		}
	});
});

describe("asking for the head conditionally", () => {
	const ETAG = 'W/"0123abcd"';
	const withEtag = (sha: string, etag = ETAG, name = "ETag") => json(200, { object: { type: "commit", sha } }, { [name]: etag });
	const notModified = (): HttpResponse => raw(304, "", { ETag: ETAG });
	const sentBack = (request: HttpRequest): string | undefined => request.headers["If-None-Match"];

	test("the first request is a full one, and the next sends the ETag back", async () => {
		const { client, http } = setup([withEtag(A), notModified()], { headMemory: new HeadMemory() });
		expect(await client.resolveHead()).toEqual({ status: "commit", sha: A });
		expect(sentBack(http.request(0))).toBeUndefined();
		expect(await client.resolveHead()).toEqual({ status: "commit", sha: A });
		expect(sentBack(http.request(1))).toBe(ETAG);
		// Still asked of GitHub itself, and not of what the app kept.
		expect(http.request(1).headers["Cache-Control"]).toBe("no-cache");
	});

	test("a 304 is the commit the ETag came with, as often as it is answered", async () => {
		const { client, http } = setup([withEtag(A), notModified(), notModified()], { headMemory: new HeadMemory() });
		await client.resolveHead();
		expect(await client.resolveHead()).toEqual({ status: "commit", sha: A });
		expect(await client.resolveHead()).toEqual({ status: "commit", sha: A });
		expect(sentBack(http.request(2))).toBe(ETAG);
	});

	test("the header is found in whatever case the platform gives it", async () => {
		const { client, http } = setup([withEtag(A, ETAG, "etag"), notModified()], { headMemory: new HeadMemory() });
		await client.resolveHead();
		await client.resolveHead();
		expect(sentBack(http.request(1))).toBe(ETAG);
	});

	test("a 200 with the same commit works as before, where no 304 is ever shown", async () => {
		const { client, http } = setup([withEtag(A), withEtag(A), withEtag(A)], { headMemory: new HeadMemory() });
		expect(await client.resolveHead()).toEqual({ status: "commit", sha: A });
		expect(await client.resolveHead()).toEqual({ status: "commit", sha: A });
		expect(await client.resolveHead()).toEqual({ status: "commit", sha: A });
		expect(sentBack(http.request(2))).toBe(ETAG);
	});

	test("a 200 with another commit takes the place of what was remembered", async () => {
		const other = 'W/"9999"';
		const { client, http } = setup([withEtag(A), withEtag(B, other), notModified()], { headMemory: new HeadMemory() });
		await client.resolveHead();
		expect(await client.resolveHead()).toEqual({ status: "commit", sha: B });
		expect(await client.resolveHead()).toEqual({ status: "commit", sha: B });
		expect(sentBack(http.request(2))).toBe(other);
	});

	test("without a memory nothing is sent back", async () => {
		const { client, http } = setup([withEtag(A), withEtag(A)]);
		await client.resolveHead();
		await client.resolveHead();
		expect(sentBack(http.request(1))).toBeUndefined();
	});

	test("an answer without an ETag leaves nothing to send back", async () => {
		const { client, http } = setup([withEtag(A), ref(B), ref(B)], { headMemory: new HeadMemory() });
		await client.resolveHead();
		await client.resolveHead();
		await client.resolveHead();
		expect(sentBack(http.request(1))).toBe(ETAG);
		expect(sentBack(http.request(2))).toBeUndefined();
	});

	test.each<[string, Partial<GitHubClientOptions>]>([
		["another token", { token: "github_pat_OTHER" }],
		["another branch", { branch: "work" }],
		["another repository", { repo: "other" }],
		["another owner", { owner: "someone" }],
	])("the ETag of one request is not sent with %s", async (_name, change) => {
		const headMemory = new HeadMemory();
		const first = setup([withEtag(A)], { headMemory });
		await first.client.resolveHead();
		const second = setup([withEtag(B, 'W/"other"')], { headMemory, ...change });
		expect(await second.client.resolveHead()).toEqual({ status: "commit", sha: B });
		expect(sentBack(second.http.request(0))).toBeUndefined();
		// What the second remembered is not the first's any more.
		const again = setup([withEtag(A)], { headMemory });
		await again.client.resolveHead();
		expect(sentBack(again.http.request(0))).toBeUndefined();
	});

	test("the same connection in another client sends it back", async () => {
		const headMemory = new HeadMemory();
		await setup([withEtag(A)], { headMemory }).client.resolveHead();
		const next = setup([notModified()], { headMemory });
		expect(await next.client.resolveHead()).toEqual({ status: "commit", sha: A });
		expect(sentBack(next.http.request(0))).toBe(ETAG);
	});

	test("a 304 to a request that sent no ETag names no commit, and fails", async () => {
		const bare = setup([notModified()]);
		expect(await kindOf(bare.client.resolveHead())).toBe("other");
		const fresh = setup([notModified()], { headMemory: new HeadMemory() });
		expect(await kindOf(fresh.client.resolveHead())).toBe("other");
	});

	test.each<[string, Step[]]>([
		["a repository that has become empty", [json(409, { message: "Git Repository is empty." })]],
		["a failure of the server", [json(502, { message: "Bad Gateway" })]],
		["a branch that is gone", [notFound(), json(200, {})]],
	])("after %s nothing is sent back", async (_name, answers) => {
		const headMemory = new HeadMemory();
		const { client, http } = setup([withEtag(A), ...answers, withEtag(A)], { headMemory });
		await client.resolveHead();
		await client.resolveHead().catch(() => {});
		await client.resolveHead();
		expect(sentBack(http.request(http.requests.length - 1))).toBeUndefined();
	});

	test("a request that got no answer leaves what was remembered", async () => {
		const headMemory = new HeadMemory();
		const { client, http } = setup([withEtag(A), new Error("offline"), notModified()], { headMemory });
		await client.resolveHead();
		expect(await kindOf(client.resolveHead())).toBe("unreachable");
		expect(await client.resolveHead()).toEqual({ status: "commit", sha: A });
		expect(sentBack(http.request(2))).toBe(ETAG);
	});

	test("a rate limit that is waited out sends the same conditional request again", async () => {
		const limited = json(429, { message: "API rate limit exceeded" }, { "Retry-After": "30" });
		const { client, http } = setup([withEtag(A), limited, notModified()], { headMemory: new HeadMemory() });
		await client.resolveHead();
		expect(await client.resolveHead()).toEqual({ status: "commit", sha: A });
		expect(sentBack(http.request(2))).toBe(ETAG);
	});

	test("how the head was answered is logged", async () => {
		const lines: string[] = [];
		const { client } = setup([withEtag(A), notModified(), withEtag(B, 'W/"2"')], {
			headMemory: new HeadMemory(),
			log: (line) => lines.push(line),
		});
		await client.resolveHead();
		await client.resolveHead();
		await client.resolveHead();
		expect(lines).toEqual(["head: asked in full (200)", "head: not modified (304)", "head: changed (200)"]);
	});

	test("the memory can be emptied", async () => {
		const headMemory = new HeadMemory();
		const { client, http } = setup([withEtag(A), withEtag(A)], { headMemory });
		await client.resolveHead();
		headMemory.forget();
		await client.resolveHead();
		expect(sentBack(http.request(1))).toBeUndefined();
	});
});
