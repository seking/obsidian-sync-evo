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

import type { Sleep } from "../core/http";
import { timerSleepOn } from "../core/github/timer-sleep";

/**
 * `Sleep` on the timer of the app's main window. The window is read at each
 * call, not as this file is loaded, so that the file can be loaded where
 * there is none yet.
 */
export const windowSleep: Sleep = (ms, signal) => timerSleepOn(window)(ms, signal);
