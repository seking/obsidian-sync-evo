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

import type { Message } from "./catalog";
import { en } from "./en";
import { ja } from "./ja";
import { BASE_LANGUAGE, createTranslator, type Translator } from "./translator";

export type MessageKey = keyof typeof en;

/** The lookup the rest of the plugin uses for every text it shows. */
export type Translate = Translator<typeof en>;

/**
 * The translations, by the language code the app reports. Adding a language
 * is adding its file and one entry here.
 */
export const translations: { readonly [code: string]: { readonly [K in MessageKey]?: Message } } = {
	ja,
};

/**
 * Maps the app language to a language there are messages for. An exact code
 * wins, then the code without its region (`ja-JP` is `ja`), then the base.
 */
export function resolveLanguage(appLanguage: string): string {
	// The types rule this out, but a throw here would stop the plugin from loading.
	if (typeof appLanguage !== "string") return BASE_LANGUAGE;
	const wanted = appLanguage.trim().toLowerCase().replace(/_/g, "-");
	const primary = wanted.split("-")[0] ?? "";
	const codes = Object.keys(translations);
	return (
		codes.find((code) => code.toLowerCase() === wanted) ??
		codes.find((code) => code.toLowerCase() === primary) ??
		BASE_LANGUAGE
	);
}

/** The suffix of a message that takes the place of another while Dropbox is the service. */
export const DROPBOX_VARIANT = ".dropbox";

/**
 * `remote` is the name of the service put where a text has `{remote}`:
 * GitHub when absent. With Dropbox, a message that has a variant of its
 * own (the key with `DROPBOX_VARIANT` after it) is taken from that: a text
 * that speaks of a repository, a commit or its history, which Dropbox has
 * none of. A variant has no placeholder its message lacks.
 */
export function translatorFor(appLanguage: string, remote?: string): Translate {
	const language = resolveLanguage(appLanguage);
	const translate = createTranslator(en, translations[language], language, remote);
	if (remote !== "Dropbox") return translate;
	const loose = translate as (key: string, ...args: unknown[]) => string;
	return ((key: string, ...args: unknown[]) => {
		const variant = `${key}${DROPBOX_VARIANT}`;
		return loose(Object.prototype.hasOwnProperty.call(en, variant) ? variant : key, ...args);
	}) as Translate;
}
