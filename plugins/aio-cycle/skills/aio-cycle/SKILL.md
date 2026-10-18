---
name: aio-cycle
description: Run a weekly search and AI-answer visibility cycle for a website. Measure how ChatGPT, Perplexity, Gemini, Google AI Mode, and AI Overviews mention and cite the site (through Scrapeless), read Google Search Console, find the fan-out queries to win, write and ship pages, get them indexed (sitemaps, URL inspection, IndexNow), and log the week. Use weekly, after shipping new pages, or when asked how a site is doing in Google or in AI answers.
---

# How the weekly cycle works

Run one weekly cycle to grow your user's website visibility in Google and in AI answers (ChatGPT, Perplexity, Gemini, Google AI Mode, and Google AI Overviews). The test of the cycle is whether visits and sign-ups from Google and from AI assistants went up. Citations and rankings are means.

Read the whole skill before acting, then run the six steps in this order:

1. Measure AI answers.
2. Measure Google.
3. Analyze.
4. Write and ship pages.
5. Get the pages indexed.
6. Log the week's numbers.

### Before you start

- Check that Node.js 20 or newer is installed. The scripts need nothing else to install.
- Use the three scripts in the `scripts/` folder next to `SKILL.md`: `aio-monitor.mjs` (AI answers), `gsc.mjs` (Google Search Console), and `indexnow.mjs` (IndexNow).
- Before the first run, ask the user for the site's domain, the brand names that count as a mention, 3 to 10 competitor names, and the languages and countries of the site's customers.
- Write the week's data and report to a folder in the user's project. The default folder is `./aio-data`.
- Never print a credential. The scripts never print one either. Name a credential by its variable name.

## Check and set up credentials

Read credentials only from environment variables in the user's shell or from a `.env` file kept out of git. On Node 20.6+, pass `.env` to a script with `node --env-file=.env <script>`.

```bash
# $SKILL_DIR is the folder that holds this SKILL.md.
export SCRAPELESS_API_TOKEN=...                 # AI answers (Scrapeless)
export GSC_SITE=sc-domain:example.com           # or https://www.example.com/
export GSC_SERVICE_ACCOUNT_KEY_FILE=$HOME/keys/search-console.json
export INDEXNOW_KEY=...                         # served at https://example.com/<key>.txt

node "$SKILL_DIR/scripts/gsc.mjs" --help
node "$SKILL_DIR/scripts/indexnow.mjs" --help
node "$SKILL_DIR/scripts/aio-monitor.mjs" --help
```

The three services need these variables:

- **Scrapeless** (the scraping provider this cycle uses to ask the AI engines): `SCRAPELESS_API_TOKEN`. Ask the user to create it in their Scrapeless dashboard.
- **Google Search Console**: `GSC_SITE` and either `GSC_SERVICE_ACCOUNT_KEY_FILE` or `GSC_SERVICE_ACCOUNT_KEY_B64`. Format `GSC_SITE` as `sc-domain:example.com` for a Domain property or `https://www.example.com/` for a URL-prefix property. Set `GSC_SERVICE_ACCOUNT_KEY_FILE` to the path of a Google Cloud service account's JSON key, or set `GSC_SERVICE_ACCOUNT_KEY_B64` to the same key in base64. The service account needs the Search Console API turned on in its Google Cloud project. Its email must also be added as a user of the property in Search Console settings.
- **IndexNow**: `INDEXNOW_KEY`, using 8 to 128 letters, digits, or dashes. Make sure the site serves the key at `https://<host>/<key>.txt` with the key as the file's only content.

Run each script with `--help` or as a dry run to check the setup. Each script checks credentials before calling any service and exits with code 2, naming the missing variable, when one is missing. When a script exits with code 2, show the message to the user and wait. Do not invent values.

## Step 1: Build the Prompt Set and Run the Monitor

The monitor sends each prompt to each AI engine through Scrapeless. For every answer, it records whether the brand is named (**mentioned**), whether the domain is linked (**cited**), or whether the engine read a page on the domain without citing it (**searched only**). It also logs every cited domain, the competitor names used, and the **fan-out queries** the engine ran to write its answer. ChatGPT and Gemini report fan-out queries most often. Perplexity returns suggested follow-up questions.

### Build the prompt set

Read `references/prompts.example.json` next to this file to see the JSON format. Give each prompt an `id`, the prompt text, `lang`, `country` (two letters, such as `US` or `JP`), and a `group`.

Follow these rules when writing prompts:
- Write prompts the way real customers ask them, from their own country.
- Write each language natively. Never translate prompts from another language.
- Add prompts based on queries in Search Console, set to the country those visitors came from.
- Group prompts by intent: how to do the task, a specific need, best-of lists, alternatives to a named competitor, and questions that name the brand. Brand-named prompts check facts and are kept out of the rate totals.
- Keep core prompts fixed for 8 weeks so weekly runs can be compared. To change a prompt, set `retired` to a date on the old prompt and add a new one with a new `id`.

### Run the monitor

By default, the monitor queries ChatGPT, Perplexity, Gemini, and Google AI Mode. It asks ChatGPT twice per prompt because ChatGPT answers vary the most. Google AI Overview and Copilot are optional.

Run a dry run first. It calls nothing and prints how many answers will be collected along with the cost estimate:

```bash
mkdir -p aio-data
cp -n "$SKILL_DIR/references/prompts.example.json" aio-data/prompts.json   # first run only, then edit it
node "$SKILL_DIR/scripts/aio-monitor.mjs" --prompts aio-data/prompts.json --domain example.com --brand "Example" --competitors "Rival One,Rival Two" --dry-run
```

Next, run the monitor with `--serp` to also look up the engines' fan-out searches in Google:

```bash
node "$SKILL_DIR/scripts/aio-monitor.mjs" --prompts aio-data/prompts.json --domain example.com --brand "Example" --competitors "Rival One,Rival Two" \
  --serp --max-calls 120 --max-serp-calls 40
```

Use `--max-calls` to cap answer tasks (default `100`) and `--max-serp-calls` to cap Google tasks (default `40`), retries included. A run never goes past its caps.

Raw answers are saved under `raw/<date>/`. A second run on the same day reuses those files at no cost. Pass `--refresh` to ask the engines again.

### Read the report

Read the finished report at `<out>/<date>/report.md`. The raw data sits beside it as JSONL files for `answers`, `citations`, `fanout`, and `serp`.

Rates are shown as `k/n` with a 95% Wilson interval. A single run is a small sample. Treat any change inside the interval as noise.

### Cost

One team measured costs in October 2026 at about 0.4 yen (about $0.0027) per answer and $0.001 per Google search through Scrapeless. Asking 64 prompts across 4 engines each week produced about 330 answers and cost about 132 yen (about $0.90) per run. With weekly runs plus one extra mid-week ChatGPT run, their projected October total was near $7, staying under a $10 monthly cap. These numbers come from one team's bills and are not a quote. Check current prices on Scrapeless's pricing page.

## Step 2: Read Search Console and web-only reports

Run `compare` to compare the last 7 complete days against the 7 days before.

```bash
node "$SKILL_DIR/scripts/gsc.mjs" compare --days 7
```

This reads clicks, impressions, CTR, position, top queries, and top pages. It also lists queries and pages that are new this week or that lost their clicks. Search Console counts days in Pacific time. The last two or three days are still filling in, so `compare` ends at the last complete day. Clicks and impressions from AI Overviews and AI Mode are inside these numbers. The API cannot separate them.

To inspect a specific range or breakdown, run `performance`. You can break results down by query, page, country, device, or date, and filter by page prefix, query text, or country.

```bash
node "$SKILL_DIR/scripts/gsc.mjs" performance --days 28 --dimensions query,page --limit 100
node "$SKILL_DIR/scripts/gsc.mjs" performance --days 28 --dimensions query --page-prefix /blog/
node "$SKILL_DIR/scripts/gsc.mjs" performance --days 28 --dimensions country
```

Next, gather the metrics that only exist in web interfaces or site analytics:

- **Google Search Console generative AI features report**: Where the property shows this report, it is only in the web interface. Ask the user to read it, or ask for read access in a browser.
- **Bing Webmaster Tools**: Read the Search Performance report and the AI Performance report in the web interface. Bing's index feeds ChatGPT search and Copilot.
- **Site analytics**: Count visits and sign-ups from `chatgpt.com`, `perplexity.ai`, `claude.ai`, `gemini.google.com`, and `copilot.microsoft.com` separately from other referrers.

Save everything you read beside the monitor's report for the same date.

## Step 3: Turn the week's data into a ranked list of actions

Group the fan-out queries the engines ran by topic. Most fan-out queries have no recurring search volume, so exact phrasings matter less than topics. Build one page per cluster instead of a separate page for every phrasing. Google's guidance calls making separate pages for every variation to influence AI answers scaled content abuse.

For each cluster, list the winning pages that are cited in answers and appear in Google's top 10 in the monitor's SERP table. Read the winning pages and note why they win. Look for an answer in the opening lines, tables, numbers, freshness, and depth.

Sort each cluster into one of three kinds:

- **Brand-named queries** (such as `<competitor> free plan limits`): The vendor's own docs usually win. A sourced page that answers the question can still be retrieved.
- **Generic task queries**: Build one page for the cluster.
- **List queries** (such as `best ... 2026`): Keep a comparison page current and get into other people's lists.

Measure competitor share of voice. Count how many answers name each competitor per engine, and list which of their pages get cited.

Measure domain share. Count which domains the answers cite most per engine, and group them by type: vendor docs, blogs and lists, Reddit, YouTube, GitHub, directories, and news. Studies found that brand mentions across the web correlate with AI visibility far more than backlinks do (Ahrefs, 2025). Recurring domains are where the brand needs to be mentioned. Earn those mentions and never buy them.

Turn gaps into briefs and off-site targets:

1. **Content briefs**: For each valuable cluster where the brand is absent, write a brief. Include the target queries, the search intent, the page type, and the answer in the first 2 to 3 sentences. Add the facts and numbers with their sources, a comparison table if the page compares options, FAQ items in the engines' own wording, internal links, and the competitor pages to beat.
2. **Off-site targets**: List the third-party pages the engines cite for each cluster, including lists, Reddit threads, GitHub lists, directories, and YouTube videos. Note how the brand can honestly get included on each page.

Rank every action by expected sign-ups per hour of work. Cite the specific data row or number behind every action in the list.

## Step 4: Write, check, and ship the pages

Write each page from its brief and pass every check before you deploy.

### Page checklist

- Put the answer in the first 2 to 3 sentences.
- Give every number with its source and date.
- Use short quotes from primary sources and link to them.
- Add a comparison table for any comparison.
- Include first-hand material such as steps you tested, screenshots, or your own data.
- Write plain prose with no keyword repetition.
- Use the exact wording of the fan-out queries for FAQ items.
- Write each language natively. Do not translate one page into another.
- Never state a feature, price, or result that the product or the user's data does not support. Ask the user when you are unsure.
- Show an **Updated** date on the page. Set `dateModified` in the structured data to match that date. Change the date only when the content changes.

### Monthly technical checks

Run these checks once a month. A failure here blocks every other step.

- Check that `robots.txt` allows `OAI-SearchBot`, `ChatGPT-User`, `PerplexityBot`, `Claude-SearchBot`, `Claude-User`, `Googlebot`, `Bingbot`, and `Google-Extended`.
- Confirm your firewall or bot protection does not challenge verified search bots.
- Keep the answer in the HTML text. Do not hide it only behind tabs, in images, or in PDFs.
- Remove `nosnippet` and `max-snippet` from pages meant to be cited.
- Set one canonical URL per page with no redirect chains.
- Set `lastmod` in the sitemap to the real update date.

### Ship

Ask the user to approve the pages before you deploy. Ship approved changes through the user's normal deploy.

## Step 5: Get New and Changed Pages Crawled and Indexed

Submit or resubmit the sitemap in Search Console after new and changed pages ship.

```bash
node "$SKILL_DIR/scripts/gsc.mjs" sitemaps
node "$SKILL_DIR/scripts/gsc.mjs" submit-sitemap https://example.com/sitemap.xml
```

Inspect the new and changed pages with the URL Inspection API to check Google's verdict, coverage state, last crawl, and canonical.

```bash
node "$SKILL_DIR/scripts/gsc.mjs" inspect https://example.com/new-page/ https://example.com/changed-page/
node "$SKILL_DIR/scripts/gsc.mjs" inspect --sitemap https://example.com/sitemap.xml --limit 200
```

Google allows 2,000 inspections a day per property. The script stops at the quota and stops after 3 failures in a row.

Requesting indexing has no public API for normal pages. Google's Indexing API is for job postings and livestreams only. Ask the user to make requests by hand in Search Console under URL Inspection and Request indexing. The limit is about 10 requests a day.

Follow these rules before asking the user to request indexing:
- Inspect the page first.
- Request a page that is not indexed only if it has been live for 24 hours or more.
- Request an indexed page only if it was retitled or rewritten and has not been crawled since the change.
- Start with the most important page first.

Send new, changed, and removed pages to IndexNow after every deploy. IndexNow shares them with Bing and the other IndexNow engines.

```bash
node "$SKILL_DIR/scripts/indexnow.mjs" --sitemap https://example.com/sitemap.xml --state aio-data/indexnow-state.json --dry-run
node "$SKILL_DIR/scripts/indexnow.mjs" --sitemap https://example.com/sitemap.xml --state aio-data/indexnow-state.json
```

`indexnow.mjs` checks that the key file is live before sending. It also keeps a state file of what it sent. The first run sends the whole sitemap once. Later runs send new and removed pages right away. They send a changed page at most once a day because every URL sent spends the site's crawl quota.

## Step 6: Log the week and schedule the next run

Append a dated entry to the weekly log file in the user's project, such as `aio-data/log.md`.

Include these items in the entry:

- **Mention and citation rates** per engine and the change from last week.
- **Cited sources**, including the domains and competitors most cited.
- **Search Console** clicks and impressions, split into branded and non-branded.
- **Referrals**, covering visits and sign-ups from AI assistants and from Google.
- **Shipped work** from this week.
- **Next steps** for the coming week.

Read a rate change only when it falls outside last week's interval. Check the test of the cycle: did visits and sign-ups from Google and AI assistants go up?

Run `aio-cycle` once a week on the same weekday. Run it again after a batch of new pages ships.
