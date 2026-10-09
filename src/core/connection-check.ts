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

// The test of the connection behind the button of the settings screen: what
// is asked of the remote, and the text for each way it can turn out. The
// screen only supplies the token and the client, and shows the text.

import { BackendError, type BackendErrorKind } from "./backend";
import type { GitHubClient } from "./github/client";
import type { Translate } from "./i18n";
import { type DeviceSettings, parseRepository } from "./settings";

export type ConnectionCheck =
	| { readonly status: "connected"; readonly head: string }
	/** The repository has no commit yet. A new repository starts like this, so it is not a failure. */
	| { readonly status: "empty" }
	| { readonly status: "failed"; readonly kind: BackendErrorKind; readonly detail: string };

/**
 * Asks for the head of the branch, the one call that tells apart everything
 * the user can have got wrong: the token, its permission, the repository,
 * and the branch. Never throws.
 */
export async function checkConnection(client: Pick<GitHubClient, "resolveHead">): Promise<ConnectionCheck> {
	try {
		const head = await client.resolveHead();
		return head.status === "empty" ? { status: "empty" } : { status: "connected", head: head.sha };
	} catch (error) {
		if (error instanceof BackendError) return { status: "failed", kind: error.kind, detail: error.message };
		return { status: "failed", kind: "other", detail: error instanceof Error ? error.message : String(error) };
	}
}

/** What the settings lack for a request to be worth sending. */
export type NotReadyReason = "repository" | "branch" | "token-secret" | "token-value";

export interface CheckTarget {
	readonly owner: string;
	readonly repo: string;
	readonly branch: string;
	readonly token: string;
}

export type CheckPreparation =
	| { readonly status: "ready"; readonly target: CheckTarget }
	| { readonly status: "not-ready"; readonly reason: NotReadyReason };

/**
 * Gathers what a request needs. `readSecret` answers the value stored under
 * a name, or `null` when there is none; it is only called once the rest is
 * in place.
 */
export function prepareCheck(
	settings: DeviceSettings,
	readSecret: (name: string) => string | null,
): CheckPreparation {
	const repository = parseRepository(settings.repository);
	if (repository === null) return { status: "not-ready", reason: "repository" };
	const branch = settings.branch.trim();
	if (branch === "") return { status: "not-ready", reason: "branch" };
	if (settings.tokenSecret === "") return { status: "not-ready", reason: "token-secret" };
	// A secret can be deleted from the app's own screen after it was chosen here.
	const token = (readSecret(settings.tokenSecret) ?? "").trim();
	if (token === "") return { status: "not-ready", reason: "token-value" };
	return { status: "ready", target: { owner: repository.owner, repo: repository.repo, branch, token } };
}

export type CheckOutcome = ConnectionCheck | { readonly status: "not-ready"; readonly reason: NotReadyReason };

/**
 * The whole test: prepare, then ask. `clientFor` is called at most once.
 * Never throws, so that the screen always has a text to show.
 */
export async function runConnectionCheck(
	settings: DeviceSettings,
	readSecret: (name: string) => string | null,
	clientFor: (target: CheckTarget) => Pick<GitHubClient, "resolveHead">,
): Promise<CheckOutcome> {
	try {
		const prepared = prepareCheck(settings, readSecret);
		if (prepared.status === "not-ready") return prepared;
		return await checkConnection(clientFor(prepared.target));
	} catch (error) {
		return { status: "failed", kind: "other", detail: error instanceof Error ? error.message : String(error) };
	}
}

/** Whether the outcome is one to show as good news. */
export function isSuccess(outcome: CheckOutcome): boolean {
	return outcome.status === "connected" || outcome.status === "empty";
}

/** The text to show for an outcome. `settings` are the ones the test was run with. */
export function connectionCheckText(t: Translate, settings: DeviceSettings, outcome: CheckOutcome): string {
	const parsed = parseRepository(settings.repository);
	const repository = parsed === null ? settings.repository.trim() : `${parsed.owner}/${parsed.repo}`;
	const branch = settings.branch.trim();

	if (outcome.status === "connected") return t("check.connected", { repository, branch });
	if (outcome.status === "empty") return t("check.empty", { repository });
	if (outcome.status === "not-ready") {
		switch (outcome.reason) {
			case "repository":
				return t("check.noRepository");
			case "branch":
				return t("check.noBranch");
			case "token-secret":
				return t("check.noTokenSecret");
			case "token-value":
				return t("check.noTokenValue", { name: settings.tokenSecret });
		}
	}
	switch (outcome.kind) {
		case "unauthorized":
			return t("check.unauthorized");
		case "forbidden":
			return t("check.forbidden", { repository });
		case "not-found":
			return t("check.notFound", { repository });
		case "branch-not-found":
			return t("check.branchNotFound", { repository, branch });
		case "unreachable":
			return t("check.unreachable");
		case "rate-limited":
			return t("check.rateLimited");
		// The kinds a read of the head does not produce, and "other". The
		// detail is in English and for developers, but it is all there is to
		// go on. They are listed, with no `default`, so that a kind added
		// later fails the type check here until it is given a text.
		case "incomplete-listing":
		case "workflows-permission":
		case "too-large":
		case "not-as-listed":
		case "cancelled":
		case "other":
			return t("check.other", { detail: outcome.detail });
		default:
			return unhandled(outcome.kind);
	}
}

/** Reached only by a kind the types do not know of. Still answers a text, since the screen has to show one. */
function unhandled(kind: never): string {
	return String(kind);
}
