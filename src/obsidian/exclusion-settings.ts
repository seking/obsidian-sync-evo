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

// The part of the settings screen about what is synced: the switches that
// write the section of the root `.gitignore`, the file itself, and the way
// in to untracking what the rules match. Nothing is decided here. What is
// shown is worked out in `core/exclusion-settings.ts` from the file as it
// is, and every change is made there, from the file as it is read again.
//
// Also the groups the whole screen is laid out in (`grouped`), and how
// some of them fold.

import {
	AbstractInputSuggest,
	type App,
	ButtonComponent,
	Notice,
	Setting,
	SettingGroup,
	setIcon,
	TextAreaComponent,
	type TextComponent,
} from "obsidian";
import {
	editorText,
	type ExclusionChanged,
	type ExclusionEdit,
	type ExclusionScreen,
	type ExclusionView,
	exclusionWriteText,
	folderToExclude,
	SHOWN_CONFIG_ITEMS,
	SHOWN_FILE_KINDS,
	textFromEditor,
	type UntrackList,
	unreadableGitignoreText,
} from "../core/exclusion-settings";
import type { ConfigItem, FileKind, SectionState } from "../core/gitignore-section";
import type { MessageKey, Translate } from "../core/i18n";
import { DEFAULT_SIZE_LIMIT } from "../core/plan";
import { megabytes, noticeTexts } from "../core/pull-report";
import { type UntrackConfirmRequest, untrackSubmodulesText } from "../core/untrack-report";
import { askUntrackIn } from "./untrack-confirm";

export type ExclusionLoad =
	/** No connection is set: there is no sync state, and nothing to show. */
	| { readonly status: "no-connection" }
	/** The sync state cannot be used, and the file is not written without it. */
	| { readonly status: "no-state" }
	/** `syncing`: a sync is running, so nothing can be changed, and what was read may be on its way out. */
	| { readonly status: "ok"; readonly screen: ExclusionScreen; readonly syncing: boolean };

/**
 * How a change ended. Beside what the core answers (how the write went, and
 * what it left to ask about untracking): a sync was running, the sync state
 * could not be used, or something failed, with what it said.
 */
export type ExclusionChange = ExclusionChanged | "syncing" | "no-state" | { readonly failed: string };

/** What this part of the screen needs from the plugin. None of it rejects. */
export interface ExclusionHost {
	readonly t: Translate;
	/** Reads the root `.gitignore` and what goes with it, as they are now. */
	exclusionScreen(): Promise<ExclusionLoad>;
	/** Changes one thing in the section, in the file as it is read again. */
	editExclusion(edit: ExclusionEdit): Promise<ExclusionChange>;
	/** Saves the whole file. `opened` is the text it was shown with, or `null` when there was no file. */
	saveGitignore(text: string, opened: string | null): Promise<ExclusionChange>;
	/**
	 * What the question before untracking is drawn from, for a list of this
	 * screen. `null` when the sync state cannot be used.
	 */
	untrackRequest(list: UntrackList): Promise<UntrackConfirmRequest | null>;
	/**
	 * Starts the sync that untracks the paths the user confirmed. Nothing is
	 * awaited in it before the screen is asked to stay on (`SyncRunner.run`).
	 * This part is drawn again when it has ended.
	 */
	untrack(shown: readonly string[]): void;
}

// The names of the switches are those of the same options of Obsidian Sync.
const KIND_NAMES = {
	image: "fileTypes.images",
	audio: "fileTypes.audio",
	video: "fileTypes.videos",
	pdf: "fileTypes.pdfs",
	other: "fileTypes.others",
} as const satisfies Record<FileKind, MessageKey>;

const CONFIG_NAMES = {
	"main-settings": "vaultConfig.main",
	appearance: "vaultConfig.appearance",
	"themes-and-snippets": "vaultConfig.themesAndSnippets",
	hotkeys: "vaultConfig.hotkeys",
	"core-plugin-list": "vaultConfig.corePluginList",
	"core-plugin-settings": "vaultConfig.corePluginSettings",
	"community-plugin-list": "vaultConfig.communityPluginList",
	"community-plugins": "vaultConfig.communityPlugins",
} as const satisfies Record<ConfigItem, MessageKey>;

// What the user has to know before switching these two on.
const CONFIG_WARNINGS = {
	"community-plugin-list": "settings.exclusion.communityPluginList.warning",
	"community-plugins": "settings.exclusion.communityPlugins.warning",
} as const satisfies Partial<Record<ConfigItem, MessageKey>>;

/** Offers the folders of the vault for the field a folder to leave out is typed into. */
class FolderSuggest extends AbstractInputSuggest<string> {
	private readonly listed: readonly string[];

	constructor(app: App, inputEl: HTMLInputElement, listed: readonly string[]) {
		super(app, inputEl);
		this.listed = listed;
	}

	// Only the folders the app has indexed: one whose name starts with a
	// dot is not among them, and is typed in full.
	protected getSuggestions(query: string): string[] {
		const wanted = query.trim().toLowerCase();
		return this.app.vault
			.getAllFolders(false)
			.map((folder) => folder.path)
			.filter((path) => path.toLowerCase().includes(wanted) && !this.listed.includes(path))
			.sort();
	}

	renderSuggestion(folder: string, el: HTMLElement): void {
		el.setText(folder);
	}
}

export class ExclusionSettings {
	private readonly app: App;
	private readonly el: HTMLElement;
	private readonly host: ExclusionHost;
	private readonly folds: Folds;
	/** Counts the times this part was asked to be drawn, so that an answer that comes late is not put on a newer one. */
	private drawn = 0;
	/**
	 * The one mark of a question about untracking: "preparing" while what it
	 * is drawn from is read, and then what closes the dialog, while that is
	 * open. `null` when there is none. No second question is begun while it
	 * is set: two taps on the button, or a switch flipped while the first
	 * is read, would put two dialogs up.
	 */
	private asking: "preparing" | { readonly close: () => void } | null = null;
	/** The button that asks about untracking, as it was last drawn, and whether a sync locked it then. */
	private untrackButton: { readonly button: ButtonComponent; readonly locked: boolean } | null = null;
	/** Counts the questions about untracking that were begun or given up, so that one given up while it is prepared is not put up. */
	private asked = 0;
	/** This part was let go of (`dispose`): no question is put up any more. */
	private disposed = false;

	constructor(app: App, el: HTMLElement, host: ExclusionHost, folds: Folds) {
		this.app = app;
		this.el = el;
		this.host = host;
		this.folds = folds;
	}

	/**
	 * This part is let go of: the screen is closed or drawn anew, or the
	 * plugin is unloaded. A question about untracking that is open is closed,
	 * which is a "no", and one that is being prepared is not put up.
	 */
	dispose(): void {
		this.disposed = true;
		if (this.asking !== null && this.asking !== "preparing") this.asking.close();
	}

	/**
	 * Gives up a question about untracking, while this part stays: one that
	 * is open is closed, which is a "no", and one that is being prepared is
	 * not put up. For a change of the connection (`main.ts`): the question
	 * lists the files of the remote that was left, and a yes would untrack
	 * them on the new one.
	 */
	closeQuestion(): void {
		if (this.asking === null) return;
		if (this.asking !== "preparing") {
			// Lowers the mark itself, through `closed`.
			this.asking.close();
			return;
		}
		this.asked += 1;
		this.asking = null;
		this.enableUntrackButton();
	}

	/**
	 * Reads the file and draws this part from it. What was drawn before
	 * stays until the answer is there, so that a switch does not make the
	 * screen jump.
	 */
	async draw(): Promise<void> {
		this.drawn += 1;
		const drawn = this.drawn;
		const load = await this.host.exclusionScreen();
		if (drawn !== this.drawn) return;
		this.el.empty();
		this.untrackButton = null;
		this.render(load);
	}

	private render(load: ExclusionLoad): void {
		const { el, host } = this;
		const t = host.t;
		// While there is no connection there is no sync state to ask, and
		// asking for one would make one.
		if (load.status === "no-connection") return;

		// What has to be heeded is said under this heading, outside every
		// group that folds.
		const synced = grouped(el, t("settings.exclusion.heading"), t("settings.exclusion.desc"));
		if (load.status === "no-state") {
			warning(synced.textEl, t("settings.exclusion.noState"));
			return;
		}
		const { view, untrack, notices, addSection } = load.screen;
		const locked = load.syncing;
		if (locked) warning(synced.textEl, t("settings.exclusion.syncRunning"));

		switch (view.kind) {
			case "unreadable":
				warning(synced.textEl, unreadableGitignoreText(t, view.reason, DEFAULT_SIZE_LIMIT));
				break;
			case "unsettled":
				warning(synced.textEl, t("settings.exclusion.unsettled"));
				break;
			case "broken":
				warning(synced.textEl, t("settings.exclusion.broken"));
				this.showFixedOff(synced.listEl, view, locked);
				this.showEditor(view, locked);
				break;
			case "none": {
				const add = new Setting(synced.listEl)
					.setName(t("settings.exclusion.noSection.name"))
					.setDesc(t("settings.exclusion.noSection.desc"));
				if (addSection === "sync-first") {
					note(add).setText(t("settings.exclusion.noSection.syncFirst"));
				} else if (addSection === "offer") {
					add.addButton((button) => {
						button
							.setButtonText(t("settings.exclusion.noSection.button"))
							.setDisabled(locked)
							.onClick(() => void this.change(host.editExclusion({ kind: "add-section" })));
					});
				} else {
					const limit = megabytes(DEFAULT_SIZE_LIMIT);
					note(add).setText(t("settings.exclusion.noSection.overLimit", { limit }));
				}
				this.showFixedOff(synced.listEl, view, locked);
				this.showEditor(view, locked);
				break;
			}
			case "section": {
				if (view.handEdited) warning(synced.textEl, t("settings.exclusion.handEdited"));
				this.showFileKinds(synced, view.state, locked);
				// Cards of their own, with no heading: what is said above
				// the switches for the kinds of file is about those alone.
				const rest = grouped(el, null, null).listEl;
				// Still what is synced: closer to the cards above than a
				// group of its own would be (`styles.css`).
				rest.parentElement?.addClass("sync-evo-group-continued");
				this.showFolders(rest, view.state, locked);
				// As of the last listing of the remote. Without one there is
				// nothing to count. The count is of every rule, and right
				// below the folders is where it is looked for after one was
				// added.
				if (untrack !== null) this.showUntrack(rest, untrack, locked);
				this.showFixedOff(rest, view, locked);
				this.showConfig(view.state, locked);
				this.showEditor(view, locked);
				break;
			}
		}

		// A fixed exclusion that is off is not among these: it is listed
		// above, from the file as it is now. Never folded: each of these
		// is something to act on.
		if (notices.length === 0) return;
		const found = grouped(el, t("settings.exclusion.notices.name"), t("settings.exclusion.notices.desc")).textEl;
		for (const text of noticeTexts(t, notices, DEFAULT_SIZE_LIMIT)) {
			// A text that lists paths has one on each line after the first.
			const [head = "", ...items] = text.split("\n");
			found.createEl("p", { text: head });
			if (items.length === 0) continue;
			const list = found.createEl("ul");
			for (const item of items) list.createEl("li", { text: item });
		}
	}

	/**
	 * How many files of the remote a rule matches, with the button that asks
	 * about untracking them, and the line for the submodules a rule matches.
	 * A setting of its own and not a line of the heading: the button needs
	 * one. Nothing when there is neither.
	 */
	private showUntrack(el: HTMLElement, list: UntrackList, locked: boolean): void {
		const t = this.host.t;
		const { files, submodules } = list;
		if (files.length === 0 && submodules.length === 0) return;
		const setting = new Setting(el).setName(t("settings.exclusion.untrack.name"));
		if (files.length > 0) {
			setting.descEl.createDiv({ text: t("settings.exclusion.tracked", { count: files.length }) });
			setting.descEl.createDiv({ text: t("settings.exclusion.untrack.desc") });
			setting.addButton((button) => {
				button.setButtonText(t("untrack.confirm.proceed")).onClick(() => void this.askUntrack(list));
				this.untrackButton = { button, locked };
				this.enableUntrackButton();
			});
		}
		if (submodules.length > 0) setting.descEl.createDiv({ text: untrackSubmodulesText(t, submodules) });
	}

	/**
	 * The button that asks about untracking is off while a sync runs, and
	 * while a question is being prepared: the vault is looked at for it,
	 * which takes a moment, and a second tap would do nothing.
	 */
	private enableUntrackButton(): void {
		if (this.untrackButton === null) return;
		const { button, locked } = this.untrackButton;
		button.setDisabled(locked || this.asking === "preparing");
	}

	/**
	 * Asks about untracking the files of a list, and starts it on a yes. The
	 * question is drawn from the vault and the records as they are now.
	 * Nothing when a question is being prepared or is open already.
	 */
	private async askUntrack(list: UntrackList): Promise<void> {
		const { host } = this;
		const t = host.t;
		if (this.asking !== null || this.disposed) return;
		this.asked += 1;
		const asked = this.asked;
		this.asking = "preparing";
		this.enableUntrackButton();
		const request = await host.untrackRequest(list);
		// Given up meanwhile (`closeQuestion`): the mark was lowered there,
		// and may be that of a newer question by now.
		if (asked !== this.asked) return;
		// Lowered on every way out of here that puts no dialog up.
		this.asking = null;
		this.enableUntrackButton();
		if (request === null) {
			if (!this.disposed) new Notice(t("settings.exclusion.write.noState"), 0);
			return;
		}
		// The settings were closed while the vault was looked at: a question
		// about a screen that is gone is not put up.
		if (this.disposed || !this.el.isConnected) return;
		const close = askUntrackIn(
			this.app,
			t,
			request,
			(shown) => {
				// From the handler of the button, with nothing awaited before.
				host.untrack(shown);
				// A sync runs from here on: the switches are shown as locked.
				void this.draw();
			},
			// Answered either way, or closed: the next question may be asked.
			() => {
				this.asking = null;
			},
		);
		this.asking = { close };
	}

	/**
	 * The switches for the kinds of file, as the settings of a group, under a
	 * heading of their own in what the group says above them: as a setting,
	 * that heading would be a card with nothing to switch.
	 */
	private showFileKinds(group: Group, state: SectionState, locked: boolean): void {
		const host = this.host;
		const t = host.t;
		group.textEl.createDiv({ cls: "sync-evo-subheading", text: t("settings.exclusion.fileKinds.name") });
		described(group.textEl, t("settings.exclusion.fileKinds.desc"));
		for (const item of SHOWN_FILE_KINDS) {
			new Setting(group.listEl).setName(t(KIND_NAMES[item])).addToggle((toggle) => {
				toggle
					.setValue(state.kinds[item])
					.setDisabled(locked)
					.onChange((synced) => void this.change(host.editExclusion({ kind: "file-kind", item, synced })));
			});
		}
	}

	/** The field a folder to leave out is added with, and the folders that are left out. */
	private showFolders(el: HTMLElement, state: SectionState, locked: boolean): void {
		const host = this.host;
		const t = host.t;
		const folders = new Setting(el)
			.setName(t("settings.exclusion.folders.name"))
			.setDesc(t("settings.exclusion.folders.desc"));
		const foldersNote = note(folders);
		let field: TextComponent | null = null;
		folders.addText((text) => {
			text.setPlaceholder(t("settings.exclusion.folders.placeholder")).setDisabled(locked);
			// Takes the folder that is picked into the field. It is added by
			// the button, like one that was typed.
			const suggest = new FolderSuggest(this.app, text.inputEl, state.folders);
			suggest.onSelect((folder) => {
				suggest.setValue(folder);
				suggest.close();
			});
			field = text;
		});
		folders.addButton((button) => {
			button
				.setButtonText(t("settings.exclusion.folders.add"))
				.setDisabled(locked)
				.onClick(() => {
					const folder = folderToExclude(field?.getValue() ?? "");
					if (folder === null) {
						foldersNote.setText(t("settings.exclusion.folders.invalid"));
						return;
					}
					void this.change(host.editExclusion({ kind: "add-folder", folder }));
				});
		});
		for (const folder of state.folders) {
			new Setting(el).setName(folder).addButton((button) => {
				button
					.setButtonText(t("settings.exclusion.folders.remove"))
					.setDisabled(locked)
					.onClick(() => void this.change(host.editExclusion({ kind: "remove-folder", folder })));
			});
		}
	}

	/**
	 * The switches for the parts of the configuration folder: folded, with
	 * how many of them are on beside the heading, to be read while it is.
	 */
	private showConfig(state: SectionState, locked: boolean): void {
		const host = this.host;
		const t = host.t;
		const count = SHOWN_CONFIG_ITEMS.filter((item) => state.config[item]).length;
		const summary = t("settings.exclusion.config.summary", { count, total: SHOWN_CONFIG_ITEMS.length });
		const el = grouped(this.el, t("settings.exclusion.config.name"), t("settings.exclusion.config.desc"), {
			folds: this.folds,
			id: "config",
			summary,
		}).listEl;
		for (const item of SHOWN_CONFIG_ITEMS) {
			const setting = new Setting(el).setName(t(CONFIG_NAMES[item]));
			if (item === "community-plugin-list" || item === "community-plugins") {
				note(setting).setText(t(CONFIG_WARNINGS[item]));
			}
			setting.addToggle((toggle) => {
				toggle
					.setValue(state.config[item])
					.setDisabled(locked)
					.onChange((synced) => void this.change(host.editExclusion({ kind: "config-item", item, synced })));
			});
		}
	}

	/**
	 * The fixed exclusions that are not in effect, when there are any, with
	 * the button that puts back the lines a section lacks. Without a section
	 * there is no such button: adding the section adds every line.
	 */
	private showFixedOff(el: HTMLElement, view: FileView, locked: boolean): void {
		const host = this.host;
		const t = host.t;
		if (view.fixedOff.length === 0) return;
		const setting = new Setting(el).setName(t("settings.exclusion.fixedOff.name"));
		note(setting).setText(t("settings.exclusion.fixedOff.desc"));
		const list = setting.descEl.createEl("ul");
		for (const line of view.fixedOff) list.createEl("li", { text: line });
		if (view.kind === "broken") return;
		if (view.kind === "none") {
			setting.descEl.createDiv({ text: t("settings.exclusion.fixedOff.undoneNoSection") });
			return;
		}
		if (!view.restorable) {
			setting.descEl.createDiv({ text: t("settings.exclusion.fixedOff.undone") });
			return;
		}
		setting.descEl.createDiv({ text: t("settings.exclusion.fixedOff.restoreNote") });
		setting.addButton((button) => {
			button
				.setButtonText(t("settings.exclusion.fixedOff.restore"))
				.setDisabled(locked)
				.onClick(() => void this.change(host.editExclusion({ kind: "restore-fixed" })));
		});
	}

	/**
	 * The whole file, to edit: folded, since few write rules by hand, but
	 * drawn open while something is to be put right in it, which the
	 * warnings above then send the user here for. Saved by the button and
	 * not while typing: a rule half typed is another rule. `view.text` is
	 * the file as it was read, which the save is checked against, or `null`
	 * when there is none.
	 */
	private showEditor(view: FileView, locked: boolean): void {
		const host = this.host;
		const t = host.t;
		const opened = view.text;
		const el = grouped(this.el, t("settings.exclusion.editor.name"), t("settings.exclusion.editor.desc"), {
			folds: this.folds,
			id: "gitignore",
			forced: view.kind !== "section" || view.fixedOff.length > 0,
		}).textEl;
		if (opened === null) described(el, t("settings.exclusion.editor.absent"));
		// Not a setting with the field beside its description: beside it, a
		// phone leaves the field a few characters of width.
		const area = new TextAreaComponent(el.createDiv()).setValue(editorText(opened)).setDisabled(locked);
		area.inputEl.rows = 12;
		// As wide as the screen (`styles.css`): by its columns alone it
		// stopped short of the edge on a phone.
		area.inputEl.addClass("sync-evo-gitignore-editor");
		// A phone would capitalize a rule and turn `--` and quotes into
		// other characters.
		area.inputEl.spellcheck = false;
		area.inputEl.setAttr("autocapitalize", "off");
		area.inputEl.setAttr("autocorrect", "off");
		new ButtonComponent(el.createDiv("sync-evo-gitignore-save"))
			.setButtonText(t("settings.exclusion.editor.save"))
			.setCta()
			.setDisabled(locked)
			.onClick(() => {
				const text = textFromEditor(area.getValue(), opened);
				void this.change(host.saveGitignore(text, opened), t("settings.exclusion.editor.saved"));
			});
	}

	/**
	 * Waits for a change, tells how it went where there is something to
	 * tell, and draws this part again from the file as it is now, whichever
	 * way it went: a switch that wrote nothing must not stay flipped.
	 *
	 * A change that made a rule match files the remote holds is followed by
	 * the question about untracking those files, and no others. The rule is
	 * written by then, and stays whatever the answer. Where it matches only
	 * submodules, which are not untracked here, that is told and not asked.
	 */
	private async change(change: Promise<ExclusionChange>, written?: string): Promise<void> {
		const t = this.host.t;
		const result = await change;
		let matched: UntrackList | null = null;
		if (result === "syncing") new Notice(t("settings.exclusion.write.syncing"));
		else if (result === "no-state") new Notice(t("settings.exclusion.write.noState"), 0);
		else if ("failed" in result) new Notice(t("settings.exclusion.write.failed", { detail: result.failed }), 0);
		else {
			const problem = exclusionWriteText(t, result.write, DEFAULT_SIZE_LIMIT);
			// Until it is dismissed: nothing was written, and why is not short.
			if (problem !== null) new Notice(problem, 0);
			else if (result.write === "written" && written !== undefined) new Notice(written);
			matched = result.matched;
		}
		await this.draw();
		if (matched === null) return;
		if (matched.files.length > 0) await this.askUntrack(matched);
		else if (matched.submodules.length > 0) new Notice(untrackSubmodulesText(t, matched.submodules, true), 0);
	}
}

function warning(el: HTMLElement, text: string): void {
	el.createEl("p", { text, cls: "mod-warning" });
}

/** The views that show the file: the ones that list the fixed exclusions that are not in effect. */
type FileView = Extract<ExclusionView, { fixedOff: readonly string[] }>;

/** The groups of the screen that fold. */
export type FoldId = "config" | "gitignore" | "symlinks";

/**
 * The groups the user has opened; every one starts closed. Kept by the
 * settings tab, and so until the plugin is loaded anew, and saved nowhere:
 * closing the settings, or drawing a part again, does not close a group.
 */
export type Folds = Set<FoldId>;

/** How a group folds. */
export interface Fold {
	readonly folds: Folds;
	readonly id: FoldId;
	/**
	 * Drawn open and without the means to close it: something in it has to
	 * be put right. What the user chose is back once it is not.
	 */
	readonly forced?: boolean;
	/** Said beside the name, to be read while the group is closed. */
	readonly summary?: string;
}

/** A group of the screen, as it is filled in. */
export interface Group {
	/** What the group says under its heading: outside the cards a phone draws the settings as. */
	readonly textEl: HTMLElement;
	/** Where the settings of the group go. Not shown while it holds none. */
	readonly listEl: HTMLElement;
}

/**
 * A group of the screen, drawn by the app's own `SettingGroup`: a heading
 * (none when `name` is `null`), what it says about the group, and the
 * settings. The heading of the app is a name alone, so the description is a
 * text of its own between the heading and the settings: as the first setting
 * it would be a card with nothing to switch.
 *
 * The app has no group that folds, so that is made here, with `fold`: the
 * heading is then what opens and closes the group, by a click or, with the
 * keyboard on it, by Enter or the space bar, and says which of the two it is
 * (`aria-expanded`). Closed, only the heading is left.
 */
export function grouped(el: HTMLElement, name: string | null, desc: string | null, fold?: Fold): Group {
	const group = new SettingGroup(el).addClass("sync-evo-group");
	const listEl = group.listEl;
	const textEl = createDiv("sync-evo-group-text");
	listEl.before(textEl);
	if (desc !== null) described(textEl, desc);
	if (fold === undefined || fold.forced === true) {
		if (name !== null) group.setHeading(name);
		return { textEl, listEl };
	}

	const heading = createFragment();
	const toggle = heading.createDiv({ cls: "sync-evo-fold", attr: { role: "button", tabindex: "0" } });
	const icon = toggle.createSpan("sync-evo-fold-icon");
	toggle.createSpan({ text: name ?? "" });
	if (fold.summary !== undefined) toggle.createSpan({ cls: "sync-evo-fold-summary", text: fold.summary });
	group.setHeading(heading);

	let open = fold.folds.has(fold.id);
	const show = (): void => {
		toggle.setAttr("aria-expanded", String(open));
		setIcon(icon, open ? "chevron-down" : "chevron-right");
		// Hidden by `styles.css`.
		textEl.toggleClass("sync-evo-folded", !open);
		listEl.toggleClass("sync-evo-folded", !open);
	};
	const flip = (): void => {
		open = !open;
		if (open) fold.folds.add(fold.id);
		else fold.folds.delete(fold.id);
		show();
	};
	toggle.addEventListener("click", flip);
	toggle.addEventListener("keydown", (event) => {
		if (event.key !== "Enter" && event.key !== " ") return;
		// The space bar would scroll the screen as well.
		event.preventDefault();
		flip();
	});
	show();
	return { textEl, listEl };
}

/** A line of what a group says about itself, in the look of the description of a setting. */
function described(el: HTMLElement, text: string): void {
	el.createDiv({ cls: "setting-item-description", text });
}

/** A line under the description of a setting, for what the user has to heed. */
function note(setting: Setting): HTMLElement {
	return setting.descEl.createDiv({ cls: "mod-warning" });
}
