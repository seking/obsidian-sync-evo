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

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// Every text the plugin shows comes from the catalog. The types cannot see a
// text written where it is used, so the source outside src/core/ is searched
// for one given to a call that puts text on the screen, or assigned to the
// text of an element.
//
// Rough on purpose, like the check of the imports of src/core/: it reads the
// text of the source, not its meaning. Any string among the arguments counts,
// other than one inside a lookup in the catalog, so a string that is only
// compared there is reported too and has to be moved out of the call. A text
// that reaches the call through a variable is not seen.

/** Calls whose arguments are shown to the user. */
const TEXT_CALL =
	/\b(?:setName|setDesc|setButtonText|setPlaceholder|setTooltip|setTitle|setText|appendText)\s*\(|\bnew\s+Notice\s*\(/g;
/** The object given to `addCommand`, in which `name` is shown. */
const COMMAND_CALL = /\baddCommand\s*\(\s*\{/g;
/** Calls that make an element. Their options can carry a text; the tag and the class are not shown. */
const ELEMENT_CALL = /\b(createEl|createDiv|createSpan)\s*\(/g;
/** The properties of those options that are shown, as far as the end of the property: the comma or the closing brace. */
const SHOWN_PROPERTY = /(?<![\w-])(text|title|placeholder|aria-label)["'`]?\s*:([^,}]*)/g;
/** The icon of the ribbon. Its first argument is the id of an icon, its second is shown. */
const RIBBON_CALL = /\baddRibbonIcon\s*\(/g;
/** Calls that set an attribute, and the attributes that are shown or read out. */
const ATTRIBUTE_CALL = /\b(?:setAttr|setAttribute)\s*\(/g;
const SHOWN_ATTRIBUTE = /^(["'`])(?:aria-label|title|placeholder)\1$/;
/** An assignment to the text of an element. A comparison is not one. */
const TEXT_ASSIGNMENT = /\.(textContent|innerText)\s*\+?=(?!=)/g;
/** A lookup in the catalog. Its key is a string that is not shown. */
const LOOKUP = /\bt\s*\(/g;

function stripComments(source: string): string {
	// A `//` only counts at the start of a line or after a space, which keeps
	// URLs inside strings whole.
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

/**
 * The index just past the bracket that closes the one at `open`. Brackets
 * inside strings do not count; a template is taken as one string, `${}` and all.
 */
function closing(code: string, open: number): number {
	const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
	const stack: string[] = [];
	let quote: string | null = null;
	for (let i = open; i < code.length; i++) {
		const char = code[i] ?? "";
		if (quote !== null) {
			if (char === "\\") i++;
			else if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") quote = char;
		else if (pairs[char] !== undefined) stack.push(pairs[char]);
		else if (char === stack[stack.length - 1]) {
			stack.pop();
			if (stack.length === 0) return i + 1;
		}
	}
	return code.length;
}

/**
 * The index of the first of `stops` at or after `from` that is outside every
 * string and bracket opened since, or of the bracket that closes the one
 * `from` is in, whichever comes first.
 */
function nextOutside(code: string, from: number, stops: string): number {
	let depth = 0;
	let quote: string | null = null;
	for (let i = from; i < code.length; i++) {
		const char = code[i] ?? "";
		if (quote !== null) {
			if (char === "\\") i++;
			else if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") quote = char;
		else if ("([{".includes(char)) depth++;
		else if (")]}".includes(char)) {
			if (depth === 0) return i;
			depth--;
		} else if (depth === 0 && stops.includes(char)) return i;
	}
	return code.length;
}

/** The arguments of the call whose bracket opens at `open`, each as written. */
function argumentsOf(code: string, open: number): string[] {
	const found: string[] = [];
	let from = open + 1;
	for (;;) {
		const end = nextOutside(code, from, ",");
		found.push(code.slice(from, end));
		if (code[end] !== ",") return found;
		from = end + 1;
	}
}

/** `code` with every lookup in the catalog, arguments and all, taken out. */
function withoutLookups(code: string): string {
	let out = "";
	let from = 0;
	for (const match of code.matchAll(LOOKUP)) {
		const start = match.index;
		if (start < from) continue;
		out += code.slice(from, start);
		from = closing(code, start + match[0].length - 1);
	}
	return out + code.slice(from);
}

/** Whether a string or template with anything in it is written in `code`. An empty one shows nothing. */
function hasText(code: string): boolean {
	return /(["'`])(?!\1)/.test(code.replace(/""|''|``/g, ""));
}

/** The calls in `source` that are given a text written in place. */
function literalTexts(source: string): string[] {
	const code = stripComments(source);
	const found: string[] = [];
	for (const match of code.matchAll(TEXT_CALL)) {
		const open = match.index + match[0].length - 1;
		const call = code.slice(match.index, closing(code, open));
		if (hasText(withoutLookups(call.slice(match[0].length)))) found.push(call.replace(/\s+/g, " "));
	}
	for (const match of code.matchAll(COMMAND_CALL)) {
		const open = match.index + match[0].length - 1;
		const options = withoutLookups(code.slice(open, closing(code, open)));
		// Up to the end of the property: the comma or the closing brace.
		for (const name of options.matchAll(/\bname\s*:([^,}]*)/g)) {
			if (hasText(name[1] ?? "")) found.push(`addCommand name:${(name[1] ?? "").replace(/\s+/g, " ")}`);
		}
	}
	for (const match of code.matchAll(ELEMENT_CALL)) {
		const args = argumentsOf(code, match.index + match[0].length - 1);
		// `createEl` takes the tag first. A string in the place of the options is a class.
		const options = (args[match[1] === "createEl" ? 1 : 0] ?? "").trim();
		if (!options.startsWith("{")) continue;
		for (const property of withoutLookups(options).matchAll(SHOWN_PROPERTY)) {
			const value = property[2] ?? "";
			if (hasText(value)) found.push(`${match[1]} ${property[1]}: ${value.replace(/\s+/g, " ").trim()}`);
		}
	}
	for (const match of code.matchAll(RIBBON_CALL)) {
		const title = argumentsOf(code, match.index + match[0].length - 1)[1] ?? "";
		if (hasText(withoutLookups(title))) found.push(`addRibbonIcon title: ${title.replace(/\s+/g, " ").trim()}`);
	}
	for (const match of code.matchAll(ATTRIBUTE_CALL)) {
		const [name = "", ...value] = argumentsOf(code, match.index + match[0].length - 1);
		if (!SHOWN_ATTRIBUTE.test(name.trim())) continue;
		if (hasText(withoutLookups(value.join(",")))) found.push(`${match[0]}${name.trim()}, …)`);
	}
	for (const match of code.matchAll(TEXT_ASSIGNMENT)) {
		// As far as the end of the statement.
		const from = match.index + match[0].length;
		const value = code.slice(from, nextOutside(code, from, ";"));
		if (hasText(withoutLookups(value))) found.push(`${match[1]} = ${value.replace(/\s+/g, " ").trim()}`);
	}
	return found;
}

describe("the search for text written in place", () => {
	test.each([
		'new Setting(el).setName("Repository")',
		"setting.setDesc('The repository to sync with.')",
		"setting.setDesc(`Syncs with ${name}`)",
		'button.setButtonText("Test connection")',
		'text.setPlaceholder("owner/name")',
		'button.setTooltip("Run")',
		'modal.setTitle("Confirm")',
		'el.setText("Done")',
		'new Notice("Connected")',
		"new Notice(`Connected to ${repository}`)",
		'new  Notice (\n\t"Connected",\n)',
		'new Notice("Connected to " + repository)',
		'new Notice(repository + " is connected")',
		'el.setText(ok ? "Connected" : t("check.unreachable"))',
		'el.setText(ok ? t("check.empty") : "Failed")',
		'el.setText(t("check.other", { detail }) + "!")',
		'new Notice(t("check.empty"), "long" as never)',
		'this.addCommand({ id: "sync", name: "Sync now", callback })',
		'this.addCommand({\n\tid: "sync",\n\tname: `Sync now`,\n\tcallback: () => {},\n})',
		'this.addCommand({ id: "sync", callback: () => this.t("a"), name: "Sync" + suffix })',
		'el.createEl("p", { text: "Hello" })',
		'el.createEl("p", { cls: "mod-warning", text: `Syncs with ${name}` })',
		'el.createEl("a", { text: t("link"), title: "Open the repository" })',
		'el.createEl("input", { type: "text", placeholder: "owner/name" })',
		'el.createEl("input", { attr: { "aria-label": "Repository" } })',
		'el.createEl(\n\t"p",\n\t{\n\t\ttext: ok ? t("check.empty") : "Failed",\n\t},\n)',
		'el.createDiv({ text: "Hello" })',
		'el.createDiv({ cls: "mod-warning", title: "Hello" })',
		'el.createSpan({ text: "Hello" })',
		'el.createSpan({ text: t("check.other", { detail }) + "!" }, (span) => span.addClass("x"))',
		'el.appendText("Hello")',
		'el.appendText(t("check.empty") + " ")',
		'this.addRibbonIcon("refresh-cw", "Sync now", () => {})',
		'this.addRibbonIcon("refresh-cw", `Sync ${name}`, () => this.sync())',
		'el.setAttr("aria-label", "Sync now")',
		"el.setAttribute('aria-label', 'Sync now')",
		'el.setAttr("aria-label", ok ? t("a") : "Failed")',
		'el.setAttr("title", "Sync now")',
		'el.textContent = "Hello";',
		'el.innerText = "Hello";',
		"el.textContent = `Syncs with ${name}`;",
		'el.textContent += "Hello";',
		'el.textContent =\n\tok ? t("check.empty") : "Failed";',
		'on(() => (el.textContent = "Hello"))',
	])("finds %j", (source) => {
		expect(literalTexts(source).length).toBeGreaterThan(0);
	});

	test.each([
		'new Setting(el).setName(t("settings.repository.name"))',
		'setting.setDesc(this.plugin.t("settings.repository.desc"))',
		'new Notice(t("check.connected", { repository: "octo/notes", branch }))',
		'new Notice(t("check.other", { detail: describe(error, ")") }))',
		"new Notice(text)",
		'el.setText("")',
		'el.setText(problem === null ? "" : t("settings.deviceName.empty"))',
		'el.setText(ok ? t("check.empty") : t("check.unreachable"))',
		'this.addCommand({ id: "sync", name: this.t("command.sync"), callback: () => {} })',
		'this.addCommand({ id: "sync", name: t("command.sync"), icon: "refresh-cw" })',
		'// new Notice("in a comment")',
		'/* setName("in a comment") */',
		'text.setValue("main")',
		'el.addClass("mod-warning")',
		'const names = { name: "not a command" }',
		'resetName("x")',
		'el.createEl("p", { text: t("x") })',
		'el.createEl("p", { cls: "mod-warning", text: this.plugin.t("x", { name: "a" }) })',
		'el.createEl("p")',
		'el.createEl("input", { type: "text", cls: "wide" })',
		'el.createEl("a", { href: "https://example.com", text: t("link"), title: t("link.title") })',
		'el.createEl("p", { text: "" })',
		'el.createEl("p", { text })',
		'el.createDiv({ cls: "mod-warning" })',
		'el.createDiv("mod-warning")',
		"el.createDiv()",
		'el.createDiv({ cls: "mod-warning" }, (div) => div.addClass("text"))',
		'el.createSpan({ cls: "title", text: t("x") })',
		'el.appendText(t("check.empty"))',
		"el.appendText(text)",
		'this.addRibbonIcon("refresh-cw", t("command.sync"), () => {})',
		'this.addRibbonIcon("refresh-cw", this.t("command.sync"), () => this.run("sync"))',
		'el.setAttr("aria-label", t("command.sync"))',
		'el.setAttribute("aria-label", this.plugin.t("command.sync"))',
		'el.setAttr("data-kind", "warning")',
		'el.setAttribute("type", "text")',
		'el.textContent = t("check.empty");',
		'el.innerText = t("check.other", { detail: "x" });',
		'el.textContent = "";',
		"el.textContent = text;",
		'if (el.textContent === "Hello") return;',
		'if (el.innerText !== "Hello") return;',
		'el.textContent = t("a");\nel.addClass("mod-warning");',
	])("leaves %j", (source) => {
		expect(literalTexts(source)).toEqual([]);
	});

	test("each call is reported on its own", () => {
		const source = 'a.setName(t("a")).setDesc("b");\nnew Notice("c");\nnew Notice(t("d"));';
		expect(literalTexts(source)).toEqual(['setDesc("b")', 'new Notice("c")']);
	});

	test("the tag, the class, and the icon are not taken for a text", () => {
		const source =
			'el.createEl("p", { cls: "a", text: "b" });\nel.createDiv({ cls: "c", title: "d" });\nthis.addRibbonIcon("e", "f", () => {});';
		expect(literalTexts(source)).toEqual(['createEl text: "b"', 'createDiv title: "d"', 'addRibbonIcon title: "f"']);
	});
});

test("no text is written in place outside src/core and pro/src/core", () => {
	// The paid part (`pro/`) has a screen of its own as well.
	const files = ["../src/", "../pro/src/"].flatMap((folder) => {
		return readdirSync(new URL(folder, import.meta.url), { recursive: true, encoding: "utf8" })
			.filter((name) => name.endsWith(".ts") && !/^core[\\/]/.test(name))
			.map((name) => `${folder.slice("../".length)}${name}`);
	});
	// The entry point and the settings screen, at the least.
	expect(files).toContain("src/main.ts");
	expect(files.some((name) => /settings-tab\.ts$/.test(name))).toBe(true);
	expect(files.some((name) => /^pro[\\/]/.test(name))).toBe(true);

	const found: string[] = [];
	let calls = 0;
	for (const file of files) {
		const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
		calls += [...stripComments(source).matchAll(TEXT_CALL)].length;
		for (const call of literalTexts(source)) found.push(`${file}: ${call}`);
	}
	expect(found).toEqual([]);
	// The search is looking at the calls the screen is made of.
	expect(calls).toBeGreaterThan(10);
});
