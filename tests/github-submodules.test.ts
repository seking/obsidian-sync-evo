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

import { describe, expect, test } from "vitest";
import { parseGitmodules, repositoryName, repositoryOfName, repositoryOfUrl } from "../src/core/github/submodules";

/** What a `.gitmodules` names, as a plain object. */
function urlsOf(text: string): Record<string, string> {
	return Object.fromEntries(parseGitmodules(text));
}

describe("what a .gitmodules names", () => {
	test("the URL of each submodule, by its path, as git writes the file", () => {
		const text =
			'[submodule "knowledge"]\n' +
			"\tpath = knowledge\n" +
			"\turl = https://github.com/octo/knowledge.git\n" +
			'[submodule "vendor/lib"]\n' +
			"\tpath = vendor/lib\n" +
			"\turl = git@github.com:octo/lib.git\n" +
			"\tbranch = main\n";
		expect(urlsOf(text)).toEqual({
			knowledge: "https://github.com/octo/knowledge.git",
			"vendor/lib": "git@github.com:octo/lib.git",
		});
	});

	test("by the path, not by the name of the section", () => {
		const text = '[submodule "a name of its own"]\n\tpath = libs/one\n\turl = ../one.git\n';
		expect(urlsOf(text)).toEqual({ "libs/one": "../one.git" });
	});

	test("an empty file, and one without a submodule, name none", () => {
		expect(urlsOf("")).toEqual({});
		expect(urlsOf("\n\n# nothing here\n")).toEqual({});
	});

	test("a value in quotes is read without them, with what is escaped inside", () => {
		const text =
			'[submodule "notes"]\n' +
			'\tpath = "my notes"\n' +
			'\turl = "https://github.com/octo/notes.git"\n' +
			'[submodule "odd"]\n' +
			'\tpath = "a \\"b\\" c"\n' +
			'\turl = https://github.com/"octo"/odd\n';
		expect(urlsOf(text)).toEqual({
			"my notes": "https://github.com/octo/notes.git",
			'a "b" c': "https://github.com/octo/odd",
		});
	});

	test("a line that is a comment, and a comment after a value, are left out", () => {
		const text =
			"# the submodules of this vault\n" +
			'[submodule "lib"]\n' +
			"\t; where it is\n" +
			"\tpath = lib # the folder\n" +
			"\turl = https://github.com/octo/lib.git ; over https\n";
		expect(urlsOf(text)).toEqual({ lib: "https://github.com/octo/lib.git" });
	});

	test("a # or a ; in quotes is part of the value", () => {
		const text = '[submodule "lib"]\n\tpath = "lib #1; old"\n\turl = https://github.com/octo/lib\n';
		expect(urlsOf(text)).toEqual({ "lib #1; old": "https://github.com/octo/lib" });
	});

	test("the ends of lines of Windows are no part of a value", () => {
		const text = '[submodule "lib"]\r\n\tpath = lib\r\n\turl = https://github.com/octo/lib.git\r\n';
		expect(urlsOf(text)).toEqual({ lib: "https://github.com/octo/lib.git" });
	});

	test("the spaces around a name and a value do not matter, nor the case of the name", () => {
		const text = '  [submodule "lib"]  \nPATH=lib\n   Url   =   https://github.com/octo/lib.git   \n';
		expect(urlsOf(text)).toEqual({ lib: "https://github.com/octo/lib.git" });
	});

	test("a path given twice is as the last of the two says", () => {
		const text =
			'[submodule "lib"]\n\tpath = lib\n\turl = https://github.com/octo/old.git\n' +
			'[submodule "lib"]\n\tpath = lib\n\turl = https://github.com/octo/new.git\n';
		expect(urlsOf(text)).toEqual({ lib: "https://github.com/octo/new.git" });
	});

	test("a value given twice in one section is as the last of the two says", () => {
		const text = '[submodule "lib"]\n\tpath = lib\n\turl = https://github.com/octo/old.git\n\turl = ../new.git\n';
		expect(urlsOf(text)).toEqual({ lib: "../new.git" });
	});

	// Reveals a difference from git: a section is read on its own here, so a
	// second one of the same name that gives the URL alone is dropped, and the URL of the first stays.
	test("a section named twice is one section, as in git: the second may give the URL alone", () => {
		const text =
			'[submodule "lib"]\n\tpath = lib\n\turl = https://github.com/octo/old.git\n' +
			'[submodule "lib"]\n\turl = https://github.com/octo/new.git\n';
		expect(urlsOf(text)).toEqual({ lib: "https://github.com/octo/new.git" });
	});

	test("the sections of anything else are not read", () => {
		const text =
			"[core]\n\tpath = not-this\n\turl = https://github.com/octo/not-this\n" +
			'[submodule "lib"]\n\tpath = lib\n\turl = https://github.com/octo/lib\n' +
			'[remote "origin"]\n\turl = https://github.com/octo/notes\n' +
			'[submodules "typo"]\n\tpath = typo\n\turl = https://github.com/octo/typo\n';
		expect(urlsOf(text)).toEqual({ lib: "https://github.com/octo/lib" });
	});

	test("a line before any section belongs to none", () => {
		const text = 'path = stray\nurl = https://github.com/octo/stray\n[submodule "lib"]\n\tpath = lib\n\turl = ../lib\n';
		expect(urlsOf(text)).toEqual({ lib: "../lib" });
	});

	test("a submodule without a path or without a URL is left out, and so is one with an empty one", () => {
		const text =
			'[submodule "no-url"]\n\tpath = no-url\n' +
			'[submodule "no-path"]\n\turl = https://github.com/octo/no-path\n' +
			'[submodule "empty-url"]\n\tpath = empty-url\n\turl =\n' +
			'[submodule "empty-path"]\n\tpath = ""\n\turl = https://github.com/octo/empty-path\n' +
			'[submodule "whole"]\n\tpath = whole\n\turl = https://github.com/octo/whole\n';
		expect(urlsOf(text)).toEqual({ whole: "https://github.com/octo/whole" });
	});

	test("a line that is neither a section nor a value is passed over", () => {
		const text = '[submodule "lib"]\n\tpath = lib\n\tshallow\n\turl = https://github.com/octo/lib\n';
		expect(urlsOf(text)).toEqual({ lib: "https://github.com/octo/lib" });
	});
});

describe("the repository a URL names", () => {
	const parent = { owner: "octo", repo: "notes" };
	const lib = { owner: "octo", repo: "lib" };

	test.each([
		"https://github.com/octo/lib",
		"https://github.com/octo/lib.git",
		"https://github.com/octo/lib/",
		"https://github.com/octo/lib.git/",
		"http://github.com/octo/lib.git",
		"git@github.com:octo/lib.git",
		"git@github.com:octo/lib",
		"github.com:octo/lib.git",
		"ssh://git@github.com/octo/lib",
		"ssh://git@github.com/octo/lib.git",
		"ssh://git@github.com:22/octo/lib.git",
		"git://github.com/octo/lib",
		"git://github.com/octo/lib.git",
		"https://user@github.com/octo/lib.git",
		"https://www.github.com/octo/lib",
		"HTTPS://GitHub.com/octo/lib.git",
		"  https://github.com/octo/lib.git  ",
	])("%s is the repository of GitHub", (url) => {
		expect(repositoryOfUrl(url, parent)).toEqual(lib);
	});

	test("the owner and the name are kept as they are spelled", () => {
		expect(repositoryOfUrl("https://github.com/Octo-Org/My.Lib_2.git", parent)).toEqual({
			owner: "Octo-Org",
			repo: "My.Lib_2",
		});
	});

	test.each([
		"https://gitlab.com/octo/lib.git",
		"git@gitlab.com:octo/lib.git",
		"ssh://git@bitbucket.org/octo/lib.git",
		"git://example.com/octo/lib",
		"https://github.com.example.com/octo/lib",
		"https://notgithub.com/octo/lib",
		"https://gist.github.com/octo/lib",
		"https://github.example.com/octo/lib",
	])("%s is of another host, and names none", (url) => {
		expect(repositoryOfUrl(url, parent)).toBeNull();
	});

	test.each([
		["one part too many", "https://github.com/octo/lib/tree"],
		["one part too many, the short way", "git@github.com:octo/lib/sub.git"],
		["an owner alone", "https://github.com/octo"],
		["the host alone", "https://github.com/"],
		["a path of this device", "/srv/git/lib.git"],
		["a path of a Windows device", "C:/git/lib.git"],
		["a file", "file:///srv/git/lib.git"],
		["a name alone", "lib"],
		["nothing", ""],
		["a query after the name", "https://github.com/octo/lib?ref=main"],
		["a name that is two dots", "https://github.com/octo/.."],
	])("%s names none", (_name, url) => {
		expect(repositoryOfUrl(url, parent)).toBeNull();
	});

	test("a URL relative to the repository is resolved against it, one name at a time", () => {
		expect(repositoryOfUrl("../lib.git", parent)).toEqual(lib);
		expect(repositoryOfUrl("../lib", parent)).toEqual(lib);
		expect(repositoryOfUrl("../lib/", parent)).toEqual(lib);
		expect(repositoryOfUrl("../../other/lib", parent)).toEqual({ owner: "other", repo: "lib" });
		expect(repositoryOfUrl("../../other/lib.git", parent)).toEqual({ owner: "other", repo: "lib" });
		// Out and back in.
		expect(repositoryOfUrl("./../lib", parent)).toEqual(lib);
		expect(repositoryOfUrl(".././lib", parent)).toEqual(lib);
		// Nowhere at all: the repository itself.
		expect(repositoryOfUrl("./", parent)).toEqual(parent);
	});

	test("a relative URL that does not end at an owner and a name names none", () => {
		// Below the repository itself.
		expect(repositoryOfUrl("./x", parent)).toBeNull();
		// The owner alone.
		expect(repositoryOfUrl("../", parent)).toBeNull();
		// Above GitHub.
		expect(repositoryOfUrl("../../../x", parent)).toBeNull();
		expect(repositoryOfUrl("../../../other/lib", parent)).toBeNull();
		// One part too many.
		expect(repositoryOfUrl("../lib/sub", parent)).toBeNull();
		expect(repositoryOfUrl("../../a/b/c", parent)).toBeNull();
	});
});

describe("a repository as a source names it", () => {
	test("the owner and the name, with a slash between", () => {
		expect(repositoryName({ owner: "octo", repo: "lib" })).toBe("octo/lib");
	});

	test("is read back as the same repository", () => {
		expect(repositoryOfName("octo/lib")).toEqual({ owner: "octo", repo: "lib" });
		expect(repositoryOfName(repositoryName({ owner: "Octo-Org", repo: "My.Lib_2" }))).toEqual({
			owner: "Octo-Org",
			repo: "My.Lib_2",
		});
	});

	test.each(["", "octo", "octo/", "/lib", "octo/lib/sub", "octo lib", "octo/li b", "octo/..", "octo/lib?x"])(
		"%j names none",
		(name) => {
			expect(repositoryOfName(name)).toBeNull();
		},
	);

	// Reveals an asymmetry: `.git` is taken off the name read back, so a repository
	// whose name ends with it is not the one that was named.
	test("a name is read back as it was written, whatever it ends with", () => {
		expect(repositoryOfName(repositoryName({ owner: "octo", repo: "lib.git" }))).toEqual({ owner: "octo", repo: "lib.git" });
	});
});

describe("what the review of the first version found", () => {
	const parent = { owner: "octo", repo: "notes" };

	test.each(["https://github.com/../user", "git@github.com:../user", "https://github.com/./user", "https://github.com/octo/..."])(
		"%s names no repository: dots alone are no name",
		(url) => {
			expect(repositoryOfUrl(url, parent)).toBeNull();
		},
	);

	test("dots alone are no owner in a stored name either", () => {
		expect(repositoryOfName("../user")).toBeNull();
	});

	test("a comment after the name of a section, and a value that goes on in the next line", () => {
		const text = '[submodule "lib"] # ours\n\tpath = lib\n\turl = https://github.com/\\\nocto/lib.git\n';
		expect([...parseGitmodules(text)]).toEqual([["lib", "https://github.com/octo/lib.git"]]);
	});

	test("a section without a name is no submodule, as in git", () => {
		expect([...parseGitmodules("[submodule]\n\tpath = lib\n\turl = https://github.com/octo/lib\n")]).toEqual([]);
	});
});
