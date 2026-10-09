import { acquire, release, cleanup, nowSeconds } from './db.js';
import { boundedText } from './text.js';
import { handleUpdate } from './bot.js';
import { pollFeeds } from './rss.js';
import { deliver } from './delivery.js';

export async function tick(env, net = fetch, now = nowSeconds()) {
  const lock = await acquire(env.DB, 'cron', 600, now);
  if (!lock) return;
  try {
    await pollFeeds(env, net, now);
    // Small deployment: bounded work per invocation. Overdue users stay due for the next tick.
    const { results } = await env.DB.prepare(`SELECT chat_id FROM users WHERE paused=0 AND interval_minutes>0
      AND next_delivery_at<=? AND categories<>'[]' ORDER BY next_delivery_at,chat_id LIMIT 3`).bind(now).all();
    for (const user of results) {
      try { await deliver(env, user.chat_id, false, net, now); }
      catch (error) { console.warn('Delivery failed', user.chat_id, error.name); }
    }
    // Run maintenance once per UTC day, using the persistent lock expiry as a marker.
    if (await acquire(env.DB, 'daily-cleanup', 86400, now)) await cleanup(env.DB, now);
  } finally { await release(env.DB, 'cron', lock); }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/') return Response.json({ service: 'japanese-rss-bot', status: 'ok' });
    if (url.pathname !== '/telegram' || request.method !== 'POST') return new Response('Not found', { status: 404 });
    if (!env.TELEGRAM_WEBHOOK_SECRET || !env.TELEGRAM_BOT_TOKEN) return new Response('Setup required', { status: 503 });
    if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TELEGRAM_WEBHOOK_SECRET) return new Response('Unauthorized', { status: 401 });
    let update;
    try { update = JSON.parse(await boundedText(new Response(request.body), 64_000)); }
    catch { return new Response('Invalid update', { status: 400 }); }
    if (!Number.isSafeInteger(update?.update_id)) return new Response('Invalid update', { status: 400 });
    const lockName = `update:${update.update_id}`;
    const token = await acquire(env.DB, lockName, 120);
    if (!token) return new Response('Retry', { status: 503 });
    try {
      const done = await env.DB.prepare('SELECT update_id FROM processed_updates WHERE update_id=?').bind(update.update_id).first();
      if (!done) {
        await handleUpdate(env, update);
        await env.DB.prepare('INSERT OR IGNORE INTO processed_updates(update_id,created_at) VALUES (?,?)').bind(update.update_id, nowSeconds()).run();
      }
      return new Response('OK');
    } catch (error) {
      // Avoid logging fetch errors containing token-bearing Telegram URLs.
      console.error('Update failed', error.name);
      return new Response('Retry', { status: 503 });
    } finally { await release(env.DB, lockName, token); }
  },
  async scheduled(_event, env) {
    if (!env.TELEGRAM_BOT_TOKEN) return;
    await tick(env);
  },
};
