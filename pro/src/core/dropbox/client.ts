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

// The calls of the Dropbox API, as requests and answers: what a sync means by
// them is the backend's (`backend.ts`). Every answer that is not a success
// becomes a `BackendError` here, and nowhere else.

import { BackendError, RateLimitedError, requestFailedDetail } from "../../../../src/core/backend";
import { type HttpFunction, type HttpRequest, type HttpResponse, headerOf, type Sleep } from "../../../../src/core/http";

const API = "https://api.dropboxapi.com/2";
const CONTENT = "https://content.dropboxapi.com/2";

const DEFAULT_API_TIMEOUT_MS = 60_000;
/** The slowest a connection is taken to be when a call moves the content of a file. */
const SLOWEST_BYTES_PER_SECOND = 50_000;
/**
 * How many times in a row one request is sent again after Dropbox asked to
 * wait. Writes are refused so whenever another device writes at the same
 * moment (`too_many_write_operations`), which is no failure.
 */
const DEFAULT_MAX_RETRIES = 5;
/** The wait when Dropbox asks for one and names no time. Doubles each time. */
const UNSTATED_WAIT_MS = 1_000;
/** The longest wait that is waited out. Longer, the request fails as rate limited. */
const MAX_WAIT_MS = 5 * 60 * 1000;

/**
 * Where the access token of a request comes from. Dropbox gives one that
 * lasts four hours, taken again from the refresh token (`auth.ts`).
 */
export interface AccessTokens {
	/** A token that is good for a while yet. Fails with "unauthorized" when none can be had. */
	get(): Promise<string>;
	/** Dropbox refused `token` as expired or revoked: the next `get` does not answer it again. */
	refused(token: string): void;
}

export interface DropboxClientOptions {
	readonly http: HttpFunction;
	/** The current time in milliseconds since the epoch. */
	readonly now: () => number;
	readonly sleep: Sleep;
	readonly tokens: AccessTokens;
	/** How long to wait for the answer to one call. A call that moves a file gets more, by its size. */
	readonly apiTimeoutMs?: number;
	/** `DEFAULT_MAX_RETRIES` when absent. */
	readonly maxRetries?: number;
	/**
	 * Aborted when the user stops the sync. A wait ends at once, and no
	 * request is sent after that. A request on its way is not interrupted.
	 */
	readonly signal?: AbortSignal;
	/**
	 * A line for the log that is kept, in English: each wait before a
	 * request is sent again. Only the status and Dropbox's `error_summary`,
	 * never a body: a line must never carry the token.
	 */
	readonly log?: (message: string) => void;
}

/**
 * A call Dropbox answered with 409: an error of that endpoint, such as a
 * path that is not there or a write that would overwrite another version.
 * `summary` is Dropbox's `error_summary`, the tags of the error joined by
 * slashes (`path/conflict/file/..`), which is what the backend reads.
 */
export class DropboxApiError extends BackendError {
	readonly summary: string;

	constructor(what: string, summary: string) {
		super(summary.startsWith("path/not_found") || summary.startsWith("path_lookup/not_found") ? "not-found" : "other", `${what}: ${summary}`, 409);
		this.name = "DropboxApiError";
		this.summary = summary;
	}

	override get remoteReason(): string {
		return this.summary;
	}

	/** Whether the error is the one of `tags`, given from the outside in. */
	is(...tags: string[]): boolean {
		return this.summary.startsWith(`${tags.join("/")}/`) || this.summary === tags.join("/");
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(body: ArrayBuffer): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(body);
	} catch {
		return "";
	}
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/**
 * JSON for the `Dropbox-API-Arg` header. A header carries only ASCII, so
 * every character above 0x7E is written as `\uXXXX`, as Dropbox asks.
 */
export function headerJson(value: unknown): string {
	return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** The bytes of a view, as a buffer of their own: what an HTTP body is. */
function bufferOf(content: Uint8Array): ArrayBuffer {
	return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
}

export class DropboxClient {
	private readonly options: DropboxClientOptions;

	constructor(options: DropboxClientOptions) {
		this.options = options;
	}

	/** A call of the API whose argument and answer are JSON. `null` for a call that takes none. */
	async rpc(endpoint: string, arg: unknown): Promise<unknown> {
		const response = await this.send(endpoint, (token) => ({
			url: `${API}/${endpoint}`,
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: arg === null ? "null" : JSON.stringify(arg),
		}));
		return this.json(endpoint, response.body);
	}

	/**
	 * Sends the content of a file, and answers with what Dropbox says of it:
	 * by `files/upload`, or by another call that takes content the same way
	 * (`files/upload_session/start`).
	 */
	async upload(arg: unknown, content: Uint8Array, endpoint = "files/upload"): Promise<unknown> {
		const body = bufferOf(content);
		const response = await this.send(
			endpoint,
			(token) => ({
				url: `${CONTENT}/${endpoint}`,
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/octet-stream",
					"Dropbox-API-Arg": headerJson(arg),
				},
				body,
			}),
			content.byteLength,
		);
		return this.json(endpoint, response.body);
	}

	/**
	 * Gets the content of a file (`files/download`), with what Dropbox says
	 * of it. `expectedBytes` is the size the listing gave, for how long the
	 * call may take.
	 */
	async download(arg: unknown, expectedBytes = 0): Promise<{ readonly content: Uint8Array; readonly result: unknown }> {
		const endpoint = "files/download";
		const response = await this.send(
			endpoint,
			(token) => ({
				url: `${CONTENT}/${endpoint}`,
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, "Dropbox-API-Arg": headerJson(arg) },
				...(expectedBytes > 0 ? { expectedBytes } : {}),
			}),
			expectedBytes,
		);
		const result = headerOf(response, "dropbox-api-result");
		return { content: new Uint8Array(response.body), result: result === undefined ? undefined : parseJson(result) };
	}

	private json(what: string, body: ArrayBuffer): unknown {
		const json = parseJson(textOf(body));
		if (json === undefined) throw new BackendError("other", `${what}: the response is not JSON`);
		return json;
	}

	/**
	 * Sends a request, made again for each attempt with the token of the
	 * moment, until it succeeds or fails for good. An expired token is taken
	 * again once. A wait Dropbox asks for (429, a write that met another one,
	 * 503 with a time) is waited out, up to `maxRetries` times.
	 */
	private async send(what: string, make: (token: string) => HttpRequest, bytes = 0): Promise<HttpResponse> {
		const maxRetries = this.options.maxRetries ?? DEFAULT_MAX_RETRIES;
		let renewed = false;
		for (let retries = 0; ; retries++) {
			this.throwIfCancelled(what);
			const token = await this.options.tokens.get();
			const response = await this.once(what, make(token), this.timeout(bytes));
			if (response.status === 200) return response;
			const text = textOf(response.body);
			if (response.status === 401 && !renewed) {
				renewed = true;
				this.options.tokens.refused(token);
				continue;
			}
			const wait = this.waitOf(response, text, retries);
			if (wait !== null) {
				if (retries >= maxRetries || wait > MAX_WAIT_MS) {
					throw new RateLimitedError(this.options.now() + wait, `${what}: Dropbox asked to wait (HTTP ${response.status})`);
				}
				// Not for a request that answered after the sync was stopped, or failed.
				this.throwIfCancelled(what);
				const summary = summaryOf(text);
				this.log(`dropbox: ${what}: HTTP ${response.status}${summary === "" ? "" : ` ${summary}`}, waiting ${wait} ms (retry ${retries + 1} of ${maxRetries})`);
				await this.sleepUnlessCancelled(what, wait);
				continue;
			}
			throw this.failure(what, response, text);
		}
	}

	/** How long Dropbox asked to wait before the same request is sent again, or `null` when it did not. */
	private waitOf(response: HttpResponse, text: string, retries: number): number | null {
		const status = response.status;
		const busy =
			status === 429 ||
			(status === 409 && /too_many_write_operations|too_many_requests/.test(summaryOf(text))) ||
			(status === 503 && headerOf(response, "retry-after") !== undefined);
		if (!busy) return null;
		const stated = Number(headerOf(response, "retry-after"));
		return Number.isFinite(stated) && stated > 0 ? stated * 1000 : UNSTATED_WAIT_MS * 2 ** retries;
	}

	/** The one place a status becomes a kind of failure. */
	private failure(what: string, response: HttpResponse, text: string): BackendError {
		const status = response.status;
		if (status === 409) return new DropboxApiError(what, summaryOf(text));
		const kind = status === 401 ? "unauthorized" : status === 403 ? "forbidden" : status >= 500 ? "unreachable" : "other";
		return new BackendError(kind, `${what}: HTTP ${status}${text === "" ? "" : `: ${text.slice(0, 200)}`}`, status);
	}

	private timeout(bytes: number): number {
		const base = this.options.apiTimeoutMs ?? DEFAULT_API_TIMEOUT_MS;
		return base + Math.ceil((bytes / SLOWEST_BYTES_PER_SECOND) * 1000);
	}

	/** One attempt. Neither a thrown request nor a silent one gets past here as anything but "unreachable". */
	private async once(what: string, request: HttpRequest, timeoutMs: number): Promise<HttpResponse> {
		// The platform's request cannot be aborted and has no timeout of its
		// own, so it is raced against a timer. A late answer is dropped.
		const timer = new AbortController();
		let response: HttpResponse | null;
		try {
			response = await Promise.race([this.options.http(request), this.options.sleep(timeoutMs, timer.signal).then(() => null)]);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new BackendError("unreachable", `${what}: the request failed: ${redact(detail)}`, undefined, requestFailedDetail(redact(detail)));
		} finally {
			timer.abort();
		}
		if (response === null) {
			throw new BackendError("unreachable", `${what}: no response within ${timeoutMs} ms`, undefined, `no response within ${timeoutMs} ms`);
		}
		return response;
	}

	private throwIfCancelled(what: string): void {
		if (this.options.signal?.aborted) throw new BackendError("cancelled", `${what}: cancelled`);
	}

	/** Writes a line to the log the client was given (`DropboxClientOptions.log`): for a wait the backend asks for. */
	log(message: string): void {
		this.options.log?.(message);
	}

	/**
	 * Waits as Dropbox asked within an answer that came with 200: a job that
	 * is not done yet, or an entry of a batch that met another write. Comes
	 * back at once, as cancelled, when the caller cancels.
	 */
	wait(what: string, ms: number): Promise<void> {
		return this.sleepUnlessCancelled(what, ms);
	}

	/** Sleeps, but comes back at once, as cancelled, when the caller cancels. */
	private async sleepUnlessCancelled(what: string, ms: number): Promise<void> {
		const signal = this.options.signal;
		if (signal === undefined) return this.options.sleep(ms);
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
		this.throwIfCancelled(what);
	}
}

/** Dropbox's `error_summary` from the body of a 409, or "". */
function summaryOf(text: string): string {
	const json = parseJson(text);
	return isRecord(json) && typeof json.error_summary === "string" ? json.error_summary : "";
}

/** A token must not reach a log. Dropbox's start with `sl.`. */
function redact(text: string): string {
	return text.replace(/Bearer\s+\S+/g, "Bearer [token]").replace(/\bsl\.[A-Za-z0-9_-]+/g, "[token]");
}
