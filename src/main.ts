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

import { getLanguage, Plugin } from "obsidian";
import { type Translate, translatorFor } from "./core/i18n";

export default class SyncEvoPlugin extends Plugin {
	/** Looks up every text the plugin shows, in the language of the app. */
	t: Translate = translatorFor("");

	override onload(): void {
		// A change of the app language takes effect on restart, so reading it once is enough.
		this.t = translatorFor(getLanguage());
	}

	override onunload(): void {
		// Nothing to clean up yet.
	}
}
