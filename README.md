# Japanese RSS bot

Small Telegram bot running on one Cloudflare Worker with one D1 database.
The interface is in English; original news stays in Japanese. No web dashboard.

## What is implemented

- Fifteen categories, one fixed RSS source each. Subscribe/unsubscribe with buttons.
- Up to **3 / 5 / 10 articles per digest total**, shared across selected categories.
- **Every 15 minutes / hourly / every 24 hours / manual only**, plus pause/resume.
- A compact digest with source, original headline, short RSS description and original link.
- “More news” returns the next unread selection. Categories take turns so a busy news feed does not occupy every slot.
- Original links are deduplicated after removing fragments and known tracking parameters.
- Shared feed cache, delivery history and user preferences persist in D1 across deployments.
- Optional OpenRouter translation/explanation, only after a button press.
- Private chats only. Every user has separate subscriptions and settings.

Start with `/start`, select categories, then tap **Read news**.
The cache fills on the next cron run, within roughly 15 minutes of deployment.
Automatic delivery defaults to hourly, with five articles maximum. Selecting zero categories stops delivery.
Pause affects automatic delivery; manually requesting news still works.
Every 24 hours means 24 hours from when that option was selected, not a fixed local clock time.

## Deploy

Requires Node.js 22+, a Cloudflare account and a **dedicated Telegram bot** from [BotFather](https://t.me/BotFather).
Keep an existing archive bot on its own webhook.

1. Unzip this folder, then run:

   ```sh
   npm ci
   npx wrangler login
   npx wrangler d1 create japanese-rss-bot
   ```

2. Copy the returned D1 database ID into `wrangler.jsonc` instead of the zero placeholder.

3. Apply the migration and configure the two required secrets:

   ```sh
   npm run db:remote
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
   ```

   Use a random 32–64 character webhook secret. Generate one locally with:

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

4. Deploy:

   ```sh
   npm run deploy
   ```

5. Copy `.dev.vars.example` to `.dev.vars`. Fill in the same bot token and webhook secret, and the HTTPS Worker URL from deployment. Run:

   ```sh
   npm run telegram:setup
   ```

   This registers the webhook and command menu. It refuses to replace a different existing webhook unless explicitly run with `--replace-webhook`.

6. Open the Telegram bot, send `/start`, select categories and request a digest.

For automatic deployment, put this folder in a dedicated GitHub repository and connect it in **Cloudflare → Workers & Pages → Import repository**. Use `npm run deploy` as the deploy command. Apply future D1 migrations before code that needs them. Keep `.dev.vars` out of Git.

## Optional OpenRouter

The bot works without an AI key. To enable AI for selected users:

```sh
npx wrangler secret put OPENROUTER_API_KEY
```

Set `OPENROUTER_MODEL` to a model ID available to your OpenRouter account and `AI_ALLOWED_CHAT_IDS` to the permitted Telegram numeric user IDs, comma-separated. Then redeploy.
Find your numeric ID in a local Telegram update or bot administration tool; it is the private chat ID.
`AI_DAILY_LIMIT` defaults to 10 uncached requests per allowed user per UTC day, including failed provider attempts.
Set a credit limit on the provider key if opening AI to more users.

AI output is available in Russian or English. It is cached for seven days, keyed by source text, model, action, language and prompt version. Cache hits do not consume the bot's daily request allowance.

**Current scope is the headline and RSS excerpt.** Buttons and responses explicitly label this. Full-article extraction has a small extension point in `src/ai.js` (`articleContext`). It is deliberately not a generic website scraper; add publisher-specific extraction there when needed. AI does not automatically rewrite news, classify stories, cluster events or maintain entity records.

## Persistence and failure behavior

| Data | Location / lifetime |
| --- | --- |
| User settings and categories | D1, retained until explicitly removed |
| Article text and delivery history | D1, 30 days from first ingestion |
| Last feed fetch and HTTP validators | D1, retained |
| Translation/explanation results | D1, 7 days |
| Processed Telegram update IDs | D1, 7 days |

One cron runs every 15 minutes and fetches every source once for all users. Conditional requests reuse ETag/Last-Modified validators. Source failures preserve the last cache. Incoming Telegram requests require the webhook secret. Duplicate webhook updates are ignored after successful processing.

Digests draw from unread articles published within the last 48 hours. This includes recent cached articles when someone first subscribes. Empty digests are not pushed. Unsent older articles expire from this reading window rather than generating a large backlog. Missing/future RSS timestamps fall back to receipt time. Retrying delivery uses per-chat locks and records each successfully sent message separately.

There is a small unavoidable duplicate window if Telegram accepts a message and the database write immediately afterward fails. This version does not claim exactly-once delivery. Link history is bounded to the cache lifetime; an undated item reintroduced after eviction may appear again.

This is a small-user MVP: at most **three automatic digests per cron invocation**, with overdue users first. More subscribers may experience delays; increase this bound in `src/index.js` after measuring plan limits. Large feeds can exceed Workers Free CPU limits even when request counts are small. Check Worker logs after deployment; use a paid Worker plan if the free limits are exceeded. No VPS, Docker, Redis, R2 or extra queue is required.

## Checks and local use

```sh
npm test
npm run check
npm run test:worker
npm run db:local
npm run dev
```

The local test suite uses real SQLite with D1-shaped methods, a disk restart test and mocked Telegram/OpenRouter calls. `npm run check` also bundles the Worker with Wrangler. `npm run test:worker` runs the compiled Worker in Miniflare with real local D1 and a mocked Telegram endpoint, verifying the authenticated webhook, subscription, digest and replay prevention. All these checks passed during development. No tests call a real Telegram chat or spend OpenRouter credits. Production deployment, real Telegram delivery and paid AI have not been exercised.

To run a local scheduled fetch with Wrangler's test server:

```sh
curl 'http://localhost:8787/__scheduled?cron=*/15%20*%20*%20*%20*'
```

The production HTTP surface is only `GET /` and the authenticated `POST /telegram` webhook.

Feed mapping: `src/feeds.js`. Bot controls: `src/bot.js`. Delivery: `src/delivery.js`. Cache/migration: `migrations/0001_init.sql`. AI adapter: `src/ai.js`.

## References

The implementation follows the small Worker + D1 approach of [lxl66566/Telegram-RSS-Bot-on-Cloudflare-Workers](https://github.com/lxl66566/Telegram-RSS-Bot-on-Cloudflare-Workers). This is a new implementation; no upstream source files were copied.

- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [D1 Worker API](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [OpenRouter chat completions](https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request)
