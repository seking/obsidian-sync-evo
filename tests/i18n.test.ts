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

import { describe, expect, test } from "vitest";
import { baseCatalog, completeTranslation, partialTranslation, type Message } from "../src/core/i18n/catalog";
import { en } from "../src/core/i18n/en";
import { DROPBOX_VARIANT, resolveLanguage, translations, translatorFor } from "../src/core/i18n/index";
import { createTranslator } from "../src/core/i18n/translator";

// A catalog of its own, so that the mechanism is tested without adding
// messages to the plugin that no screen shows yet.
const base = {
	title: "Settings",
	moved: "Moved {name} to {folder}",
	files: { one: "{count} file", other: "{count} files" },
	done: { one: "Sent one file from {device}", other: "Sent {count} files from {device}" },
	onlyInBase: "Only in English",
} as const;

const japanese = completeTranslation(base, {
	title: "設定",
	moved: "{folder} に {name} を移動しました",
	files: "{count} 件のファイル",
	done: "{device} から {count} 件のファイルを送信しました",
	onlyInBase: "英語だけ",
});

describe("choosing the language", () => {
	test.each(["ja", "JA", "ja-JP", "ja_JP", " ja "])("%j is Japanese", (code) => {
		expect(resolveLanguage(code)).toBe("ja");
		expect(translatorFor(code)("vaultConfig.hotkeys")).toBe("ホットキー");
	});

	test.each(["en", "en-GB", "fr", "zh-TW", "", "xx", "jav", "constructor"])("%j is English", (code) => {
		expect(resolveLanguage(code)).toBe("en");
		expect(translatorFor(code)("vaultConfig.hotkeys")).toBe("Hotkeys");
	});

	test.each([undefined, null, 5, {}])("%j, which is not a language code, is English", (code) => {
		const notText = code as unknown as string;
		expect(resolveLanguage(notText)).toBe("en");
		expect(translatorFor(notText)("vaultConfig.hotkeys")).toBe("Hotkeys");
	});
});

describe("looking up a message", () => {
	const t = createTranslator(base);
	const tJa = createTranslator(base, japanese, "ja");

	test("fixed text", () => {
		expect(t("title")).toBe("Settings");
		expect(tJa("title")).toBe("設定");
	});

	test("named values, in the order each language wants", () => {
		expect(t("moved", { name: "a.md", folder: "notes" })).toBe("Moved a.md to notes");
		expect(tJa("moved", { name: "a.md", folder: "notes" })).toBe("notes に a.md を移動しました");
	});

	test("a value is inserted as it is, even when it looks like a placeholder", () => {
		expect(t("moved", { name: "{folder}", folder: "$&" })).toBe("Moved {folder} to $&");
	});

	test("singular and plural in English, one form in Japanese", () => {
		expect(t("files", { count: 0 })).toBe("0 files");
		expect(t("files", { count: 1 })).toBe("1 file");
		expect(t("files", { count: 2 })).toBe("2 files");
		expect(tJa("files", { count: 1 })).toBe("1 件のファイル");
		expect(tJa("files", { count: 2 })).toBe("2 件のファイル");
		expect(t("done", { count: 1, device: "phone" })).toBe("Sent one file from phone");
		expect(tJa("done", { count: 1, device: "phone" })).toBe("phone から 1 件のファイルを送信しました");
	});

	test("a plural form the translation leaves out or blank uses its other form", () => {
		const some = createTranslator(base, { files: { one: " ", other: "{count} Dateien" } }, "de");
		expect(some("files", { count: 1 })).toBe("1 Dateien");
	});
});

describe("the name of what the vault syncs with", () => {
	const named = baseCatalog({ gone: "{count} files were deleted on {remote}.", plain: "{remote} is up to date." });

	test("is put where a message has {remote}, without the caller passing it", () => {
		const t = createTranslator(named);
		expect(t("plain")).toBe("GitHub is up to date.");
		expect(t("gone", { count: 3 })).toBe("3 files were deleted on GitHub.");
	});

	test("is the service the translator was made for, in a translation as in the base", () => {
		const t = createTranslator(named, { plain: "{remote} は最新です。" }, "ja", "Google Drive");
		expect(t("plain")).toBe("Google Drive は最新です。");
		expect(t("gone", { count: 3 })).toBe("3 files were deleted on Google Drive.");
	});
});

describe("falling back to the base", () => {
	test("a missing, empty, or blank message is shown in English", () => {
		const blanks: { [key: string]: Message } = { title: "", moved: "   ", files: { other: "" } };
		const t = createTranslator(base, blanks, "ja");
		expect(t("title")).toBe("Settings");
		expect(t("moved", { name: "a.md", folder: "notes" })).toBe("Moved a.md to notes");
		expect(t("files", { count: 1 })).toBe("1 file");
		expect(t("onlyInBase")).toBe("Only in English");
	});

	test("a partial translation is accepted and filled from English", () => {
		const some = partialTranslation(base, { title: "Einstellungen" });
		const t = createTranslator(base, some, "de");
		expect(t("title")).toBe("Einstellungen");
		expect(t("files", { count: 1 })).toBe("1 file");
	});

	test("names inherited from Object are not taken for messages", () => {
		const t = createTranslator(base, {}, "ja") as (key: string) => string;
		expect(t("constructor")).toBe("");
		expect(t("toString")).toBe("");
	});
});

// What the compiler does not stop, or stops only for text it sees as a
// literal, is checked here. The catalogs are taken loosely, so that the
// checks can also be run on catalogs broken on purpose.
type Loose = { readonly [key: string]: string | { readonly [form: string]: string } | undefined };

const FORMS = ["zero", "one", "two", "few", "many", "other"];

const namesIn = (text: string | undefined): string[] =>
	[...new Set([...(text ?? "").matchAll(/\{([^{}]+)\}/g)].map((m) => m[1] ?? ""))].sort();

/** Every placeholder of a message; plural forms always take `count`. */
const names = (message: string | { readonly [form: string]: string }): string[] =>
	typeof message === "string"
		? namesIn(message)
		: [...new Set([...Object.values(message).flatMap(namesIn), "count"])].sort();

/** The placeholders of the text shown for most numbers. */
const shown = (message: string | { readonly [form: string]: string }): string[] =>
	namesIn(typeof message === "string" ? message : message["other"]);

/** The faults of a catalog: of the base on its own, or of a translation against the base. */
function faults(base: Loose, translation?: Loose): string[] {
	const found: string[] = [];
	for (const [key, message] of Object.entries(translation ?? base)) {
		const original = base[key];
		if (original === undefined) found.push(`${key}: the base has no such key`);
		if (message === undefined) continue;
		const most = shown(original ?? message);
		if (typeof message === "string") {
			if (message.trim() === "") found.push(`${key}: blank`);
		} else {
			if (!Object.prototype.hasOwnProperty.call(message, "other")) found.push(`${key}: no other form`);
			for (const [form, text] of Object.entries(message)) {
				if (!FORMS.includes(form)) found.push(`${key}.${form}: not a plural form`);
				if (text.trim() === "") found.push(`${key}.${form}: blank`);
				// A form may leave a placeholder out ("Sent one file"), not add one.
				if (form !== "other" && namesIn(text).some((name) => !most.includes(name))) {
					found.push(`${key}.${form}: a placeholder the other form of the base lacks`);
				}
			}
		}
		if (original === undefined) continue;
		if (names(message).join() !== names(original).join()) found.push(`${key}: the placeholders differ`);
		if (shown(message).join() !== most.join()) found.push(`${key}: the other form shows other placeholders`);
	}
	return found;
}

describe("the catalogs of the plugin", () => {
	test("Japanese is registered", () => {
		expect(Object.keys(translations)).toContain("ja");
	});

	test("English has no blank text and sound plural forms", () => {
		expect(faults(en)).toEqual([]);
	});

	test.each(Object.entries(translations))("%s has only known keys, no blank text, and the same placeholders", (_code, translation) => {
		expect(faults(en, translation)).toEqual([]);
	});

	test("Japanese has every key", () => {
		expect(Object.keys(translations["ja"] ?? {}).sort()).toEqual(Object.keys(en).sort());
	});
});

describe("the checks of the catalogs", () => {
	test("sound catalogs pass", () => {
		expect(faults(base)).toEqual([]);
		expect(faults(base, japanese)).toEqual([]);
		expect(faults(base, { files: { one: "Eine Datei", other: "{count} Dateien" } })).toEqual([]);
		expect(faults(base, { title: "Einstellungen" })).toEqual([]);
	});

	test.each<[string, Loose, string[]]>([
		["empty text", { title: "" }, ["title: blank"]],
		["text of spaces", { title: " \t" }, ["title: blank"]],
		["an empty form", { files: { one: "", other: "{count} files" } }, ["files.one: blank"]],
		["a form of spaces", { files: { one: "{count} file", other: "  " } }, ["files.other: blank", "files: the other form shows other placeholders"]],
		["a misnamed form", { files: { ones: "{count} file", other: "{count} files" } }, ["files.ones: not a plural form"]],
		["no other form", { files: { one: "{count} file" } }, ["files: no other form", "files: the other form shows other placeholders"]],
		["a form with a placeholder of its own", { files: { one: "{count} file in {folder}", other: "{count} files" } }, [
			"files.one: a placeholder the other form of the base lacks",
			"files: the placeholders differ",
		]],
	])("%s is a fault in a translation", (_what, broken, expected) => {
		expect(faults(base, broken)).toEqual(expected);
	});

	test("the same faults are found in a base", () => {
		expect(faults({ title: "" })).toEqual(["title: blank"]);
		expect(faults({ title: "  " })).toEqual(["title: blank"]);
		expect(faults({ files: { one: "", other: "{count} files" } })).toEqual(["files.one: blank"]);
		expect(faults({ files: { ones: "{count} file", other: "{count} files" } })).toEqual(["files.ones: not a plural form"]);
		expect(faults({ files: { one: "{count} file" } })).toEqual([
			"files: no other form",
			"files.one: a placeholder the other form of the base lacks",
		]);
		expect(faults({ files: { one: "{count} file in {folder}", other: "{count} files" } })).toEqual([
			"files.one: a placeholder the other form of the base lacks",
		]);
	});

	test("an other form that drops the count is a fault, though a one form may", () => {
		expect(faults(base, { files: { one: "1 件", other: "件" } })).toEqual(["files: the other form shows other placeholders"]);
		expect(faults(base, { done: { one: "{device} から 1 件", other: "{device} から {count} 件" } })).toEqual([]);
	});

	test("a key the base lacks and a placeholder named differently are faults", () => {
		expect(faults(base, { extra: "余計" })).toEqual(["extra: the base has no such key"]);
		expect(faults(base, { moved: "{folder} に {file} を移動しました" })).toEqual([
			"moved: the placeholders differ",
			"moved: the other form shows other placeholders",
		]);
		expect(faults(base, { files: "ファイル" })).toEqual([
			"files: the placeholders differ",
			"files: the other form shows other placeholders",
		]);
	});
});

// Checked by the compiler, not at run time: each line marked as an expected
// error must be one, or the type check of the tests fails.
export function typeChecks(): void {
	const t = createTranslator(base);
	// @ts-expect-error unknown key
	t("nope");
	// @ts-expect-error values are required when the message has placeholders
	t("moved");
	// @ts-expect-error a value is missing
	t("moved", { name: "a.md" });
	// @ts-expect-error a plural message takes a number
	t("files", { count: "2" });
	// @ts-expect-error no values for fixed text
	t("title", { count: 1 });

	// @ts-expect-error a key is missing
	completeTranslation(base, { title: "設定" });
	partialTranslation(base, {
		title: "設定",
		// @ts-expect-error a key the base does not have
		extra: "余計",
	});
	partialTranslation(base, {
		// @ts-expect-error a placeholder named differently from the base
		moved: "{folder} に {file} を移動しました",
	});
	partialTranslation(base, {
		// @ts-expect-error a placeholder is dropped
		files: "ファイル",
	});
	partialTranslation(base, {
		// @ts-expect-error an empty message
		title: "",
	});	partialTranslation(base, {
		// @ts-expect-error an empty plural form
		files: { one: "", other: "{count} Dateien" },
	});
	partialTranslation(base, {
		// @ts-expect-error a misnamed plural form
		files: { ones: "{count} Datei", other: "{count} Dateien" },
	});
	partialTranslation(base, {
		// @ts-expect-error no other form
		files: { one: "{count} Datei" },
	});
	partialTranslation(base, {
		// @ts-expect-error the other form drops the count
		files: { one: "1 件", other: "件" },
	});
	// The one form may leave the count out.
	partialTranslation(base, { files: { one: "Eine Datei", other: "{count} Dateien" } });

	baseCatalog({ files: { one: "One file", other: "{count} files" } });
	// @ts-expect-error an empty message in the base
	baseCatalog({ title: "" });
	// @ts-expect-error an empty plural form in the base
	baseCatalog({ files: { one: "", other: "{count} files" } });
	// @ts-expect-error a misnamed plural form in the base
	baseCatalog({ files: { ones: "{count} file", other: "{count} files" } });
	// @ts-expect-error no other form in the base
	baseCatalog({ files: { one: "{count} file" } });
}

describe("the texts while Dropbox is the service", () => {
	test("a message with a variant for Dropbox is taken from it, and the others as they are, with Dropbox for {remote}", () => {
		const github = translatorFor("ja");
		const dropbox = translatorFor("ja", "Dropbox");
		expect(github("pull.remoteEmpty")).toBe("リポジトリは空です。ダウンロードするものはありません。");
		expect(dropbox("pull.remoteEmpty")).toBe("Dropbox に、このフォルダはまだありません。ダウンロードするものはありません。");
		expect(dropbox("untrack.done", { count: 2 })).toBe("Dropbox から 2 件を削除しました。このデバイスのファイルは、そのままです。");
	});

	test("every variant is of a message there is, and names no placeholder that message lacks", () => {
		const placeholders = (message: Message): Set<string> =>
			new Set([...JSON.stringify(message).matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? ""));
		const catalog = en as Record<string, Message>;
		for (const key of Object.keys(catalog).filter((name) => name.endsWith(DROPBOX_VARIANT))) {
			const base = catalog[key.slice(0, -DROPBOX_VARIANT.length)];
			const variant = catalog[key];
			expect(base, key).toBeDefined();
			if (base === undefined || variant === undefined) continue;
			for (const name of placeholders(variant)) expect(placeholders(base).has(name) || name === "remote", `${key}: {${name}}`).toBe(true);
		}
	});
});
