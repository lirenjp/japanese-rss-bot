import he from 'he';

export function plain(value = '') {
  return he.decode(String(value)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}
export const clip = (text, limit) => {
  const chars = Array.from(String(text));
  return chars.length > limit ? chars.slice(0, limit - 1).join('') + '…' : text;
};
export const html = (text) => String(text).replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

export function normalizedUrl(raw, base) {
  try {
    const u = new URL(raw, base);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return null;
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) {
      if (/^utm_/i.test(key) || ['fbclid', 'gclid'].includes(key.toLowerCase())) u.searchParams.delete(key);
    }
    u.searchParams.sort();
    return u.href;
  } catch { return null; }
}

export async function boundedText(response, maxBytes = 1_000_000) {
  if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('Response too large');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, result = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > maxBytes) throw new Error('Response too large');
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
}
