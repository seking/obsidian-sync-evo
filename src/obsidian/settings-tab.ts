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

import { type App, Notice, type Plugin, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import { type CheckOutcome, connectionCheckText, isSuccess } from "../core/connection-check";
import type { Translate } from "../core/i18n";
import type { SymlinkTarget } from "../core/pull";
import type { PushFailure } from "../core/push-failure";
import { pushFailureReminderText } from "../core/push-report";
import { branchToStore, type DeviceSettings, deviceNameProblem, repositoryToStore } from "../core/settings";

/** What the screen needs from the plugin. */
export interface SettingsHost {
	readonly t: Translate;
	/** `null` when what is stored was written by a newer version; it is then neither shown nor written. */
	readonly deviceSettings: DeviceSettings | null;
	updateSettings(next: DeviceSettings): void;
	/** Discards what is stored and starts from the defaults. */
	resetSettings(): void;
	testConnection(settings: DeviceSettings): Promise<CheckOutcome>;
	/** The symlinks of the remote that are skipped, with where they point. Never rejects. */
	skippedSymlinks(): Promise<readonly SymlinkTarget[]>;
	/** The push that did not get to its end, if no sync has sent since. Never rejects. */
	pushFailure(): Promise<PushFailure | null>;
}

/**
 * The settings screen. It is drawn with `display()`, which the app has marked
 * as deprecated since 1.13 in favour of declared settings: those do not exist
 * in 1.11.4, the oldest version the plugin runs on.
 */
export class SyncEvoSettingTab extends PluginSettingTab {
	private readonly host: SettingsHost;
	/** Takes over what is typed in the fields that are not saved while typing. */
	private commits: (() => void)[] = [];
	/** Counts the times the screen was drawn, so that an answer that comes late is not put on a newer one. */
	private drawn = 0;

	constructor(app: App, plugin: Plugin, host: SettingsHost) {
		super(app, plugin);
		this.host = host;
	}

	override display(): void {
		const { containerEl, host } = this;
		const t = host.t;
		containerEl.empty();
		this.commits = [];
		this.drawn += 1;

		const stored = host.deviceSettings;
		if (stored === null) {
			containerEl.createEl("p", { text: t("settings.unknownVersion") });
			// The way out for someone who went back to this version and does
			// not want to update. A phone has no other means to clear a stored value.
			new Setting(containerEl)
				.setName(t("settings.reset.name"))
				.setDesc(t("settings.reset.desc"))
				.addButton((button) => {
					button
						.setButtonText(t("settings.reset.button"))
						.setWarning()
						.onClick(() => {
							host.resetSettings();
							this.display();
						});
				});
			return;
		}

		// Above everything else: it is what the user has to act on.
		void this.showPushFailure(containerEl.createDiv(), this.drawn);

		// The repository and the branch are taken over when the field is left
		// or Enter is pressed (the DOM `change` event), not on each key. Every
		// change of them that is saved discards the sync state, and a name
		// half typed is a different repository.
		const repository = new Setting(containerEl)
			.setName(t("settings.repository.name"))
			.setDesc(t("settings.repository.desc"));
		const repositoryNote = note(repository);
		// Whether the field holds text that was not taken over. The settings
		// then still name the repository from before, which is not the one on
		// the screen.
		let repositoryRejected = false;
		repository.addText((text) => {
			text.setPlaceholder(t("settings.repository.placeholder")).setValue(stored.repository);
			const commit = (): void => {
				const value = repositoryToStore(text.getValue());
				if (value === null) {
					// Nothing is saved, so the repository that was there stays
					// in use. The text stays in the field to be corrected.
					repositoryNote.setText(t("settings.repository.invalid"));
					repositoryRejected = true;
					return;
				}
				text.setValue(value);
				repositoryNote.setText("");
				repositoryRejected = false;
				this.change((current) => (current.repository === value ? current : { ...current, repository: value }));
			};
			text.inputEl.addEventListener("change", commit);
			this.commits.push(commit);
		});

		const branch = new Setting(containerEl).setName(t("settings.branch.name")).setDesc(t("settings.branch.desc"));
		const branchNote = note(branch);
		let branchRejected = false;
		branch.addText((text) => {
			text.setPlaceholder(t("settings.branch.placeholder")).setValue(stored.branch);
			const commit = (): void => {
				const value = branchToStore(text.getValue());
				if (value === null) {
					// As with the repository: the branch from before stays in use.
					branchNote.setText(t("settings.branch.empty"));
					branchRejected = true;
					return;
				}
				text.setValue(value);
				branchNote.setText("");
				branchRejected = false;
				this.change((current) => (current.branch === value ? current : { ...current, branch: value }));
			};
			text.inputEl.addEventListener("change", commit);
			this.commits.push(commit);
		});

		// The app's own control: it lists the secrets saved on the device and
		// lets the user add one. Only the chosen name comes back.
		new Setting(containerEl)
			.setName(t("settings.token.name"))
			.setDesc(t("settings.token.desc"))
			.addComponent((el) =>
				new SecretComponent(this.app, el).setValue(stored.tokenSecret).onChange((name) => {
					this.change((current) => ({ ...current, tokenSecret: name }));
				}),
			);

		const deviceName = new Setting(containerEl)
			.setName(t("settings.deviceName.name"))
			.setDesc(t("settings.deviceName.desc"));
		const deviceNameNote = note(deviceName);
		deviceName.addText((text) => {
			text.setValue(stored.deviceName).onChange((typed) => {
				const problem = deviceNameProblem(typed);
				if (problem === null) {
					deviceNameNote.setText("");
					this.change((current) => ({ ...current, deviceName: typed.trim() }));
					return;
				}
				// Nothing is saved, so the last name that was fine stays in use.
				const key = problem === "empty" ? "settings.deviceName.empty" : "settings.deviceName.invalidCharacter";
				deviceNameNote.setText(t(key));
			});
		});

		const test = new Setting(containerEl).setName(t("settings.test.name")).setDesc(t("settings.test.desc"));
		const result = test.descEl.createDiv();
		test.addButton((button) => {
			button.setButtonText(t("settings.test.button")).onClick(async () => {
				// The click has already taken the focus from a field, but the
				// button can also be reached with the keyboard.
				this.commit();
				const settings = host.deviceSettings;
				if (settings === null) return;
				result.removeClass("mod-warning", "mod-success");
				if (repositoryRejected || branchRejected) {
					// A test of the connection from before would read as a
					// verdict on what is in the fields.
					result.addClass("mod-warning");
					result.setText(repositoryRejected ? t("check.noRepository") : t("check.noBranch"));
					return;
				}
				button.setDisabled(true);
				result.setText(t("settings.test.running"));
				try {
					const outcome = await host.testConnection(settings);
					const text = connectionCheckText(t, settings, outcome);
					result.addClass(isSuccess(outcome) ? "mod-success" : "mod-warning");
					result.setText(text);
					new Notice(text);
				} finally {
					button.setDisabled(false);
				}
			});
		});

		void this.showSymlinks(containerEl.createDiv(), this.drawn);
	}

	/**
	 * The list of the symlinks that are skipped, when there are any. It is
	 * read from the sync state, which answers later than the screen is
	 * drawn, so it is filled in below everything else.
	 */
	private async showSymlinks(el: HTMLElement, drawn: number): Promise<void> {
		const t = this.host.t;
		const links = await this.host.skippedSymlinks();
		if (links.length === 0 || drawn !== this.drawn) return;
		new Setting(el).setName(t("settings.symlinks.name")).setDesc(t("settings.symlinks.desc")).setHeading();
		const list = el.createEl("ul");
		for (const link of links) {
			list.createEl("li", { text: t("settings.symlinks.item", { path: link.path, target: link.target }) });
		}
	}

	/** A push that did not get to its end, when there is one. Read from the sync state, like the symlinks. */
	private async showPushFailure(el: HTMLElement, drawn: number): Promise<void> {
		const failure = await this.host.pushFailure();
		if (failure === null || drawn !== this.drawn) return;
		el.createEl("p", { text: pushFailureReminderText(this.host.t, failure), cls: "mod-warning" });
	}

	override hide(): void {
		// Closing the settings with a field still in focus does not fire `change`.
		this.commit();
		this.commits = [];
		super.hide();
	}

	private commit(): void {
		for (const commit of this.commits) commit();
	}

	/** Saves a change made to the settings as they are now, not as they were when the screen was drawn. */
	private change(edit: (current: DeviceSettings) => DeviceSettings): void {
		const current = this.host.deviceSettings;
		if (current === null) return;
		const next = edit(current);
		if (next !== current) this.host.updateSettings(next);
	}
}

/** A line under the description of a setting, for what is wrong with the value. */
function note(setting: Setting): HTMLElement {
	return setting.descEl.createDiv({ cls: "mod-warning" });
}
