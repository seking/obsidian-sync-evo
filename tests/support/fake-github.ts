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

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { HttpRequest, HttpResponse } from "../../src/core/http";
import { blobHash, bytes, type FileContent } from "./memory-backend";

/** One file of a tree, as git holds it. */
export interface FakeTreeFile {
	readonly mode: string;
	readonly sha: string;
}

/** A commit of the fake, with what its tree holds. */
export interface FakeCommit {
	readonly sha: string;
	readonly tree: string;
	readonly parents: readonly string[];
	readonly message: string;
}

/** A request the fake was sent: the method, the path below the repository, and the body. */
export interface SentRequest {
	readonly method: string;
	readonly path: string;
	readonly body: unknown;
}

/** How a file is put into the fake: its content, or with a mode, or as a symlink or a submodule. */
export type FakeFile = FileContent | { readonly content: FileContent; readonly mode: string } | { readonly submodule: string };

function sha1(text: string): string {
	return createHash("sha1").update(text).digest("hex");
}

/** An answer of the fake, or one a test gives in its place (`FakeGitHub.before`). */
export function respond(status: number, body: unknown): HttpResponse {
	const data = new TextEncoder().encode(JSON.stringify(body));
	const copy = new ArrayBuffer(data.length);
	new Uint8Array(copy).set(data);
	return { status, headers: {}, body: copy };
}

/**
 * The part of GitHub's REST API a push uses, and what a small pull needs
 * beside it, for one repository and the branch `main`, in memory. It keeps blobs, trees and commits by their sha,
 * builds a tree from `base_tree` and the changes like GitHub does, and only
 * moves the branch forward. The shas of blobs are git's; those of trees and
 * commits are made up, and only have to be the same for the same content.
 *
 * `before` is called ahead of every request. A test answers from it to make
 * a request fail, or changes the repository from it to stand in for another
 * device.
 */
export class FakeGitHub {
	static readonly REPO = "https://api.github.com/repos/octo/notes";

	readonly requests: SentRequest[] = [];
	readonly blobs = new Map<string, Uint8Array>();
	readonly trees = new Map<string, ReadonlyMap<string, FakeTreeFile>>();
	readonly commits = new Map<string, FakeCommit>();
	head: string | null = null;
	/** The branch the repository names as its default. */
	defaultBranch = "main";
	before: ((request: SentRequest) => HttpResponse | Error | undefined | void) | undefined;
	/**
	 * What the fake makes of a content that is sent inside a tree, before
	 * it stores it. Absent: the bytes as they were sent. For a GitHub that
	 * would store such a content as other bytes (line ends, say).
	 */
	normalise: ((content: string) => string) | undefined;
	/**
	 * Whether the head is answered with an `ETag`, and a request that sends
	 * it back with 304 while the branch has not moved. Off: every answer is
	 * a full one, like a platform that never shows a 304.
	 */
	etags = true;
	/** How many requests for the head were answered 304. */
	notModified = 0;

	/** Another device commits: sets the given paths, or removes them with `null`. Answers the new head. */
	commit(changes: Record<string, FakeFile | null>, message = "from a Mac"): string {
		const parent = this.head === null ? undefined : this.commits.get(this.head);
		const files = new Map(parent === undefined ? [] : this.trees.get(parent.tree));
		for (const [path, file] of Object.entries(changes)) {
			if (file === null) files.delete(path);
			else if (typeof file === "object" && "submodule" in file) files.set(path, { mode: "160000", sha: file.submodule });
			else if (typeof file === "object" && "mode" in file) files.set(path, { mode: file.mode, sha: this.blob(bytes(file.content)) });
			else files.set(path, { mode: "100644", sha: this.blob(bytes(file)) });
		}
		const sha = this.makeCommit(this.tree(files), parent === undefined ? [] : [parent.sha], message);
		this.head = sha;
		return sha;
	}

	/** Path → what the head holds there. */
	files(): Map<string, FakeTreeFile> {
		const head = this.headCommit();
		return new Map(head === null ? [] : this.trees.get(head.tree));
	}

	/** The content of a file of the head as text, or `undefined`. */
	text(path: string): string | undefined {
		const file = this.files().get(path);
		const content = file === undefined ? undefined : this.blobs.get(file.sha);
		return content === undefined ? undefined : new TextDecoder().decode(content);
	}

	headCommit(): FakeCommit | null {
		return this.head === null ? null : (this.commits.get(this.head) ?? null);
	}

	/** The requests that create something or move the branch, as "METHOD path". */
	writes(): string[] {
		return this.requests.filter((request) => request.method !== "GET").map((request) => `${request.method} ${request.path}`);
	}

	readonly http = async (request: HttpRequest): Promise<HttpResponse> => {
		if (!request.url.startsWith(FakeGitHub.REPO)) throw new Error(`not this repository: ${request.url}`);
		const sent: SentRequest = {
			method: request.method,
			path: request.url.slice(FakeGitHub.REPO.length),
			body: request.body === undefined ? undefined : JSON.parse(request.body as string),
		};
		this.requests.push(sent);
		const instead = this.before?.(sent);
		if (instead instanceof Error) throw instead;
		if (instead !== undefined) return instead;
		if (this.etags && sent.method === "GET" && sent.path === "/git/ref/heads/main" && this.head !== null) {
			// Like GitHub's: it changes with the commit, and with the token.
			const etag = `W/"${sha1(`${this.head} ${request.headers.Authorization ?? ""}`)}"`;
			const sentBack = Object.entries(request.headers).find(([name]) => name.toLowerCase() === "if-none-match");
			if (sentBack?.[1] === etag) {
				this.notModified += 1;
				return { status: 304, headers: { etag }, body: new ArrayBuffer(0) };
			}
			// Spelled as a desktop gives it; a phone gives `etag`.
			return { ...this.answer(sent), headers: { ETag: etag } };
		}
		return this.answer(sent);
	};

	private answer({ method, path, body }: SentRequest): HttpResponse {
		const data = (body ?? {}) as Record<string, unknown>;
		if (method === "GET" && path === "") return respond(200, { default_branch: this.defaultBranch });
		if (method === "PUT" && path.startsWith("/contents/")) {
			// A path that is there is only replaced when its sha is named;
			// a new one goes on top of the head, when there is one.
			const filePath = decodeURIComponent(path.slice("/contents/".length));
			const files = this.files();
			if (files.has(filePath)) return respond(422, { message: "Invalid request.\n\n\"sha\" wasn't supplied." });
			const sha = this.blob(Uint8Array.from(atob(String(data.content)), (c) => c.charCodeAt(0)));
			files.set(filePath, { mode: "100644", sha });
			const parents = this.head === null ? [] : [this.head];
			const commit = this.makeCommit(this.tree(files), parents, String(data.message));
			this.head = commit;
			return respond(201, { content: { path: filePath, sha }, commit: { sha: commit, parents: parents.map((parent) => ({ sha: parent })) } });
		}
		if (method === "GET" && path === "/git/ref/heads/main") {
			if (this.head === null) return respond(409, { message: "Git Repository is empty." });
			return respond(200, { object: { type: "commit", sha: this.head } });
		}
		if (method === "GET" && path.startsWith("/git/commits/")) {
			const commit = this.commits.get(path.slice("/git/commits/".length));
			if (commit === undefined) return respond(404, { message: "Not Found" });
			return respond(200, {
				sha: commit.sha,
				tree: { sha: commit.tree },
				parents: commit.parents.map((sha) => ({ sha })),
			});
		}
		if (method === "GET" && path.startsWith("/git/trees/")) {
			const files = this.trees.get(path.slice("/git/trees/".length).replace("?recursive=1", ""));
			if (files === undefined) return respond(404, { message: "Not Found" });
			return respond(200, { truncated: false, tree: this.items(files) });
		}
		if (method === "GET" && path.startsWith("/git/blobs/")) {
			const content = this.blobs.get(path.slice("/git/blobs/".length));
			if (content === undefined) return respond(404, { message: "Not Found" });
			const copy = new ArrayBuffer(content.length);
			new Uint8Array(copy).set(content);
			return { status: 200, headers: {}, body: copy };
		}
		if (method === "GET" && path.startsWith("/compare/")) {
			const [base = "", head = ""] = path.slice("/compare/".length).replace("?per_page=1", "").split("...");
			if (!this.commits.has(base) || !this.commits.has(head)) return respond(404, { message: "Not Found" });
			const ahead = this.descends(head, base);
			return respond(200, { status: base === head ? "identical" : ahead ? "ahead" : "diverged" });
		}
		if (method === "POST" && path === "/git/blobs") {
			if (data.encoding !== "base64" || typeof data.content !== "string") return respond(422, { message: "Invalid" });
			return respond(201, { sha: this.blob(new Uint8Array(Buffer.from(data.content, "base64"))) });
		}
		if (method === "POST" && path === "/git/trees") {
			const base = this.trees.get(String(data.base_tree));
			if (base === undefined || !Array.isArray(data.tree)) return respond(422, { message: "Invalid tree" });
			const files = new Map(base);
			for (const change of data.tree as Record<string, unknown>[]) {
				const at = String(change.path);
				// Whatever was at the path, or below it, makes way.
				for (const other of [...files.keys()]) {
					if (other === at || other.startsWith(`${at}/`)) files.delete(other);
				}
				if (change.sha === null) continue;
				// A file below a file turns that file into a folder.
				for (let slash = at.indexOf("/"); slash !== -1; slash = at.indexOf("/", slash + 1)) {
					files.delete(at.slice(0, slash));
				}
				const sha =
					typeof change.content === "string"
						? this.blob(bytes(this.normalise?.(change.content) ?? change.content))
						: String(change.sha);
				if (!this.blobs.has(sha)) return respond(422, { message: "tree.sha is not a valid blob" });
				files.set(at, { mode: String(change.mode), sha });
			}
			return respond(201, { sha: this.tree(files) });
		}
		if (method === "POST" && path === "/git/commits") {
			const parents = Array.isArray(data.parents) ? (data.parents as string[]) : [];
			if (!this.trees.has(String(data.tree))) return respond(422, { message: "Tree SHA does not exist" });
			return respond(201, { sha: this.makeCommit(String(data.tree), parents, String(data.message)) });
		}
		if (method === "PATCH" && path === "/git/refs/heads/main") {
			const sha = String(data.sha);
			if (!this.commits.has(sha)) return respond(422, { message: "Object does not exist" });
			if (data.force !== false || !this.descendsFromHead(sha)) {
				return respond(422, { message: "Update is not a fast forward" });
			}
			this.head = sha;
			return respond(200, { object: { sha } });
		}
		return respond(404, { message: "Not Found" });
	}

	private descendsFromHead(sha: string): boolean {
		return this.head !== null && this.descends(sha, this.head);
	}

	/** Whether `ancestor` is `sha` or in its history. */
	private descends(sha: string, ancestor: string): boolean {
		for (let at: string | undefined = sha; at !== undefined; at = this.commits.get(at)?.parents[0]) {
			if (at === ancestor) return true;
		}
		return false;
	}

	private blob(content: Uint8Array): string {
		const sha = blobHash(content);
		this.blobs.set(sha, content);
		return sha;
	}

	private tree(files: ReadonlyMap<string, FakeTreeFile>): string {
		const sorted = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		const sha = sha1(`tree ${JSON.stringify(sorted)}`);
		this.trees.set(sha, new Map(sorted));
		return sha;
	}

	private makeCommit(tree: string, parents: readonly string[], message: string): string {
		const sha = sha1(`commit ${tree} ${parents.join(" ")} ${message} ${this.commits.size}`);
		this.commits.set(sha, { sha, tree, parents, message });
		return sha;
	}

	/** The items of a tree as GitHub lists them: every file, and every folder on the way to one. */
	private items(files: ReadonlyMap<string, FakeTreeFile>): unknown[] {
		const items: unknown[] = [];
		const folders = new Set<string>();
		for (const [path, file] of files) {
			for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
				const folder = path.slice(0, slash);
				if (folders.has(folder)) continue;
				folders.add(folder);
				items.push({ path: folder, mode: "040000", type: "tree", sha: sha1(`folder ${folder}`) });
			}
			if (file.mode === "160000") items.push({ path, mode: file.mode, type: "commit", sha: file.sha });
			else items.push({ path, mode: file.mode, type: "blob", sha: file.sha, size: this.blobs.get(file.sha)?.length ?? 0 });
		}
		return items;
	}
}
