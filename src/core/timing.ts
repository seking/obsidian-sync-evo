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

// How long a pull or a push took, and where: one line of the log each, to
// be read on a phone, where the console is out of reach. It measures and
// decides nothing.

import type { FolderLister } from "./scan";

/**
 * The time a run spent in each of its phases, as its progress tells them.
 * A phase entered again adds to what it had.
 */
export class PhaseClock {
	private readonly spent = new Map<string, number>();
	private phase: string | null = null;
	private readonly began: number;
	private since: number;

	constructor(private readonly now: () => number) {
		this.began = now();
		this.since = this.began;
	}

	enter(phase: string): void {
		if (phase === this.phase) return;
		this.close();
		this.phase = phase;
	}

	/** The time since the start, and that of each phase in the order first entered. Ends the phase it is in. */
	line(): string {
		this.close();
		this.phase = null;
		const phases = [...this.spent].map(([phase, ms]) => `${phase} ${ms} ms`);
		return `${this.since - this.began} ms${phases.length === 0 ? "" : ` (${phases.join(", ")})`}`;
	}

	private close(): void {
		const now = this.now();
		if (this.phase !== null) this.spent.set(this.phase, (this.spent.get(this.phase) ?? 0) + now - this.since);
		this.since = now;
	}
}

/** The lister, counting the folders it lists. */
export function countingLister(lister: FolderLister): FolderLister & { readonly listed: () => number } {
	let listed = 0;
	return {
		list: (folder) => {
			listed += 1;
			return lister.list(folder);
		},
		...(lister.linksIn === undefined ? {} : { linksIn: async (folder: string) => (await lister.linksIn?.(folder)) ?? [] }),
		listed: () => listed,
	};
}

/** What the time of the disk went to, in a look at every file (`readLocal`). */
export interface DiskTime {
	readonly statted: number;
	readonly hashed: number;
	/** Milliseconds spent asking the disk about files. */
	readonly statMs: number;
	/** Milliseconds spent reading files and hashing them. */
	readonly readMs: number;
}

/** The line of a check that walked every folder. */
export function fullCheckLine(
	files: number,
	folders: number,
	scanMs: number,
	local: DiskTime,
	milliseconds: number,
): string {
	return `full check: ${files} files, ${folders} folders listed, ${local.statted} asked of the disk, ${local.hashed} hashed, ${milliseconds} ms (folders ${scanMs} ms, ${diskTimes(local)})`;
}

/** The time of the disk, to go after the line of a light check (`lightCheckLine`). */
export function diskTimes(local: DiskTime): string {
	return `disk ${local.statMs} ms, reading ${local.readMs} ms`;
}
