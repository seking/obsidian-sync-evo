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

// The calls of the app a pull reaches the vault through, one for one. Which
// of them a path goes through is decided in `core/vault-access.ts`; nothing
// is decided here.

import {
	type App,
	type DataAdapter,
	FileSystemAdapter,
	Platform,
	type TAbstractFile,
	TFile,
	TFolder,
	type Vault,
	type View,
} from "obsidian";
import type { PullVault } from "../core/pull-io";
import { type OpenEditor, RoutedVault, type VaultPorts } from "../core/vault-access";
import type { PhoneListing } from "./folder-stats";
import { type LinkFs, linkPorts } from "./vault-links";

/**
 * The app's setting for deleted files, unchecked. `getConfig` is not part of
 * the public API, so it may be missing or throw; what the answer is worth
 * is decided by whoever asked.
 */
function readTrashOption(vault: Vault): unknown {
	try {
		const getConfig = (vault as { getConfig?: unknown }).getConfig;
		return typeof getConfig === "function" ? (getConfig.call(vault, "trashOption") as unknown) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The file a view shows and the call that makes it write what was typed, or
 * `null` for a view that has neither. Views of text files have a public
 * `save`; a view of a plugin may have one without being such a view, so it
 * is looked for on the object itself.
 */
function editorOf(view: View): OpenEditor | null {
	const { file, save } = view as { file?: unknown; save?: unknown };
	if (!(file instanceof TFile) || typeof save !== "function") return null;
	return {
		path: file.path,
		save: async () => {
			await (save.call(view) as unknown);
		},
	};
}

/**
 * How to tell the links of the vault, on a desktop (`linkPorts`). Nothing
 * elsewhere: the mobile app has no Node, and its user has no means to make
 * a link. The app itself does not tell them: it lists a link to a folder as
 * a folder.
 */
function linkPortsOf(adapter: DataAdapter): Pick<VaultPorts<TAbstractFile>, "linksIn" | "isLink" | "listOnDisk"> {
	if (!Platform.isDesktopApp || !(adapter instanceof FileSystemAdapter)) return {};
	const load = (window as { require?: (id: string) => unknown }).require;
	if (load === undefined) return {};
	return linkPorts(load("fs") as LinkFs, adapter.getBasePath());
}

// A handle of the wrong type is a mistake of the caller, not a state of the vault.
function fileOf(item: TAbstractFile): TFile {
	if (item instanceof TFile) return item;
	throw new Error(`not a file: ${item.path}`);
}

export function vaultPortsOf(app: App, phone?: PhoneListing): VaultPorts<TAbstractFile> {
	const { vault, fileManager, workspace } = app;
	const adapter = vault.adapter;
	return {
		configDir: vault.configDir,

		// On a phone, from the read that also tells the times (`folder-stats.ts`), where it can be.
		list: async (folder) => (await phone?.list(folder)) ?? adapter.list(folder),
		stat: async (path) => {
			const stat = await adapter.stat(path);
			return stat === null ? null : { type: stat.type, mtime: stat.mtime, size: stat.size };
		},
		readBinary: (path) => adapter.readBinary(path),
		writeBinary: (path, data) => adapter.writeBinary(path, data),
		mkdir: (path) => adapter.mkdir(path),
		rmdir: (path) => adapter.rmdir(path, false),
		renameOnDisk: (from, to) => adapter.rename(from, to),
		trashSystem: (path) => adapter.trashSystem(path),
		trashLocal: (path) => adapter.trashLocal(path),
		remove: (path) => adapter.remove(path),

		indexed: (path) => {
			const item = vault.getAbstractFileByPath(path);
			if (item instanceof TFile) return { type: "file", path: item.path, handle: item };
			if (item instanceof TFolder) return { type: "folder", path: item.path, handle: item };
			return null;
		},
		create: async (path, data) => {
			await vault.createBinary(path, data);
		},
		modify: (file, data) => vault.modifyBinary(fileOf(file), data),
		createFolder: async (path) => {
			await vault.createFolder(path);
		},
		// Never `fileManager.renameFile`, which rewrites the links in other
		// notes: a change the remote does not have.
		renameIndexed: (item, to) => vault.rename(item, to),
		trashBySetting: (item) => fileManager.trashFile(item),
		trashToVault: (item) => vault.trash(item, false),

		trashOption: () => readTrashOption(vault),
		openEditors: () => {
			const editors: OpenEditor[] = [];
			workspace.iterateAllLeaves((leaf) => {
				const editor = editorOf(leaf.view);
				if (editor !== null) editors.push(editor);
			});
			return editors;
		},
		...linkPortsOf(adapter),
	};
}

/** The vault of the app for a pull; with `phone`, folders are listed through it. */
export function pullVaultOf(app: App, phone?: PhoneListing): PullVault {
	return new RoutedVault(vaultPortsOf(app, phone));
}
