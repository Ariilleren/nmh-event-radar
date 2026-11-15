import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { completeNewsJson, getNewsAiCacheScope, getNewsAiConfig, getNewsAiStatus } from '../../src/ai/provider';

const gemini = { NEWS_AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'test-gemini-not-real' };
const groq = { GROQ_API_KEY: 'test-groq-not-real' };
const schema = z.object({ ok: z.boolean(), at: z.iso.datetime({ offset: true }).nullable() }).strict();
const envelope = (value: unknown, finish = 'stop') => new Response(JSON.stringify({ choices: [{ finish_reason: finish, message: { content: JSON.stringify(value) } }] }));

describe('news provider configuration', () => {
  it('defaults to Groq and requires an explicit Gemini selection', () => {
    expect(getNewsAiStatus({})).toEqual({ provider: 'groq', model: 'openai/gpt-oss-20b', configured: false, errorCode: 'GROQ_NOT_CONFIGURED' });
    expect(getNewsAiStatus(gemini)).toEqual({ provider: 'gemini', model: 'gemini-3.1-flash-lite', configured: true, errorCode: null });
    expect(getNewsAiStatus({ GEMINI_API_KEY: gemini.GEMINI_API_KEY }).configured).toBe(false);
    const status = getNewsAiStatus(gemini);
    expect(status).not.toHaveProperty('apiKey'); expect(status).not.toHaveProperty('baseUrl');
    expect(JSON.stringify(status)).not.toContain(gemini.GEMINI_API_KEY);
  });
  it('does not fall back to Groq when selected Gemini has no credential', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(completeNewsJson(schema, '', {}, { env: { ...groq, NEWS_AI_PROVIDER: 'gemini' }, fetchImpl })).rejects.toMatchObject({ code: 'GEMINI_NOT_CONFIGURED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('fails closed for an unknown provider while read-only status and namespace remain available', async () => {
    const env = { ...gemini, NEWS_AI_PROVIDER: 'other' }, fetchImpl = vi.fn<typeof fetch>();
    expect(getNewsAiStatus(env)).toEqual({ provider: null, model: null, configured: false, errorCode: 'NEWS_AI_INVALID_CONFIG' });
    expect(getNewsAiCacheScope(env)).toMatch(/^[a-f0-9]{64}$/u);
    await expect(completeNewsJson(schema, '', {}, { env, fetchImpl })).rejects.toMatchObject({ code: 'NEWS_AI_INVALID_CONFIG' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each(['http://example.org/v1', 'https://name:password@example.org/v1', 'https://example.org/v1?key=hidden', 'https://example.org/v1#part'])('rejects unsafe server base %s without a request', async (base) => {
    const fetchImpl = vi.fn<typeof fetch>(), env = { ...gemini, GEMINI_BASE_URL: base };
    expect(getNewsAiStatus(env).configured).toBe(false);
    await expect(completeNewsJson(schema, '', {}, { env, fetchImpl })).rejects.toMatchObject({ code: 'GEMINI_INVALID_CONFIG' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('separates provider/model/base namespaces but excludes API keys and canonical trailing slashes', () => {
    const base = getNewsAiCacheScope(gemini);
    expect(base).not.toBe(getNewsAiCacheScope(groq));
    expect(base).not.toBe(getNewsAiCacheScope({ ...gemini, GEMINI_MODEL: 'another-model' }));
    expect(base).not.toBe(getNewsAiCacheScope({ ...gemini, GEMINI_BASE_URL: 'https://example.org/v1' }));
    expect(base).toBe(getNewsAiCacheScope({ ...gemini, GEMINI_API_KEY: 'rotated-unit-key', GROQ_MODEL: 'inactive-model' }));
    expect(base).toBe(getNewsAiCacheScope({ ...gemini, GEMINI_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai/' }));
    expect(base).toBe(getNewsAiCacheScope({ NEWS_AI_PROVIDER: 'gemini' }));
    expect(getNewsAiConfig(gemini).cacheScope).toBe(base);
  });
});

describe('Gemini OpenAI-compatible transport', () => {
  it('simplifies nested array decoding but rejects responses outside the original bounds', async () => {
    const bounded = z.object({ items: z.array(z.object({ days: z.array(z.number().int().min(1).max(7)).min(1).max(7) }).strict()).max(2) }).strict();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(envelope({ items: [{ days: [] }] }));
    await expect(completeNewsJson(bounded, '', {}, { env: gemini, fetchImpl })).rejects.toMatchObject({ code: 'GEMINI_INVALID_SCHEMA' });
    const wire = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string).response_format.json_schema.schema;
    expect(JSON.stringify(wire)).not.toContain('maxItems'); expect(JSON.stringify(wire)).not.toContain('minItems');
    expect(wire.properties.items.items.properties.days.items).toMatchObject({ type: 'integer', minimum: 1, maximum: 7 });
    expect(wire.properties.items.items.additionalProperties).toBe(false);
    const tooMany = vi.fn<typeof fetch>().mockResolvedValue(envelope({ items: [{ days: [1] }, { days: [2] }, { days: [3] }] }));
    await expect(completeNewsJson(bounded, '', {}, { env: gemini, fetchImpl: tooMany })).rejects.toMatchObject({ code: 'GEMINI_INVALID_SCHEMA' });
    const valid = vi.fn<typeof fetch>().mockResolvedValue(envelope({ items: [{ days: [1] }] }));
    expect((await completeNewsJson(bounded, '', {}, { env: gemini, fetchImpl: valid })).value.items).toEqual([{ days: [1] }]);
  });
  it('uses Google Bearer endpoint, strict schema, max_tokens and Flash-Lite minimal reasoning', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(envelope({ ok: true, at: null }));
    const result = await completeNewsJson(schema, 'system', { text: 'data' }, { env: { ...gemini, ...groq }, fetchImpl });
    expect(result).toMatchObject({ value: { ok: true, at: null }, model: 'gemini-3.1-flash-lite' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    const request = fetchImpl.mock.calls[0][1]!;
    expect(request.headers).toEqual({ Authorization: `Bearer ${gemini.GEMINI_API_KEY}`, 'Content-Type': 'application/json' });
    const body = JSON.parse(request.body as string);
    expect(body).toMatchObject({ model: 'gemini-3.1-flash-lite', reasoning_effort: 'minimal', max_tokens: 10000, response_format: { type: 'json_schema', json_schema: { strict: true, schema: { additionalProperties: false, required: ['ok', 'at'] } } } });
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(request.body).not.toContain(gemini.GEMINI_API_KEY); expect(request.body).not.toContain(groq.GROQ_API_KEY);
  });
  it.each([[401, 'GEMINI_AUTH'], [403, 'GEMINI_AUTH'], [400, 'GEMINI_INVALID_REQUEST'], [413, 'GEMINI_INPUT_TOO_LONG']] as const)('does not retry or fall back on status %s', async (status, code) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(`${gemini.GEMINI_API_KEY} private input`, { status }));
    const result = completeNewsJson(schema, '', {}, { env: { ...gemini, ...groq }, fetchImpl });
    await expect(result).rejects.toMatchObject({ code });
    await expect(result).rejects.not.toHaveProperty('message', expect.stringContaining(gemini.GEMINI_API_KEY));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('passes a long Retry-After to the queue without an early second request', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': '95', 'x-ratelimit-reset-tokens': '1ms' } }));
    const sleep = vi.fn(async () => {});
    await expect(completeNewsJson(schema, '', {}, { env: gemini, fetchImpl, sleep })).rejects.toMatchObject({ code: 'GEMINI_RATE_LIMIT', retryAfterMs: 95000 });
    expect(fetchImpl).toHaveBeenCalledTimes(1); expect(sleep).not.toHaveBeenCalled();
  });
  it('does not apply a Groq-specific quota header to Gemini', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 429, headers: { 'x-ratelimit-reset-tokens': '1ms' } }));
    await expect(completeNewsJson(schema, '', {}, { env: gemini, fetchImpl })).rejects.toMatchObject({ code: 'GEMINI_RATE_LIMIT', retryAfterMs: undefined });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('bounds transient retry and ignores abort-resistant transports after timeout', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status: 503 }));
    const sleep = vi.fn(async () => {});
    await expect(completeNewsJson(schema, '', {}, { env: gemini, fetchImpl, sleep })).rejects.toMatchObject({ code: 'GEMINI_UPSTREAM' });
    expect(fetchImpl).toHaveBeenCalledTimes(2); expect(sleep).toHaveBeenCalledExactlyOnceWith(400);
    const hanging = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    await expect(completeNewsJson(schema, '', {}, { env: gemini, fetchImpl: hanging, timeoutMs: 10 })).rejects.toMatchObject({ code: 'GEMINI_TIMEOUT' });
    expect(hanging).toHaveBeenCalledTimes(1);
  });
  it.each([{ ok: true, at: '2026-02-30T10:00:00Z' }, { ok: true, at: null, extra: 'wrong' }])('retains full local schema validation for %j', async (value) => {
    await expect(completeNewsJson(schema, '', {}, { env: gemini, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(envelope(value)) })).rejects.toMatchObject({ code: 'GEMINI_INVALID_SCHEMA' });
  });
  it('rejects incomplete model output instead of returning a partial success', async () => {
    await expect(completeNewsJson(schema, '', {}, { env: gemini, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(envelope({ ok: true, at: null }, 'length')) })).rejects.toMatchObject({ code: 'GEMINI_INVALID_JSON' });
  });
});
