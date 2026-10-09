import { send, telegram, button } from './telegram.js';

export const back = target => [button('← Back', target)];
export const pageAction = (page, index = 0, parent = 'settings') => `page:${page}:${index}:${parent}`;
export const aiEnabled = (env, chatId) => Boolean(env.OPENROUTER_API_KEY && env.OPENROUTER_MODEL
  && (env.AI_ALLOWED_CHAT_IDS ?? '').split(',').map(s => s.trim()).includes(String(chatId)));
export async function render(env, chatId, text, keyboard, net = fetch, messageId) {
  if (!messageId) return send(env, chatId, text, keyboard, net);
  try {
    return await telegram(env, 'editMessageText', { chat_id: chatId, message_id: messageId,
      text, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: keyboard } }, net);
  } catch (e) {
    // Telegram rejects an edit when a repeated click leaves the message unchanged.
    if (e.code !== 400 || !/message is not modified/i.test(e.description ?? '')) throw e;
  }
}
export const topicName = feed => feed?.label.replace(/^\S+\s/, '') ?? '';
