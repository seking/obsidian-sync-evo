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

/** The names `Intl.PluralRules` gives to the forms of a number. */
export type PluralForm = "zero" | "one" | "two" | "few" | "many" | "other";

/**
 * The forms of a message that changes with a number. `other` is the form
 * every language has; a language without plurals writes a plain string instead.
 */
export type Plural = { readonly other: string } & {
	readonly [Form in Exclude<PluralForm, "other">]?: string;
};

/** One message: fixed text, or text with `{name}` placeholders, or its plural forms. */
export type Message = string | Plural;

export type Catalog = { readonly [key: string]: Message };

type Names<Text> = Text extends `${string}{${infer Name}}${infer Rest}`
	? Name | Names<Rest>
	: never;

/**
 * The placeholder names of a message. Plural forms always take `count`, the
 * number that picks the form, whether or not a form shows it.
 */
export type ParamsOf<M> = M extends string ? Names<M> : "count" | Names<M[keyof M]>;

/**
 * The placeholder that stands for what the vault syncs with, by the name of
 * the service ("GitHub"). The lookup fills it in by itself, so a caller does
 * not pass it.
 */
export const REMOTE = "remote";

/** The placeholders a caller has to give the values of. */
export type GivenOf<M> = Exclude<ParamsOf<M>, typeof REMOTE>;

/** The placeholders of the text shown for most numbers: the message itself, or its `other` form. */
type Shown<M> = M extends string ? Names<M> : M extends { readonly other: infer Other } ? Names<Other> : never;

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// A message with the faults one message can have on its own replaced by a
// type no text fits, so the compiler points at that line and the text below
// shows up in its error.
type Sound<M> = M extends string
	? M extends ""
		? "Error: an empty message"
		: M
	: {
			readonly [Form in keyof M]: Form extends PluralForm
				? M[Form] extends ""
					? "Error: an empty form; leave the form out instead"
					: M[Form]
				: "Error: not a plural form (zero, one, two, few, many, other)";
		};

type SoundCatalog<T> = { readonly [K in keyof T]: T[K] extends Message ? Sound<T[K]> : Message };

/**
 * Declares the base catalog. An empty message, an empty plural form, and a
 * form `Intl.PluralRules` does not name all fail the type check.
 */
export function baseCatalog<const T>(catalog: T extends SoundCatalog<T> ? T : SoundCatalog<T>): T {
	return catalog as T;
}

// Each key of a translation is checked on its own and then against the base,
// in the same way: a key that fails gets a type no message fits.
type Checked<Base, T> = {
	readonly [K in keyof T]: K extends keyof Base
		? T[K] extends Message
			? T[K] extends Sound<T[K]>
				? Same<ParamsOf<Base[K]>, ParamsOf<T[K]>> extends true
					? Same<Shown<Base[K]>, Shown<T[K]>> extends true
						? T[K]
						: "Error: the other form must show the placeholders the base shows"
					: "Error: the placeholders differ from the base message"
				: Sound<T[K]>
			: Message
		: "Error: the base has no such key";
};

type Missing<Base, T> = { readonly [K in Exclude<keyof Base, keyof T>]: Message };

/**
 * Declares a translation that must have every key of the base. A missing key,
 * a key the base does not have, an empty message or plural form, a misnamed
 * plural form, and a placeholder named differently from the base (or dropped
 * from the `other` form) all fail the type check. Text that is only spaces
 * is left to the tests.
 */
export function completeTranslation<const Base extends Catalog, const T>(
	_base: Base,
	translation: T extends Checked<Base, T> & Missing<Base, T> ? T : Checked<Base, T> & Missing<Base, T>,
): T {
	return translation as T;
}

/**
 * The same checks, except that keys may be left out. For a language whose
 * translation is still in progress; the base message is shown for the rest.
 */
export function partialTranslation<const Base extends Catalog, const T>(
	_base: Base,
	translation: T extends Checked<Base, T> ? T : Checked<Base, T>,
): T {
	return translation as T;
}
