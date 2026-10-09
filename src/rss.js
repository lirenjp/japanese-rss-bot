import { FEEDS, FEED_MAP } from './feeds.js';
import { clip, normalizedUrl, plain, html } from './text.js';
import { DAY, nowSeconds, acquire, release, spend } from './db.js';

export const FEED_ITEMS = 5;
export const FEED_BYTES = 128_000;
// Fixed RSS/RDF/Atom sources need only a few leaf fields. Avoid parsing the
// complete XML tree, including embedded full articles, on Workers Free.
const fieldsPattern = /<(title|link|description|summary|content:encoded|content|pubDate|published|dc:date|updated)\b[^>]*(?:\/\s*>|>[\s\S]*?<\/\1\s*>)/gi;
const unCDATA = s => s.replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '');
function fieldText(raw, limit = 1600) {
  const end = raw.lastIndexOf('</');
  const inner = end < 0 ? '' : raw.slice(raw.indexOf('>') + 1, end);
  const text = plain(unCDATA(inner).slice(0, limit).replace(/<[^>]*$/, ''));
  return text.includes('<') ? plain(text) : text;
}
function attribute(raw, name) {
  const match = raw.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  return match ? plain(match[2]) : '';
}
export function parseFeed(xml, feed, now = nowSeconds()) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Invalid feed XML');
  const atom = /<feed[\s>]/i.test(xml);
  if (!atom && !/<(?:rss|rdf:RDF|RDF)[\s>]/i.test(xml)) throw new Error('Unsupported feed format');
  const tag = atom ? 'entry' : 'item';
  const entries = xml.matchAll(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'));
  const articles = [];
  let count = 0;
  for (const entry of entries) {
    const fields = new Map(), links = [];
    for (const match of entry[0].matchAll(fieldsPattern)) {
      const name = match[1].toLowerCase();
      if (name === 'link') links.push(match[0]);
      else if (!fields.has(name)) fields.set(name, match[0]);
    }
    const link = links.find(raw => !attribute(raw, 'rel') || attribute(raw, 'rel') === 'alternate');
    const rawUrl = link ? (attribute(link, 'href') || fieldText(link, 2000)) : '';
    const url = rawUrl ? normalizedUrl(rawUrl, feed.url) : null;
    const title = fields.has('title') ? clip(fieldText(fields.get('title'), 2000), 500) : '';
    if (url && title && html(new URL(rawUrl, feed.url).href).length <= 1500) {
      const dateField = ['pubdate', 'published', 'dc:date', 'updated'].find(k => fields.has(k));
      const date = dateField ? Date.parse(fieldText(fields.get(dateField), 200)) : NaN;
      const published = Number.isFinite(date) && date / 1000 <= now + 300 ? Math.floor(date / 1000) : now;
      const summaryField = ['description', 'summary', 'content:encoded', 'content'].find(k => fields.has(k));
      if (published >= now - 30 * DAY) articles.push({ url, original_url: new URL(rawUrl, feed.url).href,
        category: feed.id, source: feed.source, title,
        summary: summaryField ? clip(fieldText(fields.get(summaryField)), 600) : '',
        published_at: published, first_seen_at: now });
    }
    if (++count === FEED_ITEMS) break;
  }
  if (!count && new RegExp(`<${tag}\\b`, 'i').test(xml)) throw new Error('Incomplete feed entry');
  return articles;
}

async function feedPrefix(response) {
  if (!response.body) throw new Error('Empty feed');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let bytes = 0, xml = '', count = 0, scanned = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return xml + decoder.decode();
      const part = value.subarray(0, FEED_BYTES - bytes);
      bytes += part.length;
      xml += decoder.decode(part, { stream: true });
      // Scan each new chunk once, allowing a closing tag to straddle chunks.
      const tail = xml.slice(scanned);
      count += (tail.match(/<\/(?:item|entry)\s*>/gi) ?? []).length;
      scanned = Math.max(0, xml.length - 16);
      // A tiny overlap can count a tag twice. Recount only before stopping.
      if (count >= FEED_ITEMS && (xml.match(/<\/(?:item|entry)\s*>/gi) ?? []).length >= FEED_ITEMS) return xml;
      if (bytes >= FEED_BYTES) throw new Error('Feed prefix too large');
    }
  } finally { await reader.cancel().catch(() => {}); }
}

export async function pollFeed(env, id, net = fetch, now = nowSeconds()) {
  const feed = FEED_MAP.get(id);
  if (!feed) return { status: 'unknown' };
  const lock = await acquire(env.DB, `feed:${id}`, 30, now);
  if (!lock) return { status: 'busy' };
  try {
    const previous = await env.DB.prepare('SELECT * FROM feed_state WHERE category=?').bind(id).first();
    if (previous && now - previous.checked_at < 1800) return { status: 'cached' };
    if (!await spend(env.DB, 'feed-fetches', 120, now)) return { status: 'budget' };
    const headers = { 'User-Agent': 'JapaneseRSSBot/0.2', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' };
    if (previous?.etag) headers['If-None-Match'] = previous.etag;
    if (previous?.modified) headers['If-Modified-Since'] = previous.modified;
    let change, articles = [];
    try {
      const response = await net(feed.url, { headers, signal: AbortSignal.timeout(8000) });
      if (response.status === 304) {
        change = { ...previous, category: id, checked_at: now, last_ok_at: now, error: null };
      } else {
        if (!response.ok) { await response.body?.cancel(); throw new Error('Feed HTTP error'); }
        articles = parseFeed(await feedPrefix(response), feed, now);
        change = { category: id, etag: response.headers.get('etag'), modified: response.headers.get('last-modified'), checked_at: now, last_ok_at: now, error: null };
      }
    } catch (error) {
      console.warn('Feed failed', id, error.name);
      change = { ...previous, category: id, checked_at: now, error: 'Fetch or parse failed' };
    }
    const statements = [];
    if (articles.length) statements.push(env.DB.prepare(`INSERT INTO articles(url,original_url,category,source,title,summary,published_at,first_seen_at)
      SELECT json_extract(value,'$.url'),json_extract(value,'$.original_url'),json_extract(value,'$.category'),
      json_extract(value,'$.source'),json_extract(value,'$.title'),json_extract(value,'$.summary'),
      json_extract(value,'$.published_at'),json_extract(value,'$.first_seen_at') FROM json_each(?) WHERE 1
      ON CONFLICT(url) DO UPDATE SET title=excluded.title,summary=excluded.summary,original_url=excluded.original_url
      WHERE articles.title<>excluded.title OR articles.summary<>excluded.summary OR articles.original_url<>excluded.original_url`)
      .bind(JSON.stringify(articles)));
    statements.push(env.DB.prepare(`INSERT INTO feed_state(category,etag,modified,checked_at,last_ok_at,error)
      VALUES (?,?,?,?,?,?) ON CONFLICT(category) DO UPDATE SET etag=excluded.etag,modified=excluded.modified,
      checked_at=excluded.checked_at,last_ok_at=excluded.last_ok_at,error=excluded.error`)
      .bind(id, change.etag ?? null, change.modified ?? null, now, change.last_ok_at ?? null, change.error));
    await env.DB.batch(statements);
    return { status: change.error ? 'failed' : 'fresh', items: articles.length };
  } finally { await release(env.DB, `feed:${id}`, lock); }
}

export async function internal(env, path, net = fetch) {
  if (!env.SELF) throw new Error('SELF binding required');
  const response = await env.SELF.fetch(new Request(`https://internal${path}`, { method: 'POST',
    headers: { 'X-Internal-Secret': env.INTERNAL_SECRET ?? env.TELEGRAM_WEBHOOK_SECRET } }));
  if (!response.ok) throw new Error('Internal task failed');
  return response.json();
}

export async function pollFeeds(env, net = fetch, now = nowSeconds(), ids = FEEDS.map(f => f.id)) {
  const results = [];
  for (let i = 0; i < ids.length; i += 3) {
    results.push(...await Promise.all(ids.slice(i, i + 3).map(async id => {
      try { return env.SELF ? await internal(env, `/_internal/feed/${id}`, net) : await pollFeed(env, id, net, now); }
      catch (e) { console.warn('Feed task failed', id, e.name); return { status: 'failed' }; }
    })));
  }
  return results;
}
