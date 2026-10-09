import { telegram } from './telegram.js';
import { acquire, release, nowSeconds, DAY } from './db.js';

const commands = [
  { command: 'start', description: 'Open the bot menu' },
  { command: 'news', description: 'Read a small news selection' },
  { command: 'saved', description: 'Open Read later' },
  { command: 'settings', description: 'Topics, digest size and delivery' },
];

export async function configureTelegram(env, net = fetch, replace = false) {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET ?? '')) {
    throw new Error('Use a random 32–256 character webhook secret');
  }
  const url = new URL('/telegram', env.WORKER_URL);
  if (url.protocol !== 'https:') throw new Error('WORKER_URL must use HTTPS');
  const current = await telegram(env, 'getWebhookInfo', {}, net);
  if (current.url && current.url !== url.href && !replace) {
    const error = new Error('This bot already has a different webhook. Use a dedicated bot.');
    error.name = 'TelegramWebhookConflict';
    throw error;
  }
  await telegram(env, 'setWebhook', {
    url: url.href, secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query'], max_connections: 1,
  }, net);
  await telegram(env, 'setMyCommands', { commands }, net);
}

// Configure on the next cron after secrets are added. Recheck daily and after rotation.
export async function ensureTelegram(env, net = fetch, now = nowSeconds()) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET || !env.WORKER_URL) return false;
  const input = JSON.stringify([env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_WEBHOOK_SECRET, env.WORKER_URL, commands]);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  const fingerprint = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
  const key = `telegram-setup:${fingerprint}`;
  const lease = await acquire(env.DB, key, 120, now);
  if (!lease) return false;
  try {
    await configureTelegram(env, net);
    await env.DB.prepare('UPDATE locks SET expires_at=? WHERE name=? AND token=?')
      .bind(now + DAY, key, lease).run();
    return true;
  } catch (error) {
    await release(env.DB, key, lease);
    throw error;
  }
}
