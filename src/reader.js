import { button } from './telegram.js';
import { clip, html } from './text.js';
import { FEED_MAP } from './feeds.js';
import { nowSeconds, DAY } from './db.js';
import { render, back, pageAction, aiEnabled, topicName } from './navigation.js';

export function digestPages(articles) {
  const pages = [];
  let page = { text: '', ids: [], start: 0 };
  articles.forEach((a, i) => {
    const block = `${i + 1}. <a href="${html(a.original_url)}"><b>${html(clip(a.title, 130))}</b></a>\n`
      + `${html(topicName(FEED_MAP.get(a.category)))} · ${html(clip(a.source, 30))}\n`
      + (a.summary ? `${html(clip(a.summary, 180))}\n` : '') + '\n';
    if (page.ids.length && (page.text.length + block.length > 3400 || page.ids.length === 5)) {
      pages.push(page); page = { text: '', ids: [], start: i };
    }
    page.text += block; page.ids.push(a.id);
  });
  if (page.ids.length) pages.push(page);
  return pages;
}
export async function createSession(env, chatId, articles, now) {
  const row = await env.DB.prepare('INSERT INTO reader_sessions(chat_id,article_ids,created_at) VALUES (?,?,?) RETURNING id')
    .bind(chatId, JSON.stringify(articles.map(a => a.id)), now).first();
  return row.id;
}
export async function readSession(env, chatId, id, now = nowSeconds()) {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const session = await env.DB.prepare('SELECT article_ids FROM reader_sessions WHERE id=? AND chat_id=? AND created_at>=?')
    .bind(id, chatId, now - 7 * DAY).first();
  if (!session) return null;
  const { results } = await env.DB.prepare(`SELECT a.* FROM json_each(?) j JOIN articles a ON a.id=j.value ORDER BY CAST(j.key AS INTEGER)`)
    .bind(session.article_ids).all();
  return results.length ? results : null;
}
async function remember(env, chatId, ids, now) {
  await env.DB.prepare(`INSERT OR IGNORE INTO deliveries(chat_id,article_id,delivered_at)
    SELECT ?,value,? FROM json_each(?)`).bind(chatId, now, JSON.stringify(ids)).run();
}
async function expired(env, chatId, net, messageId) {
  return render(env, chatId, '<b>News</b>\n\nThis digest is no longer available. Request a fresh selection.',
    [[button('Read news', 'news')], back(pageAction('home'))], net, messageId);
}
export async function showDigest(env, chatId, sessionId, index = 0, net = fetch, now = nowSeconds(), messageId, articles) {
  articles ??= await readSession(env, chatId, sessionId, now);
  if (!articles) return expired(env, chatId, net, messageId);
  const pages = digestPages(articles);
  index = Math.max(0, Math.min(index, pages.length - 1));
  const page = pages[index];
  const keyboard = [[button('Article details', `article:${sessionId}:${page.start}`)]];
  const navigation = [];
  if (index) navigation.push(button('← Previous', `digest:${sessionId}:${index - 1}`));
  if (index + 1 < pages.length) navigation.push(button('Next →', `digest:${sessionId}:${index + 1}`));
  if (navigation.length) keyboard.push(navigation);
  if (index === pages.length - 1) keyboard.push([button('More news', 'news'), button('Refresh sources', 'refresh')]);
  keyboard.push(back(pageAction('home')));
  const text = `<b>Your news${pages.length > 1 ? ` · ${index + 1}/${pages.length}` : ''}</b>\n${articles.length} articles in this selection\n\n${page.text.trim()}`;
  await render(env, chatId, text, keyboard, net, messageId);
  await remember(env, chatId, page.ids, now);
}
export async function showArticle(env, chatId, sessionId, index, net = fetch, now = nowSeconds(), messageId) {
  const articles = await readSession(env, chatId, sessionId, now);
  if (!articles) return expired(env, chatId, net, messageId);
  index = Math.max(0, Math.min(index, articles.length - 1));
  const a = articles[index];
  const saved = await env.DB.prepare('SELECT id FROM bookmarks WHERE chat_id=? AND url=?').bind(chatId, a.url).first();
  const keyboard = [[{ text: 'Open original ↗', url: a.original_url }],
    [button(saved ? 'Remove from Read later' : 'Save for later', `keep:${sessionId}:${index}:${saved ? 0 : 1}`)]];
  if (aiEnabled(env, chatId)) keyboard.push([button('Translate excerpt', `translate:${sessionId}:${index}`), button('Explain excerpt', `explain:${sessionId}:${index}`)]);
  const navigation = [];
  if (index) navigation.push(button('← Previous', `article:${sessionId}:${index - 1}`));
  if (index + 1 < articles.length) navigation.push(button('Next →', `article:${sessionId}:${index + 1}`));
  if (navigation.length) keyboard.push(navigation);
  const pages = digestPages(articles);
  const page = pages.findIndex(p => p.ids.includes(a.id));
  keyboard.push(back(`digest:${sessionId}:${page}`));
  const text = `<b>Article ${index + 1}/${articles.length}</b>\n\n<b>${html(clip(a.title, 160))}</b>\n`
    + `${html(topicName(FEED_MAP.get(a.category)))} · ${html(clip(a.source, 30))}`
    + (a.summary ? `\n\n${html(clip(a.summary, 250))}` : '');
  await render(env, chatId, text, keyboard, net, messageId);
  await remember(env, chatId, [a.id], now);
}
