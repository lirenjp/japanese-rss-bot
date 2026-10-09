// One source per category. These URLs came from the supplied, checked feed list.
export const FEEDS = [
  ['news', '📰 News', 'TBS NEWS DIG', 'https://newsdig.tbs.co.jp/list/feed/rss'],
  ['cars', '🚗 Cars', 'WebCG', 'https://www.webcg.net/list/feed/rss'],
  ['anime', '🌸 Anime', 'Anime! Anime!', 'https://animeanime.jp/rss20/index.rdf'],
  ['games', '🎮 Games', 'AUTOMATON', 'https://automaton-media.com/feed/'],
  ['tech', '💻 Technology', 'ITmedia NEWS', 'https://rss.itmedia.co.jp/rss/2.0/news_bursts.xml'],
  ['dev', '🛠 Development', 'Zenn', 'https://zenn.dev/feed'],
  ['business', '💼 Business', 'Toyo Keizai', 'https://toyokeizai.net/list/feed/rss'],
  ['world', '🌏 World', 'BBC Japanese', 'https://feeds.bbci.co.uk/japanese/rss.xml'],
  ['crypto', '🪙 Crypto', 'CoinPost', 'https://coinpost.jp/?feed=rss2'],
  ['space', '🚀 Space', 'Sorae', 'https://sorae.info/feed'],
  ['culture', '🎨 Culture', 'CINRA', 'https://www.cinra.net/feed'],
  ['travel', '🚆 Travel', 'Travel Watch', 'https://travel.watch.impress.co.jp/data/rss/1.0/trw/feed.rdf'],
  ['food', '🍜 Food', 'Mesitsu', 'https://www.hotpepper.jp/mesitsu/rss'],
  ['sports', '⚽ Sports', 'Number Web', 'https://number.bunshun.jp/list/rsssports'],
  ['discussions', '💬 Discussions', 'Togetter', 'https://togetter.com/rss/news'],
].map(([id, label, source, url]) => ({ id, label, source, url }));
export const FEED_MAP = new Map(FEEDS.map(f => [f.id, f]));
