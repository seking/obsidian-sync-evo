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
import { GitignoreGate } from "../src/core/gitignore-gate";

/** A piece of work that ends when the test says so. */
function held<T>(value: T, log: string[], name: string) {
	let end = (): void => {};
	const ended = new Promise<void>((resolve) => {
		end = resolve;
	});
	const work = async (): Promise<T> => {
		log.push(`${name} began`);
		await ended;
		log.push(`${name} ended`);
		return value;
	};
	return { work, end };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("who is at the root .gitignore", () => {
	test("with no sync running, the work of the settings runs and its answer comes back", async () => {
		const gate = new GitignoreGate();
		expect(await gate.edit(async () => "written")).toEqual({ status: "done", value: "written" });
	});

	test("while a sync runs, the work is turned away and not begun", async () => {
		const gate = new GitignoreGate();
		await gate.beginSync();
		let began = false;
		const result = await gate.edit(async () => {
			began = true;
		});
		expect(result).toEqual({ status: "syncing" });
		expect(began).toBe(false);
	});

	test("after the sync has ended, the work runs again", async () => {
		const gate = new GitignoreGate();
		await gate.beginSync();
		gate.endSync();
		expect(await gate.edit(async () => 1)).toEqual({ status: "done", value: 1 });
	});

	test("a sync that begins while the settings write waits for the write to end", async () => {
		const gate = new GitignoreGate();
		const log: string[] = [];
		const write = held("written", log, "write");
		const written = gate.edit(write.work);
		await tick();

		const sync = gate.beginSync().then(() => log.push("sync went on"));
		await tick();
		expect(log).toEqual(["write began"]);

		write.end();
		await sync;
		expect(log).toEqual(["write began", "write ended", "sync went on"]);
		expect(await written).toEqual({ status: "done", value: "written" });
	});

	test("from the moment a sync begins, no more work is taken, though the sync still waits", async () => {
		const gate = new GitignoreGate();
		const log: string[] = [];
		const write = held("first", log, "first");
		void gate.edit(write.work);
		const sync = gate.beginSync();

		expect(await gate.edit(async () => "second")).toEqual({ status: "syncing" });
		write.end();
		await sync;
		expect(log).toEqual(["first began", "first ended"]);
	});

	test("two pieces of work run one after the other, in the order they were asked for", async () => {
		const gate = new GitignoreGate();
		const log: string[] = [];
		const first = held(1, log, "first");
		const second = held(2, log, "second");
		const one = gate.edit(first.work);
		const two = gate.edit(second.work);
		await tick();
		expect(log).toEqual(["first began"]);

		first.end();
		await one;
		await tick();
		expect(log).toEqual(["first began", "first ended", "second began"]);
		second.end();
		expect(await two).toEqual({ status: "done", value: 2 });
	});

	test("a sync waits for all the work taken before it, also what had not begun", async () => {
		const gate = new GitignoreGate();
		const log: string[] = [];
		const first = held(1, log, "first");
		const second = held(2, log, "second");
		void gate.edit(first.work);
		void gate.edit(second.work);
		const sync = gate.beginSync().then(() => log.push("sync went on"));

		first.end();
		await tick();
		expect(log).not.toContain("sync went on");
		second.end();
		await sync;
		expect(log).toEqual(["first began", "first ended", "second began", "second ended", "sync went on"]);
	});

	test("work that fails throws to its caller, and holds up neither the next work nor a sync", async () => {
		const gate = new GitignoreGate();
		const failed = gate.edit(async () => {
			throw new Error("the state is closed");
		});
		await expect(failed).rejects.toThrow("the state is closed");

		expect(await gate.edit(async () => "next")).toEqual({ status: "done", value: "next" });
		await expect(gate.beginSync()).resolves.toBeUndefined();
	});

	test("idle resolves once the work taken so far has ended, and at once when there is none", async () => {
		const gate = new GitignoreGate();
		await expect(gate.idle()).resolves.toBeUndefined();

		const log: string[] = [];
		const write = held(1, log, "write");
		void gate.edit(write.work);
		const idle = gate.idle().then(() => log.push("idle"));
		await tick();
		expect(log).toEqual(["write began"]);
		write.end();
		await idle;
		expect(log).toEqual(["write began", "write ended", "idle"]);
	});
});
