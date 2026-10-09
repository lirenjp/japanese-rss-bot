CREATE TABLE users (
  chat_id INTEGER PRIMARY KEY,
  categories TEXT NOT NULL DEFAULT '[]',
  item_limit INTEGER NOT NULL DEFAULT 5 CHECK(item_limit IN (3,5,10)),
  interval_minutes INTEGER NOT NULL DEFAULT 60 CHECK(interval_minutes IN (0,15,60,1440)),
  paused INTEGER NOT NULL DEFAULT 0,
  language TEXT NOT NULL DEFAULT 'ru' CHECK(language IN ('ru','en')),
  next_delivery_at INTEGER NOT NULL DEFAULT 0,
  last_manual_at INTEGER NOT NULL DEFAULT 0,
  ai_day TEXT NOT NULL DEFAULT '',
  ai_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX users_due ON users(paused, next_delivery_at);
CREATE TABLE articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  original_url TEXT NOT NULL,
  category TEXT NOT NULL,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL
);
CREATE INDEX articles_category_date ON articles(category, published_at DESC);
CREATE TABLE deliveries (
  chat_id INTEGER NOT NULL REFERENCES users(chat_id) ON DELETE CASCADE,
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  delivered_at INTEGER NOT NULL,
  PRIMARY KEY(chat_id, article_id)
);
CREATE TABLE feed_state (
  category TEXT PRIMARY KEY,
  etag TEXT,
  modified TEXT,
  checked_at INTEGER NOT NULL,
  last_ok_at INTEGER,
  error TEXT
);
CREATE TABLE ai_cache (
  cache_key TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE locks (
  name TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE processed_updates (
  update_id INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL
);
