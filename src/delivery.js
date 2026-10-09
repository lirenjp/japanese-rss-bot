import { acquire, release, DAY, nowSeconds } from './db.js';
import { FEED_MAP } from './feeds.js';
import { clip, html } from './text.js';
import { nextDelivery } from './schedule.js';
import { send, button, TelegramError } from './telegram.js';

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

export function digestMessages(articles, showAI = true) {
  const messages = [];
  let current = { text: '<b>日本のニュース</b>\n', keyboard: [], ids: [] };
  articles.forEach((a, index) => {
    const block = `\n${index + 1}. <b>${html(clip(a.title, 130))}</b>\n`
      + `${html(FEED_MAP.get(a.category)?.label ?? a.category)} · ${html(a.source)}\n`
      + (a.summary ? `${html(clip(a.summary, 180))}\n` : '')
      + `<a href="${html(a.original_url)}">記事を読む ↗</a>\n`;
    if (current.ids.length && (current.text.length + block.length > 3500 || current.ids.length === 3)) {
      messages.push(current);
      current = { text: '<b>日本のニュース · continued</b>\n', keyboard: [], ids: [] };
    }
    current.text += block;
    current.ids.push(a.id);
    const save = button(`${index + 1} · Save`, `save:${a.id}`);
    if (showAI) current.keyboard.push([save, button(`${index + 1} · Translate`, `ai:translate:${a.id}`), button(`${index + 1} · Explain`, `ai:explain:${a.id}`)]);
    else if (current.keyboard.length) current.keyboard[0].push(save);
    else current.keyboard.push([save]);
  });
  if (current.ids.length) messages.push(current);
  if (messages.length) messages.at(-1).keyboard.push([button('More news', 'news'), button('Read later', 'saved:0'), button('Settings', 'settings')]);
  return messages;
}

export async function deliver(env, chatId, manual = false, net = fetch, now = nowSeconds(), skipCooldown = false) {
  const lock = await acquire(env.DB, `delivery:${chatId}`, 120, now);
  if (!lock) return;
  try {
    const user = await env.DB.prepare('SELECT * FROM users WHERE chat_id=?').bind(chatId).first();
    if (!user || (!manual && (user.paused || !JSON.parse(user.delivery_slots).length || user.next_delivery_at > now))) return;
    if (manual && !skipCooldown && now - user.last_manual_at < 20) return;
    if (manual) await env.DB.prepare('UPDATE users SET last_manual_at=? WHERE chat_id=?').bind(now, chatId).run();
    const categories = JSON.parse(user.categories).filter(id => FEED_MAP.has(id));
    if (!categories.length) {
      if (manual) await send(env, chatId, 'Choose your categories first.', [[button('Categories', 'categories')]], net);
      return;
    }
    const { results } = await env.DB.prepare(`SELECT id,original_url,category,source,substr(title,1,130) AS title,substr(summary,1,180) AS summary,published_at FROM (
      SELECT a.*,row_number() OVER(PARTITION BY a.category ORDER BY a.published_at DESC,a.id DESC) AS rank
      FROM articles a WHERE a.category IN (SELECT value FROM json_each(?)) AND a.published_at >= ?
      AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.chat_id=? AND d.article_id=a.id)
    ) WHERE rank <= ? ORDER BY published_at DESC,id DESC`).bind(JSON.stringify(categories), now - 2 * DAY, chatId, user.item_limit).all();
    const selected = chooseArticles(results, user.item_limit);
    const showAI = Boolean(env.OPENROUTER_API_KEY && env.OPENROUTER_MODEL
      && (env.AI_ALLOWED_CHAT_IDS ?? '').split(',').map(s => s.trim()).includes(String(chatId)));
    for (const message of digestMessages(selected, showAI)) {
      await send(env, chatId, message.text, message.keyboard, net);
      await env.DB.prepare(`INSERT OR IGNORE INTO deliveries(chat_id,article_id,delivered_at)
        SELECT ?,value,? FROM json_each(?)`).bind(chatId, now, JSON.stringify(message.ids)).run();
    }
    if (manual && !selected.length) await send(env, chatId, 'No unread news from the past 48 hours yet. Try Refresh now or return for your next digest.', [[button('Refresh now', 'refresh'), button('Settings', 'settings')]], net);
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
