export const DAY = 86_400;
export const nowSeconds = () => Math.floor(Date.now() / 1000);

export async function getUser(db, chatId, now = nowSeconds()) {
  // Keep this first deployment small. Existing subscribers retain their settings.
  await db.prepare(`INSERT OR IGNORE INTO users(chat_id,created_at) SELECT ?,?
    WHERE (SELECT count(*) FROM users)<10`).bind(chatId, now).run();
  return db.prepare('SELECT * FROM users WHERE chat_id=?').bind(chatId).first();
}

export async function spend(db, name, limit, now = nowSeconds()) {
  const day = Math.floor(now / DAY);
  const row = await db.prepare(`INSERT INTO budgets(name,day,used) VALUES (?,?,1)
    ON CONFLICT(name) DO UPDATE SET day=excluded.day,
    used=CASE WHEN budgets.day<>excluded.day THEN 1 ELSE budgets.used+1 END
    WHERE budgets.day<>excluded.day OR budgets.used<? RETURNING used`).bind(name, day, limit).first();
  return Boolean(row);
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
    db.prepare('DELETE FROM articles WHERE id IN (SELECT id FROM articles WHERE first_seen_at < ? LIMIT 1500)').bind(now - 30 * DAY),
    db.prepare('DELETE FROM reader_sessions WHERE id IN (SELECT id FROM reader_sessions WHERE created_at < ? LIMIT 1000)').bind(now - 7 * DAY),
    db.prepare('DELETE FROM ai_cache WHERE cache_key IN (SELECT cache_key FROM ai_cache WHERE expires_at < ? LIMIT 1500)').bind(now),
    db.prepare('DELETE FROM processed_updates WHERE update_id IN (SELECT update_id FROM processed_updates WHERE created_at < ? LIMIT 1000)').bind(now - DAY),
    db.prepare('DELETE FROM locks WHERE name IN (SELECT name FROM locks WHERE expires_at < ? LIMIT 1000)').bind(now - DAY),
  ]);
}
