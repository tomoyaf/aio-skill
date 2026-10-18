// Smoke tests: every script parses its arguments, prints help, and fails clearly
// (exit 2, naming the missing variable) without credentials, before any network
// call. Run with: node --test test/
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = path.join(root, "plugins/aio-cycle/skills/aio-cycle/scripts");
const examplePrompts = path.join(
	root,
	"plugins/aio-cycle/skills/aio-cycle/references/prompts.example.json",
);

// A proxy that refuses every connection: a script that tried the network would fail
// with a connection error, not the setup message these tests look for. (Node 22.21+
// and 24+ honour these with NODE_USE_ENV_PROXY; older Node ignores them.)
const OFFLINE = {
	NODE_USE_ENV_PROXY: "1",
	HTTPS_PROXY: "http://127.0.0.1:9",
	HTTP_PROXY: "http://127.0.0.1:9",
};

function run(script, args, env = {}) {
	const clean = { PATH: process.env.PATH, HOME: process.env.HOME, ...OFFLINE, ...env };
	const r = spawnSync(process.execPath, [path.join(scripts, script), ...args], {
		env: clean,
		encoding: "utf8",
		timeout: 20_000,
	});
	return { code: r.status, out: r.stdout, err: r.stderr };
}

for (const script of ["gsc.mjs", "indexnow.mjs", "aio-monitor.mjs"]) {
	test(`${script} --help prints usage and exits 0`, () => {
		const r = run(script, ["--help"]);
		assert.equal(r.code, 0, r.err);
		assert.match(r.out, /Usage/);
	});

	test(`${script} rejects an unknown option with exit 64`, () => {
		const args = script === "gsc.mjs" ? ["performance", "--nope"] : ["--nope"];
		const r = run(script, args);
		assert.equal(r.code, 64);
		assert.match(r.err, /Unknown option --nope/);
		assert.match(r.err, /Usage/);
	});
}

test("gsc.mjs: unknown command and bad dates are usage errors", () => {
	assert.equal(run("gsc.mjs", ["bogus"]).code, 64);
	const r = run("gsc.mjs", ["performance", "--since", "2026-13-40", "--until", "2026-10-01"]);
	assert.equal(r.code, 64);
	assert.match(r.err, /YYYY-MM-DD/);
	assert.match(run("gsc.mjs", ["inspect"]).err, /needs URLs/);
	assert.match(
		run("gsc.mjs", ["performance", "--dimensions", "query,color"]).err,
		/Unknown dimension/,
	);
});

test("gsc.mjs without GSC_SITE says how to set it", () => {
	const r = run("gsc.mjs", ["performance"]);
	assert.equal(r.code, 2);
	assert.match(r.err, /GSC_SITE is not set/);
});

test("gsc.mjs without a service account key says how to get one", () => {
	const r = run("gsc.mjs", ["performance"], { GSC_SITE: "sc-domain:example.com" });
	assert.equal(r.code, 2);
	assert.match(r.err, /GSC_SERVICE_ACCOUNT_KEY_FILE/);
	assert.match(r.err, /service account/);
});

test("gsc.mjs rejects a malformed key without printing it", () => {
	const secret = Buffer.from('{"type":"service_account","private_key":"SECRET-VALUE"}').toString(
		"base64",
	);
	const r = run("gsc.mjs", ["sitemaps"], {
		GSC_SITE: "sc-domain:example.com",
		GSC_SERVICE_ACCOUNT_KEY_B64: secret,
	});
	assert.equal(r.code, 2);
	assert.doesNotMatch(r.err + r.out, /SECRET-VALUE/);
});

test("gsc.mjs rejects a property that is not one", () => {
	const r = run("gsc.mjs", ["performance", "--site", "example"]);
	assert.equal(r.code, 2);
	assert.match(r.err, /not a Search Console property/);
});

test("indexnow.mjs needs --sitemap with --state, or --urls", () => {
	assert.match(run("indexnow.mjs", []).err, /Give --sitemap or --urls/);
	assert.match(
		run("indexnow.mjs", ["--sitemap", "https://example.com/sitemap.xml"]).err,
		/--state/,
	);
	assert.equal(run("indexnow.mjs", ["--urls", "ftp://example.com/a"]).code, 64);
});

test("indexnow.mjs without INDEXNOW_KEY says how to make one", () => {
	const r = run("indexnow.mjs", ["--urls", "https://example.com/a"]);
	assert.equal(r.code, 2);
	assert.match(r.err, /INDEXNOW_KEY is not set/);
});

test("indexnow.mjs rejects a malformed key", () => {
	const r = run("indexnow.mjs", ["--urls", "https://example.com/a"], { INDEXNOW_KEY: "short" });
	assert.equal(r.code, 2);
	assert.match(r.err, /8 to 128/);
});

test("indexnow.mjs --dry-run with --urls needs no key and no network", () => {
	const r = run("indexnow.mjs", [
		"--urls",
		"https://example.com/a,https://example.com/b",
		"--dry-run",
	]);
	assert.equal(r.code, 0, r.err);
	assert.match(r.out, /Would send 2 URLs for example.com/);
});

test("aio-monitor.mjs requires --prompts and --domain", () => {
	assert.match(run("aio-monitor.mjs", []).err, /--prompts/);
	assert.match(run("aio-monitor.mjs", ["--prompts", examplePrompts]).err, /--domain/);
	assert.match(
		run("aio-monitor.mjs", ["--prompts", examplePrompts, "--domain", "not a domain"]).err,
		/--domain needs/,
	);
	assert.match(
		run("aio-monitor.mjs", [
			"--prompts",
			examplePrompts,
			"--domain",
			"example.com",
			"--engines",
			"bard",
		]).err,
		/Unknown engine/,
	);
	assert.match(
		run("aio-monitor.mjs", ["--prompts", "missing.json", "--domain", "example.com"]).err,
		/No prompt file/,
	);
});

test("aio-monitor.mjs --dry-run prints the plan and the cost without a token", () => {
	const r = run("aio-monitor.mjs", [
		"--prompts",
		examplePrompts,
		"--domain",
		"example.com",
		"--dry-run",
	]);
	assert.equal(r.code, 0, r.err);
	assert.match(r.out, /5 prompts, 25 answers to collect/);
	assert.match(r.out, /Estimated cost at most \$/);
});

test("aio-monitor.mjs without SCRAPELESS_API_TOKEN says how to set it", () => {
	const r = run("aio-monitor.mjs", [
		"--prompts",
		examplePrompts,
		"--domain",
		"example.com",
		"--out",
		path.join(root, "test", ".tmp-never-written"),
	]);
	assert.equal(r.code, 2);
	assert.match(r.err, /SCRAPELESS_API_TOKEN is not set/);
});

test("the example prompt file is valid", async () => {
	const { loadPrompts } = await import(path.join(scripts, "aio-monitor.mjs"));
	const prompts = loadPrompts(readFileSync(examplePrompts, "utf8"));
	assert.equal(prompts.length, 5);
	assert.equal(prompts.find((p) => p.lang === "ja").country, "JP");
});
