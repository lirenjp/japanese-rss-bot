import { acquire, release, cleanup, nowSeconds, spend } from './db.js';
import { boundedText } from './text.js';
import { handleUpdate } from './bot.js';
import { pollFeeds, pollFeed, internal } from './rss.js';
import { deliver } from './delivery.js';
import { ensureTelegram } from './setup.js';
import { slotAt } from './schedule.js';

function matches(secret, provided) {
  if (!secret || !provided) return false;
  const encode = new TextEncoder(), a = encode.encode(secret), b = encode.encode(provided);
  if (a.length !== b.length) return false;
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(a, b);
  // Node's test runtime lacks Workers' native timingSafeEqual.
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
export async function tick(env, net = fetch, now = nowSeconds()) {
  const lock = await acquire(env.DB, 'cron', 600, now);
  if (!lock) return;
  try {
    await pollFeeds(env, net, now);
    const slot = slotAt(now);
    const { results } = await env.DB.prepare(`SELECT chat_id FROM users WHERE paused=0
      AND next_delivery_at<=? AND categories<>'[]'
      AND EXISTS(SELECT 1 FROM json_each(delivery_slots) WHERE value=?) ORDER BY next_delivery_at,chat_id LIMIT 10`).bind(now, slot ?? '').all();
    for (const user of results) {
      try {
        if (env.SELF) await internal(env, `/_internal/deliver/${user.chat_id}`);
        else await deliver(env, user.chat_id, false, net, now);
      } catch (e) { console.warn('Delivery failed', e.name); }
    }
    if (await acquire(env.DB, 'daily-cleanup', 86400, now)) {
      if (env.SELF) await internal(env, '/_internal/cleanup');
      else await cleanup(env.DB, now);
    }
  } finally { await release(env.DB, 'cron', lock); }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/') return Response.json({ service: 'japanese-rss-bot', status: 'ok' });
    if (url.pathname.startsWith('/_internal/') && request.method === 'POST') {
      if (!matches(env.INTERNAL_SECRET ?? env.TELEGRAM_WEBHOOK_SECRET, request.headers.get('X-Internal-Secret'))) return new Response('Unauthorized', { status: 401 });
      const [, , task, id] = url.pathname.split('/');
      try {
        if (task === 'feed') return Response.json(await pollFeed(env, id));
        if (task === 'deliver' && /^\d+$/.test(id ?? '')) await deliver(env, Number(id));
        else if (task === 'cleanup') await cleanup(env.DB);
        else if (task === 'setup') await ensureTelegram(env);
        else if (task === 'tick') await tick(env);
        else return new Response('Not found', { status: 404 });
        return Response.json({ status: 'ok' });
      } catch (e) { console.error('Internal task failed', task, e.name); return new Response('Task failed', { status: 503 }); }
    }
    if (url.pathname !== '/telegram' || request.method !== 'POST') return new Response('Not found', { status: 404 });
    if (!env.TELEGRAM_WEBHOOK_SECRET || !env.TELEGRAM_BOT_TOKEN) return new Response('Setup required', { status: 503 });
    if (!matches(env.TELEGRAM_WEBHOOK_SECRET, request.headers.get('X-Telegram-Bot-Api-Secret-Token'))) return new Response('Unauthorized', { status: 401 });
    let update;
    try { update = JSON.parse(await boundedText(new Response(request.body), 64_000)); }
    catch { return new Response('Invalid update', { status: 400 }); }
    if (!Number.isSafeInteger(update?.update_id)) return new Response('Invalid update', { status: 400 });
    const lockName = `update:${update.update_id}`, token = await acquire(env.DB, lockName, 120);
    if (!token) return new Response('Retry', { status: 503 });
    try {
      const done = await env.DB.prepare('SELECT update_id FROM processed_updates WHERE update_id=?').bind(update.update_id).first();
      if (!done && await spend(env.DB, 'updates', 300)) {
        await handleUpdate(env, update);
        await env.DB.prepare('INSERT OR IGNORE INTO processed_updates(update_id,created_at) VALUES (?,?)').bind(update.update_id, nowSeconds()).run();
      }
      return new Response('OK');
    } catch (e) { console.error('Update failed', e.name); return new Response('Retry', { status: 503 }); }
    finally { await release(env.DB, lockName, token); }
  },
  async scheduled(event, env) {
    if (!env.TELEGRAM_BOT_TOKEN) return;
    try { await internal(env, '/_internal/setup'); }
    catch (e) { console.error('Telegram setup failed', e.name); return; }
    await tick(env, fetch, Math.floor(event.scheduledTime / 1000));
  },
};
