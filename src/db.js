export const DAY = 86_400;
export const nowSeconds = () => Math.floor(Date.now() / 1000);

export async function getUser(db, chatId, now = nowSeconds()) {
  await db.prepare('INSERT OR IGNORE INTO users(chat_id,created_at) VALUES (?,?)').bind(chatId, now).run();
  return db.prepare('SELECT * FROM users WHERE chat_id=?').bind(chatId).first();
}

export async function acquire(db, name, seconds = 90, now = nowSeconds()) {
  const token = crypto.randomUUID();
  const row = await db.prepare(`INSERT INTO locks(name,token,expires_at) VALUES (?,?,?)
    ON CONFLICT(name) DO UPDATE SET token=excluded.token, expires_at=excluded.expires_at
    WHERE locks.expires_at <= ? RETURNING token`).bind(name, token, now + seconds, now).first();
  return row?.token === token ? token : null;
}
export async function release(db, name, token) {
  await db.prepare('DELETE FROM locks WHERE name=? AND token=?').bind(name, token).run();
}

export async function cleanup(db, now = nowSeconds()) {
  await db.batch([
    db.prepare('DELETE FROM articles WHERE first_seen_at < ?').bind(now - 30 * DAY),
    db.prepare('DELETE FROM ai_cache WHERE expires_at < ?').bind(now),
    db.prepare('DELETE FROM processed_updates WHERE created_at < ?').bind(now - 7 * DAY),
    db.prepare('DELETE FROM locks WHERE expires_at < ?').bind(now - DAY),
  ]);
}
