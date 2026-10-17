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

// The calls of the Google Drive API (v3), as requests and answers: what a
// sync means by them is the backend's (`backend.ts`). Every answer that is
// not a success becomes a `BackendError` here, and nowhere else.

import { BackendError, RateLimitedError } from "../backend";
import type { AccessTokens } from "../dropbox/client";
import { type HttpFunction, type HttpRequest, type HttpResponse, headerOf, type Sleep } from "../github/http";
import { DriveDailyLimitError } from "./errors";
import { DriveQuota, driveUnits, nextPacificMidnight } from "./quota";

export const DRIVE_API = "https://www.googleapis.com/drive/v3";
export const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";

/**
 * Up to this size a file is sent in one request with its metadata
 * (`uploadType=multipart`), as Google advises for files of 5 MB or less.
 * Larger, an upload session is opened first (`uploadType=resumable`), and
 * the content sent to it in one request.
 */
export const MULTIPART_MAX_BYTES = 5 * 1024 * 1024;

const DEFAULT_API_TIMEOUT_MS = 60_000;
/** The slowest a connection is taken to be when a call moves the content of a file. */
const SLOWEST_BYTES_PER_SECOND = 50_000;
/** How many times in a row one request is sent again after Google asked to wait, or failed on its side. */
const DEFAULT_MAX_RETRIES = 5;
/** The first wait when Google names none. Doubles each time, as Google advises. */
const FIRST_WAIT_MS = 1_000;
/**
 * The most added to each wait at random, as Google advises: the devices
 * that met a limit together do not all ask again at the same moment.
 */
const MAX_JITTER_MS = 1_000;
/** The longest wait that is waited out. Longer, the request fails as rate limited. */
const MAX_WAIT_MS = 5 * 60 * 1000;
/** The reasons of a 403 that only ask to wait. */
const RATE_REASONS: ReadonlySet<string> = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);
/**
 * The reason of a 403 that says the requests of the day have run out: the
 * cap set on the project. Not waited out, and not sent again before
 * midnight in the Pacific time.
 */
const DAILY_REASON = "dailyLimitExceeded";

/**
 * An answer of Drive that is not a success, with the status and the reason
 * Google gives (`error.errors[0].reason`: `notFound`, `storageQuotaExceeded`,
 * `insufficientFilePermissions`, ...), which the backend reads.
 */
export class DriveApiError extends BackendError {
	readonly reason: string;

	constructor(what: string, status: number, reason: string, message: string) {
		const kind =
			status === 401 ? "unauthorized" : status === 403 ? "forbidden" : status === 404 ? "not-found" : status >= 500 ? "unreachable" : "other";
		super(kind, `${what}: HTTP ${status}${reason === "" ? "" : ` ${reason}`}${message === "" ? "" : `: ${message.slice(0, 200)}`}`, status);
		this.name = "DriveApiError";
		this.reason = reason;
	}
}

export interface DriveClientOptions {
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
	 * The units of the quota this device has used (`quota.ts`), shared by
	 * every client of the device. A quota of this client's own when absent.
	 */
	readonly quota?: DriveQuota;
	/** A number from 0 up to 1, as `Math.random`, which it is when absent: what is added to a wait at random. */
	readonly random?: () => number;
	/**
	 * Aborted when the user stops the sync. A wait ends at once, and no
	 * request is sent after that. A request on its way is not interrupted.
	 */
	readonly signal?: AbortSignal;
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

/** Google's error of a body: its first reason and its message. */
function errorOf(text: string): { readonly reason: string; readonly message: string } {
	const json = parseJson(text);
	const error = isRecord(json) ? json.error : undefined;
	if (!isRecord(error)) return { reason: "", message: "" };
	const first = Array.isArray(error.errors) ? (error.errors[0] as unknown) : undefined;
	const reason = isRecord(first) && typeof first.reason === "string" ? first.reason : typeof error.status === "string" ? error.status : "";
	return { reason, message: typeof error.message === "string" ? error.message : "" };
}

/** The bytes of a view, as a buffer of their own: what an HTTP body is. */
function bufferOf(content: Uint8Array): ArrayBuffer {
	return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
}

/** A body of `multipart/related`: the metadata as JSON, then the content. */
export function multipartBody(boundary: string, metadata: unknown, content: Uint8Array): ArrayBuffer {
	const encoder = new TextEncoder();
	const head = encoder.encode(
		`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
			`--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
	);
	const tail = encoder.encode(`\r\n--${boundary}--`);
	const body = new Uint8Array(head.byteLength + content.byteLength + tail.byteLength);
	body.set(head, 0);
	body.set(content, head.byteLength);
	body.set(tail, head.byteLength + content.byteLength);
	return body.buffer;
}

/** A boundary no content of a file is likely to hold, and no JSON can. */
function newBoundary(): string {
	const random = new Uint8Array(12);
	crypto.getRandomValues(random);
	return `sync_evo_${Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export class DriveClient {
	private readonly options: DriveClientOptions;
	private readonly quota: DriveQuota;

	constructor(options: DriveClientOptions) {
		this.options = options;
		this.quota = options.quota ?? new DriveQuota();
	}

	/** A GET whose answer is JSON. */
	async getJson(url: string): Promise<unknown> {
		const response = await this.send(`GET ${pathOf(url)}`, (token) => ({
			url,
			method: "GET",
			headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
		}));
		return this.json(url, response.body);
	}

	/**
	 * A call with a JSON body whose answer is JSON. A POST makes a file
	 * (a folder), and is not sent again after a failure on Google's side
	 * (`send`).
	 */
	async sendJson(method: "POST" | "PATCH", url: string, body: unknown): Promise<unknown> {
		const response = await this.send(
			`${method} ${pathOf(url)}`,
			(token) => ({
				url,
				method,
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
				body: JSON.stringify(body),
			}),
			0,
			method === "PATCH",
		);
		return this.json(url, response.body);
	}

	/**
	 * Sends the content of a file with its metadata, and answers with what
	 * Drive says of the file (`fields`). `id` absent makes a new file
	 * (`files.create`); given, it replaces the content of that file
	 * (`files.update`).
	 *
	 * What makes a file, and the content sent to an upload session, is not
	 * sent again after a failure on Google's side (`send`): the file may
	 * have been made all the same, and a second would be beside it. The
	 * sync fails, and the next one finds what is there.
	 */
	async upload(id: string | null, metadata: Record<string, unknown>, content: Uint8Array, fields: string): Promise<unknown> {
		const method = id === null ? "POST" : "PATCH";
		const base = `${DRIVE_UPLOAD}/files${id === null ? "" : `/${encodeURIComponent(id)}`}`;
		const what = `${method} upload`;
		if (content.byteLength <= MULTIPART_MAX_BYTES) {
			const boundary = newBoundary();
			const body = multipartBody(boundary, metadata, content);
			const url = `${base}?uploadType=multipart&fields=${encodeURIComponent(fields)}`;
			const response = await this.send(
				what,
				(token) => ({
					url,
					method,
					headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
					body,
				}),
				content.byteLength,
				id !== null,
			);
			return this.json(what, response.body);
		}
		// An upload session, then the content to it in one piece. The
		// fields go with the request that opens the session: Drive does not
		// read them from the one that sends the content.
		const opened = await this.send(
			what,
			(token) => ({
				url: `${base}?uploadType=resumable&fields=${encodeURIComponent(fields)}`,
				method,
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json; charset=UTF-8",
					"X-Upload-Content-Type": "application/octet-stream",
					"X-Upload-Content-Length": String(content.byteLength),
				},
				body: JSON.stringify(metadata),
			}),
			0,
			id !== null,
		);
		const session = headerOf(opened, "location");
		if (session === undefined || !session.startsWith("https://")) throw new BackendError("other", `${what}: no upload session was given`);
		const body = bufferOf(content);
		const response = await this.send(
			`${what} content`,
			(token) => ({
				url: session,
				method: "PUT",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
				body,
			}),
			content.byteLength,
			false,
		);
		return this.json(what, response.body);
	}

	/** Gets the content of a file (`alt=media`). `expectedBytes` is the size the listing gave. */
	async download(id: string, expectedBytes = 0): Promise<Uint8Array> {
		const url = `${DRIVE_API}/files/${encodeURIComponent(id)}?alt=media`;
		const response = await this.send(
			"GET media",
			(token) => ({
				url,
				method: "GET",
				headers: { Authorization: `Bearer ${token}` },
				...(expectedBytes > 0 ? { expectedBytes } : {}),
			}),
			expectedBytes,
		);
		return new Uint8Array(response.body);
	}

	/** Waits, and comes back at once, as cancelled, when the caller cancels. */
	wait(what: string, ms: number): Promise<void> {
		return this.sleepUnlessCancelled(what, ms);
	}

	private json(what: string, body: ArrayBuffer): unknown {
		const json = parseJson(textOf(body));
		if (json === undefined) throw new BackendError("other", `${what}: the response is not JSON`);
		return json;
	}

	/**
	 * Sends a request, made again for each attempt with the token of the
	 * moment, until it succeeds or fails for good. An expired token is taken
	 * again once. A wait Google asks for (429, a 403 of a rate limit) and a
	 * failure on its side (500, 502, 503, 504) are waited out, longer each
	 * time and by up to a second more at random, up to `maxRetries` times;
	 * the second only with `again`: a request that makes a file may have
	 * made it before it failed. The requests of the day having run out is
	 * not waited out. Every attempt first waits for its units of the quota
	 * of this device.
	 */
	private async send(what: string, make: (token: string) => HttpRequest, bytes = 0, again = true): Promise<HttpResponse> {
		const maxRetries = this.options.maxRetries ?? DEFAULT_MAX_RETRIES;
		let renewed = false;
		for (let retries = 0; ; retries++) {
			this.throwIfCancelled(what);
			const token = await this.options.tokens.get();
			const request = make(token);
			const queued = this.quota.take(driveUnits(request.method, request.url), this.options.now());
			if (queued > 0) await this.sleepUnlessCancelled(what, queued);
			const response = await this.once(what, request, this.timeout(bytes));
			if (response.status >= 200 && response.status < 300) return response;
			const text = textOf(response.body);
			if (response.status === 401 && !renewed) {
				renewed = true;
				this.options.tokens.refused(token);
				continue;
			}
			const { reason, message } = errorOf(text);
			if (reason === DAILY_REASON) {
				const now = this.options.now();
				throw new DriveDailyLimitError(
					nextPacificMidnight(now),
					now,
					`${what}: the requests of the day to Google Drive have run out (HTTP ${response.status} ${reason})`,
				);
			}
			const limited = response.status === 429 || (response.status === 403 && RATE_REASONS.has(reason));
			const failing = again && (response.status === 500 || response.status === 502 || response.status === 503 || response.status === 504);
			if (limited || failing) {
				const stated = Number(headerOf(response, "retry-after"));
				const jitter = Math.floor((this.options.random ?? Math.random)() * MAX_JITTER_MS);
				const base = Number.isFinite(stated) && stated > 0 ? stated * 1000 : FIRST_WAIT_MS * 2 ** retries;
				// The bound is on the wait Google asks for: the second at
				// random must not turn a wait of five minutes into a failure.
				if (retries >= maxRetries || base > MAX_WAIT_MS) {
					if (limited) throw new RateLimitedError(this.options.now() + base, `${what}: Google Drive asked to wait (HTTP ${response.status} ${reason})`.trim());
					throw new DriveApiError(what, response.status, reason, message);
				}
				await this.sleepUnlessCancelled(what, base + jitter);
				continue;
			}
			throw new DriveApiError(what, response.status, reason, message);
		}
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
			throw new BackendError("unreachable", `${what}: the request failed: ${redact(detail)}`);
		} finally {
			timer.abort();
		}
		if (response === null) throw new BackendError("unreachable", `${what}: no response within ${timeoutMs} ms`);
		return response;
	}

	private throwIfCancelled(what: string): void {
		if (this.options.signal?.aborted) throw new BackendError("cancelled", `${what}: cancelled`);
	}

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

/** The path of a URL, without the query, which names what is asked about. */
function pathOf(url: string): string {
	return url.split("?")[0]?.replace(/^https:\/\/www\.googleapis\.com/, "") ?? url;
}

/** A token must not reach a log. Google's access tokens start with `ya29.`, its refresh tokens with `1//`. */
function redact(text: string): string {
	return text.replace(/Bearer\s+\S+/g, "Bearer [token]").replace(/\bya29\.[A-Za-z0-9_.-]+/g, "[token]").replace(/\b1\/\/[A-Za-z0-9_-]+/g, "[token]");
}
