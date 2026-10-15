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

// Where a vault syncs to, in the words of a question: a repository and its
// branch on GitHub, a folder on Dropbox.

import type { Translate } from "./i18n";
import type { Connection } from "./settings";

/** Where a sync goes, as a question names it: the connection, without what only tells accounts apart. */
export type RemotePlace =
	| Pick<Extract<Connection, { backend: "github" }>, "backend" | "repository" | "branch">
	| Pick<Extract<Connection, { backend: "dropbox" }>, "backend" | "folder">;

export interface PlaceWords {
	/** The place alone: "octo/notes, branch main". */
	readonly place: string;
	/** The service with the place: "GitHub (octo/notes, branch main)". */
	readonly remotePlace: string;
}

export function placeWords(t: Translate, place: RemotePlace): PlaceWords {
	if (place.backend === "dropbox") {
		return { place: t("place.folder", { folder: place.folder }), remotePlace: t("remotePlace.folder", { folder: place.folder }) };
	}
	const values = { repository: place.repository, branch: place.branch };
	return { place: t("place.repository", values), remotePlace: t("remotePlace.repository", values) };
}
