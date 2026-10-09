import { getUser, nowSeconds } from './db.js';
import { FEEDS, FEED_MAP } from './feeds.js';
import { send, answer, button, telegram } from './telegram.js';
import { deliver } from './delivery.js';
import { runAI } from './ai.js';
import { SLOTS, nextDelivery } from './schedule.js';
import { pollFeeds } from './rss.js';
import { saveArticle, showSaved } from './bookmarks.js';

const pairs = a => Array.from({ length: Math.ceil(a.length / 2) }, (_, i) => a.slice(i * 2, i * 2 + 2));
export function menu(user, page = 'settings') {
  const categories = JSON.parse(user.categories), slots = JSON.parse(user.delivery_slots);
  if (page === 'categories') return {
    text: '<b>Categories</b>\nTap a category to subscribe or unsubscribe. One source per category.',
    keyboard: [...pairs(FEEDS.map(f => button(`${categories.includes(f.id) ? '✓ ' : ''}${f.label}`, `cat:${f.id}:${categories.includes(f.id) ? 0 : 1}`))),
      [button('Read news', 'news'), button('Settings', 'settings')]],
  };
  const times = SLOTS.filter(s => slots.includes(s.id)).map(s => s.label).join(', ');
  return {
    text: `<b>Japanese RSS</b>\n\n${categories.length} categories selected\nUp to ${user.item_limit} articles per digest, total\n${times ? `Delivery: ${times} JST` : 'Manual only'}${user.paused ? ' · paused' : ''}\nAI language: ${user.language === 'ru' ? 'Russian' : 'English'}\n\nChoose any delivery windows. News comes from the past 48 hours; older unread items expire.`,
    keyboard: [
      [button('Categories', 'categories'), button('Read news', 'news')],
      [button('Refresh now', 'refresh'), button('Read later', 'saved:0')],
      [3, 5, 10].map(n => button(`${n === user.item_limit ? '✓ ' : ''}${n} articles`, `count:${n}`)),
      SLOTS.map(s => button(`${slots.includes(s.id) ? '✓ ' : ''}${s.label} JST`, `slot:${s.id}:${slots.includes(s.id) ? 0 : 1}`)),
      [button(`${!slots.length ? '✓ ' : ''}Manual only`, 'manual'), button(user.paused ? 'Resume' : 'Pause', `pause:${user.paused ? 0 : 1}`)],
      [button(`${user.language === 'ru' ? '✓ ' : ''}AI → Русский`, 'lang:ru'), button(`${user.language === 'en' ? '✓ ' : ''}AI → English`, 'lang:en')],
    ],
  };
}
async function showMenu(env, user, page, messageId, net) {
  const { text, keyboard } = menu(user, page);
  if (!messageId) return send(env, user.chat_id, text, keyboard, net);
  try { return await telegram(env, 'editMessageText', { chat_id: user.chat_id, message_id: messageId,
    text, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }, net); }
  catch (e) { if (e.code !== 400) throw e; }
}
export async function handleUpdate(env, update, net = fetch, now = nowSeconds()) {
  const callback = update.callback_query;
  const message = callback?.message ?? update.message;
  if (!message || message.chat?.type !== 'private') return;
  const chatId = message.chat.id, sender = callback?.from ?? message.from;
  if (sender?.id !== chatId) return;
  const allowed = (env.ALLOWED_CHAT_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (allowed.length && !allowed.includes(String(chatId))) return;
  const user = await getUser(env.DB, chatId, now);
  if (!user) return send(env, chatId, 'This bot is full for now. Please try again later.', [], net);
  const command = (message.text ?? '').split(/\s/)[0].split('@')[0];
  const action = callback?.data ?? ({ '/start': 'categories', '/categories': 'categories', '/settings': 'settings', '/news': 'news', '/refresh': 'refresh', '/saved': 'saved:0', '/pause': 'pause:1', '/resume': 'pause:0', '/help': 'settings' })[command] ?? 'settings';
  const [kind, arg, enabled] = action.split(':');
  if (kind === 'save' && /^\d+$/.test(arg ?? '')) {
    const text = await saveArticle(env, user, Number(arg), net, now);
    if (callback) return answer(env, callback.id, text, net).catch(() => {});
    return;
  }
  if (callback) await answer(env, callback.id, kind === 'refresh'
    ? (now - user.last_refresh_at < 3600 ? 'Reading from the shared cache.' : 'Checking your sources…') : '', net).catch(() => {});
  if (kind === 'news') return deliver(env, chatId, true, net, now);
  if (kind === 'refresh') {
    const ids = JSON.parse(user.categories).filter(id => FEED_MAP.has(id));
    if (!ids.length) return send(env, chatId, 'Choose your categories first.', [[button('Categories', 'categories')]], net);
    // Per-user cooldown plus shared per-source cooldown and a daily fetch budget.
    const claimed = await env.DB.prepare(`UPDATE users SET last_refresh_at=? WHERE chat_id=? AND last_refresh_at<=? RETURNING chat_id`)
      .bind(now, chatId, now - 3600).first();
    if (claimed) await pollFeeds(env, net, now, ids);
    return deliver(env, chatId, true, net, now, true);
  }
  if (kind === 'ai' && ['translate', 'explain'].includes(arg) && /^\d+$/.test(enabled ?? '')) return runAI(env, user, arg, Number(enabled), net, now);
  if (kind === 'saved' || kind === 'unsave') {
    if (!/^\d+$/.test(arg ?? '')) return;
    if (kind === 'unsave') await env.DB.prepare('DELETE FROM bookmarks WHERE chat_id=? AND id=?').bind(chatId, Number(arg)).run();
    const before = Number(kind === 'unsave' ? enabled : arg);
    if (!Number.isSafeInteger(before) || before < 0) return;
    return showSaved(env, user, before, net, callback && /^Read later/.test(message.text ?? '') ? message.message_id : undefined);
  }
  let page = 'settings';
  if (kind === 'cat' && FEED_MAP.has(arg) && ['0', '1'].includes(enabled)) {
    if (enabled === '1') await env.DB.prepare(`UPDATE users SET categories=CASE
      WHEN EXISTS(SELECT 1 FROM json_each(categories) WHERE value=?) THEN categories ELSE json_insert(categories,'$[#]',?) END
      WHERE chat_id=?`).bind(arg, arg, chatId).run();
    else await env.DB.prepare(`UPDATE users SET categories=(SELECT json_group_array(value) FROM json_each(users.categories) WHERE value<>?) WHERE chat_id=?`).bind(arg, chatId).run();
    page = 'categories';
  } else if (kind === 'count' && ['3', '5', '10'].includes(arg)) {
    await env.DB.prepare('UPDATE users SET item_limit=? WHERE chat_id=?').bind(Number(arg), chatId).run();
  } else if (kind === 'slot' && SLOTS.some(s => s.id === arg) && ['0', '1'].includes(enabled)) {
    if (enabled === '1') await env.DB.prepare(`UPDATE users SET delivery_slots=CASE
      WHEN EXISTS(SELECT 1 FROM json_each(delivery_slots) WHERE value=?) THEN delivery_slots ELSE json_insert(delivery_slots,'$[#]',?) END WHERE chat_id=?`).bind(arg, arg, chatId).run();
    else await env.DB.prepare(`UPDATE users SET delivery_slots=(SELECT json_group_array(value) FROM json_each(users.delivery_slots) WHERE value<>?) WHERE chat_id=?`).bind(arg, chatId).run();
    const fresh = await env.DB.prepare('SELECT delivery_slots FROM users WHERE chat_id=?').bind(chatId).first();
    await env.DB.prepare('UPDATE users SET next_delivery_at=? WHERE chat_id=?').bind(nextDelivery(JSON.parse(fresh.delivery_slots), now), chatId).run();
  } else if (kind === 'manual' || kind === 'freq') {
    // Old frequency buttons remain harmless after migration.
    const slots = kind === 'manual' || arg === '0' ? [] : ['evening'];
    await env.DB.prepare('UPDATE users SET delivery_slots=?,next_delivery_at=? WHERE chat_id=?').bind(JSON.stringify(slots), nextDelivery(slots, now), chatId).run();
  } else if (kind === 'pause' && ['0', '1'].includes(arg)) {
    await env.DB.prepare('UPDATE users SET paused=?,next_delivery_at=? WHERE chat_id=?').bind(Number(arg), nextDelivery(JSON.parse(user.delivery_slots), now), chatId).run();
  } else if (kind === 'lang' && ['ru', 'en'].includes(arg)) {
    await env.DB.prepare('UPDATE users SET language=? WHERE chat_id=?').bind(arg, chatId).run();
  } else if (kind === 'categories') page = 'categories';
  const fresh = await env.DB.prepare('SELECT * FROM users WHERE chat_id=?').bind(chatId).first();
  const isMenu = /^(Japanese RSS|Categories)/.test(message.text ?? '');
  await showMenu(env, fresh, page, callback && isMenu ? message.message_id : undefined, net);
}
