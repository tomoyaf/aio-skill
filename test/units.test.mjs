// Unit tests of the pure parts: reading an answer, sitemaps, IndexNow diffs, ranges.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = path.join(root, "plugins/aio-cycle/skills/aio-cycle/scripts");
const fixture = (name) => JSON.parse(readFileSync(path.join(root, "test/fixtures", name), "utf8"));

const monitor = await import(path.join(scripts, "aio-monitor.mjs"));
const gsc = await import(path.join(scripts, "gsc.mjs"));
const indexnow = await import(path.join(scripts, "indexnow.mjs"));
const lib = await import(path.join(scripts, "lib.mjs"));

test("a ChatGPT answer: citations, searched pages, fan-out, and mentions", () => {
	const r = fixture("chatgpt.json").task_result;
	const a = monitor.analyzeAnswer("chatgpt", r, {
		domain: "netlify.com",
		brands: ["Netlify"],
		competitors: ["GitHub Pages", "Vercel"],
	});
	assert.equal(a.cited, true);
	assert.equal(a.mentioned, true);
	assert.ok(a.citations.some((c) => c.searched && c.domain === "github.com"));
	assert.ok(
		a.citations.every((c) => !/utm_source/.test(c.url)),
		"tracking parameters are removed",
	);
	assert.ok(a.fanout.length > 0 && a.fanout.every((f) => f.kind === "search"));
	assert.ok(a.competitors.includes("GitHub Pages"));
});

test("an answer that never names or cites the domain counts as neither", () => {
	for (const engine of ["chatgpt", "perplexity", "gemini", "aimode"]) {
		const r = fixture(`${engine}.json`).task_result;
		const a = monitor.analyzeAnswer(engine, r, {
			domain: "no-such-brand-xyz.com",
			brands: ["Nosuchbrandxyz"],
			competitors: [],
		});
		assert.equal(a.mentioned, false, engine);
		assert.equal(a.cited, false, engine);
		assert.ok(a.text.length > 0, `${engine} has answer text`);
	}
});

test("Perplexity's related prompts are follow-ups, not searches", () => {
	const fan = monitor.extractFanout({
		related_prompt: ["a", "b"],
		search_model_queries: { queries: ["c"] },
	});
	assert.deepEqual(fan, [
		{ query: "c", kind: "search" },
		{ query: "a", kind: "related" },
		{ query: "b", kind: "related" },
	]);
});

test("a brand name matches as a word, not inside another word", () => {
	assert.equal(monitor.names("Try Acme today", "Acme"), true);
	assert.equal(monitor.names("Acmeville is a town", "Acme"), false);
	assert.equal(monitor.names("コンビカを使う", "コンビカ"), true);
});

test("jobs ask every first run before any second run", () => {
	const prompts = [{ id: "p1" }, { id: "p2" }];
	const jobs = monitor.planJobs(prompts, ["chatgpt", "gemini"], { chatgpt: 2, gemini: 1 });
	assert.deepEqual(
		jobs.map((j) => `${j.engine}:${j.prompt.id}:${j.run}`),
		["chatgpt:p1:1", "gemini:p1:1", "chatgpt:p2:1", "gemini:p2:1", "chatgpt:p1:2", "chatgpt:p2:2"],
	);
});

test("prompt files: duplicates and missing text are refused, retired prompts skipped", () => {
	assert.throws(
		() => monitor.loadPrompts('{"prompts":[{"id":"a","prompt":"x"},{"id":"a","prompt":"y"}]}'),
		/used twice/,
	);
	assert.throws(() => monitor.loadPrompts('{"prompts":[{"id":"a"}]}'), /prompt text/);
	assert.equal(
		monitor.loadPrompts('[{"id":"a","prompt":"x","retired":"2026-01-01"},{"id":"b","prompt":"y"}]')
			.length,
		1,
	);
});

test("Google results take the domain from the link or the source name", () => {
	const results = monitor.parseOrganic(fixture("google-serp.json"));
	assert.ok(results.length > 0);
	assert.equal(results[0].domain, "formgrid.dev");
});

test("the report shows rates with intervals and the cited domains", () => {
	const r = fixture("chatgpt.json").task_result;
	const opts = {
		domain: "netlify.com",
		brands: ["Netlify"],
		competitors: ["Vercel"],
		engines: ["chatgpt"],
		date: "2026-10-18",
	};
	const a = {
		engine: "chatgpt",
		promptId: "p1",
		run: 1,
		group: "all",
		...monitor.analyzeAnswer("chatgpt", r, opts),
	};
	const report = monitor.buildReport(opts, [a], [], { llm: 1, serp: 0 }, []);
	assert.match(report, /\| ChatGPT \| 1 \| 1\/1 \(100%, CI 21-100%\)/);
	assert.match(report, /netlify\.com \(you\)/);
});

test("Wilson interval", () => {
	assert.deepEqual(lib.wilson(0, 0), { rate: 0, low: 0, high: 0 });
	assert.deepEqual(lib.wilson(4, 72), { rate: 6, low: 2, high: 13 });
});

test("sitemaps and sitemap indexes", () => {
	const xml = `<urlset><url><loc>https://a.com/x?a=1&amp;b=2</loc></url><url><loc><![CDATA[https://a.com/y]]></loc></url><url><loc>https://a.com/y</loc></url></urlset>`;
	assert.deepEqual(gsc.parseSitemap(xml), {
		urls: ["https://a.com/x?a=1&b=2", "https://a.com/y"],
		children: [],
	});
	assert.deepEqual(
		gsc.parseSitemap(
			"<sitemapindex><sitemap><loc>https://a.com/s1.xml</loc></sitemap></sitemapindex>",
		).children,
		["https://a.com/s1.xml"],
	);
});

test("a Domain property covers subdomains; a URL-prefix property only its prefix", () => {
	assert.equal(gsc.siteCovers("sc-domain:example.com", "https://blog.example.com/a"), true);
	assert.equal(gsc.siteCovers("sc-domain:example.com", "https://example.org/a"), false);
	assert.equal(gsc.siteCovers("https://www.example.com/", "https://www.example.com/a"), true);
	assert.equal(gsc.siteCovers("https://www.example.com/", "https://example.com/a"), false);
});

test("performance ranges end yesterday in Pacific time", () => {
	const now = Date.parse("2026-10-18T05:00:00Z"); // 10-17 22:00 in Los Angeles
	assert.deepEqual(gsc.resolveRange({ days: 7 }, now), {
		startDate: "2026-10-10",
		endDate: "2026-10-16",
	});
	assert.equal(gsc.lastCompleteDay("2026-10-16", "2026-10-15"), "2026-10-14");
});

test("compare finds new and lost rows", () => {
	const r = (k, clicks, impressions) => ({ keys: [k], clicks, impressions, ctr: 0, position: 5 });
	const out = gsc.compareRows([r("a", 5, 50), r("b", 0, 9)], [r("a", 2, 20), r("c", 3, 30)], 10);
	assert.deepEqual(
		out.fresh.map((x) => x.keys[0]),
		["b"],
	);
	assert.deepEqual(
		out.lost.map((x) => x.keys[0]),
		["c"],
	);
	assert.equal(gsc.change(5, 2), "+150%");
});

test("the hash ignores scripts and asset names but sees the title and text", () => {
	const page = (title, script, text) =>
		`<html><head><title>${title}</title><script src="/a-${script}.js"></script></head><body><main><p>${text}</p><script>x=${script}</script></main></body></html>`;
	assert.equal(indexnow.pageHash(page("T", 1, "hello")), indexnow.pageHash(page("T", 2, "hello")));
	assert.notEqual(
		indexnow.pageHash(page("T", 1, "hello")),
		indexnow.pageHash(page("U", 1, "hello")),
	);
	assert.notEqual(indexnow.pageHash(page("T", 1, "hello")), indexnow.pageHash(page("T", 1, "bye")));
});

test("IndexNow diff: new, changed after a day, held within a day, removed", () => {
	const now = Date.parse("2026-10-18T00:00:00Z");
	const prev = {
		"https://a.com/old": { hash: "1", sentAt: "2026-10-16T00:00:00Z" },
		"https://a.com/recent": { hash: "1", sentAt: "2026-10-17T12:00:00Z" },
		"https://a.com/same": { hash: "1", sentAt: "2026-10-01T00:00:00Z" },
		"https://a.com/gone": { hash: "1", sentAt: "2026-10-01T00:00:00Z" },
	};
	const sitemap = [
		"https://a.com/new",
		"https://a.com/old",
		"https://a.com/recent",
		"https://a.com/same",
	];
	const current = {
		"https://a.com/new": "2",
		"https://a.com/old": "2",
		"https://a.com/recent": "2",
		"https://a.com/same": "1",
	};
	assert.deepEqual(indexnow.diffPages(prev, sitemap, current, now), {
		added: ["https://a.com/new"],
		changed: ["https://a.com/old"],
		held: ["https://a.com/recent"],
		removed: ["https://a.com/gone"],
		unchanged: ["https://a.com/same"],
	});
});

test("IndexNow payloads: one per host, key file at the host root", () => {
	const p = indexnow.payloads(
		["https://a.com/1", "https://b.a.com/2", "https://a.com/3"],
		"k".repeat(16),
	);
	assert.equal(p.length, 2);
	assert.equal(p[0].keyLocation, `https://a.com/${"k".repeat(16)}.txt`);
	assert.deepEqual(p[0].urlList, ["https://a.com/1", "https://a.com/3"]);
});
