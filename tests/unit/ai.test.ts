import { describe, expect, it, vi } from 'vitest';
import { analyzeMessage, checkAIConnection, getAIStatus } from '../../src/ai';
import { demoMessages } from '../../src/data/demo';
import { type Extraction } from '../../src/domain/schemas';

// Independent mock data: this response is never submitted to any real model.
const text = 'Учебное сообщение. Москва: концерт запланирован на 15 ноября 2026, с 19:00 до 22:30. Координаты 55.7500, 37.6100.';
const input = { text, publisher: 'Тестовый источник', publishedAt: '2026-11-14T06:00:00Z', timezone: 'Europe/Moscow' };
const extraction: Extraction = {
  category: 'mass_event', title: 'Учебный концерт', summary: 'Сообщение о концерте.', status: 'scheduled',
  startsAt: '2026-11-15T19:00:00+03:00', endsAt: '2026-11-15T22:30:00+03:00', timezone: 'Europe/Moscow',
  city: 'Москва', street: null, address: null, latitude: 55.75, longitude: 37.61, vehicleRestriction: null,
  impactHypothesis: 'Проверить возможное влияние на вечернюю смену; поток неизвестен.', recommendedAction: 'Проверить смену.',
  evidence: [
    { field: 'category', quote: 'концерт' }, { field: 'status', quote: 'запланирован' },
    { field: 'startsAt', quote: '15 ноября 2026, с 19:00 до 22:30' }, { field: 'endsAt', quote: '15 ноября 2026, с 19:00 до 22:30' },
    { field: 'city', quote: 'Москва' }, { field: 'latitude', quote: 'Координаты 55.7500, 37.6100.' }, { field: 'longitude', quote: 'Координаты 55.7500, 37.6100.' },
  ],
};
const env = { AI_MODE: 'LIVE', AI_API_KEY: 'unit-test-not-a-real-key', AI_MODEL: 'mock-model', AI_BASE_URL: 'https://example.test/v1' };
const completion = (content: unknown, finishReason = 'stop') => new Response(JSON.stringify({
  choices: [{ finish_reason: finishReason, message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }],
}), { status: 200, headers: { 'Content-Type': 'application/json' } });
const reply = (content: unknown) => vi.fn<typeof fetch>().mockResolvedValue(completion(content));

describe('AI: honest modes and configuration', () => {
  it('DEMO accepts only exact known text and returns detached prepared answers', async () => {
    const example = demoMessages[0];
    const result = await analyzeMessage(example, { env: { AI_MODE: 'DEMO' } });
    expect(result.mode).toBe('DEMO'); expect(result.model).toBeNull();
    result.extraction.title = 'changed';
    expect((await analyzeMessage(example, { env: { AI_MODE: 'DEMO' } })).extraction.title).not.toBe('changed');
    await expect(analyzeMessage({ ...example, text: `${example.text}\nСовсем новое условие.` }, { env: { AI_MODE: 'DEMO' } })).rejects.toMatchObject({ code: 'DEMO_UNKNOWN_TEXT', statusCode: 422 });
  });
  it('LIVE never falls back to a prepared answer, even for a known text', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('provider unavailable'));
    await expect(analyzeMessage(demoMessages[0], { env, fetchImpl })).rejects.toMatchObject({ code: 'AI_NETWORK_ERROR', mode: 'LIVE', model: 'mock-model' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('missing key/model and invalid mode produce explicit errors without network', async () => {
    const fetchImpl = reply(extraction);
    await expect(analyzeMessage(input, { env: { AI_MODE: 'LIVE', AI_MODEL: 'mock' }, fetchImpl })).rejects.toMatchObject({ code: 'AI_CONFIG' });
    await expect(analyzeMessage(input, { env: { AI_MODE: 'LIVE', AI_API_KEY: 'test' }, fetchImpl })).rejects.toMatchObject({ code: 'AI_CONFIG' });
    await expect(analyzeMessage(input, { env: { AI_MODE: 'nonsense' }, fetchImpl })).rejects.toMatchObject({ code: 'AI_CONFIG' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('settings do not disclose keys, and readiness is not a claim of connectivity', () => {
    const status = getAIStatus(env);
    expect(status.configured).toBe(true);
    expect(JSON.stringify(status)).not.toContain(env.AI_API_KEY);
    expect(status.message).toContain('не подтверждает доступ');
    expect(getAIStatus({ AI_MODE: 'LIVE' }).configured).toBe(false);
  });
  it('DEMO connection check makes no model request', async () => {
    const fetchImpl = reply(extraction);
    const result = await checkAIConnection({ env: { AI_MODE: 'DEMO' }, fetchImpl });
    expect(result.message).toContain('не проверялось');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('LIVE validation and bounded transport', () => {
  it('returns only validated extraction and sends one source to the configured endpoint', async () => {
    const fetchImpl = reply(extraction);
    const result = await analyzeMessage(input, { env, fetchImpl });
    expect(result.extraction).toEqual(extraction); expect(result.mode).toBe('LIVE');
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://example.test/v1/chat/completions');
    const request = JSON.parse(options?.body as string);
    expect(request.model).toBe('mock-model');
    expect(request.store).toBe(false);
    expect(request.response_format.type).toBe('json_object');
    expect(JSON.parse(request.messages[1].content)).toEqual({ source: input });
    expect(options?.redirect).toBe('error');
  });
  it.each(['{not json', '```json\n{}\n```'])('rejects invalid or markdown-wrapped model JSON', async (value) => {
    await expect(analyzeMessage(input, { env, fetchImpl: reply(value) })).rejects.toMatchObject({ code: 'AI_INVALID_JSON' });
  });
  it('rejects incompatible outer envelope and invalid schema', async () => {
    await expect(analyzeMessage(input, { env, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response('{broken')) })).rejects.toMatchObject({ code: 'AI_INVALID_JSON' });
    await expect(analyzeMessage(input, { env, fetchImpl: reply({ category: 'mass_event' }) })).rejects.toMatchObject({ code: 'AI_INVALID_SCHEMA' });
  });
  it('rejects fabricated quotations and missing field evidence', async () => {
    await expect(analyzeMessage(input, { env, fetchImpl: reply({ ...extraction, evidence: [{ field: 'category', quote: 'No such quotation' }] }) })).rejects.toMatchObject({ code: 'AI_INVALID_EVIDENCE' });
    await expect(analyzeMessage(input, { env, fetchImpl: reply({ ...extraction, evidence: extraction.evidence.filter(item => item.field !== 'startsAt') }) })).rejects.toMatchObject({ code: 'AI_INVALID_EVIDENCE' });
  });
  it('allows whitespace normalization in exact quotes, without paraphrase', async () => {
    const spaced = { ...extraction, evidence: extraction.evidence.map(item => ({ ...item, quote: item.quote.replaceAll(' ', '\n  ') })) };
    expect((await analyzeMessage(input, { env, fetchImpl: reply(spaced) })).mode).toBe('LIVE');
  });
  it('rejects geocoded coordinates not literally present in coordinate evidence', async () => {
    await expect(analyzeMessage(input, { env, fetchImpl: reply({ ...extraction, latitude: 55.91 }) })).rejects.toMatchObject({ code: 'AI_UNGROUNDED_COORDINATES' });
  });
  it('rejects incomplete or refused completions', async () => {
    await expect(analyzeMessage(input, { env, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(completion(extraction, 'length')) })).rejects.toMatchObject({ code: 'AI_INCOMPLETE_RESPONSE' });
  });
  it('does not echo upstream errors or credential-bearing exception text', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(`secret: ${env.AI_API_KEY}`, { status: 401 }));
    const error = await analyzeMessage(input, { env, fetchImpl }).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: 'AI_HTTP_ERROR' });
    expect(String(error)).not.toContain(env.AI_API_KEY);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('retries a transient 503 only once; successful retry still validates output', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(completion(extraction));
    const sleep = vi.fn().mockResolvedValue(undefined);
    expect((await analyzeMessage(input, { env, fetchImpl, sleep })).mode).toBe('LIVE');
    expect(fetchImpl).toHaveBeenCalledTimes(2); expect(sleep).toHaveBeenCalledTimes(1);
  });
  it('stops after two rate-limited calls and limits Retry-After', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status: 429, headers: { 'Retry-After': '999999' } }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(analyzeMessage(input, { env, fetchImpl, sleep })).rejects.toMatchObject({ code: 'AI_HTTP_ERROR' });
    expect(fetchImpl).toHaveBeenCalledTimes(2); expect(sleep).toHaveBeenCalledWith(2000);
  });
  it('shows timeout without hidden retry or fallback', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    await expect(analyzeMessage(input, { env, fetchImpl, timeoutMs: 5 })).rejects.toMatchObject({ code: 'AI_TIMEOUT', statusCode: 504, mode: 'LIVE' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('bounds input and response sizes', async () => {
    const fetchImpl = reply(extraction);
    await expect(analyzeMessage({ ...input, text: 'x'.repeat(16001) }, { env, fetchImpl })).rejects.toMatchObject({ code: 'AI_INPUT_INVALID' });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(analyzeMessage(input, { env, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(128001))) })).rejects.toMatchObject({ code: 'AI_RESPONSE_TOO_LARGE' });
  });
  it('rejects credentials in API URL and non-local plaintext HTTP', async () => {
    for (const url of ['https://secret@example.test/v1', 'http://example.test/v1', 'https://example.test/v1?token=secret']) {
      await expect(analyzeMessage(input, { env: { ...env, AI_BASE_URL: url }, fetchImpl: reply(extraction) })).rejects.toMatchObject({ code: 'AI_CONFIG' });
    }
  });
});

describe('relative dates', () => {
  const relativeText = text.replace('15 ноября 2026', 'завтра');
  const relativeExtraction = { ...extraction, evidence: extraction.evidence.map(item => ({ ...item, quote: item.quote.replace('15 ноября 2026', 'завтра') })) };
  it('uses publication day in its explicit timezone, including local midnight', async () => {
    const result = await analyzeMessage({ ...input, text: relativeText, publishedAt: '2026-11-13T22:00:00Z' }, { env, fetchImpl: reply(relativeExtraction) });
    expect(result.extraction.startsAt).toBe(extraction.startsAt);
  });
  it('leaves relative time unknown without date or publication timezone', async () => {
    for (const metadata of [{ publishedAt: null }, { timezone: null }]) {
      const result = await analyzeMessage({ ...input, text: relativeText, ...metadata }, { env, fetchImpl: reply(relativeExtraction) });
      expect(result.extraction.startsAt).toBeNull(); expect(result.extraction.endsAt).toBeNull();
    }
  });
  it('rejects a wrong resolved day instead of treating a valid quote as correct time', async () => {
    await expect(analyzeMessage({ ...input, text: relativeText, publishedAt: '2026-11-12T06:00:00Z' }, { env, fetchImpl: reply(relativeExtraction) })).rejects.toMatchObject({ code: 'AI_INVALID_RELATIVE_DATE' });
  });
});
