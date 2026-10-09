import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

// D1-shaped adapter backed by actual SQLite. This tests the real migration and SQL.
export function database(path = ':memory:') {
  const sqlite = new DatabaseSync(path);
  sqlite.exec('PRAGMA foreign_keys=ON');
  if (!sqlite.prepare("SELECT name FROM sqlite_master WHERE name='users'").get()) {
    sqlite.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  }
  function prepare(sql, args = []) {
    return {
      bind(...values) { return prepare(sql, values); },
      async first() { return sqlite.prepare(sql).get(...args) ?? null; },
      async all() { return { results: sqlite.prepare(sql).all(...args) }; },
      async run() { return { meta: sqlite.prepare(sql).run(...args) }; },
    };
  }
  return { prepare, sqlite, async batch(statements) {
    sqlite.exec('BEGIN');
    try { const result = []; for (const stmt of statements) result.push(await stmt.run()); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
}

export function env(DB) {
  return { DB, TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_WEBHOOK_SECRET: 'test-secret' };
}
export function network() {
  const messages = [], requests = [];
  let aiCalls = 0;
  const net = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : {};
    requests.push({ url, init, body });
    if (url.includes('openrouter.ai')) {
      aiCalls++;
      return Response.json({ choices: [{ message: { content: 'Test translation: 日本語 & <quoted data>' } }] });
    }
    if (url.endsWith('/sendMessage')) messages.push(body);
    return Response.json({ ok: true, result: { message_id: messages.length } });
  };
  return { net, messages, requests, get aiCalls() { return aiCalls; } };
}
export const callback = (chatId, data) => ({ callback_query: { id: 'cb1', from: { id: chatId }, data,
  message: { message_id: 9, text: 'Japanese RSS', chat: { id: chatId, type: 'private' } } } });
export const command = (chatId, text) => ({ message: { message_id: 1, from: { id: chatId }, chat: { id: chatId, type: 'private' }, text } });
export async function article(DB, category, n, now) {
  await DB.prepare(`INSERT INTO articles(url,original_url,category,source,title,summary,published_at,first_seen_at)
    VALUES (?,?,?,?,?,?,?,?)`).bind(`https://example.org/${category}/${n}`, `https://example.org/${category}/${n}`,
    category, category, `Headline ${category} ${n}`, 'Description in RSS.', now - n, now).run();
}
