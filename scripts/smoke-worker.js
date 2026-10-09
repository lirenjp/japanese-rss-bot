import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';

const sent = [];
const mf = new Miniflare(convertV4MiniflareOptions({
  name: 'bot', serviceBindings: { SELF: 'bot' },
  modules: true, scriptPath: 'dist/index.js', compatibilityDate: '2026-10-09',
  d1Databases: ['DB'],
  bindings: { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_WEBHOOK_SECRET: 'test-secret' },
  outboundService: async request => {
    if (new URL(request.url).hostname !== 'api.telegram.org') return new Response('<rss><channel><item><title>更新されたニュース</title><link>https://example.org/2</link><description>新しい説明</description></item></channel></rss>');
    const data = await request.json();
    if (request.url.endsWith('/sendMessage')) sent.push(data);
    return Response.json({ ok: true, result: { message_id: 1 } });
  },
}));
try {
  const DB = await mf.getD1Database('DB');
  for (const name of readdirSync('migrations').sort()) for (const sql of readFileSync('migrations/' + name, 'utf8').split(';').filter(s => s.trim())) await DB.prepare(sql).run();
  async function update(id, body) {
    const response = await mf.dispatchFetch('http://localhost/telegram', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'test-secret' },
      body: JSON.stringify({ update_id: id, ...body }) });
    assert.equal(response.status, 200, await response.text());
  }
  const chat = { id: 101, type: 'private' };
  const from = { id: 101 };
  await update(1, { message: { chat, from, text: '/start' } });
  await update(2, { callback_query: { id: 'cb', from, data: 'cat:games:1', message: { chat, text: 'Categories', message_id: 1 } } });
  const now = Math.floor(Date.now() / 1000);
  await DB.prepare(`INSERT INTO articles(url,original_url,category,source,title,summary,published_at,first_seen_at)
    VALUES ('https://example.org/1','https://example.org/1','games','AUTOMATON','日本語の見出し','短い説明',?,?)`).bind(now, now).run();
  await update(3, { message: { chat, from, text: '/news' } });
  await update(3, { message: { chat, from, text: '/news' } });
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /日本語の見出し/);
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM deliveries').first()).n, 1);
  await update(4, { callback_query: { id: 'save', from, data: 'save:1', message: { chat, text: '日本のニュース', message_id: 2 } } });
  await DB.prepare('DELETE FROM articles WHERE id=1').run();
  await update(5, { message: { chat, from, text: '/saved' } });
  assert.match(sent.at(-1).text, /日本語の見出し/);
  await update(6, { message: { chat, from, text: '/refresh' } });
  assert.match(sent.at(-1).text, /更新されたニュース/);
  assert.equal((await DB.prepare('SELECT used FROM budgets WHERE name=?').bind('feed-fetches').first()).used, 1);
  assert.equal((await DB.prepare('SELECT count(*) AS n FROM bookmarks').first()).n, 1);
  console.log('PASS: compiled Worker, authenticated webhook, real D1, digest/replay, persistent bookmark and SELF refresh.');
} finally { await mf.dispose(); }
