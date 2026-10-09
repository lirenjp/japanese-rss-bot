import { acquire, release, DAY, nowSeconds } from './db.js';
import { FEED_MAP } from './feeds.js';
import { digestPages, createSession, showDigest } from './reader.js';
import { render, back, pageAction } from './navigation.js';
import { nextDelivery } from './schedule.js';
import { button, TelegramError } from './telegram.js';

export function chooseArticles(rows, limit) {
  // Round-robin over categories, starting with the freshest category. No AI ranking.
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.category)) groups.set(row.category, []);
    groups.get(row.category).push(row);
  }
  const selected = [];
  while (selected.length < limit && [...groups.values()].some(g => g.length)) {
    for (const group of groups.values()) {
      if (group.length) selected.push(group.shift());
      if (selected.length === limit) break;
    }
  }
  return selected;
}

export function digestMessages(articles) {
  // Backward-compatible export for message size checks and local previews.
  return digestPages(articles).map(p => ({ ...p, keyboard: [] }));
}

export async function deliver(env, chatId, manual = false, net = fetch, now = nowSeconds(), skipCooldown = false, messageId) {
  const lock = await acquire(env.DB, `delivery:${chatId}`, 120, now);
  if (!lock) return;
  try {
    const user = await env.DB.prepare('SELECT * FROM users WHERE chat_id=?').bind(chatId).first();
    if (!user || (!manual && (user.paused || !JSON.parse(user.delivery_slots).length || user.next_delivery_at > now))) return;
    if (manual && !skipCooldown && now - user.last_manual_at < 20) {
      const last = await env.DB.prepare('SELECT id FROM reader_sessions WHERE chat_id=? ORDER BY id DESC LIMIT 1').bind(chatId).first();
      if (last) await showDigest(env, chatId, last.id, 0, net, now, messageId);
      return;
    }
    if (manual) await env.DB.prepare('UPDATE users SET last_manual_at=? WHERE chat_id=?').bind(now, chatId).run();
    const categories = JSON.parse(user.categories).filter(id => FEED_MAP.has(id));
    if (!categories.length) {
      if (manual) await render(env, chatId, '<b>News</b>\n\nChoose your topics to get your first digest.', [[button('Choose categories', pageAction('categories', 0, 'home'))], back(pageAction('home'))], net, messageId);
      return;
    }
    const { results } = await env.DB.prepare(`SELECT id,original_url,category,source,substr(title,1,130) AS title,substr(summary,1,180) AS summary,published_at FROM (
      SELECT a.*,row_number() OVER(PARTITION BY a.category ORDER BY a.published_at DESC,a.id DESC) AS rank
      FROM articles a WHERE a.category IN (SELECT value FROM json_each(?)) AND a.published_at >= ?
      AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.chat_id=? AND d.article_id=a.id)
    ) WHERE rank <= ? ORDER BY published_at DESC,id DESC`).bind(JSON.stringify(categories), now - 2 * DAY, chatId, user.item_limit).all();
    const selected = chooseArticles(results, user.item_limit);
    if (selected.length) {
      const sessionId = await createSession(env, chatId, selected, now);
      await showDigest(env, chatId, sessionId, 0, net, now, manual ? messageId : undefined, selected);
    } else if (manual) await render(env, chatId, '<b>News</b>\n\nNo unread articles from the past 48 hours. You can check your sources now or return for the next digest.',
      [[button('Refresh sources', 'refresh')], back(pageAction('home'))], net, messageId);
    // Manual reads leave the automatic schedule unchanged.
    if (!manual) await env.DB.prepare('UPDATE users SET next_delivery_at=? WHERE chat_id=?').bind(nextDelivery(JSON.parse(user.delivery_slots), now), chatId).run();
  } catch (error) {
    if (error instanceof TelegramError && error.code === 403) {
      await env.DB.prepare('UPDATE users SET paused=1 WHERE chat_id=?').bind(chatId).run();
    } else if (error instanceof TelegramError && error.code === 429) {
      await env.DB.prepare('UPDATE users SET next_delivery_at=? WHERE chat_id=?').bind(now + Math.max(60, error.retryAfter), chatId).run();
    } else throw error;
  } finally { await release(env.DB, `delivery:${chatId}`, lock); }
}
