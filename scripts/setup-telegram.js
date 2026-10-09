// Run after deploying; reads local environment, never prints a bot token.
import { configureTelegram } from '../src/setup.js';
const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_WEBHOOK_SECRET: secret, WORKER_URL: worker } = process.env;
if (!token || !secret || !worker) throw new Error('Set TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and WORKER_URL in .dev.vars');
try { await configureTelegram(process.env, fetch, process.argv.includes('--replace-webhook')); }
catch (error) {
  // Fetch errors can include the token-bearing request URL.
  console.error(error.name === 'TelegramWebhookConflict' ? error.message : 'Telegram setup failed. Check the token, URL, secret and connection.');
  process.exitCode = 1;
}
if (process.exitCode) process.exit(process.exitCode);
console.log('Webhook and bot commands configured. Open your bot and send /start.');
