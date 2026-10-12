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

// The calls to GitHub's REST API that sync is built from. Each method is one
// API call (resolving the head can take two). Deciding what to fetch or send
// is not done here.
//
// Three things are handled in this one place for every call: the mapping of
// failures to `BackendError`, waiting out a rate limit, and the timeout.

import { BackendError, RateLimitedError } from "../backend";
import { encodeBase64 } from "./base64";
import { headerOf, type HttpFunction, type HttpRequest, type HttpResponse, type Sleep } from "./http";
import {
	MARGIN_MS,
	quotaOf,
	type RateLimit,
	type RateLimitQuota,
	rateLimitOf,
	UNSTATED_WAIT_MS,
} from "./rate-limit";

const API = "https://api.github.com";

const DEFAULT_API_TIMEOUT_MS = 60_000;
// The zip of a whole repository: tens of megabytes over a mobile connection.
const DEFAULT_ZIP_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_RATE_LIMIT_RETRIES = 3;
// The slowest connection a transfer is still given time for. A fixed timeout
// would fail a large file on every try over a slow connection, and that file
// would never sync.
const SLOWEST_BYTES_PER_SECOND = 50_000;
// On iPhone timers stand still while the app is in the background, so one
// long sleep can end long after the limit was lifted. Sleeping in slices and
// reading the clock in between bounds the overshoot to one slice.
const WAIT_SLICE_MS = 10_000;
// GitHub's quotas come back within the hour. A time further away than this is
// a misread or broken response, and waiting for it would hang the sync. The
// bound is on one wait; a request may wait several times.
const MAX_RATE_LIMIT_WAIT_MS = 2 * 60 * 60 * 1000;
// A limit that names no time may be the per-minute cap on creating content or
// the per-hour one. Waits double from a minute, and once they add up to the
// hour the longest of these limits lasts, waiting more will not help.
const MAX_UNSTATED_WAIT_TOTAL_MS = 60 * 60 * 1000;
// Requests refused together for one limit do not name the same end: each is
// worked out from the clock when its response came in and from a `date`
// header in whole seconds, and carries the margin of a second. Ends no
// further apart than this are taken to be of the same limit.
const SAME_LIMIT_MS = 2_000;

const SHA = /^[0-9a-f]{40}$/;

export interface RateLimitNotice extends RateLimit {
	/** How many times this request has already been retried after a rate limit. */
	readonly retries: number;
}

export interface GitHubClientOptions {
	readonly owner: string;
	readonly repo: string;
	readonly branch: string;
	readonly token: string;
	readonly http: HttpFunction;
	/** The current time in milliseconds since the epoch. */
	readonly now: () => number;
	readonly sleep: Sleep;
	/**
	 * Asked each time a request hits a rate limit. Answer `true` to wait until
	 * the given time and continue, `false` to fail with "rate-limited" instead.
	 * Without it the client always waits.
	 *
	 * Requests that run at the same time hit a limit together, and each
	 * response names its end a little differently. While a wait that was
	 * asked about is on, a request whose limit ends within that wait, or no
	 * more than `SAME_LIMIT_MS` after it, joins it without asking again, so
	 * the caller hears of one limit once. The time in the notice is that of
	 * the request that asked; another may wait that little longer. A request
	 * that is refused again after the wait is asked about again.
	 */
	readonly onRateLimit?: (notice: RateLimitNotice) => boolean | Promise<boolean>;
	/**
	 * How long to wait for the response to one API call. A call that carries
	 * the content of a file gets more, by the size of the content.
	 */
	readonly apiTimeoutMs?: number;
	/** How long to wait for the zip, and for the listing of a tree, which can run to megabytes. */
	readonly zipTimeoutMs?: number;
	/**
	 * How many times in a row one request is retried after a rate limit that
	 * named its time. A limit that named none is retried by time instead:
	 * waits that double from a minute, for up to an hour in all.
	 */
	readonly maxRateLimitRetries?: number;
	/**
	 * Aborted when the user stops the sync. A wait for a rate limit ends at
	 * once, and no request is sent after that, so that a write held back by a
	 * limit does not go out after the user said stop. A request already on its
	 * way is not interrupted: the platform cannot abort it, and its answer says
	 * whether a write took effect.
	 */
	readonly signal?: AbortSignal;
	/**
	 * What the head of the branch was last answered with, kept by whoever
	 * makes the clients and handed to each (`HeadMemory`). With it the head
	 * is asked for conditionally, and an answer that nothing changed is not
	 * counted against the quota. Without it every answer is a full one.
	 */
	readonly headMemory?: HeadMemory;
	/** A line for the developer console, in English: how the head was answered. */
	readonly log?: (message: string) => void;
}

/** Which head an answer was about: the branch, and the token it was asked with. */
type HeadKey = Pick<GitHubClientOptions, "owner" | "repo" | "branch" | "token">;

/**
 * The last full answer about the head of a branch: the commit, and the
 * `ETag` the answer carried. Sent back as `If-None-Match`, GitHub answers
 * 304 while the branch has not moved, without counting the request.
 *
 * In memory alone, and one answer: the two belong together and to the very
 * request they came from, so anything asked otherwise (another repository
 * or branch, or another token, which GitHub makes part of the `ETag`) finds
 * nothing here. A 304 is only ever read as "the commit that came with this
 * `ETag`".
 */
export class HeadMemory {
	private last: (HeadKey & { readonly etag: string; readonly sha: string }) | null = null;

	recall(key: HeadKey): { readonly etag: string; readonly sha: string } | null {
		const last = this.last;
		if (last === null) return null;
		const same =
			last.owner === key.owner && last.repo === key.repo && last.branch === key.branch && last.token === key.token;
		return same ? { etag: last.etag, sha: last.sha } : null;
	}

	remember(key: HeadKey, etag: string, sha: string): void {
		const { owner, repo, branch, token } = key;
		this.last = { owner, repo, branch, token, etag, sha };
	}

	forget(): void {
		this.last = null;
	}
}

export type HeadResult =
	| { readonly status: "commit"; readonly sha: string }
	/** The repository has no commit yet. Not a failure: a new repository starts like this. */
	| { readonly status: "empty" };

/** What `createFile` made. */
export interface CreatedFile {
	readonly commitSha: string;
	readonly blobSha: string;
	/** How many parents the commit has. */
	readonly parents: number;
}

export interface GitCommit {
	readonly sha: string;
	readonly treeSha: string;
	readonly parents: readonly string[];
}

export type GitTreeItemType = "blob" | "tree" | "commit";

export interface GitTreeItem {
	readonly path: string;
	/** As git has it, for example "100644", "120000" for a symlink, "160000" for a submodule. */
	readonly mode: string;
	readonly type: GitTreeItemType;
	readonly sha: string;
	/** Only blobs have one. */
	readonly size?: number;
}

/** The only modes the API accepts for a file. */
export type FileMode = "100644" | "100755";

export type TreeChange =
	/** Content sent inside the tree request, which saves the call that creates a blob. Text only. */
	| { readonly path: string; readonly mode: FileMode; readonly content: string }
	| { readonly path: string; readonly mode: FileMode; readonly sha: string }
	/**
	 * Removes the path. `mode` is the one the entry has in the base tree. It is
	 * not limited to `FileMode`: a symlink or a submodule can be removed too.
	 */
	| { readonly path: string; readonly mode: string; readonly sha: null };

export interface NewCommit {
	readonly message: string;
	readonly tree: string;
	readonly parents: readonly string[];
}

export type UpdateRefResult =
	| { readonly status: "updated" }
	/** The branch no longer points at an ancestor of the new commit. Nothing was changed. */
	| { readonly status: "stale" };

/** The size of a string on the wire, without building the bytes. */
function utf8Length(text: string): number {
	let bytes = 0;
	for (let i = 0; i < text.length; i++) {
		const unit = text.charCodeAt(i);
		// Each half of a surrogate pair counts two, which adds up to the four
		// bytes of the character they make.
		bytes += unit < 0x80 ? 1 : unit < 0x800 || (unit >= 0xd800 && unit <= 0xdfff) ? 2 : 3;
	}
	return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha(value: unknown): value is string {
	return typeof value === "string" && SHA.test(value);
}

function parseJson(body: ArrayBuffer): unknown {
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
	} catch {
		return undefined;
	}
}

/** The `message` GitHub puts in the JSON body of an error, or "". */
function messageOf(response: HttpResponse): string {
	const json = parseJson(response.body);
	return isRecord(json) && typeof json.message === "string" ? json.message : "";
}

/**
 * Whether a failed request to create a blob was refused for the size of the
 * content: 422 with "Sorry, your input was too large to process." A 413
 * means the same, should the host ever answer with it.
 */
function isTooLargeRefusal(error: BackendError): boolean {
	return error.status === 413 || (error.status === 422 && /too large/i.test(error.message));
}

/**
 * Whether a refused write says in words that the token may not touch
 * workflow files. A fine-grained token without the Workflows permission
 * is not told so: creating the tree answers 403, "Resource not accessible
 * by personal access token" (measured 2026-10-09), and the push finds out
 * by sending the tree again without those files (`GitHubBackend.push`).
 * This is for the wordings that do name it, as git's own refusal of a
 * classic token does; none has been seen from this API.
 */
export function isWorkflowsRefusal(status: number, message: string): boolean {
	return (status === 403 || status === 404 || status === 422) && /workflow/i.test(message);
}

/** The type git gives an entry of this mode. */
function typeOfMode(mode: string): GitTreeItemType {
	if (mode === "160000") return "commit";
	if (mode === "040000") return "tree";
	return "blob";
}

export class GitHubClient {
	private readonly options: GitHubClientOptions;
	private readonly repoUrl: string;
	private readonly branchPath: string;
	/**
	 * The end of the wait for a rate limit that was agreed to, on the device
	 * clock; 0 before the first. It holds for every request of this client:
	 * one that has not been sent yet waits for it too, instead of being sent
	 * only to be refused.
	 */
	private blockedUntil = 0;
	/** The question about a limit that the caller has not answered yet. */
	private asking: { readonly until: number; readonly answer: Promise<boolean> } | null = null;
	private lastQuota: RateLimitQuota | null = null;

	constructor(options: GitHubClientOptions) {
		this.options = options;
		this.repoUrl = `${API}/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}`;
		// A branch name may contain slashes, which stay as path separators.
		this.branchPath = options.branch.split("/").map(encodeURIComponent).join("/");
	}

	/**
	 * What is left of the hourly quota, as the last response that reported
	 * it said, or `null` before the first. No request is made for it. With
	 * requests running at the same time it is the answer that arrived last,
	 * which is not always the one GitHub sent last.
	 */
	get quota(): RateLimitQuota | null {
		return this.lastQuota;
	}

	/**
	 * The commit the branch points at. Fails with "branch-not-found" when the
	 * repository is there but the branch is not, and with "not-found" when the
	 * repository is missing or the token cannot see it.
	 */
	async resolveHead(): Promise<HeadResult> {
		const what = "resolve head";
		const { headMemory, log } = this.options;
		const request = this.get(`/git/ref/heads/${this.branchPath}`);
		// Asked for conditionally when the last full answer is remembered.
		// `Cache-Control: no-cache` stays: the answer has to be GitHub's, and
		// not one the app kept.
		const known = headMemory?.recall(this.options) ?? null;
		const response = await this.send(
			what,
			known === null ? request : { ...request, headers: { ...request.headers, "If-None-Match": known.etag } },
		);
		if (response.status === 304) {
			// Only an answer to the `ETag` that was sent says which commit it
			// is. A 304 nobody asked for names none.
			if (known === null) throw new BackendError("other", `${what}: HTTP 304 to a request that was not conditional`, 304);
			log?.("head: not modified (304)");
			return { status: "commit", sha: known.sha };
		}
		// Whatever follows is news about the head, or no answer about it at
		// all: what was remembered no longer stands.
		headMemory?.forget();
		if (response.status === 200) {
			const json = parseJson(response.body);
			const object = isRecord(json) ? json.object : undefined;
			if (!isRecord(object) || object.type !== "commit" || !isSha(object.sha)) {
				throw this.malformed(what);
			}
			// A platform that never shows a 304, or a server that sends no
			// `ETag`, is asked in full every time, as before.
			const etag = headerOf(response, "etag");
			if (etag !== undefined && etag !== "") headMemory?.remember(this.options, etag, object.sha);
			if (headMemory !== undefined) log?.(`head: ${known === null ? "asked in full" : "changed"} (200)`);
			return { status: "commit", sha: object.sha };
		}
		// The Git Data API does not work on a repository without commits.
		if (response.status === 409 && /empty/i.test(messageOf(response))) return { status: "empty" };
		if (response.status === 404) {
			// The same 404 comes back for a missing branch and a missing
			// repository. Asking for the repository itself tells them apart.
			const repository = await this.send("check repository", this.get(""));
			if (repository.status === 200) {
				throw new BackendError("branch-not-found", `${what}: the repository has no such branch`);
			}
			throw this.failure("check repository", repository);
		}
		throw this.failure(what, response);
	}

	async getCommit(sha: string): Promise<GitCommit> {
		const what = "get commit";
		const json = await this.json(what, this.get(`/git/commits/${this.sha(what, sha)}`), 200);
		const tree = isRecord(json.tree) ? json.tree.sha : undefined;
		const parents = Array.isArray(json.parents)
			? json.parents.map((parent: unknown) => (isRecord(parent) ? parent.sha : undefined))
			: undefined;
		if (!isSha(json.sha) || !isSha(tree) || parents === undefined || !parents.every(isSha)) {
			throw this.malformed(what);
		}
		return { sha: json.sha, treeSha: tree, parents };
	}

	/**
	 * Every item under a tree, at any depth. Fails with "incomplete-listing"
	 * when GitHub cut the answer short: syncing from part of a listing would
	 * take the missing files for deleted ones.
	 */
	async getTree(sha: string): Promise<GitTreeItem[]> {
		const what = "get tree";
		const json = await this.json(what, this.get(`/git/trees/${this.sha(what, sha)}?recursive=1`), 200, this.zipTimeout);
		if (json.truncated === true) {
			throw new BackendError("incomplete-listing", `${what}: the tree is too large to be listed in one response`);
		}
		// A response that does not say it is complete is not taken to be.
		if (json.truncated !== false || !Array.isArray(json.tree)) throw this.malformed(what);

		const items: GitTreeItem[] = [];
		for (const raw of json.tree as unknown[]) {
			if (
				!isRecord(raw) ||
				typeof raw.path !== "string" ||
				typeof raw.mode !== "string" ||
				(raw.type !== "blob" && raw.type !== "tree" && raw.type !== "commit") ||
				!isSha(raw.sha) ||
				(raw.size !== undefined && raw.size !== null && typeof raw.size !== "number")
			) {
				throw this.malformed(what);
			}
			items.push({
				path: raw.path,
				mode: raw.mode,
				type: raw.type,
				sha: raw.sha,
				...(typeof raw.size === "number" ? { size: raw.size } : {}),
			});
		}
		return items;
	}

	/**
	 * The content of a blob. `size` is its size in bytes as the tree gave it:
	 * it sets how long the download may take, and it is handed to the HTTP
	 * function as what to expect (`HttpRequest.expectedBytes`).
	 */
	async getBlob(sha: string, size = 0): Promise<Uint8Array> {
		const what = "get blob";
		// The raw media type returns the bytes themselves instead of base64 in JSON.
		const blob = this.get(`/git/blobs/${this.sha(what, sha)}`, "application/vnd.github.raw+json");
		const request: HttpRequest = size > 0 ? { ...blob, expectedBytes: size } : blob;
		const response = await this.send(what, request, this.transferTimeout(size));
		if (response.status !== 200) throw this.failure(what, response);
		return new Uint8Array(response.body);
	}

	/**
	 * The zip of a commit. Asked for by commit and never by branch name, so
	 * that the content cannot move between listing the tree and this. GitHub
	 * answers with a redirect to another host; following it is left to the
	 * HTTP function, and a platform that does not follow it gets a failure.
	 */
	async getZip(commitSha: string): Promise<ArrayBuffer> {
		const what = "get zip";
		const response = await this.send(what, this.get(`/zipball/${this.sha(what, commitSha)}`), this.zipTimeout);
		if (response.status !== 200) throw this.failure(what, response);
		return response.body;
	}

	/** The configured branch. */
	get branch(): string {
		return this.options.branch;
	}

	/**
	 * The branch the repository names as its default: the one its first
	 * commit goes to while it has none.
	 */
	async defaultBranch(): Promise<string> {
		const what = "get repository";
		const json = await this.json(what, this.get(""), 200);
		if (typeof json.default_branch !== "string" || json.default_branch === "") throw this.malformed(what);
		return json.default_branch;
	}

	/**
	 * Creates one file on the configured branch, as a commit of its own.
	 * The one way to write to a repository without commits, which the Git
	 * Data API refuses. Answers with the sha of the commit and of the blob,
	 * and with the number of parents the commit has: not 0 when the
	 * repository had a commit after all. Answers "exists" when the path is
	 * taken, which is only so in a repository that has a commit.
	 *
	 * Like `updateRef`, an "unreachable" failure does not mean that nothing
	 * was created.
	 */
	async createFile(path: string, content: Uint8Array, message: string): Promise<CreatedFile | "exists"> {
		const what = "create file";
		const encoded = path.split("/").map(encodeURIComponent).join("/");
		const body = { message, content: encodeBase64(content), branch: this.options.branch };
		const request = this.write("PUT", `/contents/${encoded}`, body);
		const response = await this.send(what, request, this.transferTimeout(utf8Length(request.body ?? "")));
		// A file that is there is only replaced when its sha is named.
		if (response.status === 422 && /sha/i.test(messageOf(response))) return "exists";
		if (response.status !== 201) throw this.writeFailure(what, response);
		const json = parseJson(response.body);
		const commit = isRecord(json) && isRecord(json.commit) ? json.commit : undefined;
		const blob = isRecord(json) && isRecord(json.content) ? json.content.sha : undefined;
		if (commit === undefined || !isSha(commit.sha) || !isSha(blob) || !Array.isArray(commit.parents)) {
			throw this.malformed(what);
		}
		return { commitSha: commit.sha, blobSha: blob, parents: commit.parents.length };
	}

	/**
	 * Stores content and answers with its sha. Content the host finds too
	 * large fails as "too-large": creating a blob is refused a little under
	 * 40 MiB of content, whatever the size of the request (measured
	 * 2026-10-09: 41,900,000 bytes passed, 41,943,039 did not). The limit is
	 * not documented.
	 */
	async createBlob(content: Uint8Array): Promise<string> {
		const what = "create blob";
		const body = { content: encodeBase64(content), encoding: "base64" };
		try {
			return await this.created(what, this.write("POST", "/git/blobs", body));
		} catch (error) {
			if (error instanceof BackendError && error.kind === "other" && isTooLargeRefusal(error)) {
				throw new BackendError("too-large", error.message, error.status);
			}
			throw error;
		}
	}

	/** Builds a tree from `baseTree` with the changes laid over it. Paths not named stay as they are. */
	async createTree(baseTree: string, changes: readonly TreeChange[]): Promise<string> {
		const what = "create tree";
		const tree = changes.map((change) => {
			if ("content" in change) {
				return { path: change.path, mode: change.mode, type: "blob", content: change.content };
			}
			// The API wants a mode and a type even for a removal, and the two
			// have to agree with each other.
			if (change.sha === null) {
				return { path: change.path, mode: change.mode, type: typeOfMode(change.mode), sha: null };
			}
			return { path: change.path, mode: change.mode, type: "blob", sha: this.sha(what, change.sha) };
		});
		const body = { base_tree: this.sha(what, baseTree), tree };
		return this.created(what, this.write("POST", "/git/trees", body));
	}

	/** The author is left out, so GitHub records the owner of the token. */
	async createCommit(commit: NewCommit): Promise<string> {
		const what = "create commit";
		const body = {
			message: commit.message,
			tree: this.sha(what, commit.tree),
			parents: commit.parents.map((parent) => this.sha(what, parent)),
		};
		return this.created(what, this.write("POST", "/git/commits", body));
	}

	/**
	 * Moves the branch to `sha`, only as a fast-forward. Another device having
	 * pushed in between is an expected outcome, so it is answered as "stale"
	 * rather than thrown. The branch is never forced.
	 *
	 * An "unreachable" failure does not mean the branch was left as it was. A
	 * timeout, a dropped connection, or timers that only resumed after the app
	 * had been in the background can all hide an update that went through. The
	 * caller has to resolve the head again and compare it with the commit it
	 * created before it decides anything, and must never answer such a failure
	 * by forcing the branch.
	 */
	async updateRef(sha: string): Promise<UpdateRefResult> {
		const what = "update ref";
		const body = { sha: this.sha(what, sha), force: false };
		const response = await this.send(what, this.write("PATCH", `/git/refs/heads/${this.branchPath}`, body));
		if (response.status === 200) return { status: "updated" };
		if (response.status === 422) {
			const message = messageOf(response);
			if (/fast[ -]?forward/i.test(message)) return { status: "stale" };
			// The branch was deleted between resolving the head and this. The
			// wording is matched with "reference" in it because a commit that is
			// missing gets "Object does not exist", which is another failure.
			if (/reference does not exist/i.test(message)) {
				throw new BackendError("branch-not-found", `${what}: the branch no longer exists`);
			}
		}
		throw this.writeFailure(what, response);
	}

	/**
	 * Whether `base` is `head` or one of its ancestors. Answers `false` only
	 * when GitHub says so: every failure to find out is thrown, because a false
	 * "no" would be shown to the user as a rewritten history.
	 */
	async isAncestor(base: string, head: string): Promise<boolean> {
		const what = "compare commits";
		// Only the status is used, so the smallest page of commits is asked for.
		const path = `/compare/${this.sha(what, base)}...${this.sha(what, head)}?per_page=1`;
		const response = await this.send(what, this.get(path));
		if (response.status === 404) {
			// GitHub answers 404 when the base commit is gone or shares no
			// history with the head, and also when the token cannot see the
			// repository at all. Only the first is a "no". The head is known to
			// have existed a moment ago, so reading it tells the two apart: it
			// throws "not-found" when the repository is out of sight.
			await this.getCommit(head);
			return false;
		}
		if (response.status !== 200) throw this.failure(what, response);

		const json = parseJson(response.body);
		const status = isRecord(json) ? json.status : undefined;
		if (status === "ahead" || status === "identical") return true;
		if (status === "diverged" || status === "behind") return false;
		throw this.malformed(what);
	}

	private get(path: string, accept = "application/vnd.github+json"): HttpRequest {
		// GitHub lets a response be reused for 60 seconds, and the desktop app
		// does so: a pull right after a push from another device was answered
		// with the old head, from the cache, without a request. Asking for the
		// cache to be checked against the server each time costs nothing where
		// the answer is unchanged.
		return {
			url: this.repoUrl + path,
			method: "GET",
			headers: { ...this.headers(accept), "Cache-Control": "no-cache" },
		};
	}

	private write(method: "POST" | "PATCH" | "PUT", path: string, body: unknown): HttpRequest {
		return {
			url: this.repoUrl + path,
			method,
			headers: { ...this.headers("application/vnd.github+json"), "Content-Type": "application/json" },
			body: JSON.stringify(body),
		};
	}

	private headers(accept: string): Record<string, string> {
		return {
			Authorization: `Bearer ${this.options.token}`,
			Accept: accept,
			"X-GitHub-Api-Version": "2022-11-28",
		};
	}

	/** Guards the URL: a sha goes into the path as it is. */
	private sha(what: string, value: string): string {
		if (!SHA.test(value)) throw new BackendError("other", `${what}: not a commit or object id`);
		return value;
	}

	/** Sends a request whose answer is a JSON object, and fails unless the status is `expected`. */
	private async json(
		what: string,
		request: HttpRequest,
		expected: number,
		timeoutMs?: number,
	): Promise<Record<string, unknown>> {
		const response = await this.send(what, request, timeoutMs);
		if (response.status !== expected) {
			throw request.method === "GET" ? this.failure(what, response) : this.writeFailure(what, response);
		}
		const json = parseJson(response.body);
		if (!isRecord(json)) throw this.malformed(what);
		return json;
	}

	/** Sends a request that creates a git object and answers with the sha of that object. */
	private async created(what: string, request: HttpRequest): Promise<string> {
		// Inline content makes the body of a tree as large as a blob's.
		const json = await this.json(what, request, 201, this.transferTimeout(utf8Length(request.body ?? "")));
		if (!isSha(json.sha)) throw this.malformed(what);
		return json.sha;
	}

	/**
	 * Sends a request and answers with the response, whatever its status,
	 * except for a rate limit: that is waited out and the same request is sent
	 * again. A request refused for a rate limit changed nothing, so repeating
	 * a write is safe.
	 */
	private async send(what: string, request: HttpRequest, timeoutMs?: number): Promise<HttpResponse> {
		const maxRetries = this.options.maxRateLimitRetries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES;
		let stated = 0;
		let unstated = 0;
		let unstatedWaited = 0;
		for (let retries = 0; ; retries++) {
			// A limit another request ran into holds for this one as well.
			await this.waitUntil(what, this.blockedUntil);
			const response = await this.once(what, request, timeoutMs ?? this.options.apiTimeoutMs ?? DEFAULT_API_TIMEOUT_MS);
			const now = this.options.now();
			this.lastQuota = quotaOf(response, now) ?? this.lastQuota;
			if (response.status !== 403 && response.status !== 429) return response;
			let limit = rateLimitOf(response, messageOf(response), now);
			if (limit === null) return response;

			if (limit.stated) {
				// A limit that is still there after waiting until the time it
				// named is not going to be waited out. The cap keeps a misread
				// response from looping.
				if (stated >= maxRetries) {
					throw new RateLimitedError(limit.until, `${what}: still rate limited after ${stated} retries`);
				}
				stated += 1;
			} else {
				if (unstatedWaited >= MAX_UNSTATED_WAIT_TOTAL_MS) {
					throw new RateLimitedError(limit.until, `${what}: still rate limited after waiting an hour`);
				}
				const wait = UNSTATED_WAIT_MS * 2 ** unstated;
				limit = { ...limit, until: now + wait + MARGIN_MS };
				unstated += 1;
				unstatedWaited += wait;
			}
			if (limit.until - now > MAX_RATE_LIMIT_WAIT_MS) {
				throw new RateLimitedError(limit.until, `${what}: rate limited for longer than can be waited out`);
			}
			if (!(await this.agreesToWait({ ...limit, retries }))) {
				throw new RateLimitedError(limit.until, `${what}: rate limited (${limit.kind})`);
			}
			await this.waitUntil(what, limit.until);
		}
	}

	/**
	 * Whether the limit is waited out. The caller is asked once per limit:
	 * the requests that ran into it together share the one answer. Their
	 * ends are not the same to the millisecond (`SAME_LIMIT_MS`), and each
	 * request still waits until its own.
	 */
	private async agreesToWait(notice: RateLimitNotice): Promise<boolean> {
		if (notice.until <= this.blockedUntil) return true;
		// Only while the wait agreed to is on. Once it is over, a limit that
		// ends a moment after it is a new one: the request was sent again
		// and refused again, and a short `retry-after` puts that end
		// within the tolerance.
		const waiting = this.options.now() < this.blockedUntil;
		if (waiting && notice.until <= this.blockedUntil + SAME_LIMIT_MS) return true;
		// Asked, and not answered yet: an answer can take a moment, and the
		// other requests get here before it is in.
		const pending = this.asking;
		if (pending !== null && notice.until <= pending.until + SAME_LIMIT_MS) return pending.answer;

		const onRateLimit = this.options.onRateLimit;
		const answer = (async () => onRateLimit === undefined || (await onRateLimit(notice)))();
		const asking = { until: notice.until, answer };
		this.asking = asking;
		try {
			const wait = await answer;
			if (wait) this.blockedUntil = Math.max(this.blockedUntil, notice.until);
			return wait;
		} finally {
			if (this.asking === asking) this.asking = null;
		}
	}

	private async waitUntil(what: string, time: number): Promise<void> {
		for (;;) {
			this.throwIfCancelled(what);
			const remaining = time - this.options.now();
			if (remaining <= 0) return;
			await this.sleepUnlessCancelled(Math.min(remaining, WAIT_SLICE_MS));
		}
	}

	/** Sleeps, but comes back at once when the caller cancels. */
	private async sleepUnlessCancelled(ms: number): Promise<void> {
		const signal = this.options.signal;
		if (signal === undefined) return this.options.sleep(ms);
		// A sleep stays pending when its own signal is aborted, so it gets one
		// that is aborted either way, and the cancellation is raced against it.
		const timer = new AbortController();
		let onAbort = (): void => {};
		const cancelled = new Promise<void>((resolve) => {
			onAbort = resolve;
			signal.addEventListener("abort", onAbort);
		});
		try {
			await Promise.race([this.options.sleep(ms, timer.signal), cancelled]);
		} finally {
			signal.removeEventListener("abort", onAbort);
			timer.abort();
		}
	}

	private get zipTimeout(): number {
		return this.options.zipTimeoutMs ?? DEFAULT_ZIP_TIMEOUT_MS;
	}

	/** The timeout of a call that moves `bytes` of content, in either direction. */
	private transferTimeout(bytes: number): number {
		const base = this.options.apiTimeoutMs ?? DEFAULT_API_TIMEOUT_MS;
		return base + Math.ceil((bytes / SLOWEST_BYTES_PER_SECOND) * 1000);
	}

	private throwIfCancelled(what: string): void {
		if (this.options.signal?.aborted) throw new BackendError("cancelled", `${what}: cancelled`);
	}

	/** One attempt. Neither a thrown request nor a silent one gets past here as anything but "unreachable". */
	private async once(what: string, request: HttpRequest, timeoutMs: number): Promise<HttpResponse> {
		// The platform's request cannot be aborted and has no timeout of its
		// own, so it is raced against a timer. A request that lost the race
		// keeps running; its late answer is dropped.
		const timer = new AbortController();
		let response: HttpResponse | null;
		try {
			response = await Promise.race([
				this.options.http(request),
				this.options.sleep(timeoutMs, timer.signal).then(() => null),
			]);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new BackendError("unreachable", this.redact(`${what}: the request failed: ${detail}`));
		} finally {
			timer.abort();
		}
		if (response === null) {
			throw new BackendError("unreachable", `${what}: no response within ${timeoutMs} ms`);
		}
		return response;
	}

	/** The one place a response status becomes a kind of failure. */
	private failure(what: string, response: HttpResponse): BackendError {
		const status = response.status;
		const kind =
			status === 401
				? "unauthorized"
				: status === 403
					? "forbidden"
					: status === 404
						? "not-found"
						: status >= 500
							? "unreachable"
							: "other";
		const message = messageOf(response).slice(0, 200);
		return new BackendError(
			kind,
			this.redact(`${what}: HTTP ${status}${message === "" ? "" : `: ${message}`}`),
			status,
		);
	}

	private writeFailure(what: string, response: HttpResponse): BackendError {
		const message = messageOf(response);
		if (isWorkflowsRefusal(response.status, message)) {
			return new BackendError(
				"workflows-permission",
				this.redact(`${what}: HTTP ${response.status}: ${message.slice(0, 200)}`),
				response.status,
			);
		}
		return this.failure(what, response);
	}

	private malformed(what: string): BackendError {
		return new BackendError("other", `${what}: the response is not in the expected form`);
	}

	/** Text from outside (a thrown error, a response body) could echo the request. The token must not reach a log. */
	private redact(text: string): string {
		const token = this.options.token;
		return token === "" ? text : text.split(token).join("[token]");
	}
}
