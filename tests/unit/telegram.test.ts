import { describe, expect, it, vi } from 'vitest';
import { fetchTelegramMessages, importTelegramMessages, parseTelegramPage, telegramSource } from '../../src/server/telegram';

function post(id: number, text: string, date = '2026-11-15T09:00:00+03:00', channel = 'newsssss09') {
  return `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div data-post="${channel}/${id}" class="tgme_widget_message js-widget_message"><div class="tgme_widget_message_author"><a>Author</a></div><div class="tgme_widget_message_text js-message_text" dir="auto">${text}</div><div class="tgme_widget_message_footer"><a class="tgme_widget_message_date"><time datetime="${date}">09:00</time></a></div></div></div>`;
}
const page = (text: string) => new Response(text, { headers: { 'content-type': 'text/html; charset=utf-8' } });

describe('configured Telegram source', () => {
  it('preserves text, Cyrillic entities, line breaks, date and original post URL without guessing timezone', () => {
    const html = `<html><body>${post(55, 'Москва: <b>перекрытие</b><br>15 ноября &amp; 16 ноября. &#x1F6A7; &lt;script&gt;alert(1)&lt;/script&gt;')}</body></html>`;
    expect(parseTelegramPage(html)).toEqual({ messages: [{ channel: 'newsssss09', messageId: '55', links: [],
      text: 'Москва: перекрытие\n15 ноября & 16 ноября. 🚧 <script>alert(1)</script>',
      publisher: '@newsssss09', url: 'https://t.me/newsssss09/55', publishedAt: '2026-11-15T06:00:00.000Z', timezone: null, origin: 'telegram',
    }], skipped: 0, nextBefore: null });
  });

  it('only accepts this channel, rejects incomplete metadata, skips photo-only posts and returns the latest bounded batch', () => {
    const html = post(1, 'Старое сообщение канала') + post(10, 'Текст другого источника', undefined, 'other_channel') + post(2, 'Нет даты публикации', '') + post(3, '') + post(4, 'Последнее сообщение канала');
    expect(parseTelegramPage(html, 1)).toEqual({ messages: [expect.objectContaining({ url: 'https://t.me/newsssss09/4', text: 'Последнее сообщение канала' })], skipped: 2, nextBefore: null });
  });

  it('handles nested blocks and ignores script/style content and duplicate post ids', () => {
    const html = post(7, 'Новость <div>вложенный блок</div><script>опасный код</script><style>скрытый стиль</style><b> конец</b>') + post(7, 'Дубликат того же сообщения');
    expect(parseTelegramPage(html).messages.map((message) => message.text)).toEqual(['Новость вложенный блок конец']);
  });

  it('does not turn an inaccessible or changed preview into a successful empty import', () => {
    expect(() => parseTelegramPage('<html><body>Open in Telegram</body></html>')).toThrow(/нет доступных текстовых публикаций/);
    expect(() => parseTelegramPage(post(1, 'Сообщение', 'yesterday'))).toThrow(/нет доступных/);
  });

  it('fetches only the configured HTTPS preview and prohibits redirects', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(page(post(50, 'Проверяемое сообщение')));
    const result = await fetchTelegramMessages(10, transport);
    expect(result.messages).toHaveLength(1);
    expect(transport).toHaveBeenCalledWith(telegramSource.previewUrl, expect.objectContaining({ redirect: 'error', cache: 'no-store', signal: expect.any(AbortSignal) }));
  });

  it('reports HTTP and network errors explicitly without provider details', async () => {
    await expect(fetchTelegramMessages(10, vi.fn<typeof fetch>().mockResolvedValue(new Response('Private details', { status: 503 })))).rejects.toMatchObject({ code: 'TELEGRAM_HTTP', message: expect.stringContaining('503') });
    await expect(fetchTelegramMessages(10, vi.fn<typeof fetch>().mockRejectedValue(new Error('secret proxy details')))).rejects.toMatchObject({ code: 'TELEGRAM_UNAVAILABLE', message: expect.not.stringContaining('secret') });
  });

  it('enforces response format and streamed size limit', async () => {
    await expect(fetchTelegramMessages(10, vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { headers: { 'content-type': 'application/json' } })))).rejects.toMatchObject({ code: 'TELEGRAM_FORMAT' });
    await expect(fetchTelegramMessages(10, vi.fn<typeof fetch>().mockResolvedValue(page('x'.repeat(2_000_001))))).rejects.toMatchObject({ code: 'TELEGRAM_SIZE' });
  });

  it('saves provenance through the existing workflow and counts duplicates', async () => {
    const save = vi.fn().mockResolvedValueOnce({ eventId: 'first', duplicate: false }).mockResolvedValueOnce({ eventId: 'second', duplicate: true });
    const transport = vi.fn<typeof fetch>().mockResolvedValue(page(post(50, 'Первая новость канала') + post(51, 'Вторая новость канала')));
    const result = await importTelegramMessages('Анна', save, 10, transport);
    expect(result).toMatchObject({ imported: 1, duplicates: 1, fetched: 2 });
    expect(save).toHaveBeenNthCalledWith(1, expect.objectContaining({ actor: 'Анна', origin: 'telegram', url: 'https://t.me/newsssss09/50', timezone: null }));
  });

  it('makes partial save failures explicit and preserves completed writes for safe retry', async () => {
    const save = vi.fn().mockResolvedValueOnce({ eventId: 'first', duplicate: false }).mockRejectedValueOnce(new Error('database detail'));
    const transport = vi.fn<typeof fetch>().mockResolvedValue(page(post(50, 'Первая новость канала') + post(51, 'Вторая новость канала')));
    await expect(importTelegramMessages('Анна', save, 10, transport)).rejects.toMatchObject({ code: 'TELEGRAM_SAVE', message: expect.stringContaining('1 из 2') });
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('keeps short captions, anchor destinations and legitimate media-only pages', () => {
    const result = parseTelegramPage(post(1, 'Да<br><a href="https://example.test/a?x=1&amp;y=2">источник</a>'));
    expect(result.messages[0].text).toBe('Да\nисточник');
    expect(result.messages[0].links).toEqual([{ text: 'источник', url: 'https://example.test/a?x=1&y=2' }]);
    expect(parseTelegramPage(post(2, '')).messages).toEqual([]);
    expect(parseTelegramPage('<div class="tgme_channel_info">newsssss09</div>').messages).toEqual([]);
  });

  it('loads at most fifty latest available posts with bounded same-channel pagination', async () => {
    const html = (from: number, to: number, before?: number) => Array.from({ length: to - from + 1 }, (_, i) => post(from + i, `Текст публикации ${from + i}`)).join('') + (before ? `<a href="/s/newsssss09?before=${before}">More</a>` : '');
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(page(html(41, 60, 41))).mockResolvedValueOnce(page(html(21, 40, 21))).mockResolvedValueOnce(page(html(1, 20)));
    const result = await fetchTelegramMessages(50, transport);
    expect(result.messages).toHaveLength(50);
    expect(result.messages[0].messageId).toBe('11');
    expect(result.messages.at(-1)?.messageId).toBe('60');
    expect(transport).toHaveBeenCalledTimes(3);
    expect(transport.mock.calls[1][0]).toBe('https://t.me/s/newsssss09?before=41');
  });
});
