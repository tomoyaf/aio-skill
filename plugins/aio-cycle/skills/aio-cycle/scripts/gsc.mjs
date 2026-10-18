#!/usr/bin/env node
// Google Search Console for any site, through its API, with a service account.
// Reads clicks, impressions, and positions; compares two periods; checks whether
// pages are indexed; lists and submits sitemaps. Node 20+, no dependencies.
//
// Credentials come from your environment only:
//   GSC_SITE                       sc-domain:example.com  or  https://www.example.com/
//   GSC_SERVICE_ACCOUNT_KEY_FILE   path to the service account's JSON key
//   GSC_SERVICE_ACCOUNT_KEY_B64    or the same JSON key, base64 on one line
// The service account must be added as a user of the property in Search Console.
// The script calls only oauth2.googleapis.com and searchconsole.googleapis.com,
// and never prints the key or the access token.

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
	addDays,
	bareDomain,
	cell,
	dateIn,
	fetchWithTimeout,
	isDate,
	parseFlags,
	requireEnv,
	runMain,
	SetupError,
	sleep,
	UsageError,
} from "./lib.mjs";

export const USAGE = `Usage: node gsc.mjs <command> [options]

Commands:
  performance     clicks, impressions, CTR, position
                  [--days 28 | --since YYYY-MM-DD --until YYYY-MM-DD]
                  [--dimensions query,page,country,device,date] [--page-prefix /blog/]
                  [--query-contains text] [--country usa] [--limit 50] [--json]
  compare         the last N complete days against the N before them [--days 7] [--limit 15] [--json]
  inspect         is each page indexed?  <url...> | --sitemap <sitemap URL> [--limit 50] [--json]
  sitemaps        the sitemaps Search Console has for the site [--json]
  submit-sitemap  submit or resubmit sitemaps  <sitemap URL...>

Every command takes --site to override GSC_SITE.

Environment:
  GSC_SITE                      sc-domain:example.com or https://www.example.com/
  GSC_SERVICE_ACCOUNT_KEY_FILE  path to the service account JSON key
  GSC_SERVICE_ACCOUNT_KEY_B64   or the JSON key in base64`;

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_ROOT = "https://searchconsole.googleapis.com";
const ALLOWED_HOSTS = new Set(["oauth2.googleapis.com", "searchconsole.googleapis.com"]);
const SCOPE_READ = "https://www.googleapis.com/auth/webmasters.readonly";
const SCOPE_WRITE = "https://www.googleapis.com/auth/webmasters";
export const DIMENSIONS = ["query", "page", "country", "device", "date", "searchAppearance"];
/** Google's daily URL Inspection quota for one property. */
export const MAX_INSPECTIONS = 2000;
const ROWS_PER_REQUEST = 25_000;
const MAX_ROWS = 100_000;
const SETUP_HINT =
	"Create a service account in Google Cloud, enable the Search Console API, add the account's email as a user of your property in Search Console, then set GSC_SERVICE_ACCOUNT_KEY_FILE to its JSON key file (or GSC_SERVICE_ACCOUNT_KEY_B64 to the key in base64).";

const FLAGS = {
	site: "string",
	days: "number",
	since: "string",
	until: "string",
	dimensions: "list",
	"page-prefix": "string",
	"query-contains": "string",
	country: "string",
	limit: "number",
	sitemap: "string",
	json: "boolean",
	help: "boolean",
};

const COMMANDS = new Set(["performance", "compare", "inspect", "sitemaps", "submit-sitemap"]);

// ---------------------------------------------------------------------------
// Arguments and setup

export function parseArgs(argv) {
	const [command, ...rest] = argv;
	if (!command || command === "--help" || command === "-h" || command === "help") {
		return { command: "help" };
	}
	if (!COMMANDS.has(command)) throw new UsageError(`Unknown command "${command}"`);
	const { flags, positional } = parseFlags(rest, FLAGS);
	if (flags.help) return { command: "help" };
	for (const d of flags.dimensions ?? []) {
		if (!DIMENSIONS.includes(d)) {
			throw new UsageError(`Unknown dimension "${d}". Use: ${DIMENSIONS.join(", ")}`);
		}
	}
	if ((flags.dimensions ?? []).includes("searchAppearance") && flags.dimensions.length > 1) {
		throw new UsageError("Google takes searchAppearance only on its own");
	}
	for (const name of ["since", "until"]) {
		if (flags[name] !== undefined && !isDate(flags[name])) {
			throw new UsageError(`--${name} needs a date as YYYY-MM-DD`);
		}
	}
	if ((flags.since === undefined) !== (flags.until === undefined)) {
		throw new UsageError("--since and --until go together");
	}
	if (flags.since && flags.days !== undefined)
		throw new UsageError("Use --days or --since/--until");
	if (command === "inspect" && positional.length === 0 && !flags.sitemap) {
		throw new UsageError("inspect needs URLs or --sitemap <URL>");
	}
	if (command === "submit-sitemap" && positional.length === 0) {
		throw new UsageError("submit-sitemap needs at least one sitemap URL");
	}
	for (const url of [...positional, ...(flags.sitemap ? [flags.sitemap] : [])]) {
		if (!/^https?:\/\/[^/]+/.test(url)) throw new UsageError(`Not a URL: ${url}`);
	}
	return { command, flags, positional };
}

/** The property, as Search Console names it: sc-domain:example.com or https://example.com/. */
export function resolveSite(flags, env) {
	const site =
		flags.site ??
		requireEnv(
			env,
			"GSC_SITE",
			"Set it to sc-domain:example.com (a Domain property) or https://www.example.com/ (a URL-prefix property).",
		);
	if (/^sc-domain:[a-z0-9.-]+\.[a-z]{2,}$/i.test(site)) return site.toLowerCase();
	if (/^https?:\/\/[^/]+\/$/.test(site)) return site;
	if (/^https?:\/\/[^/]+$/.test(site)) return `${site}/`;
	throw new SetupError(
		`"${site}" is not a Search Console property. Use sc-domain:example.com or https://www.example.com/`,
	);
}

/** The property covers the URL (a Domain property covers every subdomain). */
export function siteCovers(site, url) {
	if (site.startsWith("sc-domain:")) {
		const domain = site.slice("sc-domain:".length);
		const host = (() => {
			try {
				return new URL(url).hostname.toLowerCase();
			} catch {
				return "";
			}
		})();
		return host === domain || host.endsWith(`.${domain}`);
	}
	return url.startsWith(site);
}

export function parseServiceAccountKey(json) {
	const invalid = new SetupError(
		"The service account key is not a Google service account JSON key. Download a new JSON key for the service account in Google Cloud.",
	);
	let key;
	try {
		key = JSON.parse(json);
	} catch {
		throw invalid; // JSON.parse's message would quote part of the key.
	}
	if (
		!key ||
		key.type !== "service_account" ||
		typeof key.client_email !== "string" ||
		typeof key.private_key !== "string" ||
		!key.private_key.includes("PRIVATE KEY-----")
	) {
		throw invalid;
	}
	return { clientEmail: key.client_email, privateKey: key.private_key };
}

export function loadServiceAccountKey(env) {
	const file = env.GSC_SERVICE_ACCOUNT_KEY_FILE?.trim();
	if (file) {
		let text;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			throw new SetupError(`GSC_SERVICE_ACCOUNT_KEY_FILE points at ${file}, which can't be read.`);
		}
		return parseServiceAccountKey(text);
	}
	const b64 = env.GSC_SERVICE_ACCOUNT_KEY_B64?.trim();
	if (b64) return parseServiceAccountKey(Buffer.from(b64, "base64").toString("utf8"));
	throw new SetupError(
		`Neither GSC_SERVICE_ACCOUNT_KEY_FILE nor GSC_SERVICE_ACCOUNT_KEY_B64 is set. ${SETUP_HINT}`,
	);
}

// ---------------------------------------------------------------------------
// Google API

const b64url = (input) => Buffer.from(input).toString("base64url");

export function signedAssertion(key, scope, nowMs) {
	const iat = Math.floor(nowMs / 1000);
	const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const claims = b64url(
		JSON.stringify({ iss: key.clientEmail, scope, aud: TOKEN_URL, iat, exp: iat + 3600 }),
	);
	const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(key.privateKey);
	return `${header}.${claims}.${b64url(signature)}`;
}

class GoogleError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

async function googleFetch(url, init) {
	const parsed = new URL(url);
	if (parsed.protocol !== "https:" || !ALLOWED_HOSTS.has(parsed.hostname)) {
		throw new Error(`Refusing to call ${parsed.origin}`);
	}
	return fetchWithTimeout(url, { ...init, redirect: "error" }, 60_000);
}

async function errorText(response) {
	const text = await response.text().catch(() => "");
	try {
		const body = JSON.parse(text);
		if (body.error?.message) return body.error.message;
		if (typeof body.error === "string") {
			return body.error_description ? `${body.error}: ${body.error_description}` : body.error;
		}
	} catch {
		// not JSON
	}
	return text.slice(0, 300) || response.statusText;
}

export async function getAccessToken(key, scope) {
	const response = await googleFetch(TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
			assertion: signedAssertion(key, scope, Date.now()),
		}).toString(),
	});
	if (!response.ok) {
		throw new GoogleError(
			response.status,
			`Google refused the service account ${key.clientEmail} (${response.status}): ${await errorText(response)}`,
		);
	}
	const json = await response.json();
	if (typeof json.access_token !== "string") throw new Error("Google sent no access token");
	return json.access_token;
}

export class SearchConsole {
	constructor(site, token) {
		this.site = site;
		this.token = token;
		this.base = `${API_ROOT}/webmasters/v3/sites/${encodeURIComponent(site)}`;
	}

	async call(method, url, body) {
		for (let attempt = 1; ; attempt++) {
			const response = await googleFetch(url, {
				method,
				headers: {
					authorization: `Bearer ${this.token}`,
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			if (response.ok) {
				const text = await response.text();
				return text ? JSON.parse(text) : {};
			}
			const message = `${response.status} ${await errorText(response)}`;
			if (response.status >= 500 && attempt < 2) {
				await sleep(2000);
				continue;
			}
			if (response.status === 403) {
				throw new GoogleError(
					403,
					`${message}\nIs the service account a user of ${this.site} in Search Console, and is the Search Console API enabled in its Google Cloud project?`,
				);
			}
			throw new GoogleError(response.status, message);
		}
	}

	inspect(url) {
		return this.call("POST", `${API_ROOT}/v1/urlInspection/index:inspect`, {
			inspectionUrl: url,
			siteUrl: this.site,
			languageCode: "en-US",
		});
	}

	listSitemaps() {
		return this.call("GET", `${this.base}/sitemaps`);
	}

	submitSitemap(feed) {
		return this.call("PUT", `${this.base}/sitemaps/${encodeURIComponent(feed)}`);
	}

	query(body) {
		return this.call("POST", `${this.base}/searchAnalytics/query`, body);
	}
}

// ---------------------------------------------------------------------------
// Performance

/** Days are Pacific time, as Search Console counts them. */
export function resolveRange(flags, nowMs = Date.now()) {
	if (flags.since) return { startDate: flags.since, endDate: flags.until };
	const yesterday = addDays(dateIn("America/Los_Angeles", nowMs), -1);
	const days = flags.days ?? 28;
	if (days < 1) throw new UsageError("--days needs 1 or more");
	return { startDate: addDays(yesterday, -(days - 1)), endDate: yesterday };
}

export function buildFilters(flags, site) {
	const filters = [];
	if (flags["page-prefix"]) {
		const prefix = flags["page-prefix"];
		let expression = prefix;
		if (prefix.startsWith("/")) {
			expression = site.startsWith("sc-domain:")
				? `https://${site.slice("sc-domain:".length)}${prefix}`
				: new URL(prefix, site).toString();
		}
		filters.push({
			dimension: "page",
			operator: "includingRegex",
			expression: `^${expression.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
		});
	}
	if (flags["query-contains"]) {
		filters.push({ dimension: "query", operator: "contains", expression: flags["query-contains"] });
	}
	if (flags.country) {
		filters.push({
			dimension: "country",
			operator: "equals",
			expression: flags.country.toLowerCase(),
		});
	}
	return filters.length ? [{ groupType: "and", filters }] : undefined;
}

export async function queryAll(client, query, max = MAX_ROWS) {
	const rows = [];
	let metadata = null;
	for (;;) {
		const rowLimit = Math.min(ROWS_PER_REQUEST, max - rows.length);
		const response = await client.query({
			...query,
			type: "web",
			dataState: "all",
			rowLimit,
			startRow: rows.length,
		});
		metadata ??= response.metadata ?? null;
		const page = response.rows ?? [];
		for (const row of page) {
			rows.push({
				keys: row.keys ?? [],
				clicks: row.clicks ?? 0,
				impressions: row.impressions ?? 0,
				ctr: row.ctr ?? 0,
				position: row.position ?? 0,
			});
		}
		if (page.length < rowLimit || rows.length >= max) return { rows, metadata };
	}
}

export function totals(rows) {
	let clicks = 0;
	let impressions = 0;
	let weighted = 0;
	for (const r of rows) {
		clicks += r.clicks;
		impressions += r.impressions;
		weighted += r.position * r.impressions;
	}
	return {
		clicks,
		impressions,
		ctr: impressions ? clicks / impressions : 0,
		position: impressions ? weighted / impressions : 0,
	};
}

const byClicks = (a, b) => b.clicks - a.clicks || b.impressions - a.impressions;

function metricCells(m) {
	return `${m.clicks} | ${m.impressions} | ${(m.ctr * 100).toFixed(1)}% | ${m.position ? m.position.toFixed(1) : "-"}`;
}

export function change(now, before) {
	if (before === 0) return now === 0 ? "0" : "new";
	const pct = Math.round(((now - before) / before) * 100);
	return `${pct >= 0 ? "+" : ""}${pct}%`;
}

async function performance(client, flags, site) {
	const range = resolveRange(flags);
	const dimensions = flags.dimensions ?? ["query"];
	const filters = buildFilters(flags, site);
	const [{ rows }, overall] = await Promise.all([
		queryAll(client, { ...range, dimensions, dimensionFilterGroups: filters }),
		queryAll(client, { ...range, dimensionFilterGroups: filters }),
	]);
	const sorted = [...rows].sort(byClicks);
	const limit = flags.limit ?? 50;
	const sum = overall.rows[0] ?? totals([]);
	if (flags.json) {
		console.log(
			JSON.stringify(
				{ site, ...range, dimensions, total: sum, rows: sorted.slice(0, limit) },
				null,
				2,
			),
		);
		return;
	}
	console.log(
		`# Search performance, ${site}, ${range.startDate} to ${range.endDate} (Pacific time)\n`,
	);
	console.log(
		`Total: ${sum.clicks} clicks, ${sum.impressions} impressions, CTR ${(sum.ctr * 100).toFixed(1)}%, position ${sum.position ? sum.position.toFixed(1) : "-"}\n`,
	);
	console.log(`| ${dimensions.join(" | ")} | Clicks | Impressions | CTR | Position |`);
	console.log(`|${" --- |".repeat(dimensions.length + 4)}`);
	for (const row of sorted.slice(0, limit)) {
		console.log(`| ${row.keys.map((k) => cell(k)).join(" | ")} | ${metricCells(row)} |`);
	}
	if (sorted.length > limit)
		console.log(`\n${sorted.length - limit} more rows; raise --limit to see them.`);
	console.log(
		"\nAI Overviews and AI Mode are inside these numbers: the API has no filter that separates them.",
	);
}

/** The last day Google has finished counting: the day before the first incomplete one. */
export function lastCompleteDay(yesterday, firstIncompleteDate) {
	if (!firstIncompleteDate) return yesterday;
	const day = addDays(firstIncompleteDate, -1);
	return day < yesterday ? day : yesterday;
}

export function compareRows(nowRows, beforeRows, limit) {
	const before = new Map(beforeRows.map((r) => [r.keys.join("\u0000"), r]));
	const rows = [...nowRows]
		.sort(byClicks)
		.slice(0, limit)
		.map((r) => ({
			key: r.keys.join(" / "),
			now: r,
			before: before.get(r.keys.join("\u0000")) ?? null,
		}));
	const nowKeys = new Set(nowRows.map((r) => r.keys.join("\u0000")));
	const fresh = nowRows
		.filter((r) => !before.has(r.keys.join("\u0000")))
		.sort((a, b) => b.impressions - a.impressions)
		.slice(0, limit);
	const lost = beforeRows
		.filter((r) => !nowKeys.has(r.keys.join("\u0000")) && r.clicks > 0)
		.sort(byClicks)
		.slice(0, limit);
	return { rows, fresh, lost };
}

async function compare(client, flags, site) {
	const days = flags.days ?? 7;
	const limit = flags.limit ?? 15;
	const yesterday = addDays(dateIn("America/Los_Angeles"), -1);
	const probe = await queryAll(client, {
		startDate: addDays(yesterday, -9),
		endDate: yesterday,
		dimensions: ["date"],
	});
	const end = lastCompleteDay(yesterday, probe.metadata?.firstIncompleteDate ?? null);
	const now = { startDate: addDays(end, -(days - 1)), endDate: end };
	const prev = { startDate: addDays(end, -(2 * days - 1)), endDate: addDays(end, -days) };
	const read = async (range, dimensions) => (await queryAll(client, { ...range, dimensions })).rows;
	const [tNow, tPrev, qNow, qPrev, pNow, pPrev] = await Promise.all([
		read(now, undefined),
		read(prev, undefined),
		read(now, ["query"]),
		read(prev, ["query"]),
		read(now, ["page"]),
		read(prev, ["page"]),
	]);
	const a = tNow[0] ?? totals([]);
	const b = tPrev[0] ?? totals([]);
	const queries = compareRows(qNow, qPrev, limit);
	const pages = compareRows(pNow, pPrev, limit);
	if (flags.json) {
		console.log(
			JSON.stringify({ site, now, prev, total: { now: a, prev: b }, queries, pages }, null, 2),
		);
		return;
	}
	console.log(
		`# ${site}: ${now.startDate} to ${now.endDate} against ${prev.startDate} to ${prev.endDate}\n`,
	);
	console.log("| | Clicks | Impressions | CTR | Position |\n| --- | --- | --- | --- | --- |");
	console.log(`| Last ${days} days | ${metricCells(a)} |`);
	console.log(`| ${days} days before | ${metricCells(b)} |`);
	console.log(
		`| Change | ${change(a.clicks, b.clicks)} | ${change(a.impressions, b.impressions)} | | |\n`,
	);
	for (const [title, set] of [
		["Queries", queries],
		["Pages", pages],
	]) {
		console.log(`## ${title}, top ${limit} by clicks\n`);
		console.log(
			"| | Clicks (before) | Impressions (before) | Position |\n| --- | --- | --- | --- |",
		);
		for (const r of set.rows) {
			console.log(
				`| ${cell(r.key)} | ${r.now.clicks} (${r.before?.clicks ?? 0}) | ${r.now.impressions} (${r.before?.impressions ?? 0}) | ${r.now.position.toFixed(1)} |`,
			);
		}
		console.log(`\n### ${title} new this period (no impressions in the ${days} days before)\n`);
		if (!set.fresh.length) console.log("None.");
		for (const r of set.fresh) {
			console.log(
				`- ${cell(r.keys.join(" / "))}: ${r.impressions} impressions, ${r.clicks} clicks, position ${r.position.toFixed(1)}`,
			);
		}
		console.log(`\n### ${title} that had clicks before and none now\n`);
		if (!set.lost.length) console.log("None.");
		for (const r of set.lost)
			console.log(`- ${cell(r.keys.join(" / "))}: ${r.clicks} clicks before`);
		console.log("");
	}
}

// ---------------------------------------------------------------------------
// Inspection and sitemaps

/** The <loc> of every <url> (or child <sitemap>) in a sitemap, in order, without duplicates. */
export function parseSitemap(xml) {
	const decode = (s) =>
		s
			.replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, "")
			.trim()
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&quot;/g, '"')
			.replace(/&apos;/g, "'")
			.replace(/&amp;/g, "&");
	const urls = [];
	const children = [];
	for (const [, tag, body] of xml.matchAll(/<(url|sitemap)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
		const loc = body.match(/<loc\b[^>]*>([\s\S]*?)<\/loc>/i)?.[1];
		if (!loc) continue;
		const value = decode(loc);
		const list = tag.toLowerCase() === "url" ? urls : children;
		if (value && !list.includes(value)) list.push(value);
	}
	return { urls, children };
}

/** Every page URL in a sitemap, following a sitemap index one level down. */
export async function sitemapUrls(sitemapUrl) {
	const get = async (url) => {
		const response = await fetchWithTimeout(
			url,
			{ headers: { "user-agent": "aio-cycle" } },
			30_000,
		);
		if (!response.ok) throw new Error(`${url} answered ${response.status}`);
		return parseSitemap(await response.text());
	};
	const top = await get(sitemapUrl);
	const urls = [...top.urls];
	for (const child of top.children) {
		for (const url of (await get(child)).urls) if (!urls.includes(url)) urls.push(url);
	}
	return urls;
}

export function adviseIndexing(status) {
	if (status.verdict === "PASS") return "indexed";
	const reason = status.coverageState ?? "no coverage state";
	return `not indexed (${reason}): request indexing by hand in Search Console, URL Inspection`;
}

async function inspect(client, flags, positional, site) {
	let urls = positional;
	if (flags.sitemap) urls = [...urls, ...(await sitemapUrls(flags.sitemap))];
	urls = [...new Set(urls)];
	const outside = urls.filter((u) => !siteCovers(site, u));
	if (outside.length) {
		throw new UsageError(`Not in ${site}: ${outside.slice(0, 5).join(", ")}`);
	}
	const limit = Math.min(flags.limit ?? 50, MAX_INSPECTIONS);
	const todo = urls.slice(0, limit);
	const results = [];
	let failuresInARow = 0;
	for (const url of todo) {
		try {
			const r = await client.inspect(url);
			const status = r.inspectionResult?.indexStatusResult ?? {};
			results.push({
				url,
				verdict: status.verdict ?? null,
				coverageState: status.coverageState ?? null,
				lastCrawlTime: status.lastCrawlTime ?? null,
				googleCanonical: status.googleCanonical ?? null,
				userCanonical: status.userCanonical ?? null,
				advice: adviseIndexing(status),
			});
			failuresInARow = 0;
			if (!flags.json)
				console.log(
					`${url}\n  ${results.at(-1).advice}; last crawl ${status.lastCrawlTime ?? "never"}`,
				);
		} catch (error) {
			if (error.status === 429) {
				console.error("Google's inspection quota is used up for today. Run again tomorrow.");
				break;
			}
			if (error.status === 401 || error.status === 403) throw error;
			results.push({ url, error: error.message });
			if (!flags.json) console.log(`${url}\n  failed: ${error.message}`);
			if (++failuresInARow >= 3) {
				console.error("3 failures in a row; stopping.");
				break;
			}
		}
	}
	const notIndexed = results.filter((r) => r.verdict && r.verdict !== "PASS");
	if (flags.json) {
		console.log(
			JSON.stringify({ site, inspected: results, notReached: urls.slice(results.length) }, null, 2),
		);
	} else {
		console.log(
			`\n${results.length} inspected, ${notIndexed.length} not indexed, ${urls.length - results.length} not reached (--limit ${limit}).`,
		);
		console.log(
			"Requesting indexing has no public API for normal pages. Request the not-indexed ones in Search Console (about 10 a day), most important first.",
		);
	}
	return 0;
}

async function sitemaps(client, flags) {
	const list = (await client.listSitemaps()).sitemap ?? [];
	if (flags.json) {
		console.log(JSON.stringify(list, null, 2));
		return;
	}
	if (!list.length) console.log("No sitemaps. Submit one with: node gsc.mjs submit-sitemap <URL>");
	for (const s of list) {
		const submitted = (s.contents ?? [])
			.map((c) => `${c.submitted ?? "?"} ${c.type ?? ""}`)
			.join(", ");
		console.log(
			`${s.path}\n  last submitted ${s.lastSubmitted ?? "-"}, last read ${s.lastDownloaded ?? "-"}, errors ${s.errors ?? 0}, warnings ${s.warnings ?? 0}${submitted ? `, ${submitted}` : ""}`,
		);
	}
}

async function submitSitemaps(client, positional, site) {
	let ok = true;
	for (const feed of positional) {
		if (!siteCovers(site, feed)) {
			console.log(`Skipped ${feed}: not in ${site}`);
			ok = false;
			continue;
		}
		try {
			await client.submitSitemap(feed);
			console.log(`Submitted ${feed}`);
		} catch (error) {
			console.log(`Failed ${feed}: ${error.message}`);
			ok = false;
		}
	}
	return ok ? 0 : 1;
}

// ---------------------------------------------------------------------------

export async function main(argv, env) {
	const args = parseArgs(argv);
	if (args.command === "help") {
		console.log(USAGE);
		return 0;
	}
	const site = resolveSite(args.flags, env);
	if (!bareDomain(site)) throw new SetupError(`Can't read a domain from ${site}`);
	const key = loadServiceAccountKey(env);
	const scope = args.command === "submit-sitemap" ? SCOPE_WRITE : SCOPE_READ;
	const client = new SearchConsole(site, await getAccessToken(key, scope));
	switch (args.command) {
		case "performance":
			return performance(client, args.flags, site);
		case "compare":
			return compare(client, args.flags, site);
		case "inspect":
			return inspect(client, args.flags, args.positional, site);
		case "sitemaps":
			return sitemaps(client, args.flags);
		case "submit-sitemap":
			return submitSitemaps(client, args.positional, site);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runMain(main, USAGE);
}
