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

import { REMOTE, type Catalog, type GivenOf, type Message } from "./catalog";

/** The language of the base catalog, which decides its plural forms. */
export const BASE_LANGUAGE = "en";

/** The service every vault syncs with, while there is only one. */
export const DEFAULT_REMOTE = "GitHub";

type Values<M> = {
	readonly [Name in GivenOf<M>]: Name extends "count"
		? M extends string
			? string | number
			: number
		: string | number;
};

type Args<M> = [GivenOf<M>] extends [never] ? [] : [values: Values<M>];

/**
 * Returns the text for a key. The values are required exactly when the base
 * message has placeholders, and are named, so each language orders them freely.
 */
export type Translator<Base extends Catalog> = <K extends keyof Base & string>(
	key: K,
	...args: Args<Base[K]>
) => string;

function own(catalog: { readonly [key: string]: Message | undefined }, key: string): Message | undefined {
	return Object.prototype.hasOwnProperty.call(catalog, key) ? catalog[key] : undefined;
}

/**
 * Builds the lookup for one language. A message the translation lacks, or
 * has only as blank text, is taken from the base, so that neither an empty
 * label nor a key name is ever shown. `remote` is the name of the service
 * the vault syncs with, which is put wherever a message has `{remote}`.
 */
export function createTranslator<const Base extends Catalog>(
	base: Base,
	translation: { readonly [K in keyof Base]?: Message } = {},
	language: string = BASE_LANGUAGE,
	remote: string = DEFAULT_REMOTE,
): Translator<Base> {
	const rules = new Map<string, Intl.PluralRules>();
	const formOf = (lang: string, count: number): Intl.LDMLPluralRule => {
		let rule = rules.get(lang);
		if (rule === undefined) {
			rule = new Intl.PluralRules(lang);
			rules.set(lang, rule);
		}
		return rule.select(count);
	};

	const textOf = (message: Message | undefined, lang: string, count: unknown): string | undefined => {
		if (message === undefined) return undefined;
		let text: string | undefined;
		if (typeof message === "string") {
			text = message;
		} else {
			if (typeof count === "number") text = message[formOf(lang, count)];
			// A form that is absent or blank falls to the one every language has.
			if (text === undefined || text.trim() === "") text = message.other;
		}
		return text.trim() === "" ? undefined : text;
	};

	return (key, ...args) => {
		const values: { readonly [name: string]: string | number } = args[0] ?? {};
		const count = own(values as Catalog, "count");
		const text =
			textOf(own(translation, key), language, count) ??
			textOf(own(base, key), BASE_LANGUAGE, count) ??
			"";
		return text.replace(/\{([^{}]+)\}/g, (whole: string, name: string) => {
			if (name === REMOTE) return remote;
			const value = Object.prototype.hasOwnProperty.call(values, name) ? values[name] : undefined;
			return value === undefined ? whole : String(value);
		});
	};
}
