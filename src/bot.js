import { getUser, nowSeconds } from './db.js';
import { FEEDS, FEED_MAP } from './feeds.js';
import { send, answer, button, telegram } from './telegram.js';
import { deliver } from './delivery.js';
import { runAI } from './ai.js';

const frequency = n => ({ 0: 'Manual only', 15: 'Every 15 minutes', 60: 'Hourly', 1440: 'Every 24 hours' })[n];
const pairs = a => Array.from({ length: Math.ceil(a.length / 2) }, (_, i) => a.slice(i * 2, i * 2 + 2));

export function menu(user, page = 'settings') {
  const categories = JSON.parse(user.categories);
  if (page === 'categories') return {
    text: '<b>Categories</b>\nTap a category to subscribe or unsubscribe. One source per category.',
    keyboard: [...pairs(FEEDS.map(f => button(`${categories.includes(f.id) ? '✓ ' : ''}${f.label}`, `cat:${f.id}:${categories.includes(f.id) ? 0 : 1}`))),
      [button('Read news', 'news'), button('Settings', 'settings')]],
  };
  return {
    text: `<b>Japanese RSS</b>\n\n${categories.length} categories selected\nUp to ${user.item_limit} articles per digest, total\n${frequency(user.interval_minutes)}${user.paused ? ' · paused' : ''}\nAI language: ${user.language === 'ru' ? 'Russian' : 'English'}\n\nLatest unread articles from the past 48 hours. The count is shared across your categories.`,
    keyboard: [
      [button('Categories', 'categories'), button('Read news', 'news')],
      [3, 5, 10].map(n => button(`${n === user.item_limit ? '✓ ' : ''}${n} articles`, `count:${n}`)),
      [15, 60, 1440].map(n => button(`${n === user.interval_minutes ? '✓ ' : ''}${frequency(n)}`, `freq:${n}`)),
      [button(`${!user.interval_minutes ? '✓ ' : ''}Manual only`, 'freq:0'), button(user.paused ? 'Resume' : 'Pause', `pause:${user.paused ? 0 : 1}`)],
      [button(`${user.language === 'ru' ? '✓ ' : ''}AI → Русский`, 'lang:ru'), button(`${user.language === 'en' ? '✓ ' : ''}AI → English`, 'lang:en')],
    ],
  };
}

async function showMenu(env, user, page, messageId, net) {
  const { text, keyboard } = menu(user, page);
  if (!messageId) return send(env, user.chat_id, text, keyboard, net);
  try {
    return await telegram(env, 'editMessageText', { chat_id: user.chat_id, message_id: messageId,
      text, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }, net);
  } catch (error) {
    // A repeated, explicit setting can leave an already-updated keyboard unchanged.
    if (error.code !== 400) throw error;
  }
}

export async function handleUpdate(env, update, net = fetch, now = nowSeconds()) {
  const callback = update.callback_query;
  const message = callback?.message ?? update.message;
  if (!message || message.chat?.type !== 'private') return;
  const chatId = message.chat.id;
  const sender = callback?.from ?? message.from;
  if (sender?.id !== chatId) return;
  const allowed = (env.ALLOWED_CHAT_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (allowed.length && !allowed.includes(String(chatId))) return;
  if (callback) await answer(env, callback.id, '', net).catch(() => {});
  const user = await getUser(env.DB, chatId, now);
  const command = (message.text ?? '').split(/\s/)[0].split('@')[0];
  const action = callback?.data ?? ({ '/start': 'categories', '/categories': 'categories', '/settings': 'settings', '/news': 'news', '/pause': 'pause:1', '/resume': 'pause:0', '/help': 'settings' })[command] ?? 'settings';
  const [kind, arg, enabled] = action.split(':');
  let page = 'settings';
  if (kind === 'news') return deliver(env, chatId, true, net, now);
  if (kind === 'ai' && ['translate', 'explain'].includes(arg) && /^\d+$/.test(enabled ?? '')) return runAI(env, user, arg, Number(enabled), net, now);
  if (kind === 'cat' && FEED_MAP.has(arg) && ['0', '1'].includes(enabled)) {
    // SQL computes from current state, so simultaneous category clicks cannot overwrite each other.
    if (enabled === '1') await env.DB.prepare(`UPDATE users SET categories=CASE
      WHEN EXISTS(SELECT 1 FROM json_each(categories) WHERE value=?) THEN categories ELSE json_insert(categories,'$[#]',?) END
      WHERE chat_id=?`).bind(arg, arg, chatId).run();
    else await env.DB.prepare(`UPDATE users SET categories=(SELECT json_group_array(value) FROM json_each(users.categories) WHERE value<>?) WHERE chat_id=?`).bind(arg, chatId).run();
    page = 'categories';
  } else if (kind === 'count' && ['3', '5', '10'].includes(arg)) {
    await env.DB.prepare('UPDATE users SET item_limit=? WHERE chat_id=?').bind(Number(arg), chatId).run();
  } else if (kind === 'freq' && ['0', '15', '60', '1440'].includes(arg)) {
    await env.DB.prepare('UPDATE users SET interval_minutes=?,next_delivery_at=? WHERE chat_id=?').bind(Number(arg), now + Number(arg) * 60, chatId).run();
  } else if (kind === 'pause' && ['0', '1'].includes(arg)) {
    await env.DB.prepare('UPDATE users SET paused=?,next_delivery_at=? WHERE chat_id=?').bind(Number(arg), now + user.interval_minutes * 60, chatId).run();
  } else if (kind === 'lang' && ['ru', 'en'].includes(arg)) {
    await env.DB.prepare('UPDATE users SET language=? WHERE chat_id=?').bind(arg, chatId).run();
  } else if (kind === 'categories') page = 'categories';
  const fresh = await env.DB.prepare('SELECT * FROM users WHERE chat_id=?').bind(chatId).first();
  // Never replace a digest with the settings menu; old article buttons stay useful.
  const isMenuMessage = /^(Japanese RSS|Categories)/.test(message.text ?? '');
  await showMenu(env, fresh, page, callback && isMenuMessage ? message.message_id : undefined, net);
}
