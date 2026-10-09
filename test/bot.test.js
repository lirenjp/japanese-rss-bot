import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { database, env, network, callback, command, article } from './support.js';
import { handleUpdate } from '../src/bot.js';
import { deliver, digestMessages } from '../src/delivery.js';
import { acquire, release, cleanup, DAY } from '../src/db.js';
import { parseFeed, pollFeeds } from '../src/rss.js';
import { normalizedUrl } from '../src/text.js';
import { FEEDS } from '../src/feeds.js';
import worker from '../src/index.js';

const now = 1_800_000_000;

test('two users retain independent subscriptions, count, cadence and pause across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rss-bot-'));
  let DB = database(join(dir, 'test.db'));
  const n = network();
  try {
    await handleUpdate(env(DB), command(1, '/start'), n.net, now);
    await handleUpdate(env(DB), callback(1, 'cat:games:1'), n.net, now);
    await handleUpdate(env(DB), callback(1, 'cat:games:1'), n.net, now); // stale keyboard is idempotent
    await handleUpdate(env(DB), callback(1, 'cat:tech:1'), n.net, now);
    await handleUpdate(env(DB), callback(1, 'cat:tech:0'), n.net, now);
    await handleUpdate(env(DB), callback(1, 'count:3'), n.net, now);
    await handleUpdate(env(DB), callback(1, 'slot:morning:1'), n.net, now);
    await handleUpdate(env(DB), callback(1, 'pause:1'), n.net, now);
    await handleUpdate(env(DB), callback(2, 'cat:space:1'), n.net, now);
    DB.sqlite.close();
    DB = database(join(dir, 'test.db'));
    const a = await DB.prepare('SELECT * FROM users WHERE chat_id=1').first();
    const b = await DB.prepare('SELECT * FROM users WHERE chat_id=2').first();
    assert.deepEqual(JSON.parse(a.categories), ['games']);
    assert.equal(a.item_limit, 3); assert.deepEqual(JSON.parse(a.delivery_slots), ['evening', 'morning']); assert.equal(a.paused, 1);
    assert.deepEqual(JSON.parse(b.categories), ['space']); assert.equal(b.item_limit, 5);
  } finally { DB.sqlite.close(); rmSync(dir, { recursive: true }); }
});

test('digest enforces total cap, represents categories, excludes read and unsubscribed articles', async () => {
  const DB = database(), e = env(DB), n = network();
  await handleUpdate(e, callback(1, 'cat:news:1'), n.net, now);
  await handleUpdate(e, callback(1, 'cat:space:1'), n.net, now);
  await handleUpdate(e, callback(1, 'count:3'), n.net, now);
  for (let i = 0; i < 5; i++) await article(DB, 'news', i, now);
  await article(DB, 'space', 10, now); await article(DB, 'cars', 0, now);
  n.messages.length = 0;
  await deliver(e, 1, true, n.net, now);
  const first = (await DB.prepare('SELECT * FROM deliveries').all()).results;
  assert.equal(first.length, 3); assert.match(n.messages[0].text, /Headline space/);
  assert.doesNotMatch(n.messages[0].text, /Headline cars/);
  await deliver(e, 1, true, n.net, now + 30);
  assert.equal((await DB.prepare('SELECT * FROM deliveries').all()).results.length, 6);
  await handleUpdate(e, callback(1, 'pause:1'), n.net, now);
  await article(DB, 'news', 9, now);
  const before = n.messages.length;
  await deliver(e, 1, false, n.net, now + DAY);
  assert.equal(n.messages.length, before);
});

test('unsent articles remain retryable after a Telegram failure', async () => {
  const DB = database(), e = env(DB), n = network();
  await handleUpdate(e, callback(1, 'cat:news:1'), n.net, now);
  await article(DB, 'news', 0, now);
  await assert.rejects(deliver(e, 1, false, async () => Response.json({ ok: false, error_code: 500 }), now));
  assert.equal((await DB.prepare('SELECT * FROM deliveries').all()).results.length, 0);
  await deliver(e, 1, false, n.net, now + 60);
  assert.equal((await DB.prepare('SELECT * FROM deliveries').all()).results.length, 1);
});

test('RSS2, RDF and Atom parse Japanese text, relative links, CDATA and future dates', () => {
  const feed = FEEDS[0];
  const xml = '<rss><channel><item><title>新しい &amp; 話題</title><link>https://example.org/a?utm_source=x&amp;id=1</link><description><![CDATA[<p>日本語 &amp; English</p>]]></description><pubDate>2099-01-01</pubDate></item></channel></rss>';
  const a = parseFeed(xml, feed, now)[0];
  assert.equal(a.url, 'https://example.org/a?id=1'); assert.equal(a.summary, '日本語 & English'); assert.equal(a.published_at, now);
  assert.equal(parseFeed('<rdf:RDF xmlns:rdf="rdf"><item><title>車</title><link>https://example.org/car</link></item></rdf:RDF>', feed, now)[0].title, '車');
  assert.equal(parseFeed('<feed><entry><title>宇宙</title><link rel="self" href="/self"/><link rel="alternate" href="/space"/><summary>星</summary></entry></feed>', feed, now)[0].url, 'https://newsdig.tbs.co.jp/space');
  assert.equal(parseFeed('<rss><channel><item><title>bad</title><link>javascript:alert(1)</link></item></channel></rss>', feed, now).length, 0);
  assert.throws(() => parseFeed('<!DOCTYPE rss [<!ENTITY x "boom">]><rss/>', feed, now));
  assert.throws(() => parseFeed('<rss><channel><item><title>incomplete</title>', feed, now));
  const escaped = parseFeed('<feed><entry><title>日本語</title><link rel="alternate" href="https://example.org/?x=1&amp;y=2"/><summary>&lt;p&gt;読みやすい説明&lt;/p&gt;</summary></entry></feed>', feed, now)[0];
  assert.equal(escaped.summary, '読みやすい説明');
  assert.equal(escaped.original_url, 'https://example.org/?x=1&y=2');
  assert.equal(normalizedUrl('https://example.org/a?b=2&utm_campaign=x&a=1#part'), 'https://example.org/a?a=1&b=2');
});

test('feed polling caches validators, deduplicates links and preserves cache on source failure', async () => {
  const DB = database(), e = env(DB);
  const xml = '<rss><channel><item><title>ニュース</title><link>https://example.org/one?utm_source=test</link><description>概要</description></item></channel></rss>';
  await pollFeeds(e, async () => new Response(xml, { headers: { ETag: 'v1' } }), now);
  assert.equal((await DB.prepare('SELECT * FROM articles').all()).results.length, 1);
  await pollFeeds(e, async (_url, init) => { assert.equal(init.headers['If-None-Match'], 'v1'); return new Response(null, { status: 304 }); }, now + 1800);
  await pollFeeds(e, async () => new Response('bad', { status: 503 }), now + 3600);
  assert.equal((await DB.prepare('SELECT * FROM articles').all()).results.length, 1);
  assert.equal((await DB.prepare('SELECT * FROM feed_state').all()).results.length, FEEDS.length);
});

test('AI is opt-in, caches answers, separates language and rejects unreceived article IDs', async () => {
  const DB = database(), e = env(DB), n = network();
  await handleUpdate(e, callback(1, 'cat:news:1'), n.net, now);
  await article(DB, 'news', 0, now);
  await deliver(e, 1, true, n.net, now);
  await handleUpdate(e, callback(1, 'ai:translate:1'), n.net, now);
  assert.equal(n.aiCalls, 0);
  Object.assign(e, { OPENROUTER_API_KEY: 'fake', OPENROUTER_MODEL: 'test/model', AI_ALLOWED_CHAT_IDS: '1', AI_DAILY_LIMIT: '2' });
  await handleUpdate(e, callback(1, 'ai:translate:1'), n.net, now);
  await handleUpdate(e, callback(1, 'ai:translate:1'), n.net, now);
  assert.equal(n.aiCalls, 1);
  await handleUpdate(e, callback(1, 'lang:en'), n.net, now);
  await handleUpdate(e, callback(1, 'ai:translate:1'), n.net, now);
  assert.equal(n.aiCalls, 2);
  await handleUpdate(e, callback(1, 'ai:explain:1'), n.net, now);
  assert.equal(n.aiCalls, 2);
  await handleUpdate(e, callback(1, 'ai:translate:999'), n.net, now);
  assert.equal(n.aiCalls, 2);
  assert.match(n.messages.at(-1).text, /no longer/);
});

test('lease prevents overlapping deliveries and cannot be released by a different owner', async () => {
  const DB = database();
  const token = await acquire(DB, 'test', 10, now);
  assert.ok(token); assert.equal(await acquire(DB, 'test', 10, now), null);
  await release(DB, 'test', 'wrong'); assert.equal(await acquire(DB, 'test', 10, now), null);
  assert.ok(await acquire(DB, 'test', 10, now + 11));
});

test('cleanup removes old article cache and AI output but keeps user preferences', async () => {
  const DB = database(), n = network();
  await handleUpdate(env(DB), callback(1, 'cat:space:1'), n.net, now);
  await article(DB, 'space', 0, now - 31 * DAY);
  await cleanup(DB, now);
  assert.equal((await DB.prepare('SELECT * FROM articles').all()).results.length, 0);
  assert.equal((await DB.prepare('SELECT * FROM users').all()).results.length, 1);
});

test('long Japanese headlines and HTML metacharacters produce bounded, escaped Telegram messages', () => {
  const articles = Array.from({ length: 10 }, (_, i) => ({ id: i, title: '<script>&'.repeat(100), summary: '<b>&'.repeat(200), source: 'test', category: 'news', original_url: 'https://example.org/' }));
  const messages = digestMessages(articles);
  assert.equal(messages.flatMap(m => m.ids).length, 10);
  assert.ok(messages.every(m => m.text.length < 4096));
  assert.ok(messages.every(m => !m.text.includes('<script>')));
  assert.ok(messages.every(m => m.keyboard.flat().every(b => Buffer.byteLength(b.callback_data) <= 64)));
});

test('webhook rejects unauthenticated requests and ignores replayed authenticated updates', async () => {
  const DB = database(), e = env(DB), n = network();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = n.net;
  const request = secret => new Request('https://bot.example/telegram', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify({ update_id: 100, ...command(1, '/start') }) });
  try {
    assert.equal((await worker.fetch(request('wrong'), e)).status, 401);
    assert.equal((await worker.fetch(request('test-secret'), e)).status, 200);
    assert.equal((await worker.fetch(request('test-secret'), e)).status, 200);
    assert.equal(n.messages.length, 1);
  } finally { globalThis.fetch = originalFetch; }
});
