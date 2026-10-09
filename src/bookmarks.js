import { button } from './telegram.js';
import { clip, html } from './text.js';
import { render, back, pageAction, topicName } from './navigation.js';
import { FEED_MAP } from './feeds.js';

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
const savedArticles = async (env, chatId) => (await env.DB.prepare('SELECT * FROM bookmarks WHERE chat_id=? ORDER BY id DESC LIMIT 50').bind(chatId).all()).results;
export async function showSaved(env, user, index = 0, net = fetch, messageId) {
  const articles = await savedArticles(env, user.chat_id);
  const pages = Math.max(1, Math.ceil(articles.length / 5));
  index = Math.max(0, Math.min(index, pages - 1));
  const page = articles.slice(index * 5, (index + 1) * 5);
  const text = `<b>Read later${pages > 1 ? ` · ${index + 1}/${pages}` : ''}</b>\n\n` + (page.length
    ? page.map((a, i) => `${index * 5 + i + 1}. <b>${html(clip(a.title, 100))}</b>\n${html(clip(a.source, 30))}`).join('\n\n')
    : 'Your reading list is empty. Open Article details in a digest to save a story.');
  const keyboard = page.length ? [[button('Read article', `bookmark:${page[0].id}:${index}`)]] : [];
  const navigation = [];
  if (index) navigation.push(button('← Previous', pageAction('saved', index - 1, 'home')));
  if (index + 1 < pages) navigation.push(button('Next →', pageAction('saved', index + 1, 'home')));
  if (navigation.length) keyboard.push(navigation);
  keyboard.push(back(pageAction('home')));
  return render(env, user.chat_id, text, keyboard, net, messageId);
}
export async function showBookmark(env, user, id, page = 0, net = fetch, messageId) {
  const articles = await savedArticles(env, user.chat_id);
  const index = articles.findIndex(a => a.id === id);
  if (index < 0) return render(env, user.chat_id, '<b>Read later</b>\n\nThis article is no longer saved.',
    [back(pageAction('saved', page, 'home'))], net, messageId);
  const a = articles[index];
  page = Math.floor(index / 5);
  const keyboard = [[{ text: 'Open original ↗', url: a.original_url }], [button('Remove from Read later', `drop:${a.id}:${page}`)]];
  const navigation = [];
  if (index) navigation.push(button('← Previous', `bookmark:${articles[index - 1].id}:${Math.floor((index - 1) / 5)}`));
  if (index + 1 < articles.length) navigation.push(button('Next →', `bookmark:${articles[index + 1].id}:${Math.floor((index + 1) / 5)}`));
  if (navigation.length) keyboard.push(navigation);
  keyboard.push(back(pageAction('saved', page, 'home')));
  return render(env, user.chat_id, `<b>Saved article ${index + 1}/${articles.length}</b>\n\n<b>${html(clip(a.title, 160))}</b>\n`
    + `${html(topicName(FEED_MAP.get(a.category)))} · ${html(clip(a.source, 30))}`, keyboard, net, messageId);
}
