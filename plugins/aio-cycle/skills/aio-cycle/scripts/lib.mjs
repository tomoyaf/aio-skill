// Shared helpers for the aio-cycle scripts. Node 20+, no dependencies.

/** A mistake in the command line. Exit code 64 (EX_USAGE). */
export class UsageError extends Error {}

/** A credential or setting the script needs is missing or malformed. Exit code 2. */
export class SetupError extends Error {}

export const EXIT_USAGE = 64;
export const EXIT_SETUP = 2;

/**
 * Parses `--name value`, `--name=value`, and boolean `--flag` options.
 * spec maps an option name (without dashes) to "string", "number", "boolean", or "list".
 * Unknown options and missing values throw a UsageError.
 */
export function parseFlags(argv, spec) {
	const flags = {};
	const positional = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") {
			positional.push(...argv.slice(i + 1));
			break;
		}
		if (!arg.startsWith("--")) {
			positional.push(arg);
			continue;
		}
		const eq = arg.indexOf("=");
		const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
		const type = spec[name];
		if (!type) throw new UsageError(`Unknown option --${name}`);
		if (type === "boolean") {
			if (eq !== -1) throw new UsageError(`--${name} takes no value`);
			flags[name] = true;
			continue;
		}
		let value;
		if (eq !== -1) value = arg.slice(eq + 1);
		else {
			value = argv[i + 1];
			if (value === undefined || value.startsWith("--")) {
				throw new UsageError(`--${name} needs a value`);
			}
			i++;
		}
		if (type === "number") {
			const n = Number(value);
			if (!Number.isFinite(n) || n < 0)
				throw new UsageError(`--${name} needs a number, got "${value}"`);
			flags[name] = n;
		} else if (type === "list") {
			flags[name] = value
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
		} else {
			flags[name] = value;
		}
	}
	return { flags, positional };
}

/** The value of an environment variable, trimmed, or a SetupError that says how to set it. */
export function requireEnv(env, name, hint) {
	const value = env[name]?.trim();
	if (!value) throw new SetupError(`${name} is not set. ${hint}`);
	return value;
}

/**
 * Runs a script's main function and turns errors into exit codes:
 * 64 for a usage mistake (with the usage text), 2 for missing setup, 1 for anything else.
 */
export async function runMain(main, usage) {
	try {
		const code = await main(process.argv.slice(2), process.env);
		process.exitCode = typeof code === "number" ? code : 0;
	} catch (error) {
		if (error instanceof UsageError) {
			console.error(`${error.message}\n\n${usage}`);
			process.exitCode = EXIT_USAGE;
		} else if (error instanceof SetupError) {
			console.error(`Setup needed: ${error.message}`);
			process.exitCode = EXIT_SETUP;
		} else {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
	}
}

/** fetch with a timeout and no redirects followed unless allowed. */
export async function fetchWithTimeout(url, init = {}, timeoutMs = 30_000) {
	return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 95% Wilson score interval for k successes in n trials, as whole percents. */
export function wilson(k, n) {
	if (n === 0) return { rate: 0, low: 0, high: 0 };
	const z = 1.96;
	const p = k / n;
	const denom = 1 + (z * z) / n;
	const centre = (p + (z * z) / (2 * n)) / denom;
	const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
	return {
		rate: Math.round(p * 100),
		low: Math.max(0, Math.round((centre - margin) * 100)),
		high: Math.min(100, Math.round((centre + margin) * 100)),
	};
}

export function formatRate(k, n) {
	if (n === 0) return "0/0";
	const w = wilson(k, n);
	return `${k}/${n} (${w.rate}%, CI ${w.low}-${w.high}%)`;
}

const TRACKING_PARAMS = /^(utm_[a-z0-9_]*|srsltid|gclid|fbclid|msclkid|ref_src)$/i;

/** The URL without tracking parameters and fragment, or null if it is not an http(s) URL. */
export function normalizeUrl(raw) {
	let url;
	try {
		url = new URL(String(raw).trim());
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	if (!url.hostname.includes(".")) return null;
	if (/(^|\.)google\.[a-z.]+$/.test(url.hostname) && url.pathname === "/url") {
		const target = url.searchParams.get("q") ?? url.searchParams.get("url");
		if (target && target !== raw) return normalizeUrl(target);
	}
	url.hash = "";
	for (const key of [...url.searchParams.keys()]) {
		if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
	}
	if ([...url.searchParams.keys()].length === 0) url.search = "";
	return url.toString();
}

export function hostOf(url) {
	try {
		return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
	} catch {
		return null;
	}
}

/** Hosting suffixes under which each subdomain belongs to someone else. */
const SHARED_SUFFIXES = new Set([
	"co.jp",
	"ne.jp",
	"or.jp",
	"ac.jp",
	"co.uk",
	"org.uk",
	"com.au",
	"co.nz",
	"com.br",
	"co.in",
	"github.io",
	"netlify.app",
	"vercel.app",
	"pages.dev",
	"workers.dev",
	"web.app",
	"substack.com",
	"blogspot.com",
	"wordpress.com",
	"notion.site",
]);

/** example.com for docs.example.com; user.github.io stays as is. */
export function registrableDomain(host) {
	const labels = String(host)
		.toLowerCase()
		.replace(/^www\./, "")
		.split(".")
		.filter(Boolean);
	if (labels.length <= 2) return labels.join(".");
	const lastTwo = labels.slice(-2).join(".");
	return SHARED_SUFFIXES.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

/** The URL is on `domain` or one of its subdomains. */
export function isOnDomain(url, domain) {
	const host = hostOf(url);
	const d = String(domain)
		.toLowerCase()
		.replace(/^www\./, "");
	return host !== null && (host === d || host.endsWith(`.${d}`));
}

/** A bare domain from "example.com", "https://www.example.com/", or "sc-domain:example.com". */
export function bareDomain(value) {
	const v = String(value)
		.trim()
		.replace(/^sc-domain:/, "");
	const host = /^https?:\/\//.test(v) ? hostOf(v) : v.toLowerCase().replace(/^www\./, "");
	if (!host || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null;
	return host.replace(/\/+$/, "");
}

export function toJsonl(rows) {
	return rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");
}

/** YYYY-MM-DD in the given IANA time zone. */
export function dateIn(timeZone, ms = Date.now()) {
	return new Intl.DateTimeFormat("sv-SE", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(ms);
}

export function addDays(date, days) {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

export function isDate(value) {
	return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** Text safe to print in a Markdown table cell. */
export function cell(value, max = 80) {
	const text = String(value ?? "")
		.replace(/[\p{Cc}\p{Cf}]/gu, " ")
		.replace(/\|/g, "\\|")
		.replace(/\s+/g, " ")
		.trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
