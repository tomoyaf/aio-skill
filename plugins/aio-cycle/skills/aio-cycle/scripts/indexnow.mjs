#!/usr/bin/env node
// Tells IndexNow (Bing, Yandex, Seznam, Naver, and the other IndexNow engines)
// which pages of your site are new, changed, or gone, so they recrawl them soon
// instead of whenever they next read your sitemap. Bing's index feeds ChatGPT
// search and Copilot. Node 20+, no dependencies.
//
//   node indexnow.mjs --sitemap https://example.com/sitemap.xml --state .aio/indexnow-state.json
//   node indexnow.mjs --urls https://example.com/a,https://example.com/b
//   node indexnow.mjs --sitemap ... --state ... --dry-run
//
// With --sitemap it reads every page in the sitemap and hashes what a search
// engine reads (title, meta description and robots, canonical and hreflang,
// JSON-LD, the text of <main> or <body>). It sends pages that are new to the
// state file, pages whose hash changed (at most once a day per page), and pages
// that left the sitemap. The state file keeps what was sent and when; the
// first run sends the whole sitemap once.
//
// Environment:
//   INDEXNOW_KEY   your IndexNow key (8-128 letters, digits, or dashes). Serve it
//                  as a text file at https://<your host>/<key>.txt whose body is
//                  the key, or pass --key-location with where you serve it.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sitemapUrls } from "./gsc.mjs";
import {
	fetchWithTimeout,
	parseFlags,
	requireEnv,
	runMain,
	SetupError,
	UsageError,
} from "./lib.mjs";

export const USAGE = `Usage:
  node indexnow.mjs --sitemap <sitemap URL> --state <file.json> [--dry-run] [--key-location <URL>]
  node indexnow.mjs --urls <url,url,...> [--dry-run] [--key-location <URL>]

Environment:
  INDEXNOW_KEY  your IndexNow key, served at https://<host>/<key>.txt`;

export const ENDPOINT = "https://api.indexnow.org/indexnow";
export const MAX_URLS_PER_REQUEST = 10_000;
/** A changed page is sent at most once in this long: every URL sent spends crawl quota. */
export const RESEND_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** From https://www.indexnow.org/documentation */
const STATUS = {
	200: "OK, URLs submitted",
	202: "Accepted, key validation pending",
	400: "Bad request, invalid format",
	403: "Forbidden, key not valid (key file missing, or its body is not the key)",
	422: "Unprocessable, a URL is not on the host, or the key doesn't match the format",
	429: "Too many requests",
};

const FLAGS = {
	sitemap: "string",
	state: "string",
	urls: "list",
	"key-location": "string",
	"dry-run": "boolean",
	help: "boolean",
};

export function parseArgs(argv) {
	const { flags, positional } = parseFlags(argv, FLAGS);
	if (flags.help) return { help: true };
	if (positional.length) throw new UsageError(`Unexpected argument ${positional[0]}`);
	if (!flags.sitemap && !flags.urls) throw new UsageError("Give --sitemap or --urls");
	if (flags.sitemap && flags.urls) throw new UsageError("Give --sitemap or --urls, not both");
	if (flags.sitemap && !flags.state) {
		throw new UsageError("--sitemap needs --state <file.json> to remember what was sent");
	}
	for (const url of [...(flags.urls ?? []), ...(flags.sitemap ? [flags.sitemap] : [])]) {
		if (!/^https:\/\/[^/]+/.test(url)) throw new UsageError(`Not an https URL: ${url}`);
	}
	return { help: false, ...flags };
}

export function validateKey(key) {
	if (!/^[a-zA-Z0-9-]{8,128}$/.test(key)) {
		throw new SetupError("INDEXNOW_KEY must be 8 to 128 letters, digits, or dashes.");
	}
	return key;
}

function attributes(tag) {
	const attrs = {};
	for (const [, name, dq, sq] of tag.matchAll(/([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
		attrs[name.toLowerCase()] = dq ?? sq ?? "";
	}
	return attrs;
}

const collapse = (text) => text.replace(/\s+/g, " ").trim();

/** What a search engine reads on a page, as stable text, so asset renames change nothing. */
export function searchableContent(html) {
	const lines = [];
	const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
	if (title !== undefined) lines.push(`title: ${collapse(title)}`);
	for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
		const a = attributes(tag);
		const name = a.name?.toLowerCase();
		if (name === "description" || name === "robots")
			lines.push(`${name}: ${collapse(a.content ?? "")}`);
	}
	for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
		const a = attributes(tag);
		const rel = a.rel?.toLowerCase();
		if (rel === "canonical") lines.push(`canonical: ${a.href ?? ""}`);
		if (rel === "alternate" && a.hreflang) lines.push(`alternate ${a.hreflang}: ${a.href ?? ""}`);
	}
	for (const [, json] of html.matchAll(
		/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
	)) {
		lines.push(`ld+json: ${collapse(json)}`);
	}
	const content =
		html.match(/<main\b[^>]*>([\s\S]*)<\/main>/i)?.[1] ??
		html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)?.[1] ??
		html;
	const text = content
		.replace(/<script\b[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[\s\S]*?<\/style>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<[^>]+>/g, " ");
	lines.push(`text: ${collapse(text)}`);
	return lines.join("\n");
}

export const pageHash = (html) =>
	createHash("sha256").update(searchableContent(html)).digest("hex");

/** Splits pages into added, changed, held (changed again too soon), removed, and unchanged. */
export function diffPages(previous, sitemap, current, nowMs) {
	const out = { added: [], changed: [], held: [], removed: [], unchanged: [] };
	for (const url of sitemap) {
		if (!(url in current)) continue;
		const sent = previous[url];
		if (!sent) out.added.push(url);
		else if (sent.hash === current[url]) out.unchanged.push(url);
		else if (nowMs >= Date.parse(sent.sentAt) + RESEND_INTERVAL_MS) out.changed.push(url);
		else out.held.push(url);
	}
	const inSitemap = new Set(sitemap);
	out.removed = Object.keys(previous).filter((url) => !inSitemap.has(url));
	return out;
}

export function readState(file) {
	if (!existsSync(file)) return {};
	const parsed = JSON.parse(readFileSync(file, "utf8"));
	return parsed && typeof parsed.pages === "object" ? parsed.pages : {};
}

export function payloads(urls, key, keyLocation) {
	const byHost = new Map();
	for (const url of urls) {
		const host = new URL(url).host;
		if (!byHost.has(host)) byHost.set(host, []);
		byHost.get(host).push(url);
	}
	const out = [];
	for (const [host, list] of byHost) {
		for (let i = 0; i < list.length; i += MAX_URLS_PER_REQUEST) {
			out.push({
				host,
				key,
				keyLocation: keyLocation ?? `https://${host}/${key}.txt`,
				urlList: list.slice(i, i + MAX_URLS_PER_REQUEST),
			});
		}
	}
	return out;
}

async function keyFileIsLive(keyLocation, key) {
	try {
		const response = await fetchWithTimeout(keyLocation, {}, 15_000);
		return response.ok && (await response.text()).trim() === key;
	} catch {
		return false;
	}
}

async function submit(payload) {
	const response = await fetchWithTimeout(
		ENDPOINT,
		{
			method: "POST",
			headers: { "content-type": "application/json; charset=utf-8" },
			body: JSON.stringify(payload),
		},
		30_000,
	);
	return { status: response.status, ok: response.status === 200 || response.status === 202 };
}

async function hashPages(urls) {
	const hashes = {};
	let next = 0;
	const worker = async () => {
		while (next < urls.length) {
			const url = urls[next++];
			try {
				const response = await fetchWithTimeout(
					url,
					{ headers: { "user-agent": "aio-cycle-indexnow" } },
					15_000,
				);
				if (response.ok) hashes[url] = pageHash(await response.text());
				else console.warn(`Skipped ${url}: HTTP ${response.status}`);
			} catch (error) {
				console.warn(`Skipped ${url}: ${error.message}`);
			}
		}
	};
	await Promise.all(Array.from({ length: 4 }, worker));
	return hashes;
}

export async function main(argv, env) {
	const args = parseArgs(argv);
	if (args.help) {
		console.log(USAGE);
		return 0;
	}
	const dryRun = Boolean(args["dry-run"]);
	// The key is checked before any network call, so a missing key fails at once.
	const key = dryRun
		? env.INDEXNOW_KEY?.trim() || "dry-run-key"
		: validateKey(
				requireEnv(
					env,
					"INDEXNOW_KEY",
					"Generate a key (for example: openssl rand -hex 16), serve it as https://<your host>/<key>.txt with the key as the file's only content, then export INDEXNOW_KEY=<key>.",
				),
			);

	let urls;
	let nextPages = null;
	const now = Date.now();
	if (args.urls) {
		urls = args.urls;
	} else {
		const previous = readState(args.state);
		const sitemap = await sitemapUrls(args.sitemap);
		const host = new URL(args.sitemap).host;
		const onHost = sitemap.filter((u) => {
			try {
				return new URL(u).host === host;
			} catch {
				return false;
			}
		});
		console.log(`${onHost.length} pages in the sitemap on ${host}.`);
		const current = await hashPages(onHost);
		const diff = diffPages(previous, onHost, current, now);
		urls = [...diff.added, ...diff.changed, ...diff.removed];
		console.log(
			`New ${diff.added.length}, changed ${diff.changed.length}, removed ${diff.removed.length}, held until a day has passed ${diff.held.length}, unchanged ${diff.unchanged.length}.`,
		);
		nextPages = { ...previous };
		for (const url of diff.removed) delete nextPages[url];
		for (const url of [...diff.added, ...diff.changed]) {
			nextPages[url] = { hash: current[url], sentAt: new Date(now).toISOString() };
		}
	}

	if (!urls.length) {
		console.log("Nothing to send.");
		return 0;
	}
	const batches = payloads(urls, key, args["key-location"]);
	if (dryRun) {
		for (const b of batches) {
			console.log(`Would send ${b.urlList.length} URLs for ${b.host}:`);
			for (const u of b.urlList) console.log(`  ${u}`);
		}
		return 0;
	}
	let failed = false;
	for (const b of batches) {
		if (!(await keyFileIsLive(b.keyLocation, key))) {
			throw new SetupError(
				`${b.keyLocation} doesn't serve the key. Put a text file there whose only content is INDEXNOW_KEY, deploy it, and run again.`,
			);
		}
		const result = await submit(b);
		console.log(
			`IndexNow ${b.host}: HTTP ${result.status}, ${STATUS[result.status] ?? "unexpected"} (${b.urlList.length} URLs)`,
		);
		if (!result.ok) failed = true;
	}
	if (nextPages && !failed) {
		mkdirSync(path.dirname(path.resolve(args.state)), { recursive: true });
		writeFileSync(
			args.state,
			`${JSON.stringify({ version: 1, updatedAt: new Date(now).toISOString(), pages: nextPages }, null, 2)}\n`,
		);
		console.log(`State saved to ${args.state}.`);
	}
	return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runMain(main, USAGE);
}
