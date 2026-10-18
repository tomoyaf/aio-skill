[English](README.md)

# aio-cycle

**aio-cycle** は、検索と AI の回答から人を呼ぶ毎週のサイクルを回す、Claude Code と Codex のプラグインです（無料、MIT ライセンス）。

毎週、次のサイクルを 1 周させます。

1. ChatGPT、Perplexity、Gemini、Google の AI モード、AI による概要が、サイトを名前に出すか、引用するかを測る
2. Google Search Console を読む
3. 取りにいく検索語を見つける
4. ページを書いて出す
5. インデックスさせる
6. 結果を読む

ランディングページのサービス Convika が `convika.com` で回した毎週のサイクルを、そのとき使ったスクリプトごとまとめました。Convika は 2026-10-11 から 10-17 にガイド、比較、ブログ記事を 68 本出し、毎週 64 の質問を ChatGPT、Perplexity、Gemini、Google の AI モードに投げて測りました。Google Search Console の表示回数は 2026-10-04 の 1 日 59 回から 10-15 には 1 日 675 回になり、クリックは 1 日 1 回から 20 回へ増えています。同じ期間に、登録は週 4 件ほどから週 27 件になりました。

## パッケージの中身

リポジトリには、エージェントが従う手順書と 3 本のスクリプト、質問セットのひな形が入っています。スクリプトの実行に必要なのは Node.js 20 以上だけです。パッケージのインストールはいりません。

- **`skills/aio-cycle/SKILL.md`** — エージェントが従う手順。AI の回答を測る、Google を測る、分析する、書いて出す、インデックスさせる、その週を記録する、の 6 つの段階で進みます。
- **`scripts/aio-monitor.mjs`** — 用意した質問を Scrapeless 経由で AI に投げます。名前に出た率と引用された率（95% 区間つき）、引用されたドメイン、競合の露出、AI が回答のために検索した語（ファンアウト）、その語で Google の何位にいるかを出します。
- **`scripts/gsc.mjs`** — Search Console を API で読みます。検索パフォーマンスの取得、先週との比較、URL 検査（インデックスされているか）、サイトマップの一覧と送信を担います。
- **`scripts/indexnow.mjs`** — 新しいページ、変わったページ、消えたページを IndexNow（Bing など）に送ります。状態ファイルを持ち、変わっていないページは送り直しません。
- **`references/prompts.example.json`** — 最初の質問セットのひな形。

## Claude Code にインストールする

Claude Code の中でマーケットプレイスを追加し、プラグインを入れます。

```text
/plugin marketplace add tomoyaf/aio-skill
/plugin install aio-cycle@aio-skill
```

ターミナルから直接実行する場合も同じです。

```bash
claude plugin marketplace add tomoyaf/aio-skill
claude plugin install aio-cycle@aio-skill
```

インストールが済んだら、Claude に「今週の AIO サイクルを回して」と頼んでください。頼んだ内容が合えば、スキルが読み込まれます。

## Codex へのインストール

マーケットプレイスを追加してプラグインを入れます。

```bash
codex plugin marketplace add tomoyaf/aio-skill
codex plugin add aio-cycle@aio-skill
```

プラグインを使わないときは、リポジトリを clone して、スキルのフォルダを Codex のスキルのフォルダにコピーしてください。

```bash
git clone https://github.com/tomoyaf/aio-skill.git
mkdir -p ~/.codex/skills
cp -R aio-skill/plugins/aio-cycle/skills/aio-cycle ~/.codex/skills/
```

リポジトリには `AGENTS.md` もあります。clone したフォルダで Codex を開けば、そのままスキルが見つかります。

## 必要な認証情報と、計測にかかる費用

スクリプトは認証情報を手元の環境変数から読みます。通信先は、下に並べたサービスと自分のサイトだけです。足りない変数があるときは、どのサービスも呼ぶ前にその変数名を出して止まります。

```bash
export SCRAPELESS_API_TOKEN=...
export GSC_SITE=sc-domain:example.com            # or https://www.example.com/
export GSC_SERVICE_ACCOUNT_KEY_FILE=$HOME/keys/search-console.json
export INDEXNOW_KEY=...                          # served at https://example.com/<key>.txt
```

- `SCRAPELESS_API_TOKEN`: スクレイピングサービスの Scrapeless のトークン。モニターが ChatGPT、Perplexity、Gemini、Google の AI モード、AI による概要、Copilot に質問し、Google 検索を行うために使います。
- `GSC_SITE` と `GSC_SERVICE_ACCOUNT_KEY_FILE`: Search Console API を有効にした Google Cloud のサービスアカウント。Search Console でそのプロパティのユーザーに追加しておきます。
- `INDEXNOW_KEY`: 8 から 128 文字の英数字かダッシュ。サイトの `/<key>.txt` で配信します。

Search Console と IndexNow は無料です。費用がかかるのは Scrapeless だけ。

Convika の 2026 年 10 月の請求では、Scrapeless の単価は AI の回答 1 件あたり約 0.4 円、Google 検索 1 回あたり 0.001 ドルでした。毎週の計測（64 の質問、回答約 330 件）は 1 回約 132 円。10 月の合計は約 7 ドルの見込みで、Convika が決めた月 10 ドルの上限に収まります。

料金は Scrapeless が決めます。登録する前に料金ページで確かめてください。

## クイックスタート

エージェントにサイクル全体を任せる前に、まず手で 1 回動かします。

### 1. 質問セットを用意する

質問セットのひな形をコピーし、顧客が実際にする質問に、顧客の言葉で書き換えます。

```bash
git clone https://github.com/tomoyaf/aio-skill.git
S=aio-skill/plugins/aio-cycle/skills/aio-cycle
mkdir -p aio-data && cp $S/references/prompts.example.json aio-data/prompts.json
```

### 2. 内容と費用を確かめる

何を聞き、いくらかかるかを、何も呼ばずに確かめます。

```bash
node $S/scripts/aio-monitor.mjs --prompts aio-data/prompts.json --domain example.com --brand "Example" --competitors "Rival One,Rival Two" --dry-run
```

### 3. 実行する

```bash
node $S/scripts/aio-monitor.mjs --prompts aio-data/prompts.json --domain example.com --brand "Example" --competitors "Rival One,Rival Two" --serp
```

終わると、レポートが `aio-data/<日付>/report.md` にできます。

### 4. Search Console で比べる

Search Console で今週と先週を比べます。

```bash
node $S/scripts/gsc.mjs compare --days 7
```

### 5. IndexNow に送る

デプロイのあと、変わったページを IndexNow に送ります。

```bash
node $S/scripts/indexnow.mjs --sitemap https://example.com/sitemap.xml --state aio-data/indexnow-state.json
```

## ライセンスと制作元

このスキルは MIT ライセンスで公開しています。

制作は Convika（convika.com）。ダッシュボードからはもちろん、Claude や ChatGPT、Codex からランディングページを作ってそのまま公開できるサービスです。フォームの送信を集め、訪問者の動きも追えます。

Issue と Pull Request は、このリポジトリで受け付けています。
