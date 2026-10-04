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

export function translatorFor(appLanguage: string): Translate {
	const language = resolveLanguage(appLanguage);
	return createTranslator(en, translations[language], language);
}
