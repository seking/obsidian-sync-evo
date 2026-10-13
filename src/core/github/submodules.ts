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

// Where a submodule points to: what `.gitmodules` says of it, and which
// repository of GitHub that is. Nothing here asks GitHub anything.

import type { RepositoryName } from "./client";

/**
 * The URL of each submodule a `.gitmodules` names, by the path it gives.
 * The file is in git's configuration format; only the sections of
 * submodules and their `path` and `url` are read. Sections of one name are
 * one section, and a value given twice is as it was given last, as in git.
 * What cannot be read is left out, and its submodule is then one the file
 * says nothing of.
 */
export function parseGitmodules(text: string): Map<string, string> {
	const sections = new Map<string, { path?: string; url?: string }>();
	let current: { path?: string; url?: string } | null = null;
	// A line that ends in a backslash goes on in the next one.
	for (const raw of text.replace(/\\\r?\n/g, "").split(/\r?\n/)) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
		if (line.startsWith("[")) {
			const section = /^\[\s*submodule\s+"((?:[^"\\]|\\.)*)"\s*\]\s*(?:[#;].*)?$/i.exec(line);
			current = section === null ? null : (sections.get(section[1] ?? "") ?? {});
			if (section !== null && current !== null) sections.set(section[1] ?? "", current);
			continue;
		}
		if (current === null) continue;
		const equals = line.indexOf("=");
		if (equals < 0) continue;
		const name = line.slice(0, equals).trim().toLowerCase();
		const value = valueOf(line.slice(equals + 1));
		if (name === "path") current.path = value;
		else if (name === "url") current.url = value;
	}

	const urls = new Map<string, string>();
	for (const { path, url } of sections.values()) {
		if (path !== undefined && url !== undefined && path !== "" && url !== "") urls.set(path, url);
	}
	return urls;
}

// A value as git reads it, as far as a path or a URL needs: without the
// comment after it, and without the quotes around it or a part of it.
function valueOf(raw: string): string {
	let value = "";
	let quoted = false;
	for (let at = 0; at < raw.length; at += 1) {
		const char = raw[at] ?? "";
		if (char === "\\" && at + 1 < raw.length) {
			at += 1;
			value += raw[at] ?? "";
		} else if (char === '"') {
			quoted = !quoted;
		} else if (!quoted && (char === "#" || char === ";")) {
			break;
		} else {
			value += char;
		}
	}
	return value.trim();
}

const HOST = /^(?:www\.)?github\.com$/i;

/**
 * The repository of GitHub a URL of `.gitmodules` names, or `null` when it
 * names none: another host, or a form that is not read. Read are the forms
 * git writes for GitHub (`https://github.com/o/r`, `git@github.com:o/r`,
 * `ssh://git@github.com/o/r`, `git://github.com/o/r`), with or without
 * `.git` at the end, and a URL that is relative to the repository the
 * submodule is in (`../r.git`), which `parent` is.
 */
export function repositoryOfUrl(url: string, parent: RepositoryName): RepositoryName | null {
	const trimmed = url.trim();
	if (trimmed.startsWith("./") || trimmed.startsWith("../")) {
		// As git resolves it: against the URL of the parent, one name at a time.
		const parts = [parent.owner, parent.repo];
		for (const part of trimmed.split("/")) {
			if (part === "" || part === ".") continue;
			if (part === "..") {
				if (parts.pop() === undefined) return null;
			} else {
				parts.push(part);
			}
		}
		return named(parts);
	}

	const scp = /^(?:[^@/:]+@)?([^/:]+):(?!\/\/)(.+)$/.exec(trimmed);
	if (scp !== null && !trimmed.includes("://")) {
		return HOST.test(scp[1] ?? "") ? named((scp[2] ?? "").split("/")) : null;
	}
	const full = /^(?:https?|ssh|git|git\+ssh):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(trimmed);
	if (full !== null) return HOST.test(full[1] ?? "") ? named((full[2] ?? "").split("/")) : null;
	return null;
}

// An owner and a name, and nothing else: what GitHub addresses a repository by.
// `ofUrl`: the name is the end of a URL, where git allows a `.git` after it.
function named(parts: readonly string[], ofUrl = true): RepositoryName | null {
	const names = parts.filter((part) => part !== "");
	const [owner, last] = names;
	if (names.length !== 2 || owner === undefined || last === undefined) return null;
	const repo = ofUrl && last.endsWith(".git") ? last.slice(0, -".git".length) : last;
	// What GitHub allows in each. A name of dots alone would be a step in
	// the path of a request, and not a name.
	if (!/^[A-Za-z0-9-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo) || /^\.+$/.test(repo)) return null;
	return { owner, repo };
}

/** A repository as an `EntrySource` names it. */
export function repositoryName(name: RepositoryName): string {
	return `${name.owner}/${name.repo}`;
}

/** The repository an `EntrySource` names, or `null` when it names none. */
export function repositoryOfName(name: string): RepositoryName | null {
	return named(name.split("/"), false);
}
