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

// What this device alone does not sync: kinds of file and folders, chosen in
// the settings and kept with the other settings of the device, not in the
// vault. It reaches no other device and no git on a computer. The lines it is
// judged by are built here in the form of `.gitignore`, and judged apart from
// the root `.gitignore` (`createExclusion`): a path that either matches is
// excluded, and a `!` of one cannot undo a line of the other.
//
// Changing it costs no sync state: what is switched off is not synced from
// the next sync on, and what is switched on again is compared as usual.

import type { ExclusionPaths } from "./exclusion";
import {
	type FileKind,
	findSection,
	folderLine,
	readSectionState,
	type SectionState,
	sectionLines,
} from "./gitignore-section";
import type { MessageKey, Translate } from "./i18n";
import { isPathFromRoot } from "./paths";

/** The kinds of file in the order the settings show them. */
export const FILE_KINDS: readonly FileKind[] = ["image", "audio", "video", "pdf", "other"];

export interface DeviceExclusion {
	/** The kinds of file this device does not sync, each once, in the order of `FILE_KINDS`. */
	readonly kinds: readonly FileKind[];
	/** The folders this device does not sync, from the vault root, as they are named. */
	readonly folders: readonly string[];
	/**
	 * Whether the lines of the kinds that an earlier version wrote into the
	 * section of the root `.gitignore` have been looked for, and copied here
	 * when there were any (`kindsFromSection`). Once, so that the kinds a user
	 * switched on again here do not come back from a section that still has
	 * their lines.
	 */
	readonly sectionChecked: boolean;
}

/** Nothing is left out, and the section has not been looked at yet. */
export const NO_DEVICE_EXCLUSION: DeviceExclusion = { kinds: [], folders: [], sectionChecked: false };

/** Whether this device leaves anything out of its own. */
export function isDeviceExclusionEmpty(device: Pick<DeviceExclusion, "kinds" | "folders">): boolean {
	return device.kinds.length === 0 && device.folders.length === 0;
}

/**
 * The lines this device's exclusion is judged by, in the form the section
 * of the root `.gitignore` had them in an earlier version: the kinds, the
 * line that keeps them out of the configuration folder (only with a line of
 * a kind before it), then the folders. A kind is about the notes and their
 * attachments, not about the settings of the app.
 */
export function deviceExclusionLines(device: Pick<DeviceExclusion, "kinds" | "folders">, paths: ExclusionPaths): string[] {
	if (isDeviceExclusionEmpty(device)) return [];
	const kinds = { image: true, audio: true, video: true, pdf: true, other: true };
	for (const kind of device.kinds) kinds[kind] = false;
	// The state of a section with nothing else in it: every part of the
	// configuration folder on, and no fixed exclusion.
	const state: SectionState = {
		kinds,
		folders: device.folders.filter(isFolderName),
		config: allConfigOn,
		fixed: [],
		unknown: [],
	};
	return sectionLines(state, paths);
}

const allConfigOn: SectionState["config"] = {
	"main-settings": true,
	appearance: true,
	"themes-and-snippets": true,
	hotkeys: true,
	"core-plugin-list": true,
	"core-plugin-settings": true,
	"community-plugin-list": true,
	"community-plugins": true,
};

/**
 * The exclusion of this device once the section of the root `.gitignore`
 * has been looked at, or `null` when nothing is to change: it was looked at
 * before, or there is no section to look at (no file, none in it, or a
 * broken one). Looked at once, the first time a section is read.
 *
 * The kinds the section leaves out, as an earlier version wrote them there,
 * are added to this device's, also when this device already leaves
 * something out of its own: the section keeps those lines until a switch of
 * a kind is changed here, and a kind they keep out must show on this
 * device's switches. Either way the section counts as looked at from then
 * on, also when it left no kind out.
 */
export function kindsFromSection(
	text: string | null,
	paths: ExclusionPaths,
	device: DeviceExclusion,
): DeviceExclusion | null {
	if (device.sectionChecked) return null;
	const found = findSection(text ?? "");
	if (found.kind !== "found") return null;
	const { kinds } = readSectionState(found.lines, paths);
	const off = FILE_KINDS.filter((kind) => !kinds[kind] || device.kinds.includes(kind));
	return { ...device, kinds: off, sectionChecked: true };
}

/**
 * The state of a section without the lines of the kinds, and so without the
 * line that kept them out of the configuration folder: the form a section is
 * written in now that the kinds are each device's own. A `*.webm` the user
 * wrote by hand is kept as it was.
 */
export function withoutKinds(state: SectionState): SectionState {
	return { ...state, kinds: { image: true, audio: true, video: true, pdf: true, other: true } };
}

/** One thing the settings screen changes in what this device leaves out. `synced` is what the switch was set to. */
export type DeviceExclusionEdit =
	| { readonly kind: "file-kind"; readonly item: FileKind; readonly synced: boolean }
	/** `folder` is one `folderToExclude` answered. */
	| { readonly kind: "add-folder"; readonly folder: string }
	| { readonly kind: "remove-folder"; readonly folder: string };

/**
 * What this device leaves out with one thing changed. The same object when
 * nothing changes: a folder that is there already, one to remove that is
 * not, a kind that is already as asked, or a folder no line can name.
 */
export function editedDeviceExclusion(device: DeviceExclusion, edit: DeviceExclusionEdit): DeviceExclusion {
	switch (edit.kind) {
		case "file-kind": {
			if (device.kinds.includes(edit.item) !== edit.synced) return device;
			const off = new Set(device.kinds);
			if (edit.synced) off.delete(edit.item);
			else off.add(edit.item);
			return { ...device, kinds: FILE_KINDS.filter((kind) => off.has(kind)) };
		}
		case "add-folder":
			if (device.folders.includes(edit.folder) || !isFolderName(edit.folder)) return device;
			return { ...device, folders: [...device.folders, edit.folder] };
		case "remove-folder":
			if (!device.folders.includes(edit.folder)) return device;
			return { ...device, folders: device.folders.filter((folder) => folder !== edit.folder) };
	}
}

/**
 * What this device leaves out, in a few words, for beside the name of its
 * group while that is closed: the kinds of file that are off, by their
 * short names, then how many folders, or that nothing is left out.
 */
export function deviceExclusionSummary(t: Translate, device: Pick<DeviceExclusion, "kinds" | "folders">): string {
	if (isDeviceExclusionEmpty(device)) return t("settings.deviceExclusion.summary.none");
	const parts = device.kinds.map((kind) => t(KIND_SHORT_NAMES[kind]));
	if (device.folders.length > 0) parts.push(t("settings.deviceExclusion.summary.folders", { count: device.folders.length }));
	return parts.join(t("list.separator"));
}

const KIND_SHORT_NAMES = {
	image: "settings.deviceExclusion.kind.image",
	audio: "settings.deviceExclusion.kind.audio",
	video: "settings.deviceExclusion.kind.video",
	pdf: "settings.deviceExclusion.kind.pdf",
	other: "settings.deviceExclusion.kind.other",
} as const satisfies Record<FileKind, MessageKey>;

/**
 * Reads what was stored. Anything that is not what this writes counts as
 * nothing left out: a kind that is not known, a folder that is no path from
 * the root, each once and in order.
 */
export function parseDeviceExclusion(raw: unknown): DeviceExclusion {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return NO_DEVICE_EXCLUSION;
	const { kinds, folders, sectionChecked } = raw as Record<string, unknown>;
	const listed = (value: unknown): unknown[] => (Array.isArray(value) ? (value as unknown[]) : []);
	const kindSet = new Set(listed(kinds));
	const folderList: string[] = [];
	for (const folder of listed(folders)) {
		if (typeof folder === "string" && isFolderName(folder) && !folderList.includes(folder)) folderList.push(folder);
	}
	return {
		kinds: FILE_KINDS.filter((kind) => kindSet.has(kind)),
		folders: folderList,
		sectionChecked: sectionChecked === true,
	};
}

/** Field by field, so that nothing else an object happens to carry is stored. */
export function serializeDeviceExclusion(device: DeviceExclusion): DeviceExclusion {
	return { kinds: [...device.kinds], folders: [...device.folders], sectionChecked: device.sectionChecked };
}

// A folder `folderLine` can write a line for.
function isFolderName(folder: string): boolean {
	if (!isPathFromRoot(folder)) return false;
	try {
		folderLine(folder);
		return true;
	} catch {
		return false;
	}
}
