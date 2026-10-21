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

import { describe, expect, test } from "vitest";
import {
	type DeviceExclusion,
	deviceExclusionLines,
	deviceExclusionSummary,
	editedDeviceExclusion,
	isDeviceExclusionEmpty,
	kindsFromSection,
	NO_DEVICE_EXCLUSION,
	withoutKinds,
} from "../src/core/device-exclusion";
import { createExclusion, defaultSectionLines } from "../src/core/exclusion";
import { translatorFor } from "../src/core/i18n";
import {
	defaultSectionState,
	findSection,
	readSectionState,
	type SectionState,
	sectionLines,
	withSection,
} from "../src/core/gitignore-section";

const paths = { configDir: ".obsidian", pluginDir: ".obsidian/plugins/sync-evo" };

const device = (over: Partial<DeviceExclusion> = {}): DeviceExclusion => ({ ...NO_DEVICE_EXCLUSION, ...over });

/** The section an earlier version wrote, with these kinds off. */
function sectionWith(kinds: Partial<SectionState["kinds"]>, rest = ""): string {
	const state = defaultSectionState(paths);
	return withSection(rest, sectionLines({ ...state, kinds: { ...state.kinds, ...kinds } }, paths));
}

describe("the lines this device's exclusion is judged by", () => {
	test("none while nothing is left out", () => {
		expect(deviceExclusionLines(device(), paths)).toEqual([]);
		expect(isDeviceExclusionEmpty(device())).toBe(true);
	});

	test("the kinds, then the line that keeps them out of the configuration folder, then the folders", () => {
		expect(deviceExclusionLines(device({ kinds: ["image", "pdf"], folders: ["Attachments", "a[1]"] }), paths)).toEqual([
			"*.bmp",
			"*.png",
			"*.jpg",
			"*.jpeg",
			"*.gif",
			"*.svg",
			"*.webp",
			"*.avif",
			"*.pdf",
			"!/.obsidian/**",
			"/Attachments/",
			"/a\\[1\\]/",
		]);
	});

	test("the line for the configuration folder only with a kind, and not for folders alone", () => {
		expect(deviceExclusionLines(device({ folders: ["Attachments"] }), paths)).toEqual(["/Attachments/"]);
	});

	test("what they leave out: a kind outside the configuration folder, and a folder", () => {
		const exclusion = createExclusion({
			...paths,
			gitignore: null,
			device: { kinds: ["image", "other"], folders: ["日記"] },
		});
		expect(exclusion.matchesRule("photos/IMG_1.PNG", "file")).toBe(true);
		expect(exclusion.matchesRule("data.csv", "file")).toBe(true);
		expect(exclusion.matchesRule("日記/a.md".normalize("NFD"), "file")).toBe(true);
		// Notes, the root `.gitignore`, and the configuration folder stay.
		expect(exclusion.matchesRule("notes/a.md", "file")).toBe(false);
		expect(exclusion.matchesRule(".gitignore", "file")).toBe(false);
		expect(exclusion.matchesRule(".obsidian/icon.png", "file")).toBe(false);
		expect(exclusion.matchesRule("photos", "folder")).toBe(false);
		// None of it is a rule of the root `.gitignore`.
		expect(exclusion.matchesGitignore("photos/IMG_1.PNG", "file")).toBe(false);
	});
});

describe("the kinds an earlier version wrote into the section", () => {
	test("are copied the first time a section is read, and only the kinds", () => {
		const text = sectionWith({ image: false, video: false }, "/mine/\n");
		const copied = kindsFromSection(text, paths, device());
		expect(copied).toEqual({ kinds: ["image", "video"], folders: [], sectionChecked: true });
		// Once: the section is not looked at again, whatever it holds.
		expect(kindsFromSection(text, paths, copied ?? device())).toBeNull();
		expect(kindsFromSection(text, paths, device({ kinds: [], sectionChecked: true }))).toBeNull();
	});

	test('with "other" off, as it was written then', () => {
		const copied = kindsFromSection(sectionWith({ other: false, pdf: false }), paths, device());
		expect(copied?.kinds).toEqual(["pdf", "other"]);
	});

	test("a section without them counts as looked at: a kind removed from it later is not copied", () => {
		expect(kindsFromSection(withSection(null, defaultSectionLines(paths)), paths, device())).toEqual({
			kinds: [],
			folders: [],
			sectionChecked: true,
		});
	});

	test("are added to what this device leaves out already, in the order of the switches, keeping its folders", () => {
		const own = device({ kinds: ["pdf"], folders: ["Attachments"] });
		expect(kindsFromSection(sectionWith({ image: false, pdf: false }), paths, own)).toEqual({
			kinds: ["image", "pdf"],
			folders: ["Attachments"],
			sectionChecked: true,
		});
	});

	test("a section without them keeps what this device leaves out as it was", () => {
		const own = device({ kinds: ["video"], folders: ["Attachments"] });
		expect(kindsFromSection(withSection(null, defaultSectionLines(paths)), paths, own)).toEqual({
			...own,
			sectionChecked: true,
		});
	});

	test("nothing is decided without a section to read: no file, none in it, or a broken one", () => {
		expect(kindsFromSection(null, paths, device())).toBeNull();
		expect(kindsFromSection("*.png\n", paths, device())).toBeNull();
		const broken = `${sectionWith({ image: false })}# >>> Sync Evo: again\n`;
		expect(kindsFromSection(broken, paths, device())).toBeNull();
	});

	test("a byte order mark and line ends of Windows are read like anything else", () => {
		const text = `﻿${sectionWith({ audio: false }).replace(/\n/g, "\r\n")}`;
		expect(kindsFromSection(text, paths, device())?.kinds).toEqual(["audio"]);
	});

	test("the section can be written without them, and keeps everything else", () => {
		const found = findSection(sectionWith({ image: false, other: false }, "/mine/\n"));
		if (found.kind !== "found") throw new Error("expected a section");
		const written = sectionLines(withoutKinds(readSectionState(found.lines, paths)), paths);
		expect(written).toEqual(defaultSectionLines(paths));
	});
});

describe("changing what this device leaves out", () => {
	test("a kind switched off is added in the order of the switches, and switched on again is taken out", () => {
		const off = editedDeviceExclusion(device({ kinds: ["pdf"] }), { kind: "file-kind", item: "image", synced: false });
		expect(off.kinds).toEqual(["image", "pdf"]);
		expect(editedDeviceExclusion(off, { kind: "file-kind", item: "pdf", synced: true }).kinds).toEqual(["image"]);
	});

	test("a folder is added after the others, once, and removed alone", () => {
		const one = editedDeviceExclusion(device(), { kind: "add-folder", folder: "Attachments" });
		const two = editedDeviceExclusion(one, { kind: "add-folder", folder: "日記/写真" });
		expect(two.folders).toEqual(["Attachments", "日記/写真"]);
		expect(editedDeviceExclusion(two, { kind: "remove-folder", folder: "Attachments" }).folders).toEqual(["日記/写真"]);
	});

	test("what changes nothing answers the same object, and keeps the rest as it was", () => {
		const start = device({ kinds: ["video"], folders: ["a"], sectionChecked: true });
		expect(editedDeviceExclusion(start, { kind: "file-kind", item: "video", synced: false })).toBe(start);
		expect(editedDeviceExclusion(start, { kind: "file-kind", item: "image", synced: true })).toBe(start);
		expect(editedDeviceExclusion(start, { kind: "add-folder", folder: "a" })).toBe(start);
		expect(editedDeviceExclusion(start, { kind: "remove-folder", folder: "b" })).toBe(start);
		expect(editedDeviceExclusion(start, { kind: "add-folder", folder: "/a/" })).toBe(start);
		expect(editedDeviceExclusion(start, { kind: "add-folder", folder: "b" })).toMatchObject({ sectionChecked: true, kinds: ["video"] });
	});
});

describe("what this device leaves out, in a few words", () => {
	const en = translatorFor("en");
	const ja = translatorFor("ja");

	test("the kinds that are off, then how many folders, or that there is nothing", () => {
		expect(deviceExclusionSummary(ja, device({ kinds: ["image", "video"], folders: ["a", "b"] }))).toBe("画像、動画、フォルダ 2 件");
		expect(deviceExclusionSummary(ja, device())).toBe("なし");
		expect(deviceExclusionSummary(ja, device({ folders: ["a"] }))).toBe("フォルダ 1 件");
		expect(deviceExclusionSummary(en, device({ kinds: ["image", "video"], folders: ["a", "b"] }))).toBe("Images, Videos, 2 folders");
		expect(deviceExclusionSummary(en, device({ kinds: ["pdf", "other"], folders: ["a"] }))).toBe("PDFs, Other types, 1 folder");
		expect(deviceExclusionSummary(en, device())).toBe("None");
	});
});
