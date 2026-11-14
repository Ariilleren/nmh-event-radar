import { AppError } from './errors';

/** An explicitly configured public source; URLs from news or HTTP input are never fetched. */
export const telegramSource = {
  channel: 'newsssss09',
  title: '@newsssss09',
  url: 'https://t.me/newsssss09',
  previewUrl: 'https://t.me/s/newsssss09',
} as const;

export type TelegramMessage = {
  text: string;
  publisher: string;
  url: string;
  publishedAt: string;
  timezone: null;
  origin: 'telegram';
};

const maxPageBytes = 2_000_000;
const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', bull: '•', copy: '©', reg: '®', trade: '™' };
function decodeHtml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (raw, key: string) => {
    if (!key.startsWith('#')) return entities[key.toLowerCase()] ?? raw;
    const code = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : raw;
  });
}
function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) result[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3]);
  return result;
}

/** Parses Telegram's public preview, preserving the publication text and absolute post URL. */
export function parseTelegramPage(html: string, limit = 10): { messages: TelegramMessage[]; skipped: number } {
  if (Buffer.byteLength(html) > maxPageBytes) throw new AppError(502, 'TELEGRAM_SIZE', 'Страница Telegram превышает лимит 2 МБ.');
  const messages: TelegramMessage[] = [];
  let skipped = 0;
  let post: { id: string; text: string; date: string | null; depth: number } | null = null;
  let depth = 0;
  let textDepth: number | null = null;
  let ignoredTag: string | null = null;
  const seen = new Set<string>();
  const finish = () => {
    if (!post) return;
    const text = post.text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim();
    if (text.length >= 10 && text.length <= 20000 && post.date && !seen.has(post.id)) {
      seen.add(post.id);
      messages.push({ text, publisher: telegramSource.title, url: `${telegramSource.url}/${post.id}`, publishedAt: post.date, timezone: null, origin: 'telegram' });
    } else skipped++;
    post = null; textDepth = null;
  };
  // Tags and text are separate tokens: escaped markup in a post cannot become a real tag.
  for (const match of html.matchAll(/<!--[\s\S]*?-->|<[^>"']*(?:"[^"]*"[^>"']*|'[^']*'[^>"']*)*>|[^<]+/g)) {
    const token = match[0];
    if (token.startsWith('<!--')) continue;
    if (!token.startsWith('<')) {
      if (post && textDepth !== null && !ignoredTag) post.text += decodeHtml(token);
      continue;
    }
    const name = /^<\/?\s*([\w-]+)/.exec(token)?.[1].toLowerCase();
    if (!name) continue;
    const closing = /^<\//.test(token);
    if (ignoredTag) { if (closing && name === ignoredTag) ignoredTag = null; continue; }
    if (['script', 'style'].includes(name) && !closing) { ignoredTag = name; continue; }
    if (name === 'br') { if (post && textDepth !== null) post.text += '\n'; continue; }
    if (name === 'div') {
      if (closing) {
        if (textDepth === depth) textDepth = null;
        if (post?.depth === depth) finish();
        depth = Math.max(0, depth - 1);
        continue;
      }
      depth++;
      const attrs = attributes(token);
      const classes = (attrs.class ?? '').split(/\s+/);
      if (classes.includes('tgme_widget_message') && attrs['data-post']) {
        finish();
        const known = new RegExp(`^${telegramSource.channel}/([1-9][0-9]*)$`, 'i').exec(attrs['data-post']);
        if (known) post = { id: known[1], text: '', date: null, depth };
      }
      if (post && classes.includes('tgme_widget_message_text')) textDepth = depth;
      continue;
    }
    if (post && name === 'time' && !closing) {
      const date = attributes(token).datetime;
      // An instant does not establish the author's local timezone for relative event dates.
      if (date && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(date) && Number.isFinite(Date.parse(date))) post.date = new Date(date).toISOString();
    }
    if (post && textDepth !== null && closing && ['p', 'li', 'blockquote'].includes(name)) post.text += '\n';
  }
  finish();
  if (!messages.length) throw new AppError(502, 'TELEGRAM_EMPTY', 'В публичном просмотре @newsssss09 нет доступных текстовых публикаций. Канал может быть закрыт или Telegram изменил формат страницы.');
  return { messages: messages.slice(-Math.max(1, Math.min(20, limit))), skipped };
}

export async function fetchTelegramMessages(limit = 10, transport: typeof fetch = fetch) {
  const signal = AbortSignal.timeout(15_000);
  try {
    const response = await transport(telegramSource.previewUrl, { signal, redirect: 'error', cache: 'no-store', headers: { Accept: 'text/html', 'User-Agent': 'NMH-Event-Radar/1.0 (public channel preview)' } });
    if (!response.ok) throw new AppError(502, 'TELEGRAM_HTTP', `Telegram не отдал публикации @newsssss09 (HTTP ${response.status}). Повторите позже.`);
    if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('text/html')) throw new AppError(502, 'TELEGRAM_FORMAT', 'Telegram вернул неподдерживаемый формат вместо страницы канала.');
    if (Number(response.headers.get('content-length') ?? 0) > maxPageBytes) throw new AppError(502, 'TELEGRAM_SIZE', 'Страница Telegram превышает лимит 2 МБ.');
    const reader = response.body?.getReader();
    if (!reader) throw new AppError(502, 'TELEGRAM_EMPTY', 'Telegram вернул пустой ответ.');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > maxPageBytes) throw new AppError(502, 'TELEGRAM_SIZE', 'Страница Telegram превышает лимит 2 МБ.');
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    return parseTelegramPage(Buffer.concat(chunks).toString('utf8'), limit);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(signal.aborted ? 504 : 502, signal.aborted ? 'TELEGRAM_TIMEOUT' : 'TELEGRAM_UNAVAILABLE', 'Не удалось загрузить @newsssss09 из Telegram. Проверьте доступ к t.me и повторите. Можно сохранить текст публикации вручную со ссылкой.');
  }
}

type SaveMessage = (message: TelegramMessage & { actor: string }) => Promise<{ eventId: string; duplicate: boolean }>;
export async function importTelegramMessages(actor: string, save: SaveMessage, limit = 10, transport: typeof fetch = fetch) {
  const page = await fetchTelegramMessages(limit, transport);
  const results: { eventId: string; duplicate: boolean }[] = [];
  for (const message of page.messages) {
    try { results.push(await save({ ...message, actor })); }
    catch { throw new AppError(502, 'TELEGRAM_SAVE', `Не удалось сохранить все публикации Telegram. Уже обработано: ${results.length} из ${page.messages.length}. Повторите импорт: сохранённые повторы будут пропущены.`); }
  }
  return { source: telegramSource, fetched: page.messages.length, imported: results.filter((item) => !item.duplicate).length, duplicates: results.filter((item) => item.duplicate).length, skipped: page.skipped, results };
}
