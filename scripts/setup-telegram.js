// Run after deploying; reads local environment, never prints a bot token.
const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_WEBHOOK_SECRET: secret, WORKER_URL: worker } = process.env;
if (!token || !secret || !worker) throw new Error('Set TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and WORKER_URL in .dev.vars');
if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret)) throw new Error('Use a random webhook secret of 32–256 letters, digits, underscores or hyphens');
const url = new URL('/telegram', worker);
if (url.protocol !== 'https:') throw new Error('WORKER_URL must use HTTPS');
async function api(method, payload = {}) {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error('Telegram rejected setup');
    return result.result;
  } catch { throw new Error(`Telegram ${method} failed. Check your token and network connection.`); }
}
const current = await api('getWebhookInfo');
if (current.url && current.url !== url.href && !process.argv.includes('--replace-webhook')) {
  throw new Error('This bot already has a different webhook. Use a new bot, or explicitly pass --replace-webhook to move it.');
}
await api('setWebhook', { url: url.href, secret_token: secret, allowed_updates: ['message', 'callback_query'], max_connections: 1 });
await api('setMyCommands', { commands: [
  { command: 'start', description: 'Choose your categories' },
  { command: 'news', description: 'Read the next digest' },
  { command: 'categories', description: 'Subscribe or unsubscribe' },
  { command: 'settings', description: 'Article count, frequency and AI language' },
  { command: 'pause', description: 'Pause automatic delivery' },
  { command: 'resume', description: 'Resume automatic delivery' },
] });
console.log('Webhook and bot commands configured. Open your bot and send /start.');
