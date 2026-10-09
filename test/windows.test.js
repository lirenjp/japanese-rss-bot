import test from 'node:test';
import assert from 'node:assert/strict';
import { database, env, network, callback, article } from './support.js';
import { handleUpdate, menu } from '../src/bot.js';
import { nextDelivery, slotAt } from '../src/schedule.js';
import { DAY, cleanup, spend } from '../src/db.js';
import { deliver } from '../src/delivery.js';
import { parseFeed, pollFeed, FEED_ITEMS } from '../src/rss.js';
import { FEEDS } from '../src/feeds.js';

const now = Date.parse('2026-10-09T10:00:00Z') / 1000;
test('JST windows cross UTC midnight, default to evening and manual reads preserve schedule', async () => {
  assert.equal(slotAt(now + 3600), 'evening');
  assert.equal(nextDelivery(['morning'], now), Date.parse('2026-10-09T22:00:00Z') / 1000);
  assert.equal(nextDelivery(['morning'], now + DAY), Date.parse('2026-10-10T22:00:00Z') / 1000);
  assert.equal(nextDelivery(['evening'], now + 3600), now + 3600 + DAY);
  assert.equal(nextDelivery([], now), 0);
  const DB = database(), e = env(DB), n = network();
  await handleUpdate(e, callback(1, 'cat:news:1'), n.net, now);
  await handleUpdate(e, callback(1, 'slot:lunch:1'), n.net, now);
  await handleUpdate(e, callback(1, 'slot:lunch:1'), n.net, now);
  let u = await DB.prepare('SELECT * FROM users WHERE chat_id=1').first();
  assert.deepEqual(JSON.parse(u.delivery_slots), ['evening', 'lunch']);
  assert.equal(u.next_delivery_at, now + 3600);
  assert.doesNotMatch(menu(u).text, /15 minutes|Hourly/);
  await article(DB, 'news', 0, now);
  await deliver(e, 1, true, n.net, now);
  u = await DB.prepare('SELECT * FROM users WHERE chat_id=1').first();
  assert.equal(u.next_delivery_at, now + 3600);
  await handleUpdate(e, callback(1, 'manual'), n.net, now);
  u = await DB.prepare('SELECT * FROM users WHERE chat_id=1').first();
  assert.deepEqual(JSON.parse(u.delivery_slots), []);
});
test('saved links survive cache cleanup; ownership, repeated saves and removal are enforced', async () => {
  const DB = database(), e = env(DB), n = network();
  await handleUpdate(e, callback(1, 'cat:news:1'), n.net, now);
  await article(DB, 'news', 0, now);
  await deliver(e, 1, true, n.net, now);
  await handleUpdate(e, callback(2, 'save:1'), n.net, now);
  assert.equal((await DB.prepare('SELECT count(*) AS n FROM bookmarks').first()).n, 0);
  await handleUpdate(e, callback(1, 'save:1'), n.net, now);
  await handleUpdate(e, callback(1, 'save:1'), n.net, now);
  assert.equal((await DB.prepare('SELECT count(*) AS n FROM bookmarks').first()).n, 1);
  assert.equal(n.requests.at(-1).body.text, 'Saved for later.');
  await cleanup(DB, now + 31 * DAY);
  assert.equal((await DB.prepare('SELECT count(*) AS n FROM articles').first()).n, 0);
  await handleUpdate(e, callback(1, 'saved:0'), n.net, now + 31 * DAY);
  assert.match(n.messages.at(-1).text, /Headline news/);
  assert.equal(n.messages.at(-1).reply_markup.inline_keyboard[0][0].url, 'https://example.org/news/0');
  await handleUpdate(e, callback(2, 'unsave:1:0'), n.net, now);
  assert.equal((await DB.prepare('SELECT count(*) AS n FROM bookmarks').first()).n, 1);
  await handleUpdate(e, callback(1, 'unsave:1:0'), n.net, now);
  assert.equal((await DB.prepare('SELECT count(*) AS n FROM bookmarks').first()).n, 0);
});
test('refresh is shared, bounded to selected categories and coalesces repeated clicks', async () => {
  const DB = database(), e = env(DB), n = network();
  let feeds = 0;
  const net = async (url, init) => {
    if (String(url).startsWith('https://api.telegram.org')) return n.net(url, init);
    feeds++;
    return new Response('<rss><channel><item><title>新しい</title><link>https://example.org/new</link></item></channel></rss>');
  };
  await handleUpdate(e, callback(1, 'cat:news:1'), net, now);
  await handleUpdate(e, callback(2, 'cat:news:1'), net, now);
  await handleUpdate(e, callback(1, 'refresh'), net, now);
  await handleUpdate(e, callback(1, 'refresh'), net, now + 30);
  await handleUpdate(e, callback(2, 'refresh'), net, now + 60);
  assert.equal(feeds, 1);
  assert.equal((await DB.prepare('SELECT count(*) AS n FROM deliveries').first()).n, 2);
  await pollFeed(e, 'news', net, now + 1800);
  assert.equal(feeds, 2);
});
test('daily budgets reset in UTC and bound concurrent attempts; large feeds parse only five useful entries', async () => {
  const DB = database();
  const attempts = await Promise.all(Array.from({ length: 10 }, () => spend(DB, 'test', 3, now)));
  assert.equal(attempts.filter(Boolean).length, 3);
  assert.equal(await spend(DB, 'test', 3, now + DAY), true);
  const items = Array.from({ length: 500 }, (_, i) => `<item><title>Item ${i}</title><link>https://example.org/${i}</link><description>Short</description><content:encoded><![CDATA[${'x'.repeat(20_000)}]]></content:encoded></item>`).join('');
  const parsed = parseFeed(`<rss><channel>${items}</channel></rss>`, FEEDS[0], now);
  assert.equal(parsed.length, FEED_ITEMS);
  assert.equal(parsed[0].summary, 'Short');
});

test('oversized feed entries preserve cached news instead of consuming an unbounded response', async () => {
  const DB = database(), e = env(DB);
  await article(DB, 'news', 0, now);
  const huge = '<rss><channel><item><title>Too large</title><link>https://example.org/huge</link><description>'
    + 'x'.repeat(150_000) + '</description></item></channel></rss>';
  const result = await pollFeed(e, 'news', async () => new Response(huge), now);
  assert.equal(result.status, 'failed');
  assert.equal((await DB.prepare('SELECT count(*) AS n FROM articles').first()).n, 1);
  assert.ok((await DB.prepare('SELECT error FROM feed_state WHERE category=?').bind('news').first()).error);
});
