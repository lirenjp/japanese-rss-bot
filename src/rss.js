import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { FEEDS } from './feeds.js';
import { boundedText, clip, normalizedUrl, plain, html } from './text.js';
import { DAY, nowSeconds } from './db.js';

const list = value => value == null ? [] : Array.isArray(value) ? value : [value];
const value = v => typeof v === 'object' && v ? (v['#text'] ?? '') : (v ?? '');
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, processEntities: true });

export function parseFeed(xml, feed, now = nowSeconds()) {
  // Feeds need no DTD. Reject entity expansion before parsing untrusted XML.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('Invalid feed XML');
  const doc = parser.parse(xml);
  const items = doc.rss?.channel?.item ?? doc['rdf:RDF']?.item ?? doc.RDF?.item ?? doc.feed?.entry;
  if (items === undefined && !doc.rss?.channel && !doc.feed && !doc['rdf:RDF'] && !doc.RDF) throw new Error('Unsupported feed format');
  return list(items).slice(0, 60).flatMap(item => {
    const links = list(item.link);
    const link = links.find(l => typeof l === 'string') ?? links.find(l => !l['@_rel'] || l['@_rel'] === 'alternate');
    const rawUrl = typeof link === 'string' ? link : link?.['@_href'] ?? value(link);
    if (!rawUrl) return [];
    const url = normalizedUrl(String(rawUrl), feed.url);
    if (!url || html(new URL(String(rawUrl), feed.url).href).length > 1500) return [];
    const title = clip(plain(value(item.title)), 500);
    if (!title) return [];
    const date = Date.parse(String(value(item.pubDate ?? item.published ?? item['dc:date'] ?? item.updated)));
    // Missing and future dates use receipt time; old, dated entries never reappear after cleanup.
    const published = Number.isFinite(date) && date / 1000 <= now + 300 ? Math.floor(date / 1000) : now;
    if (published < now - 30 * DAY) return [];
    return [{ url, original_url: new URL(String(rawUrl), feed.url).href, category: feed.id,
      source: feed.source, title,
      summary: clip(plain(value(item.description ?? item.summary ?? item['content:encoded'] ?? item.content)), 2400),
      published_at: published, first_seen_at: now }];
  });
}

export async function pollFeeds(env, net = fetch, now = nowSeconds()) {
  const states = (await env.DB.prepare('SELECT * FROM feed_state').all()).results;
  const byId = new Map(states.map(s => [s.category, s]));
  const articles = [], changes = [];
  // Fetch each source once for all users. Three concurrent requests avoid connection saturation.
  for (let i = 0; i < FEEDS.length; i += 3) {
    await Promise.all(FEEDS.slice(i, i + 3).map(async feed => {
      const previous = byId.get(feed.id);
      const headers = { 'User-Agent': 'JapaneseRSSBot/0.1', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' };
      if (previous?.etag) headers['If-None-Match'] = previous.etag;
      if (previous?.modified) headers['If-Modified-Since'] = previous.modified;
      try {
        const response = await net(feed.url, { headers, signal: AbortSignal.timeout(8000) });
        if (response.status === 304) {
          changes.push({ ...previous, category: feed.id, checked_at: now, last_ok_at: now, error: null });
          return;
        }
        if (!response.ok) throw new Error(`Feed HTTP ${response.status}`);
        articles.push(...parseFeed(await boundedText(response), feed, now));
        changes.push({ category: feed.id, etag: response.headers.get('etag'), modified: response.headers.get('last-modified'), checked_at: now, last_ok_at: now, error: null });
      } catch (error) {
        console.warn('Feed failed', feed.id, error.name);
        changes.push({ ...previous, category: feed.id, checked_at: now, error: 'Fetch or parse failed' });
      }
    }));
  }
  const statements = [];
  for (let i = 0; i < articles.length; i += 75) {
    statements.push(env.DB.prepare(`INSERT INTO articles(url,original_url,category,source,title,summary,published_at,first_seen_at)
      SELECT json_extract(value,'$.url'),json_extract(value,'$.original_url'),json_extract(value,'$.category'),
      json_extract(value,'$.source'),json_extract(value,'$.title'),json_extract(value,'$.summary'),
      json_extract(value,'$.published_at'),json_extract(value,'$.first_seen_at') FROM json_each(?) WHERE 1
      ON CONFLICT(url) DO UPDATE SET title=excluded.title,summary=excluded.summary,original_url=excluded.original_url`)
      .bind(JSON.stringify(articles.slice(i, i + 75))));
  }
  statements.push(env.DB.prepare(`INSERT INTO feed_state(category,etag,modified,checked_at,last_ok_at,error)
    SELECT json_extract(value,'$.category'),json_extract(value,'$.etag'),json_extract(value,'$.modified'),
    json_extract(value,'$.checked_at'),json_extract(value,'$.last_ok_at'),json_extract(value,'$.error')
    FROM json_each(?) WHERE 1 ON CONFLICT(category) DO UPDATE SET etag=excluded.etag,modified=excluded.modified,
    checked_at=excluded.checked_at,last_ok_at=excluded.last_ok_at,error=excluded.error`).bind(JSON.stringify(changes)));
  // Cache validators advance only when article storage succeeds too.
  await env.DB.batch(statements);
}
