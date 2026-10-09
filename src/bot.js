import { getUser, nowSeconds } from './db.js';
import { FEEDS, FEED_MAP } from './feeds.js';
import { send, answer, button } from './telegram.js';
import { deliver } from './delivery.js';
import { runAI } from './ai.js';
import { SLOTS, nextDelivery } from './schedule.js';
import { pollFeeds } from './rss.js';
import { saveArticle, showSaved, showBookmark } from './bookmarks.js';
import { render, back, pageAction, aiEnabled, topicName } from './navigation.js';
import { readSession, showDigest, showArticle } from './reader.js';
import { html } from './text.js';

const CATEGORY_PAGE_SIZE = 5;
const pageNumber = n => /^\d{1,4}$/.test(String(n)) ? Number(n) : 0;
const deliveryText = (slots, paused) => !slots.length ? 'Manual only' :
  `${paused ? 'Automatic delivery paused\n' : ''}Japan ${SLOTS.filter(s => slots.includes(s.id)).map(s => s.label).join(', ')}\n`
  + `Moscow ${SLOTS.filter(s => slots.includes(s.id)).map(s => `${String((s.hour + 3) % 24).padStart(2, '0')}:00`).join(', ')}`;

export function menu(user, page = 'home', index = 0, parent = 'settings', env = {}) {
  const categories = JSON.parse(user.categories), slots = JSON.parse(user.delivery_slots);
  const home = pageAction('home'), settings = pageAction('settings');
  if (page === 'categories') {
    const pages = Math.ceil(FEEDS.length / CATEGORY_PAGE_SIZE);
    index = Math.max(0, Math.min(index, pages - 1));
    parent = parent === 'home' ? 'home' : 'settings';
    const feeds = FEEDS.slice(index * CATEGORY_PAGE_SIZE, (index + 1) * CATEGORY_PAGE_SIZE);
    const keyboard = feeds.map(f => [button(`${categories.includes(f.id) ? '✓' : '＋'} ${topicName(f)} · ${f.source}`,
      `cat:${f.id}:${categories.includes(f.id) ? 0 : 1}:${index}:${parent}`)]);
    const navigation = [];
    if (index) navigation.push(button('← Previous', pageAction('categories', index - 1, parent)));
    if (index + 1 < pages) navigation.push(button('Next →', pageAction('categories', index + 1, parent)));
    if (navigation.length) keyboard.push(navigation);
    keyboard.push(back(pageAction(parent)));
    return { text: `<b>Categories · ${index + 1}/${pages}</b>\n\n${categories.length} selected. ✓ means subscribed.\nTap to add or remove a topic. Each topic has one source.`, keyboard };
  }
  if (page === 'count') return {
    text: `<b>Articles per digest</b>\n\nCurrently: up to ${user.item_limit} articles, total across your topics.\nChoose a small selection. Digests show up to five articles per page.`,
    keyboard: [[3, 5, 10].map(n => button(`${n === user.item_limit ? '✓ ' : ''}${n}`, `count:${n}`)), back(settings)],
  };
  if (page === 'delivery') return {
    text: `<b>Delivery times</b>\n\n${deliveryText(slots, user.paused)}\n\nChoose any windows, or Manual only. ✓ means enabled.\n“Read news” is always available.`,
    keyboard: [...SLOTS.map(s => [button(`${slots.includes(s.id) ? '✓ ' : ''}${s.label} Japan · ${String((s.hour + 3) % 24).padStart(2, '0')}:00 Moscow`,
      `slot:${s.id}:${slots.includes(s.id) ? 0 : 1}`)]), [button(`${!slots.length ? '✓ ' : ''}Manual only`, 'manual')], back(settings)],
  };
  if (page === 'language' && aiEnabled(env, user.chat_id)) return {
    text: '<b>AI language</b>\n\nChoose the language for excerpt translations and explanations.',
    keyboard: [[button(`${user.language === 'ru' ? '✓ ' : ''}Русский`, 'lang:ru'), button(`${user.language === 'en' ? '✓ ' : ''}English`, 'lang:en')], back(settings)],
  };
  if (page === 'settings' || page === 'language') return {
    text: `<b>Settings</b>\n\nChange your topics, digest size and delivery times.\nAutomatic delivery: ${user.paused ? 'paused' : slots.length ? 'on' : 'manual only'}.`,
    keyboard: [[button('Categories', pageAction('categories'))], [button('Articles per digest', pageAction('count'))],
      [button('Delivery times', pageAction('delivery'))], [button(user.paused ? 'Resume delivery' : 'Pause delivery', `pause:${user.paused ? 0 : 1}`)],
      ...(aiEnabled(env, user.chat_id) ? [[button('AI language', pageAction('language'))]] : []), back(home)],
  };
  const topics = FEEDS.filter(f => categories.includes(f.id)).map(topicName);
  return {
    text: '<b>Japanese RSS</b>\n\n' + (topics.length
      ? `<b>Topics:</b> ${html(topics.slice(0, 3).join(', '))}${topics.length > 3 ? ` +${topics.length - 3} more` : ''}\n`
      : 'Choose a few topics to get started.\n')
      + `Up to ${user.item_limit} articles per digest\n\n<b>Delivery:</b>\n${deliveryText(slots, user.paused)}`,
    keyboard: [[button(topics.length ? 'Read news' : 'Choose categories', topics.length ? 'news' : pageAction('categories', 0, 'home'))],
      [button('Read later', pageAction('saved', 0, 'home')), button('Settings', settings)]],
  };
}
async function showMenu(env, user, page, index, parent, messageId, net) {
  const view = menu(user, page, index, parent, env);
  return render(env, user.chat_id, view.text, view.keyboard, net, messageId);
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
  const action = callback?.data ?? ({ '/start': 'home', '/categories': 'categories', '/settings': 'settings', '/news': 'news', '/refresh': 'refresh', '/saved': 'saved:0', '/pause': 'pause:1', '/resume': 'pause:0', '/help': 'home' })[command] ?? 'home';
  const [kind, arg, enabled, position, origin] = action.split(':');
  const messageId = callback ? message.message_id : undefined;
  if (kind === 'save' && /^\d+$/.test(arg ?? '')) {
    const text = await saveArticle(env, user, Number(arg), net, now);
    if (callback) return answer(env, callback.id, text, net).catch(() => {});
    return;
  }
  if (kind === 'keep' && ['0', '1'].includes(position)) {
    const articles = await readSession(env, chatId, Number(arg), now);
    const a = articles?.[pageNumber(enabled)];
    let text = 'This digest is no longer available.';
    if (a) {
      if (position === '1') text = await saveArticle(env, user, a.id, net, now);
      else {
        await env.DB.prepare('DELETE FROM bookmarks WHERE chat_id=? AND url=?').bind(chatId, a.url).run();
        text = 'Removed from Read later.';
      }
    }
    if (callback) await answer(env, callback.id, text, net).catch(() => {});
    return showArticle(env, chatId, Number(arg), pageNumber(enabled), net, now, messageId);
  }
  if (callback) await answer(env, callback.id, kind === 'refresh'
    ? (now - user.last_refresh_at < 3600 ? 'Reading from the shared cache.' : 'Checking your sources…') : '', net).catch(() => {});
  if (kind === 'news') return deliver(env, chatId, true, net, now, false, messageId);
  if (kind === 'refresh') {
    const ids = JSON.parse(user.categories).filter(id => FEED_MAP.has(id));
    if (!ids.length) return showMenu(env, user, 'categories', 0, 'home', messageId, net);
    const claimed = await env.DB.prepare(`UPDATE users SET last_refresh_at=? WHERE chat_id=? AND last_refresh_at<=? RETURNING chat_id`)
      .bind(now, chatId, now - 3600).first();
    if (claimed) await pollFeeds(env, net, now, ids);
    return deliver(env, chatId, true, net, now, true, messageId);
  }
  if (kind === 'digest') return showDigest(env, chatId, Number(arg), pageNumber(enabled), net, now, messageId);
  if (kind === 'article') return showArticle(env, chatId, Number(arg), pageNumber(enabled), net, now, messageId);
  if (['translate', 'explain'].includes(kind)) {
    const articles = await readSession(env, chatId, Number(arg), now);
    const a = articles?.[pageNumber(enabled)];
    if (!a) return showArticle(env, chatId, Number(arg), pageNumber(enabled), net, now, messageId);
    return runAI(env, user, kind, a.id, net, now, `article:${arg}:${pageNumber(enabled)}`);
  }
  if (kind === 'ai' && ['translate', 'explain'].includes(arg) && /^\d+$/.test(enabled ?? '')) return runAI(env, user, arg, Number(enabled), net, now);
  if (kind === 'bookmark') return showBookmark(env, user, Number(arg), pageNumber(enabled), net, messageId);
  if (kind === 'drop') {
    await env.DB.prepare('DELETE FROM bookmarks WHERE chat_id=? AND id=?').bind(chatId, Number(arg)).run();
    return showSaved(env, user, pageNumber(enabled), net, messageId);
  }
  if (kind === 'saved' || kind === 'unsave') {
    // Old saved-list callbacks used an ID cursor. Keep them usable after the UI update.
    if (!/^\d+$/.test(arg ?? '')) return;
    if (kind === 'unsave') await env.DB.prepare('DELETE FROM bookmarks WHERE chat_id=? AND id=?').bind(chatId, Number(arg)).run();
    const cursor = Number(kind === 'unsave' ? enabled : arg);
    const count = cursor ? await env.DB.prepare('SELECT count(*) AS n FROM bookmarks WHERE chat_id=? AND id>=?').bind(chatId, cursor).first() : { n: 0 };
    return showSaved(env, user, Math.floor(count.n / 5), net, messageId);
  }
  let page = 'settings', index = 0, parent = 'settings';
  if (kind === 'page') {
    if (arg === 'saved') return showSaved(env, user, pageNumber(enabled), net, messageId);
    page = arg; index = pageNumber(enabled); parent = position;
  } else if (kind === 'home') page = 'home';
  else if (kind === 'cat' && FEED_MAP.has(arg) && ['0', '1'].includes(enabled)) {
    if (enabled === '1') await env.DB.prepare(`UPDATE users SET categories=CASE
      WHEN EXISTS(SELECT 1 FROM json_each(categories) WHERE value=?) THEN categories ELSE json_insert(categories,'$[#]',?) END
      WHERE chat_id=?`).bind(arg, arg, chatId).run();
    else await env.DB.prepare(`UPDATE users SET categories=(SELECT json_group_array(value) FROM json_each(users.categories) WHERE value<>?) WHERE chat_id=?`).bind(arg, chatId).run();
    page = 'categories'; index = pageNumber(position); parent = origin;
  } else if (kind === 'count' && ['3', '5', '10'].includes(arg)) {
    await env.DB.prepare('UPDATE users SET item_limit=? WHERE chat_id=?').bind(Number(arg), chatId).run();
    page = 'count';
  } else if (kind === 'slot' && SLOTS.some(s => s.id === arg) && ['0', '1'].includes(enabled)) {
    if (enabled === '1') await env.DB.prepare(`UPDATE users SET delivery_slots=CASE
      WHEN EXISTS(SELECT 1 FROM json_each(delivery_slots) WHERE value=?) THEN delivery_slots ELSE json_insert(delivery_slots,'$[#]',?) END WHERE chat_id=?`).bind(arg, arg, chatId).run();
    else await env.DB.prepare(`UPDATE users SET delivery_slots=(SELECT json_group_array(value) FROM json_each(users.delivery_slots) WHERE value<>?) WHERE chat_id=?`).bind(arg, chatId).run();
    const fresh = await env.DB.prepare('SELECT delivery_slots FROM users WHERE chat_id=?').bind(chatId).first();
    await env.DB.prepare('UPDATE users SET next_delivery_at=? WHERE chat_id=?').bind(nextDelivery(JSON.parse(fresh.delivery_slots), now), chatId).run();
    page = 'delivery';
  } else if (kind === 'manual' || kind === 'freq') {
    const slots = kind === 'manual' || arg === '0' ? [] : ['evening'];
    await env.DB.prepare('UPDATE users SET delivery_slots=?,next_delivery_at=? WHERE chat_id=?').bind(JSON.stringify(slots), nextDelivery(slots, now), chatId).run();
    page = 'delivery';
  } else if (kind === 'pause' && ['0', '1'].includes(arg)) {
    await env.DB.prepare('UPDATE users SET paused=?,next_delivery_at=? WHERE chat_id=?').bind(Number(arg), nextDelivery(JSON.parse(user.delivery_slots), now), chatId).run();
  } else if (kind === 'lang' && ['ru', 'en'].includes(arg)) {
    await env.DB.prepare('UPDATE users SET language=? WHERE chat_id=?').bind(arg, chatId).run();
    page = 'language';
  } else if (kind === 'categories') { page = 'categories'; parent = 'home'; }
  const fresh = await env.DB.prepare('SELECT * FROM users WHERE chat_id=?').bind(chatId).first();
  await showMenu(env, fresh, page, index, parent, messageId, net);
}
