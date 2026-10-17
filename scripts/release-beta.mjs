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

// Creates a GitHub prerelease `<version>-beta.<N>` of the current commit, for
// installing on a phone with BRAT. The beta version goes only into the
// manifest.json attached to the release; the one in the repository is not
// changed. Uses the `gh` CLI, with whatever repository and login it resolves.
//
// With --dry-run, does everything except creating the release, and prints
// what it would have run.

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { nextBetaVersion } from "./beta-version.mjs";
import { googleClientSecret, REQUIRE_ENV, SECRET_ENV, SECRET_FILE } from "./google-client-secret.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.slice(2).includes("--dry-run");

function fail(message) {
	console.error(`release:beta: ${message}`);
	process.exit(1);
}

// Runs a command in the repository root and returns its trimmed stdout, or
// null if it could not be started or exited with an error. What the failed
// command wrote to stderr is kept in `reason`, for the message.
let reason = "";
function capture(command, args) {
	try {
		return execFileSync(command, args, {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch (error) {
		reason = String(error.stderr ?? "").trim() || error.message;
		return null;
	}
}

function lines(text) {
	return text.split("\n").filter((line) => line !== "");
}

for (const arg of process.argv.slice(2)) {
	if (arg !== "--dry-run") fail(`unknown argument ${arg}. The only option is --dry-run.`);
}

// 1. Preconditions.
const status = capture("git", ["status", "--porcelain"]);
if (status === null) fail("could not run `git status`.");
if (status !== "") {
	fail("the working tree is not clean. Commit or stash the changes first.");
}

// The client secret of Google goes into main.js (esbuild.config.mjs); a
// release without it could not connect to Google Drive.
const secret = googleClientSecret();
if (secret === null) fail(`no Google client secret. Set ${SECRET_ENV}, or put the value in ${SECRET_FILE}.`);

const branch = capture("git", ["symbolic-ref", "--quiet", "--short", "HEAD"]);
if (!branch) fail("HEAD is detached. Check out a branch first.");

if (capture("git", ["fetch", "origin"]) === null) fail(`\`git fetch origin\` failed: ${reason}`);
const pushed = spawnSync("git", ["merge-base", "--is-ancestor", "HEAD", `refs/remotes/origin/${branch}`], {
	cwd: root,
	stdio: "ignore",
});
if (pushed.status !== 0) {
	fail(`HEAD is not in origin/${branch}. Push the branch first.`);
}
const sha = capture("git", ["rev-parse", "HEAD"]);
if (!sha) fail("could not read the commit of HEAD.");

if (capture("gh", ["--version"]) === null) {
	fail("the `gh` CLI was not found. Install it from https://cli.github.com.");
}
// `gh` fills in {owner} and {repo} from the remotes of this folder.
const repo = capture("gh", ["api", "repos/{owner}/{repo}", "--jq", ".full_name"]);
if (!repo) {
	fail(`\`gh\` could not open the repository (try \`gh auth login\`): ${reason}`);
}

// 2. The version. Tags are read both from the releases (all pages, drafts
// included) and from the remote, because deleting a release leaves its tag.
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
	fail(`the version in manifest.json must look like 1.2.3, but is ${manifest.version}.`);
}

const releaseTags = capture("gh", ["api", "--paginate", "repos/{owner}/{repo}/releases?per_page=100", "--jq", ".[].tag_name"]);
if (releaseTags === null) fail(`could not list the releases: ${reason}`);
const remoteTags = capture("git", ["ls-remote", "--tags", "--refs", "origin"]);
if (remoteTags === null) fail(`could not list the tags of origin: ${reason}`);
const tags = [
	...lines(releaseTags),
	...lines(remoteTags).map((line) => line.replace(/^.*\trefs\/tags\//, "")),
];
const tag = nextBetaVersion(manifest.version, tags);

// 3. Build and test.
for (const args of [["run", "build"], ["test"]]) {
	const result = spawnSync("npm", args, { cwd: root, stdio: "inherit", env: { ...process.env, [REQUIRE_ENV]: "1" } });
	if (result.status !== 0) fail(`\`npm ${args.join(" ")}\` failed.`);
}
if (!existsSync(join(root, "main.js"))) fail("the build did not produce main.js.");
if (!readFileSync(join(root, "main.js"), "utf8").includes(JSON.stringify(secret.value).slice(1, -1))) {
	fail("the Google client secret is not in main.js.");
}

// 4 to 6. The files to attach go into a temporary folder, which is removed
// whether or not the release is created.
const staging = mkdtempSync(join(tmpdir(), "sync-evo-beta-"));
let url = "";
let error = null;
try {
	const files = [join(staging, "manifest.json"), join(staging, "main.js")];
	writeFileSync(files[0], `${JSON.stringify({ ...manifest, version: tag }, null, "\t")}\n`);
	copyFileSync(join(root, "main.js"), files[1]);
	if (existsSync(join(root, "styles.css"))) { // styles.css is optional
		files.push(join(staging, "styles.css"));
		copyFileSync(join(root, "styles.css"), files[2]);
	}

	const args = [
		"release", "create", tag, ...files,
		"--prerelease",
		"--title", tag,
		"--target", sha,
		"--notes", `Beta build of ${sha}.`,
	];

	if (dryRun) {
		const staged = JSON.parse(readFileSync(files[0], "utf8"));
		console.log(`\ndry run: no release was created in ${repo}.`);
		console.log(`would run: gh ${args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(" ")}`);
		console.log("would attach:");
		for (const file of files) console.log(`  ${file}`);
		console.log(`manifest.json version: ${staged.version}`);
	} else {
		url = execFileSync("gh", args, {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "inherit"],
		}).trim();
	}
} catch (caught) {
	error = caught;
} finally {
	rmSync(staging, { recursive: true, force: true });
}

if (error) fail(`could not create the release ${tag}: ${error.message}`);
if (!dryRun) {
	console.log(`created ${tag}`);
	console.log(url);
}
