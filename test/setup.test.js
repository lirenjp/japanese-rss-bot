import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from './support.js';
import { ensureTelegram } from '../src/setup.js';

test('setup waits for secrets, persists its marker, retries failures and preserves other webhooks', async () => {
  const DB = database();
  const env = { DB, WORKER_URL: 'https://rss.example.org', TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(64) };
  const calls = [];
  let occupied = false, fail = false;
  const net = async (url, init) => {
    const method = new URL(url).pathname.split('/').at(-1);
    calls.push({ method, body: JSON.parse(init.body) });
    if (fail) throw new Error('Network failed');
    return Response.json({ ok: true, result: method === 'getWebhookInfo'
      ? { url: occupied ? 'https://archive.example.org/telegram' : '' } : true });
  };
  try {
    assert.equal(await ensureTelegram({ ...env, TELEGRAM_BOT_TOKEN: '' }, net, 1000), false);
    assert.equal(calls.length, 0);
    assert.equal(await ensureTelegram(env, net, 1000), true);
    assert.deepEqual(calls.map(c => c.method), ['getWebhookInfo', 'setWebhook', 'setMyCommands']);
    assert.equal(calls[1].body.url, 'https://rss.example.org/telegram');
    assert.equal(calls[1].body.secret_token, env.TELEGRAM_WEBHOOK_SECRET);
    assert.equal(await ensureTelegram(env, net, 1900), false);
    assert.equal(calls.length, 3);
    // Changing secrets gets its own marker. An existing unrelated webhook blocks setup.
    env.TELEGRAM_BOT_TOKEN = 'new-token';
    occupied = true;
    await assert.rejects(ensureTelegram(env, net, 2000), { name: 'TelegramWebhookConflict' });
    assert.equal(calls.at(-1).method, 'getWebhookInfo');
    occupied = false;
    fail = true;
    await assert.rejects(ensureTelegram(env, net, 2100), /Network failed/);
    fail = false;
    assert.equal(await ensureTelegram(env, net, 2200), true);
    assert.equal(calls.at(-1).method, 'setMyCommands');
  } finally { DB.sqlite.close(); }
});
