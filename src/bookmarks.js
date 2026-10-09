import { send, button, telegram } from './telegram.js';
import { clip, html } from './text.js';

export async function saveArticle(env, user, articleId, net, now) {
  const a = await env.DB.prepare(`SELECT a.* FROM articles a JOIN deliveries d ON d.article_id=a.id
    WHERE d.chat_id=? AND a.id=?`).bind(user.chat_id, articleId).first();
  if (!a) return 'This article is no longer in the news cache.';
  // Snapshot the link and headline: deleting the article cache must not delete a bookmark.
  await env.DB.prepare(`INSERT OR IGNORE INTO bookmarks(chat_id,url,original_url,title,source,category,saved_at)
    SELECT ?,?,?,?,?,?,? WHERE (SELECT count(*) FROM bookmarks WHERE chat_id=?) < 50`)
    .bind(user.chat_id, a.url, a.original_url, a.title, a.source, a.category, now, user.chat_id).run();
  const saved = await env.DB.prepare('SELECT id FROM bookmarks WHERE chat_id=? AND url=?').bind(user.chat_id, a.url).first();
  return saved ? 'Saved for later.' : 'Your reading list is full (50). Remove an item to save another.';
}

export async function showSaved(env, user, before, net, messageId) {
  const { results } = await env.DB.prepare(`SELECT * FROM bookmarks WHERE chat_id=? AND id<? ORDER BY id DESC LIMIT 6`)
    .bind(user.chat_id, before || Number.MAX_SAFE_INTEGER).all();
  const page = results.slice(0, 5);
  const text = '<b>Read later</b>\n\n' + (page.length ? page.map((a, i) =>
    `${i + 1}. <b>${html(clip(a.title, 100))}</b>\n${html(clip(a.source, 20))}`).join('\n\n') : 'Your reading list is empty.');
  const keyboard = page.map((a, i) => [{ text: `${i + 1} · Open article`, url: a.original_url }, button(`${i + 1} · Remove`, `unsave:${a.id}:${before || 0}`)]);
  if (results.length > 5) keyboard.push([button('Next 5', `saved:${page.at(-1).id}`)]);
  keyboard.push([button('First page', 'saved:0'), button('Settings', 'settings')]);
  if (!messageId) return send(env, user.chat_id, text, keyboard, net);
  try { return await telegram(env, 'editMessageText', { chat_id: user.chat_id, message_id: messageId,
    text, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }, net); }
  catch (e) { if (e.code !== 400) throw e; }
}
