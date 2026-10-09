import { clip } from './text.js';

export class TelegramError extends Error {
  constructor(code, retryAfter = 0, description = '') { super(`Telegram HTTP ${code}`); this.code = code; this.retryAfter = retryAfter; this.description = description; }
}
export async function telegram(env, method, payload, net = fetch) {
  const response = await net(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(8000),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new TelegramError(data.error_code ?? response.status, data.parameters?.retry_after, data.description);
  return data.result;
}
export const send = (env, chatId, text, keyboard, net = fetch) => telegram(env, 'sendMessage', {
  chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
  ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
}, net);
export const answer = (env, id, text = '', net = fetch) => telegram(env, 'answerCallbackQuery', {
  callback_query_id: id, text: clip(text, 180),
}, net);
export const button = (text, callback_data) => ({ text, callback_data });
