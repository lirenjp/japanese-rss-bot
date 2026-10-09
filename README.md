# Japanese RSS bot

A small Telegram bot on one Cloudflare Worker and one D1 database. The interface is in English; original headlines stay in Japanese.

## Reading flow

- A three-action home screen: **Read news**, **Read later**, **Settings**. It shows your topics, digest size and delivery times.
- Settings has separate pages for categories, article count and delivery. Categories show five choices per page, each with its source. **Previous / Next / Back** stay in the same message; changing a setting updates that page.
- Choose **3 / 5 / 10 articles per digest total**, shared across categories.
- Choose any combination of **07:00 / 12:00 / 20:00 JST**, or manual only. Default: **five articles at 20:00 JST**. These are 01:00 / 06:00 / 14:00 in Moscow.
- **Read news** selects recent unread articles from the shared cache. Headlines link to originals. Digests have up to five articles per page; **Article details** opens a single story with Previous / Next and Back to its digest page. **Refresh sources** is on the last digest page.
- **Save for later** is in the article view. Read later has a paged list and a single-article view with the original link and Remove. Saved links survive article-cache cleanup.
- **Pause** stops automatic delivery. Manual reading and saved links remain available.
- Headlines, short RSS descriptions, source names and original links. Basic URL deduplication removes fragments and common tracking parameters.
- Optional, on-request OpenRouter translation or explanation of the headline and RSS excerpt. Disabled without a key, model and allowed-user list.

Send `/start` to open the home screen. The Telegram command menu contains just `/start`, `/news`, `/saved`, `/settings`. `/refresh`, `/categories`, `/pause`, `/resume` remain supported when typed. Unconfigured AI controls are hidden.

Only unread articles from the past 48 hours enter a digest. Older items expire from the reading window. There is no obligation to empty a backlog of hundreds. Empty digests are not pushed. Categories take turns within the selected count.

## Cloudflare Free budget

The deployed account was confirmed as **Workers Free** by the Cloudflare API. No paid plan or paid resource is enabled by this project. Keep the account on Free: Cloudflare stops requests or queries at its Free quotas rather than billing overages. Other applications share the account quotas.

| Resource | Free quota | Bot bound |
| --- | --- | --- |
| Worker requests | 100,000/day | Three scheduled runs; up to 300 accepted Telegram updates/day, shared by all users |
| Worker CPU | 10 ms/invocation | Feed work and automatic deliveries split into small invocations through a self service binding |
| Cron triggers | 5/account | One expression: `0 3,11,22 * * *` (UTC) |
| External subrequests | 50/invocation | At most 15 feed service calls per coordinator; three at a time |
| D1 queries | 50/invocation | Separate feed and delivery tasks; each uses a small number of queries |
| D1 rows read | 5 million/day | 300 accepted updates/day, 10 users, bounded article retention and indexed lookups |
| D1 rows written | 100,000/day | 120 source-fetch attempts/day, 5 entries/source; unchanged entries are not rewritten |
| D1 storage | 500 MB/database; 5 GB/account | 30-day article cache, 50 saved links/user, 10-user initial deployment |

The daily application budgets reset at midnight UTC and fail closed. A user can request a source refresh once per hour; a shared source is fetched at most once per 30 minutes. Cache reads remain immediate. Scheduled refreshes use about 45 of the 120 daily source-fetch attempts. Manual refreshes share the remainder. Source errors preserve cached articles.

A service binding points back to this same Worker, keeping the deployment at one Worker and one database. Each feed invocation reads only a bounded prefix (128 KB maximum), keeps at most 5 entries, and parses only useful, size-limited XML fields. Oversized full-article content is skipped. A publisher that exceeds a bound keeps its previous cached data. CPU usage depends on feed contents; monitor Worker logs for `exceededCpu` before increasing any bounds. No upgrade is required or performed.

The current account's database is around 0.6 MB. At the daily ingest cap, 30 days would contain at most 18,000 article rows plus delivery records and small bookmark snapshots. Feed validation, query work and index writes consume quotas too; the application budgets intentionally leave substantial room for them. They bound this bot, not other applications or hostile requests to the public URL.

## Deploy

Requires Node.js 22+, a Cloudflare Free account and a dedicated Telegram bot from [BotFather](https://t.me/BotFather).

This repository is configured for `https://japanese-rss-bot.chitoge322.workers.dev` and its D1 database. Its Telegram secrets and webhook are already configured. Never copy secrets into GitHub.

For your own copy:

1. Run `npm ci`, `npx wrangler login` and `npx wrangler d1 create japanese-rss-bot`.
2. Set the returned database ID and your HTTPS `WORKER_URL` in `wrangler.jsonc`. Set both `name` and the `SELF` service's name to your Worker name.
3. Run `npm run db:remote` to apply migrations.
4. Configure `TELEGRAM_BOT_TOKEN` and a random 32–64 character `TELEGRAM_WEBHOOK_SECRET` with `npx wrangler secret put NAME` or the Cloudflare dashboard.
5. Run `npm run deploy`. The existing deployed Worker supports its self service binding. For a new Worker name, deploy once without `services`, then add the SELF binding and redeploy.
6. Copy `.dev.vars.example` to `.dev.vars`, fill the same secrets and Worker URL, then run `npm run telegram:setup` to register Telegram immediately. Alternatively, the next scheduled run registers it automatically.

Automatic setup rechecks daily and after secret rotation or command changes. It refuses to replace a different existing webhook. The CLI accepts `--replace-webhook` when explicitly moving a bot.

Connect this repository in Cloudflare Workers & Pages for GitHub deployment. Deploy command: `npm run deploy`. Apply future D1 migrations before deploying code that needs them. Keep `.dev.vars` out of Git. No VPS, Docker, Redis, R2, queue or separate web dashboard is needed.

## Optional OpenRouter

The bot works without AI. To enable it for selected users, add the `OPENROUTER_API_KEY` secret, set `OPENROUTER_MODEL`, and list numeric Telegram IDs in `AI_ALLOWED_CHAT_IDS`. Keep all three empty for zero provider calls. Restrict provider-key credits before enabling paid models.

`AI_DAILY_LIMIT` defaults to 10 uncached attempts per permitted user per UTC day, including failed attempts. Responses are cached seven days by source text, model, action, language and prompt version. Cache hits do not spend the daily allowance. Russian and English are available. Article AI buttons appear only for permitted users after configuration.

The current buttons translate or explain the **headline and RSS excerpt**. `articleContext` in `src/ai.js` is an extension point for publisher-specific full-article extraction. There is no automatic AI processing, semantic clustering, entity database or phrase-selection UI.

## Persistence and failures

| Data | Lifetime in D1 |
| --- | --- |
| User preferences and categories | Retained |
| Saved links and headline snapshots | Until individually removed; 50/user |
| Article cache and delivery history | 30 days from first ingestion |
| Feed validators and refresh times | Retained |
| AI answers | 7 days |
| Digest navigation sessions | 7 days; scoped to the owning user |
| Processed Telegram update IDs | 1 day |

Incoming Telegram requests require the webhook secret. Private chats only; users cannot operate another user's saved list. `ALLOWED_CHAT_IDS` can restrict the entire bot further. Category and schedule buttons set explicit state, so repeated clicks are safe. Pause/manual settings are preserved during migration; previous automatic intervals become the evening window.

Per-chat locks prevent overlapping digests; article IDs are marked read only after their page or article view is successfully shown. Unopened pages remain eligible for later selections. A repeated request within 20 seconds reopens the last selection. There is a small duplicate window if Telegram accepts a message and the following database write fails. The bot does not claim exactly-once delivery. Link history is bounded to the cache lifetime; an undated entry reintroduced after eviction may appear again.

The authenticated internal task endpoints use `INTERNAL_SECRET` if set, otherwise the webhook secret. The deployed Worker has a separate internal secret; new copies can use the fallback. Never expose either secret in logs or source.

## Verification

```sh
npm test
npm run check
npm run test:worker
npm run db:local
npm run dev
```

Tests use real SQLite and Miniflare D1 with mocked Telegram/OpenRouter. They cover preferences across restart, digest caps, RSS formats, duplicate links, source failures, JST rollover, refresh reuse, daily budgets, persistent bookmarks, user isolation, webhook authentication and replay prevention. Tests do not send real Telegram messages or spend AI credits.

Worker CPU limits are enforced on Cloudflare, not locally. Check invocation CPU and outcomes after changing parser or digest bounds. The setup uses Cloudflare Free's fixed limit; configurable CPU limits require Paid and must not be added here.

Feed mapping: `src/feeds.js`. Menu: `src/bot.js`. Schedule: `src/schedule.js`. Delivery: `src/delivery.js`. Bookmarks: `src/bookmarks.js`. Migrations: `migrations/`. AI: `src/ai.js`.

## References

Inspired by the small Worker + D1 approach of [lxl66566/Telegram-RSS-Bot-on-Cloudflare-Workers](https://github.com/lxl66566/Telegram-RSS-Bot-on-Cloudflare-Workers). This implementation does not copy upstream source files.

- [Workers Free limits](https://developers.cloudflare.com/workers/platform/limits/)
- [D1 pricing and Free quota behavior](https://developers.cloudflare.com/d1/platform/pricing/)
- [Service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [OpenRouter chat completions](https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request)
