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

import { type App, Notice, Platform, type Plugin, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import { type CheckOutcome, connectionCheckText, isSuccess } from "../core/connection-check";
import { newSignIn, type SignIn } from "../core/dropbox/auth";
import type { DeviceCode } from "../core/gdrive/auth";
import type { Translate } from "../core/i18n";
import { PURCHASE_URL, README_URL } from "../core/license";
import { type PaidInfo, paidStatusLines } from "../core/paid";
import type { SymlinkTarget } from "../core/pull";
import type { PushFailure } from "../core/push-failure";
import { pushFailureReminderText } from "../core/push-report";
import {
	type AutoSyncSettings,
	branchToStore,
	conflictHandlingOf,
	dropboxFolderToStore,
	type DeviceSettings,
	deviceNameProblem,
	intervalToStore,
	MAX_INTERVAL_MINUTES,
	MIN_SENDING_INTERVAL_MINUTES,
	minIntervalMinutes,
	repositoryToStore,
	withBackend,
	withSendsChanges,
} from "../core/settings";
import { type ExclusionHost, ExclusionSettings, type Folds, grouped } from "./exclusion-settings";

/** What the screen needs from the plugin. */
export interface SettingsHost extends ExclusionHost {
	readonly t: Translate;
	/** `null` when what is stored was written by a newer version; it is then neither shown nor written. */
	readonly deviceSettings: DeviceSettings | null;
	updateSettings(next: DeviceSettings): void;
	/** Discards what is stored and starts from the defaults. */
	resetSettings(): void;
	testConnection(settings: DeviceSettings): Promise<CheckOutcome>;
	/** The account this device is connected to Dropbox with, or `null` while it is not. */
	dropboxConnection(): { readonly email: string } | null;
	/** Opens Dropbox in the browser. Called in the handler of the press, with nothing awaited before. */
	startDropboxSignIn(sign: SignIn): void;
	/** Never rejects. */
	disconnectDropbox(): Promise<void>;
	/** The account this device is connected to Google Drive with, or `null` while it is not. */
	gdriveConnection(): { readonly email: string } | null;
	/** A code of Google ahead of the press of "Connect", the same one while it lasts. */
	prepareGdriveCode(): Promise<DeviceCode>;
	/** Shows the code and opens the browser. Called in the handler of the press, with nothing awaited before. */
	connectGdrive(prefetched: DeviceCode | null): void;
	/** Never rejects. */
	disconnectGdrive(): Promise<void>;
	/** The symlinks of the remote that are skipped, with where they point. Never rejects. */
	skippedSymlinks(): Promise<readonly SymlinkTarget[]>;
	/** The push that did not get to its end, if no sync has sent since. Never rejects. */
	pushFailure(): Promise<PushFailure | null>;
	/** What to show of the paid plan of Dropbox and Google Drive, or `null` for nothing (T082). */
	paidInfo(settings: DeviceSettings): PaidInfo | null;
	/** Takes the license key typed: "" removes it. Never rejects. */
	setLicenseKey(typed: string): Promise<void>;
	/** The secret of the Google client of the user's own, or "". */
	gdriveClientSecret(): string;
	/** Takes the id of the Google client of the user's own; answers whether the client changed. Never rejects. */
	setGdriveClientId(typed: string): Promise<boolean>;
	setGdriveClientSecret(typed: string): void;
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
	/** The part about what is synced, while the screen is shown. */
	private exclusion: ExclusionSettings | null = null;
	/**
	 * The groups that are open, for as long as the plugin is loaded: closing
	 * the settings does not close them, but for what this device leaves out.
	 */
	private readonly folds: Folds = new Set();
	/**
	 * The interval that the switch to Google Drive raised, until the screen
	 * that the switch draws again has said so.
	 */
	private raisedForGdrive: number | null = null;

	constructor(app: App, plugin: Plugin, host: SettingsHost) {
		super(app, plugin);
		this.host = host;
	}

	override display(): void {
		const { containerEl, host } = this;
		const t = host.t;
		containerEl.empty();
		this.commits = [];
		this.dropExclusion();
		this.drawn += 1;
		// Closed each time the settings are opened: what is in it is told
		// beside its name.
		this.folds.delete("device");

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

		const connection = grouped(containerEl, t("settings.connection.heading"), null).listEl;

		// Above the rest: what else the connection asks for depends on it.
		new Setting(connection)
			.setName(t("settings.service.name"))
			.setDesc(t("settings.service.desc"))
			.addDropdown((dropdown) => {
				dropdown
					.addOption("github", "GitHub")
					.addOption("dropbox", "Dropbox")
					.addOption("gdrive", "Google Drive")
					.setValue(stored.backend)
					.onChange((value) => {
						const backend = value === "dropbox" || value === "gdrive" ? value : "github";
						const before = this.host.deviceSettings?.autoSync.intervalMinutes;
						this.change((current) => {
							if (current.backend === backend) return current;
							// The folder of the vault starts as the name of the
							// vault, the first time Dropbox or Google Drive is
							// chosen (R-4, R-1).
							const vault = dropboxFolderToStore(this.app.vault.getName()) ?? "";
							const folder = current.dropboxFolder === "" && backend === "dropbox" ? vault : current.dropboxFolder;
							const gdriveFolder = current.gdriveFolder === "" && backend === "gdrive" ? vault : current.gdriveFolder;
							// Google Drive has a longer shortest interval.
							return { ...withBackend(current, backend), dropboxFolder: folder, gdriveFolder };
						});
						const now = this.host.deviceSettings?.autoSync.intervalMinutes;
						this.raisedForGdrive = backend === "gdrive" && before !== undefined && now !== undefined && now > before ? now : null;
						this.display();
					});
			});

		// What is in a field that was not taken over, as the text the test
		// of the connection says instead of testing: the settings still
		// name what was there before, which is not what is on the screen.
		let rejected = (): string | null => null;
		if (stored.backend === "dropbox") {
			rejected = this.showDropbox(connection, stored);
		} else if (stored.backend === "gdrive") {
			rejected = this.showGdrive(connection, stored);
		} else {
			// The repository and the branch are taken over when the field is left
			// or Enter is pressed (the DOM `change` event), not on each key. Every
			// change of them that is saved discards the sync state, and a name
			// half typed is a different repository.
			const repository = new Setting(connection)
				.setName(t("settings.repository.name"))
				.setDesc(t("settings.repository.desc"));
			repository.settingEl.addClass("sync-evo-repository");
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

			const branch = new Setting(connection).setName(t("settings.branch.name")).setDesc(t("settings.branch.desc"));
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
			new Setting(connection)
				.setName(t("settings.token.name"))
				.setDesc(t("settings.token.desc"))
				.addComponent((el) =>
					new SecretComponent(this.app, el).setValue(stored.tokenSecret).onChange((name) => {
						this.change((current) => ({ ...current, tokenSecret: name }));
					}),
				);
			rejected = () => (repositoryRejected ? t("check.noRepository") : branchRejected ? t("check.noBranch") : null);
		}

		this.showLicense(connection, stored);

		const deviceName = new Setting(connection)
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

		// No description: the name says what it does, and how it went is
		// put where one would be.
		const test = new Setting(connection).setName(t("settings.test.name"));
		const result = test.descEl.createDiv();
		test.addButton((button) => {
			button.setButtonText(t("settings.test.button")).onClick(async () => {
				// The click has already taken the focus from a field, but the
				// button can also be reached with the keyboard.
				this.commit();
				const settings = host.deviceSettings;
				if (settings === null) return;
				result.removeClass("mod-warning", "mod-success");
				const unsaved = rejected();
				if (unsaved !== null) {
					// A test of the connection from before would read as a
					// verdict on what is in the fields.
					result.addClass("mod-warning");
					result.setText(unsaved);
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

		if (stored.backend === "gdrive") this.showGdriveClient(containerEl, stored);

		this.showHowItSyncs(grouped(containerEl, t("settings.howItSyncs.heading"), null).listEl, stored);

		// What is not synced: the switches for the root `.gitignore`, what
		// this device alone leaves out, and the file. Read from the vault and
		// the sync state, so filled in later, like the list below it.
		// Nothing while there is no connection.
		this.exclusion = new ExclusionSettings(this.app, containerEl.createDiv("sync-evo-part"), host, this.folds);
		void this.exclusion.draw();

		void this.showSymlinks(containerEl.createDiv("sync-evo-part"), this.drawn);
	}

	/**
	 * The row of Dropbox, with the button that connects or disconnects, and
	 * the folder of the vault (R-4). Answers what the test of the connection
	 * says instead while the folder field holds a name that was not taken.
	 */
	private showDropbox(el: HTMLElement, stored: DeviceSettings): () => string | null {
		const { host } = this;
		const t = host.t;
		const connected = host.dropboxConnection();
		const row = new Setting(el)
			.setName(t("settings.dropbox.name"))
			.setDesc(connected === null ? t("settings.dropbox.desc") : t("settings.dropbox.connected", { email: connected.email }));
		if (connected === null) {
			// Made before the press, and anew after each: iOS opens the
			// browser only right after a tap, and the challenge of PKCE takes
			// a moment to compute.
			let sign: SignIn | null = null;
			row.addButton((button) => {
				// Pressable once the sign-in is made.
				const prepare = (): void => {
					sign = null;
					button.setDisabled(true);
					newSignIn((length) => crypto.getRandomValues(new Uint8Array(length))).then(
						(made) => {
							sign = made;
							button.setDisabled(false);
						},
						(error: unknown) => {
							new Notice(t("dropbox.signInFailed", { detail: error instanceof Error ? error.message : String(error) }));
						},
					);
				};
				button
					.setCta()
					.setButtonText(t("settings.dropbox.connect"))
					.onClick(() => {
						if (sign === null) return;
						host.startDropboxSignIn(sign);
						prepare();
					});
				prepare();
			});
		} else {
			row.addButton((button) => {
				button.setButtonText(t("settings.dropbox.disconnect")).onClick(async () => {
					button.setDisabled(true);
					await host.disconnectDropbox();
					this.display();
				});
			});
		}

		// Taken over when the field is left, like the repository: every
		// change of it that is saved discards the sync state.
		const folder = new Setting(el).setName(t("settings.dropboxFolder.name")).setDesc(t("settings.dropboxFolder.desc"));
		const folderNote = note(folder);
		let folderRejected = false;
		folder.addText((text) => {
			text.setValue(stored.dropboxFolder);
			const commit = (): void => {
				const value = dropboxFolderToStore(text.getValue());
				if (value === null) {
					folderNote.setText(t("settings.dropboxFolder.invalid"));
					folderRejected = true;
					return;
				}
				text.setValue(value);
				folderNote.setText("");
				folderRejected = false;
				this.change((current) => (current.dropboxFolder === value ? current : { ...current, dropboxFolder: value }));
			};
			text.inputEl.addEventListener("change", commit);
			this.commits.push(commit);
		});
		return () => (folderRejected ? t("check.dropbox.noFolder") : null);
	}

	/**
	 * The row of Google Drive, with the button that connects or disconnects,
	 * and the folder of the vault (R-1). Answers what the test of the
	 * connection says instead while the folder field holds a name that was
	 * not taken.
	 */
	private showGdrive(el: HTMLElement, stored: DeviceSettings): () => string | null {
		const { host } = this;
		const t = host.t;
		const connected = host.gdriveConnection();
		const row = new Setting(el)
			.setName(t("settings.gdrive.name"))
			.setDesc(connected === null ? t("settings.gdrive.desc") : t("settings.gdrive.connected", { email: connected.email }));
		if (connected === null) {
			// Asked for before the press, so the dialog shows the code at once
			// and copies it in the press (the clipboard too may take a tap).
			// Without one by then, the dialog asks for it.
			// The plugin keeps it while it lasts: drawing the screen again
			// asks for no other.
			let code: DeviceCode | null = null;
			host.prepareGdriveCode().then(
				(made) => {
					code = made;
				},
				() => undefined,
			);
			row.addButton((button) => {
				button
					.setCta()
					.setButtonText(t("settings.gdrive.connect"))
					.onClick(() => {
						host.connectGdrive(code);
						// A code is for one press. Without one, the dialog asks.
						code = null;
					});
			});
		} else {
			row.addButton((button) => {
				button.setButtonText(t("settings.gdrive.disconnect")).onClick(async () => {
					button.setDisabled(true);
					await host.disconnectGdrive();
					this.display();
				});
			});
		}

		// Taken over when the field is left, like the repository: every
		// change of it that is saved discards the sync state, and with it the
		// id of the folder that was found by the name before.
		const folder = new Setting(el).setName(t("settings.gdriveFolder.name")).setDesc(t("settings.gdriveFolder.desc"));
		const folderNote = note(folder);
		let folderRejected = false;
		folder.addText((text) => {
			text.setValue(stored.gdriveFolder);
			const commit = (): void => {
				const value = dropboxFolderToStore(text.getValue());
				if (value === null) {
					folderNote.setText(t("settings.dropboxFolder.invalid"));
					folderRejected = true;
					return;
				}
				text.setValue(value);
				folderNote.setText("");
				folderRejected = false;
				this.change((current) =>
					current.gdriveFolder === value ? current : { ...current, gdriveFolder: value, gdriveFolderId: null },
				);
			};
			text.inputEl.addEventListener("change", commit);
			this.commits.push(commit);
		});
		return () => (folderRejected ? t("check.gdrive.noFolder") : null);
	}

	/**
	 * The license key of the paid plan of Dropbox and Google Drive (T082),
	 * with where this device stands. Nothing while the plan is off, and with
	 * GitHub. A page to buy a key is linked on a desktop only: the app
	 * stores of the phones do not have a purchase outside them linked from
	 * an app. Every device gets the field and the README.
	 */
	private showLicense(el: HTMLElement, stored: DeviceSettings): void {
		const { host } = this;
		const t = host.t;
		const info = host.paidInfo(stored);
		if (info === null) return;
		const row = new Setting(el).setName(t("settings.license.name")).setDesc(t("settings.license.desc"));
		const status = row.descEl.createDiv();
		const show = (shown: PaidInfo): void => {
			status.empty();
			for (const line of paidStatusLines(t, shown)) status.createDiv({ text: line });
		};
		show(info);
		const readme = row.descEl.createDiv();
		readme.createEl("a", { text: t("settings.license.readme"), href: README_URL });
		if (!Platform.isMobile && PURCHASE_URL !== "") {
			row.addButton((button) => {
				button.setButtonText(t("settings.license.buy")).onClick(() => {
					window.open(PURCHASE_URL);
				});
			});
		}
		row.addText((text) => {
			text.setValue(info.key);
			// Taken when the field is left: each key that is taken is an
			// activation on Dodo, and half a key is none.
			const commit = (): void => {
				const typed = text.getValue().trim();
				if (typed === (host.paidInfo(stored)?.key ?? "")) return;
				status.empty();
				status.createDiv({ text: t("settings.license.checking") });
				void host.setLicenseKey(typed).then(() => {
					const current = host.deviceSettings;
					const now = current === null ? null : host.paidInfo(current);
					if (now !== null) show(now);
				});
			};
			text.inputEl.addEventListener("change", commit);
			this.commits.push(commit);
		});
	}

	/**
	 * A Google client of the user's own (R-1, T082): the insurance for when
	 * the client of Sync Evo stops working, folded away. Shown whether or
	 * not the paid plan is on. The id is kept in the settings, the secret
	 * beside the token.
	 */
	private showGdriveClient(containerEl: HTMLElement, stored: DeviceSettings): void {
		const { host } = this;
		const t = host.t;
		const group = grouped(containerEl, t("settings.gdriveClient.heading"), t("settings.gdriveClient.desc"), {
			folds: this.folds,
			id: "gdrive-client",
		});
		new Setting(group.listEl).setName(t("settings.gdriveClient.id.name")).addText((text) => {
			text.setValue(stored.gdriveClientId ?? "");
			const commit = (): void => {
				void host.setGdriveClientId(text.getValue()).then((changed) => {
					if (!changed) return;
					this.display();
					new Notice(t("settings.gdriveClient.reconnect"));
				});
			};
			text.inputEl.addEventListener("change", commit);
			this.commits.push(commit);
		});
		new Setting(group.listEl)
			.setName(t("settings.gdriveClient.secret.name"))
			.setDesc(t("settings.gdriveClient.secret.desc"))
			.addText((text) => {
				text.inputEl.type = "password";
				text.setValue(host.gdriveClientSecret());
				const commit = (): void => {
					if (text.getValue().trim() === host.gdriveClientSecret()) return;
					host.setGdriveClientSecret(text.getValue());
				};
				text.inputEl.addEventListener("change", commit);
				this.commits.push(commit);
			});
	}

	/** Draws the screen again, when it is shown: after the connection to Dropbox changed from outside it. */
	redrawIfShown(): void {
		if (this.containerEl.isShown()) this.display();
	}

	/**
	 * When this device syncs by itself, whether it sends then, and what it
	 * does with a conflict. Nothing here is a change of the connection: the
	 * sync state stays. A switch takes effect with the next look at the
	 * clock (`auto-scheduler.ts`), the handling of conflicts with the next
	 * sync.
	 */
	private showHowItSyncs(el: HTMLElement, settings: DeviceSettings): void {
		const t = this.host.t;
		const stored = settings.autoSync;
		const change = (edit: (auto: AutoSyncSettings) => AutoSyncSettings): void => {
			this.change((current) => ({ ...current, autoSync: edit(current.autoSync) }));
		};
		const sendingMin = MIN_SENDING_INTERVAL_MINUTES;

		new Setting(el)
			.setName(t("settings.autoSync.onStartup.name"))
			.setDesc(t("settings.autoSync.onStartup.desc"))
			.addToggle((toggle) => {
				toggle.setValue(stored.onStartup).onChange((onStartup) => change((auto) => ({ ...auto, onStartup })));
			});
		// Shows the interval only while its switch is on: left on the screen,
		// it was read as the time of the switch above.
		let showIntervalRow = (_shown: boolean): void => {};
		new Setting(el)
			.setName(t("settings.autoSync.atInterval.name"))
			.setDesc(t("settings.autoSync.atInterval.desc"))
			.addToggle((toggle) => {
				toggle.setValue(stored.atInterval).onChange((atInterval) => {
					change((auto) => ({ ...auto, atInterval }));
					showIntervalRow(atInterval);
				});
			});

		// With Google Drive the bound is the same, sending or not.
		const min = minIntervalMinutes(false, settings.backend);
		const intervalDesc =
			settings.backend === "gdrive"
				? t("settings.autoSync.interval.gdriveDesc", { min, max: MAX_INTERVAL_MINUTES })
				: t("settings.autoSync.interval.desc", { min, max: MAX_INTERVAL_MINUTES, sendingMin });
		const interval = new Setting(el).setName(t("settings.autoSync.interval.name")).setDesc(intervalDesc);
		const intervalNote = note(interval);
		// Not a warning: the number was changed as it should be. But in a
		// colour of its own, or the change goes unnoticed.
		const intervalRaised = interval.descEl.createDiv({ cls: "sync-evo-changed" });
		// Said once, on the screen that the switch of the service drew.
		if (this.raisedForGdrive !== null) {
			intervalRaised.setText(t("settings.autoSync.interval.raisedForGdrive", { minutes: this.raisedForGdrive }));
			this.raisedForGdrive = null;
		}
		showIntervalRow = (shown) => interval.settingEl.toggle(shown);
		showIntervalRow(stored.atInterval);
		// Puts the interval that is in use into the field: after the switch
		// below has raised it.
		let showInterval = (_minutes: number): void => {};
		interval.addText((text) => {
			text.inputEl.inputMode = "numeric";
			text.setValue(String(stored.intervalMinutes));
			showInterval = (minutes) => {
				text.setValue(String(minutes));
				intervalNote.setText("");
				intervalRaised.setText("");
			};
			// Taken over when the field is left, like the repository: "1" on
			// the way to "15" is an interval of its own.
			const commit = (): void => {
				const sends = this.host.deviceSettings?.autoSync.sendsChanges ?? stored.sendsChanges;
				const backend = this.host.deviceSettings?.backend ?? settings.backend;
				const minutes = intervalToStore(text.getValue(), sends, backend);
				if (minutes === null) {
					// Nothing is saved, so the interval from before stays in use.
					const min = minIntervalMinutes(sends, backend);
					intervalRaised.setText("");
					intervalNote.setText(t("settings.autoSync.interval.invalid", { min, max: MAX_INTERVAL_MINUTES }));
					return;
				}
				showInterval(minutes);
				change((auto) => (auto.intervalMinutes === minutes ? auto : { ...auto, intervalMinutes: minutes }));
			};
			text.inputEl.addEventListener("change", commit);
			this.commits.push(commit);
		});

		// Why sending raises the interval differs by the service. With Google
		// Drive the interval is at its bound for sending either way.
		const sendsDesc =
			settings.backend === "gdrive"
				? t("settings.autoSync.sends.gdriveDesc")
				: settings.backend === "dropbox"
					? t("settings.autoSync.sends.dropboxDesc", { sendingMin })
					: t("settings.autoSync.sends.githubDesc", { sendingMin });
		new Setting(el)
			.setName(t("settings.autoSync.sends.name"))
			.setDesc(sendsDesc)
			.addToggle((toggle) => {
				toggle.setValue(stored.sendsChanges).onChange((sends) => {
					const before = this.host.deviceSettings?.autoSync.intervalMinutes;
					change((auto) => withSendsChanges(auto, sends, this.host.deviceSettings?.backend ?? settings.backend));
					// The interval that is in use now, whatever the field held:
					// one below the bound for sending was raised to it.
					const now = this.host.deviceSettings?.autoSync.intervalMinutes;
					if (now === undefined) return;
					showInterval(now);
					// Said where the number changed. While the row is hidden it
					// is said there all the same, and seen when the row is shown.
					if (before !== undefined && now > before) {
						intervalRaised.setText(t("settings.autoSync.interval.raised", { minutes: now }));
					}
				});
			});

		new Setting(el)
			.setName(t("settings.onConflict.name"))
			.setDesc(t("settings.onConflict.desc"))
			.addDropdown((dropdown) => {
				dropdown
					.addOption("merge", t("settings.onConflict.merge"))
					.addOption("copy", t("settings.onConflict.copy"))
					.setValue(settings.onConflict)
					.onChange((chosen) => {
						const onConflict = conflictHandlingOf(chosen);
						this.change((current) => (current.onConflict === onConflict ? current : { ...current, onConflict }));
					});
			});
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
		// Folded: nothing in it is to be acted on.
		const group = grouped(el, t("settings.symlinks.name"), t("settings.symlinks.desc"), {
			folds: this.folds,
			id: "symlinks",
			summary: t("settings.symlinks.summary", { count: links.length }),
		});
		const list = group.textEl.createEl("ul");
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

	/**
	 * Draws the part about what is synced again, if the screen is shown: for
	 * when something outside it changed what that part reads (an untracking
	 * ended). Nothing when the screen is closed; opening it draws it anyway.
	 */
	redrawExclusion(): void {
		void this.exclusion?.draw();
	}

	override hide(): void {
		// Closing the settings with a field still in focus does not fire `change`.
		this.commit();
		this.commits = [];
		this.dropExclusion();
		super.hide();
	}

	/**
	 * Lets go of the part about what is synced: the screen is closed or
	 * drawn anew, or the plugin is unloaded (`main.ts`). A question about
	 * untracking it has open goes with it, closed as a "no": nothing else
	 * would reach that dialog after this to close it.
	 */
	dropExclusion(): void {
		this.exclusion?.dispose();
		this.exclusion = null;
	}

	/**
	 * Gives up a question about untracking that is open or being prepared,
	 * as a "no", while the screen stays as it is: the connection was changed
	 * (`main.ts`), and the question is about the remote that was left.
	 */
	closeUntrackQuestion(): void {
		this.exclusion?.closeQuestion();
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
