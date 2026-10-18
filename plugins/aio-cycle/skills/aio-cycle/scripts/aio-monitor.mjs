#!/usr/bin/env node
// Asks AI assistants the questions your customers ask, and records whether the
// answers name your brand or cite your domain, which domains and competitors
// they cite and name instead, and what the assistants searched for on the way
// (fan-out). With --serp it then looks those searches up in Google, to see which
// pages win the queries the assistants actually run. Node 20+, no dependencies.
//
// The answers are collected through Scrapeless (https://www.scrapeless.com),
// whose scrapers ask ChatGPT, Perplexity, Gemini, Google AI Mode, Google AI
// Overview, and Copilot as a signed-out user would, and return the answer with
// its citations. Each task is billed by Scrapeless; see their pricing page.
//
// Environment:
//   SCRAPELESS_API_TOKEN   your Scrapeless API token (not needed for --dry-run)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	bareDomain,
	cell,
	dateIn,
	fetchWithTimeout,
	formatRate,
	hostOf,
	isDate,
	isOnDomain,
	normalizeUrl,
	parseFlags,
	registrableDomain,
	requireEnv,
	runMain,
	SetupError,
	sleep,
	toJsonl,
	UsageError,
} from "./lib.mjs";

export const USAGE = `Usage: node aio-monitor.mjs --prompts <prompts.json> --domain <example.com> [options]

Options:
  --brand a,b             names that count as a mention of you (default: the domain's first label)
  --competitors a,b       brand names to count in the answers
  --engines a,b           chatgpt, perplexity, gemini, aimode, overview, copilot
                          (default: chatgpt,perplexity,gemini,aimode)
  --runs N | e=N,...      times each prompt is asked per engine (default: chatgpt=2, others 1)
  --max-calls N           most answer tasks to create, retries included (default 100)
  --serp                  look up the engines' fan-out searches in Google
  --max-serp-calls N      most Google tasks to create (default 40)
  --out DIR               where data and the report go (default ./aio-data)
  --date YYYY-MM-DD       the run's date (default: today, UTC)
  --concurrency N         tasks in flight at once (default 4)
  --refresh               ask again even when today's answer is already saved
  --dry-run               print the plan and the cost estimate; call nothing

Environment:
  SCRAPELESS_API_TOKEN    your Scrapeless API token`;

export const ENGINES = ["chatgpt", "perplexity", "gemini", "aimode", "overview", "copilot"];
export const DEFAULT_ENGINES = ["chatgpt", "perplexity", "gemini", "aimode"];
export const ENGINE_LABELS = {
	chatgpt: "ChatGPT",
	perplexity: "Perplexity",
	gemini: "Gemini",
	aimode: "Google AI Mode",
	overview: "Google AI Overview",
	copilot: "Copilot",
};
/** ChatGPT's answers vary most from run to run, so it is asked twice by default. */
export const DEFAULT_RUNS = {
	chatgpt: 2,
	perplexity: 1,
	gemini: 1,
	aimode: 1,
	overview: 1,
	copilot: 1,
};
export const ACTORS = {
	chatgpt: "scraper.chatgpt",
	perplexity: "scraper.perplexity",
	gemini: "scraper.gemini",
	aimode: "scraper.aimode",
	overview: "scraper.overview",
	copilot: "scraper.copilot",
};
const API = "https://api.scrapeless.com";
const LLM_CREATE = `${API}/api/v2/scraper/request`;
const LLM_RESULT = `${API}/api/v2/scraper/result`;
const SERP_CREATE = `${API}/api/v1/scraper/request`;
const SERP_RESULT = `${API}/api/v1/scraper/result`;
/**
 * Cost estimate only, from one team's bills in October 2026: about 0.4 yen
 * ($0.0027) per answer task and $0.001 per Google search task. Check your own
 * Scrapeless plan.
 */
export const EST_USD_PER_ANSWER = 0.0027;
export const EST_USD_PER_SERP = 0.001;
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [5_000, 20_000];

const FLAGS = {
	prompts: "string",
	domain: "string",
	brand: "list",
	competitors: "list",
	engines: "list",
	runs: "string",
	"max-calls": "number",
	serp: "boolean",
	"max-serp-calls": "number",
	out: "string",
	date: "string",
	concurrency: "number",
	refresh: "boolean",
	"dry-run": "boolean",
	help: "boolean",
};

// ---------------------------------------------------------------------------
// Arguments and prompts

export function parseRuns(value, engines) {
	const runs = { ...DEFAULT_RUNS };
	if (value === undefined) return runs;
	if (/^\d+$/.test(value)) {
		for (const e of engines) runs[e] = Number(value);
		return runs;
	}
	for (const part of value.split(",")) {
		const [engine, n] = part.split("=");
		if (!ENGINES.includes(engine) || !/^\d+$/.test(n ?? "")) {
			throw new UsageError(`--runs needs N or engine=N,... (got "${part}")`);
		}
		runs[engine] = Number(n);
	}
	return runs;
}

export function parseArgs(argv) {
	const { flags, positional } = parseFlags(argv, FLAGS);
	if (flags.help) return { help: true };
	if (positional.length) throw new UsageError(`Unexpected argument ${positional[0]}`);
	if (!flags.prompts) throw new UsageError("--prompts <file.json> is required");
	if (!flags.domain) throw new UsageError("--domain <example.com> is required");
	const domain = bareDomain(flags.domain);
	if (!domain)
		throw new UsageError(`--domain needs a domain such as example.com (got "${flags.domain}")`);
	const engines = flags.engines ?? DEFAULT_ENGINES;
	for (const e of engines) {
		if (!ENGINES.includes(e))
			throw new UsageError(`Unknown engine "${e}". Use: ${ENGINES.join(", ")}`);
	}
	if (flags.date !== undefined && !isDate(flags.date))
		throw new UsageError("--date needs YYYY-MM-DD");
	const brand = flags.brand ?? [domain.split(".")[0]];
	return {
		help: false,
		prompts: flags.prompts,
		domain,
		brands: brand,
		competitors: flags.competitors ?? [],
		engines,
		runs: parseRuns(flags.runs, engines),
		maxCalls: flags["max-calls"] ?? 100,
		serp: Boolean(flags.serp),
		maxSerpCalls: flags["max-serp-calls"] ?? 40,
		out: flags.out ?? "aio-data",
		date: flags.date ?? dateIn("UTC"),
		concurrency: Math.max(1, Math.min(16, flags.concurrency ?? 4)),
		refresh: Boolean(flags.refresh),
		dryRun: Boolean(flags["dry-run"]),
	};
}

const LANG_COUNTRY = {
	en: "US",
	ja: "JP",
	de: "DE",
	fr: "FR",
	es: "ES",
	pt: "BR",
	it: "IT",
	ko: "KR",
};

/**
 * Reads the prompt file: an array, or { "prompts": [...] }. Each prompt has an
 * id and a prompt, and may have lang, country (ISO 3166 alpha-2), group, and
 * retired (a date: the prompt is no longer asked).
 */
export function loadPrompts(text, file = "the prompt file") {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new UsageError(`${file} is not valid JSON: ${error.message}`);
	}
	const list = Array.isArray(parsed) ? parsed : parsed?.prompts;
	if (!Array.isArray(list) || list.length === 0) {
		throw new UsageError(`${file} needs a "prompts" array with at least one prompt`);
	}
	const seen = new Set();
	const prompts = [];
	for (const [i, p] of list.entries()) {
		if (!p || typeof p.id !== "string" || !/^[a-z0-9][a-z0-9_-]*$/i.test(p.id)) {
			throw new UsageError(`Prompt ${i + 1} needs an id of letters, digits, - or _`);
		}
		if (typeof p.prompt !== "string" || !p.prompt.trim()) {
			throw new UsageError(`Prompt ${p.id} needs prompt text`);
		}
		if (seen.has(p.id)) throw new UsageError(`Prompt id ${p.id} is used twice`);
		seen.add(p.id);
		if (p.retired) continue;
		const lang = typeof p.lang === "string" ? p.lang : "en";
		const country = (
			typeof p.country === "string" ? p.country : (LANG_COUNTRY[lang] ?? "US")
		).toUpperCase();
		if (!/^[A-Z]{2}$/.test(country))
			throw new UsageError(`Prompt ${p.id}: country must be two letters`);
		prompts.push({ id: p.id, prompt: p.prompt.trim(), lang, country, group: p.group ?? "all" });
	}
	return prompts;
}

/** Every prompt's first run on every engine, then every second run: a cap cuts repeats first. */
export function planJobs(prompts, engines, runs) {
	const jobs = [];
	const most = Math.max(0, ...engines.map((e) => runs[e] ?? 0));
	for (let run = 1; run <= most; run++) {
		for (const prompt of prompts) {
			for (const engine of engines)
				if ((runs[engine] ?? 0) >= run) jobs.push({ engine, prompt, run });
		}
	}
	return jobs;
}

// ---------------------------------------------------------------------------
// Reading an answer

const asObject = (v) => (v !== null && typeof v === "object" && !Array.isArray(v) ? v : {});
const asString = (v) => (typeof v === "string" ? v : "");

function linksFrom(value) {
	if (!Array.isArray(value)) return [];
	const links = [];
	for (const entry of value) {
		if (typeof entry === "string") links.push({ url: entry, title: "" });
		else {
			const o = asObject(entry);
			const url = asString(o.url) || asString(o.link);
			if (url) links.push({ url, title: asString(o.title) || asString(o.name) });
		}
	}
	return links;
}

/** http(s) URLs written in the text outside code blocks. */
export function urlsInText(text) {
	const masked = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ");
	return [...masked.matchAll(/https?:\/\/[^\s<>"'()\]]+/g)].map((m) =>
		m[0].replace(/[.,;:!?*_]+$/, ""),
	);
}

const NOISE_HOST = /(^|\.)(gstatic\.com|googleusercontent\.com|bingapis\.com|images\.openai\.com)$/;

/** The answer text, the URLs it cites (in order), and the URLs the engine searched. */
export function extractAnswer(engine, taskResult) {
	const r = asObject(taskResult);
	const text =
		engine === "aimode"
			? asString(r.result_md) || asString(r.result_text)
			: engine === "overview"
				? asString(r.content)
				: asString(r.result_text);
	const inText = urlsInText(text).map((url) => ({ url, title: "" }));
	const fields = {
		chatgpt: [["content_references", "links"], ["search_result"]],
		perplexity: [["web_results"], []],
		gemini: [["citations"], []],
		aimode: [["citations"], ["search_result"]],
		overview: [["source"], ["web_source"]],
		copilot: [["citations", "links"], []],
	}[engine];
	const cited = [
		...linksFrom(r[fields[0][0]]),
		...inText,
		...fields[0].slice(1).flatMap((f) => linksFrom(r[f])),
	];
	const searched = fields[1].flatMap((f) => linksFrom(r[f]));
	return { text, cited, searched, model: asString(r.model) || null };
}

const SEARCH_FIELDS = [
	"search_model_queries",
	"related_queries",
	"search_queries",
	"fan_out_queries",
];
const RELATED_FIELDS = ["related_prompt", "related_prompts", "related_questions"];

function queriesFrom(value) {
	const list = Array.isArray(value) ? value : asObject(value).queries;
	if (!Array.isArray(list)) return [];
	return list
		.map((e) =>
			typeof e === "string" ? e : asString(e?.query) || asString(e?.text) || asString(e?.question),
		)
		.map((q) => q.trim())
		.filter(Boolean);
}

/** The searches the engine ran for the answer, and the follow-ups it suggests. */
export function extractFanout(taskResult) {
	const r = asObject(taskResult);
	const out = [];
	const seen = new Set();
	for (const [fields, kind] of [
		[SEARCH_FIELDS, "search"],
		[RELATED_FIELDS, "related"],
	]) {
		for (const field of fields) {
			for (const query of queriesFrom(r[field])) {
				const key = `${kind}:${query.toLowerCase()}`;
				if (seen.has(key)) continue;
				seen.add(key);
				out.push({ query, kind });
			}
		}
	}
	return out;
}

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The text names `name` as a word (case-insensitive; any script). */
export function names(text, name) {
	const n = name.trim();
	if (!n) return false;
	// Latin names match as whole words; names in scripts without spaces (Japanese) match anywhere.
	if (/^[A-Za-z0-9][ -~]*$/.test(n)) {
		return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(n)}($|[^\\p{L}\\p{N}])`, "iu").test(text);
	}
	return text.toLowerCase().includes(n.toLowerCase());
}

/** One answer, read for your domain and brand names. */
export function analyzeAnswer(engine, taskResult, { domain, brands, competitors }) {
	const { text, cited, searched, model } = extractAnswer(engine, taskResult);
	const entries = new Map();
	const entryFor = (raw) => {
		const url = normalizeUrl(raw.url);
		if (!url) return null;
		const host = hostOf(url);
		if (!host || NOISE_HOST.test(host)) return null;
		const key = url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/+$/, "");
		if (!entries.has(key)) {
			entries.set(key, {
				url,
				domain: registrableDomain(host),
				title: raw.title,
				cited: false,
				position: null,
				searched: false,
			});
		}
		return entries.get(key);
	};
	let position = 0;
	for (const raw of cited) {
		const e = entryFor(raw);
		if (e && !e.cited) {
			e.cited = true;
			e.position = ++position;
		}
	}
	for (const raw of searched) {
		const e = entryFor(raw);
		if (e) e.searched = true;
	}
	const citations = [...entries.values()];
	const own = citations.filter((c) => isOnDomain(c.url, domain));
	const prose = text.replace(/https?:\/\/\S+/g, " ");
	const mentioned = brands.some((b) => names(prose, b)) || names(text, domain);
	const citedOwn = own.some((c) => c.cited);
	return {
		text,
		model,
		citations,
		fanout: extractFanout(taskResult),
		mentioned,
		cited: citedOwn,
		retrieved: !citedOwn && own.some((c) => c.searched),
		ownUrls: own.filter((c) => c.cited).map((c) => c.url),
		competitors: competitors.filter((c) => names(prose, c)),
	};
}

/** Organic results of a Scrapeless Google search response. */
export function parseOrganic(response, limit = 10) {
	const organic = asObject(response).organic_results;
	if (!Array.isArray(organic)) return [];
	return organic.slice(0, limit).map((entry, i) => {
		const o = asObject(entry);
		const link = asString(o.link) || asString(o.url);
		const direct = /^https?:\/\//.test(link) && !/(^|\.)google\./.test(hostOf(link) ?? "");
		const source = asString(o.source) || asString(o.displayed_link);
		const sourceHost = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(source.split(/[\s›/]/)[0] ?? "")
			? source.split(/[\s›/]/)[0].toLowerCase()
			: null;
		const url = direct ? normalizeUrl(link) : null;
		const host = url ? hostOf(url) : sourceHost;
		return {
			position: i + 1,
			title: asString(o.title),
			url,
			source,
			domain: host ? registrableDomain(host) : null,
		};
	});
}

// ---------------------------------------------------------------------------
// Scrapeless

class Retryable extends Error {}
class Fatal extends Error {}

async function http(url, token, body, timeoutMs) {
	const response = await fetchWithTimeout(
		url,
		{
			method: body === undefined ? "GET" : "POST",
			headers: { "content-type": "application/json", "x-api-token": token },
			body: body === undefined ? undefined : JSON.stringify(body),
		},
		timeoutMs,
	);
	const text = await response.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {
		// not JSON
	}
	return {
		status: response.status,
		json: asObject(json),
		snippet: text.slice(0, 200).replace(/\s+/g, " "),
	};
}

function checkStatus(result) {
	if (result.status === 401 || result.status === 403) {
		throw new Fatal(
			`Scrapeless refused the token (HTTP ${result.status}). Check SCRAPELESS_API_TOKEN.`,
		);
	}
	if (result.status === 429 || result.status >= 500) throw new Retryable(`HTTP ${result.status}`);
	if (result.status === 400 && /request failed/.test(result.snippet))
		throw new Retryable(`HTTP 400 ${result.snippet}`);
	if (result.status >= 400) throw new Error(`HTTP ${result.status}: ${result.snippet}`);
}

export function engineInput(engine, prompt) {
	const base = { prompt: prompt.prompt, country: prompt.country };
	switch (engine) {
		case "chatgpt":
			return { ...base, web_search: true, shopping: false };
		case "perplexity":
			return { ...base, web_search: true };
		case "copilot":
			return { ...base, mode: "search" };
		default:
			return { ...base, shopping: false };
	}
}

async function poll(url, token, { first, every, max }, done) {
	const deadline = Date.now() + max;
	await sleep(first);
	for (;;) {
		let result;
		try {
			result = await http(url, token, undefined, 30_000);
		} catch {
			result = null;
		}
		if (result) {
			if (result.status === 401 || result.status === 403) checkStatus(result);
			const value = done(result);
			if (value) return value;
		}
		if (Date.now() >= deadline)
			throw new Retryable(`no result after ${Math.round(max / 60_000)} min`);
		await sleep(every);
	}
}

async function askEngine(token, engine, prompt) {
	const created = await http(
		LLM_CREATE,
		token,
		{ actor: ACTORS[engine], input: engineInput(engine, prompt) },
		180_000,
	);
	checkStatus(created);
	if (created.json.status === "success" && created.json.task_result) return created.json;
	if (created.json.status === "failed")
		throw new Retryable(`task failed: ${created.json.message ?? ""}`);
	const taskId = created.json.task_id ?? created.json.taskId;
	if (typeof taskId !== "string") throw new Retryable(`no task id: ${created.snippet}`);
	return poll(
		`${LLM_RESULT}/${taskId}`,
		token,
		{ first: 10_000, every: 5_000, max: 600_000 },
		(r) => {
			if (r.status === 200 && r.json.status === "success" && r.json.task_result) return r.json;
			if (
				(r.status === 200 && r.json.status === "failed") ||
				r.status === 400 ||
				r.status === 410
			) {
				throw new Retryable(`task failed: ${r.snippet}`);
			}
			return null;
		},
	);
}

export function serpInput(query, lang, country) {
	const gl = country.toLowerCase();
	const domains = {
		jp: "google.co.jp",
		gb: "google.co.uk",
		in: "google.co.in",
		de: "google.de",
		fr: "google.fr",
	};
	return { q: query, gl, hl: lang, google_domain: domains[gl] ?? "google.com" };
}

async function searchGoogle(token, input) {
	const created = await http(SERP_CREATE, token, { actor: "scraper.google.search", input }, 90_000);
	checkStatus(created);
	if (created.status === 200) return created.json;
	const taskId = created.json.taskId ?? created.json.task_id;
	if (typeof taskId !== "string") throw new Retryable(`no task id: ${created.snippet}`);
	return poll(
		`${SERP_RESULT}/${taskId}`,
		token,
		{ first: 2_000, every: 3_000, max: 180_000 },
		(r) => {
			if (r.status === 200) return r.json;
			if (r.status === 400) throw new Retryable(`task failed: ${r.snippet}`);
			return null;
		},
	);
}

/** Runs a task with up to MAX_ATTEMPTS tries, each taking one call from the budget. */
async function withRetries(budget, state, task) {
	let last = "";
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		if (state.stop) return { ok: false, error: `run stopped: ${state.stop}` };
		if (budget.used >= budget.max)
			return { ok: false, error: `call cap reached${last ? ` (last: ${last})` : ""}` };
		budget.used++;
		try {
			return { ok: true, value: await task() };
		} catch (error) {
			last = error.message;
			if (error instanceof Fatal) {
				state.stop = last;
				return { ok: false, error: last };
			}
			if (!(error instanceof Retryable)) return { ok: false, error: last };
			if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAYS_MS[attempt - 1]);
		}
	}
	return { ok: false, error: `${last} (${MAX_ATTEMPTS} attempts)` };
}

async function pool(items, concurrency, worker) {
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, items.length) }, async () => {
			while (next < items.length) {
				const i = next++;
				await worker(items[i], i);
			}
		}),
	);
}

// ---------------------------------------------------------------------------
// Report

export function buildReport(opts, answers, serp, calls, missing) {
	const lines = [];
	const { domain, engines, date } = opts;
	lines.push(`# AI answer visibility for ${domain}, ${date}\n`);
	lines.push(
		`${answers.length} answers collected from ${new Set(answers.map((a) => a.promptId)).size} prompts. Tasks created: ${calls.llm} answer, ${calls.serp} Google. Estimated cost: $${(calls.llm * EST_USD_PER_ANSWER + calls.serp * EST_USD_PER_SERP).toFixed(2)}.\n`,
	);
	lines.push(
		"- **Mentioned**: the answer text names you. **Cited**: a citation or link points at your domain. **Searched only**: the engine read your page but didn't cite it.",
	);
	lines.push(
		"- Rates show k/n, the rate, and a 95% Wilson interval. A change inside the interval is noise.\n",
	);
	lines.push("## Visibility by engine\n");
	lines.push(
		"| Engine | n | Mentioned | Cited | Mentioned or cited | Searched only |\n| --- | --- | --- | --- | --- | --- |",
	);
	const row = (label, list) =>
		`| ${label} | ${list.length} | ${formatRate(list.filter((a) => a.mentioned).length, list.length)} | ${formatRate(list.filter((a) => a.cited).length, list.length)} | ${formatRate(list.filter((a) => a.mentioned || a.cited).length, list.length)} | ${list.filter((a) => a.retrieved).length} |`;
	for (const e of engines) {
		const list = answers.filter((a) => a.engine === e);
		if (list.length) lines.push(row(ENGINE_LABELS[e], list));
	}
	lines.push(row("**All**", answers));
	const groups = [...new Set(answers.map((a) => a.group))];
	if (groups.length > 1) {
		lines.push("\n## By prompt group (mentioned or cited)\n");
		lines.push(
			`| Group | ${engines.map((e) => ENGINE_LABELS[e]).join(" | ")} | All |\n|${" --- |".repeat(engines.length + 2)}`,
		);
		for (const g of groups) {
			const inG = answers.filter((a) => a.group === g);
			const c = (list) => `${list.filter((a) => a.mentioned || a.cited).length}/${list.length}`;
			lines.push(
				`| ${cell(g)} | ${engines.map((e) => c(inG.filter((a) => a.engine === e))).join(" | ")} | ${c(inG)} |`,
			);
		}
	}
	lines.push("\n## Prompts where you appear\n");
	const hits = answers.filter((a) => a.mentioned || a.cited || a.retrieved);
	if (!hits.length) lines.push("None yet. Start from the fan-out queries and cited domains below.");
	for (const a of hits) {
		const how =
			a.mentioned && a.cited
				? "named and cited"
				: a.mentioned
					? "named"
					: a.cited
						? "cited"
						: "searched only";
		lines.push(
			`- \`${a.promptId}\`, ${ENGINE_LABELS[a.engine]}: ${how}${a.ownUrls.length ? `; ${a.ownUrls.join(", ")}` : ""}`,
		);
	}

	const domainCounts = new Map();
	for (const a of answers) {
		for (const d of new Set(a.citations.filter((c) => c.cited).map((c) => c.domain))) {
			domainCounts.set(d, (domainCounts.get(d) ?? 0) + 1);
		}
	}
	lines.push("\n## Domains the answers cite most\n");
	lines.push(
		"Answers citing each domain at least once. These are the sites to be on, or to beat.\n",
	);
	lines.push("| Domain | Answers | Share |\n| --- | --- | --- |");
	for (const [d, n] of [...domainCounts].sort((x, y) => y[1] - x[1]).slice(0, 25)) {
		lines.push(
			`| ${d}${d === domain ? " (you)" : ""} | ${n} | ${Math.round((n / Math.max(1, answers.length)) * 100)}% |`,
		);
	}

	if (opts.competitors.length) {
		lines.push("\n## Brands named (share of voice)\n");
		lines.push("| Brand | Answers naming it | Share |\n| --- | --- | --- |");
		const counts = [
			[`${opts.brands[0]} (you)`, answers.filter((a) => a.mentioned).length],
			...opts.competitors.map((c) => [c, answers.filter((a) => a.competitors.includes(c)).length]),
		].sort((x, y) => y[1] - x[1]);
		for (const [b, n] of counts) {
			lines.push(`| ${cell(b)} | ${n} | ${Math.round((n / Math.max(1, answers.length)) * 100)}% |`);
		}
	}

	const fan = new Map();
	for (const a of answers) {
		for (const f of a.fanout) {
			const key = f.query.toLowerCase();
			const entry = fan.get(key) ?? { query: f.query, kind: f.kind, count: 0, engines: new Set() };
			entry.count++;
			entry.engines.add(ENGINE_LABELS[a.engine]);
			fan.set(key, entry);
		}
	}
	lines.push("\n## Fan-out: what the engines searched for\n");
	lines.push(
		"The searches behind the answers. A page that wins these searches is a page the engines can cite.\n",
	);
	if (!fan.size)
		lines.push("No fan-out in these answers (ChatGPT and Gemini report it most often).");
	else lines.push("| Query | Kind | Times | Engines |\n| --- | --- | --- | --- |");
	for (const f of [...fan.values()].sort((x, y) => y.count - x.count).slice(0, 40)) {
		lines.push(`| ${cell(f.query)} | ${f.kind} | ${f.count} | ${[...f.engines].join(", ")} |`);
	}

	if (serp.length) {
		lines.push("\n## Google results for the fan-out searches\n");
		lines.push("| Query | Your position | Top 3 domains |\n| --- | --- | --- |");
		for (const s of serp) {
			const mine = s.results.find(
				(r) => r.domain && (r.domain === domain || r.domain.endsWith(`.${domain}`)),
			);
			lines.push(
				`| ${cell(s.query)} | ${s.error ? `failed: ${cell(s.error, 40)}` : mine ? mine.position : "not in top 10"} | ${s.results
					.slice(0, 3)
					.map((r) => r.domain ?? cell(r.source, 30))
					.join(", ")} |`,
			);
		}
	}
	if (missing.length) {
		lines.push("\n## Answers not collected\n");
		for (const m of missing)
			lines.push(
				`- \`${m.promptId}\` ${ENGINE_LABELS[m.engine]} run ${m.run}: ${cell(m.error, 160)}`,
			);
	}
	return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------

export async function main(argv, env) {
	const opts = parseArgs(argv);
	if (opts.help) {
		console.log(USAGE);
		return 0;
	}
	if (!existsSync(opts.prompts)) throw new UsageError(`No prompt file at ${opts.prompts}`);
	const prompts = loadPrompts(readFileSync(opts.prompts, "utf8"), opts.prompts);
	const jobs = planJobs(prompts, opts.engines, opts.runs);
	const estimate = (
		Math.min(jobs.length, opts.maxCalls) * EST_USD_PER_ANSWER +
		(opts.serp ? opts.maxSerpCalls * EST_USD_PER_SERP : 0)
	).toFixed(2);
	console.log(
		`${prompts.length} prompts, ${jobs.length} answers to collect on ${opts.engines.map((e) => ENGINE_LABELS[e]).join(", ")}; cap ${opts.maxCalls} answer tasks${opts.serp ? ` and ${opts.maxSerpCalls} Google tasks` : ""}. Estimated cost at most $${estimate}.`,
	);
	if (jobs.length > opts.maxCalls) {
		console.log(
			`The cap cuts ${jobs.length - opts.maxCalls} answers (repeat runs go first). Raise --max-calls to ask them all.`,
		);
	}
	if (opts.dryRun) {
		for (const j of jobs.slice(0, 50))
			console.log(`  ${j.engine} run ${j.run}: ${j.prompt.id} (${j.prompt.country})`);
		if (jobs.length > 50) console.log(`  ... and ${jobs.length - 50} more`);
		return 0;
	}
	const token = requireEnv(
		env,
		"SCRAPELESS_API_TOKEN",
		"Create an API token in your Scrapeless dashboard and export SCRAPELESS_API_TOKEN=<token>. Try --dry-run first to see what a run would ask and cost.",
	);

	const rawDir = path.join(opts.out, "raw", opts.date);
	const dataDir = path.join(opts.out, opts.date);
	mkdirSync(rawDir, { recursive: true });
	mkdirSync(dataDir, { recursive: true });
	const budget = { used: 0, max: opts.maxCalls };
	const state = { stop: null };
	const answers = [];
	const missing = [];
	let reused = 0;
	await pool(jobs, opts.concurrency, async (job) => {
		const file = path.join(rawDir, `${job.engine}__${job.prompt.id}__${job.run}.json`);
		let response = null;
		if (!opts.refresh && existsSync(file)) {
			response = JSON.parse(readFileSync(file, "utf8"));
			reused++;
		} else {
			const result = await withRetries(budget, state, () =>
				askEngine(token, job.engine, job.prompt),
			);
			if (!result.ok) {
				missing.push({
					engine: job.engine,
					promptId: job.prompt.id,
					run: job.run,
					error: result.error,
				});
				return;
			}
			response = result.value;
			writeFileSync(file, JSON.stringify(response));
		}
		const a = analyzeAnswer(job.engine, response.task_result, opts);
		answers.push({
			engine: job.engine,
			promptId: job.prompt.id,
			run: job.run,
			group: job.prompt.group,
			lang: job.prompt.lang,
			country: job.prompt.country,
			...a,
		});
		process.stdout.write(`.${answers.length % 50 === 0 ? `${answers.length}\n` : ""}`);
	});
	console.log("");
	if (state.stop) throw new SetupError(state.stop);

	const serp = [];
	const serpBudget = { used: 0, max: opts.maxSerpCalls };
	if (opts.serp) {
		const queries = new Map();
		for (const a of answers) {
			for (const f of a.fanout.filter((x) => x.kind === "search")) {
				const key = f.query.toLowerCase();
				const q = queries.get(key) ?? {
					query: f.query,
					lang: a.lang,
					country: a.country,
					count: 0,
				};
				q.count++;
				queries.set(key, q);
			}
		}
		const list = [...queries.values()]
			.sort((x, y) => y.count - x.count)
			.slice(0, opts.maxSerpCalls);
		await pool(list, opts.concurrency, async (q) => {
			const slug = q.query
				.toLowerCase()
				.replace(/[^\p{L}\p{N}]+/gu, "-")
				.slice(0, 80);
			const file = path.join(rawDir, `serp__${q.country}__${slug}.json`);
			let response;
			if (!opts.refresh && existsSync(file)) response = JSON.parse(readFileSync(file, "utf8"));
			else {
				const result = await withRetries(serpBudget, state, () =>
					searchGoogle(token, serpInput(q.query, q.lang, q.country)),
				);
				if (!result.ok) {
					serp.push({ ...q, results: [], error: result.error });
					return;
				}
				response = result.value;
				writeFileSync(file, JSON.stringify(response));
			}
			serp.push({ ...q, results: parseOrganic(response) });
		});
	}

	const order = (a, b) =>
		a.promptId.localeCompare(b.promptId) || a.engine.localeCompare(b.engine) || a.run - b.run;
	answers.sort(order);
	const calls = { llm: budget.used, serp: serpBudget.used };
	writeFileSync(
		path.join(dataDir, "answers.jsonl"),
		toJsonl(answers.map(({ citations, fanout, ...rest }) => rest)),
	);
	writeFileSync(
		path.join(dataDir, "citations.jsonl"),
		toJsonl(
			answers.flatMap((a) =>
				a.citations.map((c) => ({ engine: a.engine, promptId: a.promptId, run: a.run, ...c })),
			),
		),
	);
	writeFileSync(
		path.join(dataDir, "fanout.jsonl"),
		toJsonl(
			answers.flatMap((a) =>
				a.fanout.map((f) => ({ engine: a.engine, promptId: a.promptId, run: a.run, ...f })),
			),
		),
	);
	writeFileSync(path.join(dataDir, "serp.jsonl"), toJsonl(serp));
	writeFileSync(
		path.join(dataDir, "calls.json"),
		`${JSON.stringify({ ...calls, reused }, null, 2)}\n`,
	);
	const report = buildReport(opts, answers, serp, calls, missing);
	writeFileSync(path.join(dataDir, "report.md"), report);
	console.log(
		`${answers.length} answers (${reused} reused from earlier today), ${missing.length} missing.`,
	);
	console.log(`Report: ${path.join(dataDir, "report.md")}`);
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runMain(main, USAGE);
}
