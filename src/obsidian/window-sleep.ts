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

import type { Sleep } from "../core/github/http";
import { timerSleepOn } from "../core/github/timer-sleep";

/**
 * `Sleep` on the timer of the app's main window. The window is read at each
 * call, not as this file is loaded, so that the file can be loaded where
 * there is none yet.
 */
export const windowSleep: Sleep = (ms, signal) => timerSleepOn(window)(ms, signal);
