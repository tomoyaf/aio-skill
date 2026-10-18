[日本語](README.ja.md)

# aio-cycle

`aio-cycle` is a free, MIT-licensed plugin for Claude Code and Codex. It packages the weekly SEO and AI visibility cycle that Convika, a landing page service, ran on convika.com, complete with its scripts.

Each week, `aio-cycle` runs six steps:

1. Measure how AI answers on ChatGPT, Perplexity, Gemini, Google AI Mode, and Google AI Overviews mention and cite your site.
2. Read Google Search Console.
3. Find the queries to win.
4. Write and ship pages.
5. Get those pages indexed.
6. Read the results.

When Convika ran this cycle on convika.com, it measured 64 prompts each week across ChatGPT, Perplexity, Gemini, and Google AI Mode. From 2026-10-11 to 2026-10-17, it shipped 68 new guides, comparisons, and blog posts.

In Google Search Console, convika.com went from 59 impressions a day on 2026-10-04 to 675 a day on 2026-10-15. Clicks went from 1 a day to 20 a day. Over the same weeks, sign-ups grew from about 4 a week to 27 a week.

## What is inside

- `skills/aio-cycle/SKILL.md`: The instructions your agent follows across six steps: measure AI answers, measure Google, analyze, write and ship, get indexed, and log the week.
- `scripts/aio-monitor.mjs`: Sends your prompts to AI engines through Scrapeless. It reports mention and citation rates with 95% intervals, cited domains, and competitor share of voice. It also shows the engines' fan-out searches and where you rank in Google for them.
- `scripts/gsc.mjs`: Connects to the Search Console API. It pulls performance data, compares weeks, inspects URLs to check if pages are indexed, and lists or submits sitemaps.
- `scripts/indexnow.mjs`: Submits new, changed, and removed pages to IndexNow for Bing and other engines. It keeps a state file so a page is not sent again until it changes.
- `references/prompts.example.json`: A starter prompt set.

The scripts need Node.js 20 or newer. There are no packages to install.

## Install in Claude Code

In Claude Code, add the marketplace and install the plugin:

```text
/plugin marketplace add tomoyaf/aio-skill
/plugin install aio-cycle@aio-skill
```

You can also run the same install from your terminal:

```bash
claude plugin marketplace add tomoyaf/aio-skill
claude plugin install aio-cycle@aio-skill
```

After installing, ask Claude to run this week's AIO cycle for your site. The skill loads when your request matches.

## Install in Codex

Add the marketplace to Codex and install the plugin:

```bash
codex plugin marketplace add tomoyaf/aio-skill
codex plugin add aio-cycle@aio-skill
```

If you do not use plugins, clone the repository and copy the skill folder into your Codex skills folder:

```bash
git clone https://github.com/tomoyaf/aio-skill.git
mkdir -p ~/.codex/skills
cp -R aio-skill/plugins/aio-cycle/skills/aio-cycle ~/.codex/skills/
```

The repository also includes `AGENTS.md`. If you open Codex inside the cloned folder, it finds the skill automatically.

## Credentials and cost

Credentials come from your own environment variables. The scripts call only the services named here and your own site. Each script stops with a message naming the missing variable before calling any service.

```bash
export SCRAPELESS_API_TOKEN=...
export GSC_SITE=sc-domain:example.com            # or https://www.example.com/
export GSC_SERVICE_ACCOUNT_KEY_FILE=$HOME/keys/search-console.json
export INDEXNOW_KEY=...                          # served at https://example.com/<key>.txt
```

- `SCRAPELESS_API_TOKEN`: Scrapeless is the scraping provider the monitor uses. It asks ChatGPT, Perplexity, Gemini, Google AI Mode, Google AI Overview, and Copilot, and runs Google searches.
- `GSC_SITE` and `GSC_SERVICE_ACCOUNT_KEY_FILE`: Use a Google Cloud service account with the Search Console API turned on. Add it as a user of your property in Search Console.
- `INDEXNOW_KEY`: Use any string of 8 to 128 letters, digits, or dashes. Serve it from your site at `/<key>.txt`.

Search Console and IndexNow are free. You pay only for Scrapeless.

In Convika's October 2026 bills, each AI answer cost about 0.4 yen (about $0.0027). Each Google search cost $0.001. Convika's weekly run of 64 prompts produced about 330 answers and cost about 132 yen (about $0.90). October was projected near $7, which is under the $10 monthly cap Convika set. Scrapeless sets its own prices, so check their pricing page.

## Quick start

Run your first cycle by hand before handing it off to your agent.

1. Copy the example prompt set and edit it with the questions your customers ask, in their language:

```bash
git clone https://github.com/tomoyaf/aio-skill.git
S=aio-skill/plugins/aio-cycle/skills/aio-cycle
mkdir -p aio-data && cp $S/references/prompts.example.json aio-data/prompts.json
```

2. See what a run would ask and cost, without calling anything:

```bash
node $S/scripts/aio-monitor.mjs --prompts aio-data/prompts.json --domain example.com --brand "Example" --competitors "Rival One,Rival Two" --dry-run
```

3. Run the prompts:

```bash
node $S/scripts/aio-monitor.mjs --prompts aio-data/prompts.json --domain example.com --brand "Example" --competitors "Rival One,Rival Two" --serp
```

The report lands in `aio-data/<date>/report.md`.

4. Compare this week against last week in Search Console:

```bash
node $S/scripts/gsc.mjs compare --days 7
```

5. Send changed pages to IndexNow after a deploy:

```bash
node $S/scripts/indexnow.mjs --sitemap https://example.com/sitemap.xml --state aio-data/indexnow-state.json
```

## License and credits

Made by [Convika](https://convika.com). Convika lets you build a landing page on the dashboard or from Claude, ChatGPT, or Codex. You can publish it, collect form entries, and see what visitors do.

Issues and pull requests are welcome on this repository.

Released under the MIT license.
