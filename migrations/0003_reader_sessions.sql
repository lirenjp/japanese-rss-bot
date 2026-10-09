CREATE TABLE reader_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL REFERENCES users(chat_id) ON DELETE CASCADE,
  article_ids TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX reader_sessions_expiry ON reader_sessions(created_at);
