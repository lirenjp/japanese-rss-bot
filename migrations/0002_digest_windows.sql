ALTER TABLE users ADD COLUMN delivery_slots TEXT NOT NULL DEFAULT '["evening"]';
ALTER TABLE users ADD COLUMN last_refresh_at INTEGER NOT NULL DEFAULT 0;
UPDATE users SET delivery_slots=CASE WHEN interval_minutes=0 THEN '[]' ELSE '["evening"]' END,next_delivery_at=0;
CREATE TABLE bookmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL REFERENCES users(chat_id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  original_url TEXT NOT NULL,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  category TEXT NOT NULL,
  saved_at INTEGER NOT NULL,
  UNIQUE(chat_id,url)
);
CREATE INDEX bookmarks_page ON bookmarks(chat_id,id DESC);
CREATE TABLE budgets (name TEXT PRIMARY KEY,day INTEGER NOT NULL,used INTEGER NOT NULL);
