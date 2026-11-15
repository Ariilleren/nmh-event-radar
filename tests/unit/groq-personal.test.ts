import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { completeGroq, getGroqStatus, groqJsonSchema } from '../../src/ai/groq';
import { createPersonalAnalyzer, personalAnalysisWireSchema, type PersonalAnalysisInput } from '../../src/ai/personal';
import { locationSchema } from '../../src/domain/schemas';

const env = { GROQ_API_KEY: 'unit-test-not-a-real-key' };
const response = (value: unknown) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }));
let analyzePersonalNews = createPersonalAnalyzer();
beforeEach(() => { analyzePersonalNews = createPersonalAnalyzer(); });
function sourceWire(extraction: ReturnType<typeof output>['extraction'], fragments: { id: string; text: string }[] = []) {
  const pair = (field: string, value: unknown) => {
    if (value === null) return null;
    const quote = extraction.evidence.find(item => item.field === field)?.quote;
    return { value, quoteId: quote === undefined ? undefined : fragments.find(fragment => fragment.text.includes(quote))?.id ?? 'unknown' };
  };
  const list = (field: string, values: string[]) => values.map((value, index) => pair(extraction.evidence.some(item => item.field === `${field}.${index}`) ? `${field}.${index}` : field, value));
  return {
    ...Object.fromEntries(Object.entries(extraction).filter(([field]) => !['categories', 'entities', 'affectedResources', 'affectedAddresses', 'evidence', 'impactHypothesis', 'recommendedAction'].includes(field)).map(([field, value]) => [field, pair(field, value)])),
    categories: list('categories', extraction.categories),
    entities: Object.fromEntries(Object.entries(extraction.entities).map(([field, values]) => [field, list(`entities.${field}`, values)])),
    affectedResources: list('affectedResources', extraction.affectedResources), affectedAddresses: list('affectedAddresses', extraction.affectedAddresses),
  };
}
const reply = (value: unknown, newsExtras: Record<string, unknown> = {}, sourceExtras: Record<string, unknown> = {}) => vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
  const request = JSON.parse(init!.body as string);
  if (!value || typeof value !== 'object' || !('extraction' in value)) return response(value);
  const record = value as Record<string, unknown>;
  if (request.response_format.json_schema.schema.properties.category) {
    const payload = JSON.parse(request.messages[1].content);
    return response({ ...sourceWire(record.extraction as ReturnType<typeof output>['extraction'], payload.source.fragments), ...sourceExtras });
  }
  if (request.response_format.json_schema.schema.properties.contexts) {
    const payload = JSON.parse(request.messages[1].content) as { descriptions: { scope: string; text: string }[] };
    const locations = record.locationContexts as { locationId: string; context: unknown }[] | null;
    return response({ contexts: Object.fromEntries(payload.descriptions.map((item) => {
      const context = { ...(item.scope === 'business' ? record.businessContext as Record<string, unknown> : locations?.find((point) => `location:${point.locationId}` === item.scope)?.context as Record<string, unknown> ?? emptyContext()) };
      delete context.industry;
      return [item.scope, context];
    })) });
  }
  return response({ ...Object.fromEntries(Object.entries(record).filter(([key]) => !['extraction', 'businessContext', 'locationContexts'].includes(key))), ...newsExtras });
});
const newsRequest = (transport: ReturnType<typeof reply>) => transport.mock.calls.map((call) => JSON.parse(call[1]!.body as string)).find((request) => request.response_format.json_schema.schema.properties.relevance);
const sourceRequests = (transport: ReturnType<typeof reply>) => transport.mock.calls.map((call) => JSON.parse(call[1]!.body as string)).filter((request) => request.response_format.json_schema.schema.properties.category);
const emptyContext = () => ({ industry: null, products: [], services: [], suppliers: [], brands: [], platforms: [], resources: [], audiences: [], processes: [], productionHours: [], evidence: [] });
function input(): PersonalAnalysisInput {
  return {
    source: { text: 'Ozon объявил изменение комиссии.', publisher: 'Тестовый канал', url: 'https://t.me/newsssss09/21', publishedAt: '2026-11-15T08:00:00Z', receivedAt: '2026-11-15T08:10:00Z', timezone: null, channel: 'newsssss09', messageId: '21' },
    business: { id: 'business', name: 'Магазин', industry: 'retail', about: 'Продаём на Ozon.', city: 'Москва' },
    locations: [{ ...locationSchema.parse({ locationId: 'store', name: 'Магазин', address: 'Москва, улица Тестовая, дом 7', city: 'Москва', timezone: 'Europe/Moscow', waterDependency: 'essential', openingHours: [{ days: [1, 2, 3, 4, 5, 6, 7], start: '08:00', end: '20:00' }] }), id: 'point-a' }],
    now: '2026-11-15T08:10:00Z',
  };
}
function output() {
  return personalAnalysisWireSchema.parse({
    extraction: {
      category: 'commercial', categories: ['commercial'], title: 'Комиссия Ozon', summary: 'Объявлено изменение комиссии.', status: 'scheduled',
      startsAt: null, endsAt: null, timezone: null, city: null, street: null, address: null, latitude: null, longitude: null, vehicleRestriction: null,
      impactHypothesis: 'Могут измениться условия продаж.', recommendedAction: 'Проверить новые условия.', factStatus: 'announced', influence: 'risk', responseDeadline: null, identity: null,
      entities: { suppliers: [], platforms: ['Ozon'], brands: [], products: [], services: [], industries: [], audiences: [] }, affectedResources: [], affectedAddresses: [],
      evidence: ['category', 'categories', 'title', 'summary', 'status', 'factStatus', 'influence', 'entities.platforms'].map((field) => ({ field, quote: 'Ozon объявил изменение комиссии.' })),
    },
    businessContext: { ...emptyContext(), platforms: ['Ozon'], evidence: [{ field: 'platforms', quote: 'Продаём на Ozon.' }] },
    locationContexts: [], relevance: 'relevant', relevanceExplanation: 'Профиль указывает продажи на Ozon.', affectedLocationIds: ['point-a'], affectedProcesses: [],
    fact: 'Ozon объявил изменение комиссии.', quotes: ['Ozon объявил изменение комиссии.'], possibleImpact: 'Могут измениться условия продаж на указанной платформе.',
    assumptions: ['Применимость конкретной комиссии к товарам нужно проверить.'], question: null,
    recommendations: [{ type: 'threat', title: 'Проверьте комиссию Ozon', action: 'Сверьте новые комиссии с условиями своих продаж на Ozon.', reason: 'Профиль указывает использование Ozon.', locationIds: ['point-a'], processes: [] }],
  });
}
function localCase() {
  const data = input(), value = output();
  data.source.text = 'Москва, улица Тестовая, дом 7: 16 ноября 2026 с 10:00 до 12:00 запланировано отключение воды. Время Europe/Moscow (UTC+03:00).';
  data.business.about = 'Для работы нужна вода.';
  value.businessContext = personalAnalysisWireSchema.shape.businessContext.parse({ ...emptyContext(), resources: ['water'], evidence: [{ field: 'resources', quote: 'Для работы нужна вода.' }] });
  value.extraction = {
    ...value.extraction, category: 'water_outage', categories: ['water_outage'], title: 'Отключение воды', summary: 'В доме 7 запланировано отключение воды с 10:00 до 12:00.', entities: { ...value.extraction.entities, platforms: [] },
    city: 'Москва', address: 'Москва, улица Тестовая, дом 7', affectedResources: ['water'],
    startsAt: '2026-11-16T10:00:00+03:00', endsAt: '2026-11-16T12:00:00+03:00', timezone: 'Europe/Moscow',
    impactHypothesis: 'Приготовление напитков может быть ограничено.', recommendedAction: 'Проверить запас воды.',
    evidence: ['category', 'categories', 'title', 'summary', 'status', 'factStatus', 'influence', 'timezone', 'city', 'address', 'affectedResources', 'startsAt', 'endsAt'].map((field) => ({ field, quote: data.source.text })),
  };
  value.fact = data.source.text; value.quotes = [data.source.text];
  value.relevanceExplanation = 'Отключение воды по адресу точки пересекается с её рабочими часами.';
  value.possibleImpact = 'Работа с водой может быть ограничена в часы отключения.'; value.assumptions = ['Фактическое отключение требует проверки.'];
  value.affectedProcesses = ['Работа с водой'];
  value.recommendations = [{ type: 'threat', title: 'Подготовиться к отключению воды', action: 'Проверить запас воды и порядок работы на время отключения.', reason: 'Отключение воды затрагивает адрес точки и её рабочие часы.', locationIds: ['point-a'], processes: ['Работа с водой'] }];
  return { data, value };
}

describe('Groq transport', () => {
  const schema = z.object({ result: z.string().nullable() }).strict();
  it('uses documented strict schema and default model in one call', async () => {
    const fetchImpl = reply({ result: 'ok' });
    await completeGroq(schema, 'system', { text: 'data' }, { env, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.groq.com/openai/v1/chat/completions');
    const body = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string);
    expect(body.model).toBe('openai/gpt-oss-20b');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.max_completion_tokens).toBeGreaterThan(0);
    expect(body).not.toHaveProperty('max_tokens');
  });
  it('makes every nested personal schema property required', () => {
    function inspect(value: unknown) {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) return value.forEach(inspect);
      const object = value as Record<string, unknown>;
      if (object.type === 'object') {
        expect(object.additionalProperties).toBe(false);
        expect(object.required).toEqual(Object.keys(object.properties as object));
      }
      Object.values(object).forEach(inspect);
    }
    inspect(groqJsonSchema(personalAnalysisWireSchema));
  });
  it('compacts standard date-time patterns while preserving format and custom constraints', () => {
    const dateSchema = z.object({ at: z.iso.datetime({ offset: true }).nullable(), code: z.string().regex(/^ABC$/) }).strict();
    const wire = groqJsonSchema(dateSchema);
    expect(wire.required).toEqual(['at', 'code']);
    expect(wire.additionalProperties).toBe(false);
    const properties = wire.properties as Record<string, Record<string, unknown>>;
    expect(properties.at.anyOf).toEqual([{ type: 'string', format: 'date-time' }, { type: 'null' }]);
    expect(properties.code.pattern).toBe('^ABC$');
  });
  it.each(['2026-02-30T12:00:00+03:00', '2026-11-15T25:00:00+03:00'])('still rejects invalid date-time %s with original local Zod', async (at) => {
    const dateSchema = z.object({ at: z.iso.datetime({ offset: true }) }).strict();
    const fetchImpl = reply({ at });
    await expect(completeGroq(dateSchema, 'system', {}, { env, fetchImpl })).rejects.toMatchObject({ code: 'GROQ_INVALID_SCHEMA' });
    const request = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string);
    expect(request.response_format.json_schema.strict).toBe(true);
    expect(request.response_format.json_schema.schema.properties.at).toEqual({ type: 'string', format: 'date-time' });
  });
  it('reports absent config without any request or fake result', async () => {
    const fetchImpl = reply({ result: 'ok' });
    expect(getGroqStatus({})).toEqual({ configured: false, model: 'openai/gpt-oss-20b' });
    await expect(completeGroq(schema, '', {}, { env: {}, fetchImpl })).rejects.toMatchObject({ code: 'GROQ_NOT_CONFIGURED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([401, 403])('never retries authorization status %s or exposes body', async (status) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(env.GROQ_API_KEY, { status }));
    await expect(completeGroq(schema, '', {}, { env, fetchImpl })).rejects.toMatchObject({ code: 'GROQ_AUTH' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each([429, 503])('honors long %s backoff without premature retries', async (status) => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response('private upstream details', { status, headers: { 'retry-after': '9000' } }));
    const sleep = vi.fn(async () => {});
    await expect(completeGroq(schema, '', {}, { env, fetchImpl, sleep })).rejects.toMatchObject({ code: status === 429 ? 'GROQ_RATE_LIMIT' : 'GROQ_UPSTREAM' });
    expect(fetchImpl).toHaveBeenCalledTimes(1); expect(sleep).not.toHaveBeenCalled();
  });
  it('leaves the queue fallback when 429 has no timing headers', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 429 }));
    await expect(completeGroq(schema, '', {}, { env, fetchImpl })).rejects.toMatchObject({ code: 'GROQ_RATE_LIMIT', retryAfterMs: undefined });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('uses the documented token reset header for durable cooldown', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 429, headers: { 'x-ratelimit-reset-tokens': '41.144s' } }));
    await expect(completeGroq(schema, '', {}, { env, fetchImpl })).rejects.toMatchObject({ code: 'GROQ_RATE_LIMIT', retryAfterMs: 41144 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('permits at most one short transient retry', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status: 503 }));
    const sleep = vi.fn(async () => {});
    await expect(completeGroq(schema, '', {}, { env, fetchImpl, sleep })).rejects.toMatchObject({ code: 'GROQ_UPSTREAM' });
    expect(fetchImpl).toHaveBeenCalledTimes(2); expect(sleep).toHaveBeenCalledExactlyOnceWith(400);
  });
  it('classifies a provider 400 as request failure without exposing failed generation', async () => {
    await expect(completeGroq(schema, '', {}, { env, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response('private failed generation', { status: 400 })) })).rejects.toMatchObject({ code: 'GROQ_INVALID_REQUEST' });
  });
  it('bounds timeout even when an injected transport ignores abort', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    await expect(completeGroq(schema, '', {}, { env, fetchImpl, timeoutMs: 10 })).rejects.toMatchObject({ code: 'GROQ_TIMEOUT' });
  });
  it('returns sanitized network failure without retry', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error(env.GROQ_API_KEY));
    await expect(completeGroq(schema, '', {}, { env, fetchImpl })).rejects.toMatchObject({ code: 'GROQ_NETWORK' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed JSON and strict-schema extras', async () => {
    await expect(completeGroq(schema, '', {}, { env, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response('not JSON')) })).rejects.toMatchObject({ code: 'GROQ_INVALID_JSON' });
    await expect(completeGroq(schema, '', {}, { env, fetchImpl: reply({ result: 'ok', extra: 'bad' }) })).rejects.toMatchObject({ code: 'GROQ_INVALID_SCHEMA' });
  });
});

describe('unified personal analysis code gates', () => {
  it('isolates source and profile caches across provider, model and base while preserving the public result', async () => {
    const data = input(), fetchImpl = reply(output());
    await analyzePersonalNews(data, { env, fetchImpl });
    const gemini = { NEWS_AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'unit-gemini-not-real' };
    const result = await analyzePersonalNews(data, { env: gemini, fetchImpl });
    expect(result.recommendations[0]).toMatchObject({ sourceUrl: data.source.url, locationIds: ['point-a'] });
    expect(result.model).toBe('gemini-3.1-flash-lite'); expect(fetchImpl).toHaveBeenCalledTimes(6);
    await analyzePersonalNews(data, { env: gemini, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(7);
    await analyzePersonalNews(data, { env: { ...gemini, GEMINI_MODEL: 'another-test-model' }, fetchImpl });
    await analyzePersonalNews(data, { env: { ...gemini, GEMINI_BASE_URL: 'https://example.org/test' }, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(13); expect(sourceRequests(fetchImpl)).toHaveLength(4);
    await expect(analyzePersonalNews(data, { env: { NEWS_AI_PROVIDER: 'gemini' }, fetchImpl })).rejects.toMatchObject({ code: 'GEMINI_NOT_CONFIGURED' });
    expect(fetchImpl).toHaveBeenCalledTimes(13);
  });
  it('requires a source-fragment reference alongside every fact with strict nested objects', async () => {
    const fetchImpl = reply(output());
    await analyzePersonalNews(input(), { env, fetchImpl });
    const request = sourceRequests(fetchImpl)[0];
    const schema = request.response_format.json_schema.schema;
    const inspect = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { value.forEach(inspect); return; }
      const object = value as Record<string, unknown>;
      if (object.type === 'object') {
        expect(object.additionalProperties).toBe(false);
        expect(object.required).toEqual(Object.keys(object.properties as object));
      }
      Object.values(object).forEach(inspect);
    };
    inspect(schema);
    expect(schema.properties.category.required).toEqual(['value', 'quoteId']);
    expect(schema.properties.categories.items.required).toEqual(['value', 'quoteId']);
    expect(schema.properties.entities.properties.platforms.items.required).toEqual(['value', 'quoteId']);
    expect(schema.properties).not.toHaveProperty('evidence');
    expect(schema.properties).not.toHaveProperty('impactHypothesis');
    expect(request.response_format.json_schema.strict).toBe(true);
  });
  it.each([
    { startsAt: { value: '2026-11-16T10:00:00+03:00' } },
    { startsAt: { value: '2026-11-16T10:00:00+03:00', quoteId: '' } },
    { startsAt: '2026-11-16T10:00:00+03:00' },
    { startsAt: { value: null, quoteId: null } },
  ])('rejects malformed fact pairs instead of silently losing explicit time: %j', async (sourceExtras) => {
    const { data, value } = localCase();
    const fetchImpl = reply(value, {}, sourceExtras);
    await expect(analyzePersonalNews(data, { env, fetchImpl })).rejects.toMatchObject({ code: 'GROQ_INVALID_SCHEMA' });
    expect(newsRequest(fetchImpl)).toBeUndefined();
  });
  it('rejects an unknown fragment ID even when the paired date is valid', async () => {
    const { data, value } = localCase();
    const fetchImpl = reply(value, {}, { startsAt: { value: value.extraction.startsAt, quoteId: 'q999' } });
    await expect(analyzePersonalNews(data, { env, fetchImpl })).rejects.toMatchObject({ code: 'GROQ_SOURCE_EVIDENCE' });
    expect(newsRequest(fetchImpl)).toBeUndefined();
  });
  it('retrieves source case and punctuation verbatim without asking the model to rewrite quotes', async () => {
    const data = input(), value = output();
    const fetchImpl = reply(value, {}, { category: { value: 'commercial', quoteId: 'q1' } });
    const result = await analyzePersonalNews(data, { env, fetchImpl });
    expect(result.extraction.evidence.find(item => item.field === 'category')?.quote).toBe(data.source.text);
    expect(JSON.parse(sourceRequests(fetchImpl)[0].messages[1].content).source.fragments).toEqual([{ id: 'q1', text: data.source.text }]);
    await expect(createPersonalAnalyzer()(data, { env, fetchImpl: reply(value, {}, { category: { value: 'commercial', quoteId: 'q1', quote: data.source.text.toLocaleLowerCase('ru-RU') } }) })).rejects.toMatchObject({ code: 'GROQ_INVALID_SCHEMA' });
  });
  it('rejects publisher metadata used as quoted event identity', async () => {
    const data = input(), value = output();
    const fetchImpl = reply(value, {}, { identity: { value: data.source.publisher, quoteId: 'q1' } });
    await expect(analyzePersonalNews(data, { env, fetchImpl })).rejects.toMatchObject({ code: 'GROQ_SOURCE_EVIDENCE' });
    expect(newsRequest(fetchImpl)).toBeUndefined();
  });
  it('rejects an event status substituted for a fact-status enum', async () => {
    const { data, value } = localCase();
    const fetchImpl = reply(value, {}, { factStatus: { value: 'scheduled', quoteId: 'q1' } });
    await expect(analyzePersonalNews(data, { env, fetchImpl })).rejects.toMatchObject({ code: 'GROQ_INVALID_SCHEMA' });
    expect(newsRequest(fetchImpl)).toBeUndefined();
  });
  it.each([[55.755, 37.62], [0, 0]])('preserves explicitly quoted coordinates %s/%s and absolute time', async (latitude, longitude) => {
    const { data, value } = localCase();
    const latitudeQuote = `Широта: ${latitude}`, longitudeQuote = `Долгота: ${longitude}`;
    data.source.text += `\n${latitudeQuote}\n${longitudeQuote}`;
    value.extraction.latitude = latitude; value.extraction.longitude = longitude;
    value.extraction.evidence.push({ field: 'latitude', quote: latitudeQuote }, { field: 'longitude', quote: longitudeQuote });
    const result = await analyzePersonalNews(data, { env, fetchImpl: reply(value) });
    expect(result.extraction).toMatchObject({ latitude, longitude, startsAt: value.extraction.startsAt, endsAt: value.extraction.endsAt, city: value.extraction.city, address: value.extraction.address });
    expect(result.extraction.evidence).toEqual(expect.arrayContaining([{ field: 'latitude', quote: latitudeQuote }, { field: 'longitude', quote: longitudeQuote }]));
    expect(result.recommendations[0].locationIds).toEqual(['point-a']);
  });
  it('checks each coordinate against its own quote rather than another coordinate citation', async () => {
    const { data, value } = localCase(); data.source.text += '\nШирота: 55.755.\nДолгота: 37.62.';
    const fetchImpl = reply(value, {}, { latitude: { value: 55.755, quoteId: 'q3' }, longitude: { value: 37.62, quoteId: 'q2' } });
    await expect(analyzePersonalNews(data, { env, fetchImpl })).rejects.toMatchObject({ code: 'GROQ_SOURCE_EVIDENCE' });
    expect(newsRequest(fetchImpl)).toBeUndefined();
  });
  it('never guesses the missing half of a coordinate pair', async () => {
    const { data, value } = localCase(); data.source.text += '\nШирота: 0.';
    const fetchImpl = reply(value, {}, { latitude: { value: 0, quoteId: 'q2' }, longitude: null });
    await expect(analyzePersonalNews(data, { env, fetchImpl })).rejects.toMatchObject({ code: 'GROQ_SOURCE_EVIDENCE' });
    expect(newsRequest(fetchImpl)).toBeUndefined();
  });
  it('does not let a different list item supply evidence for an entity', async () => {
    const data = input(), value = output(); data.source.text += '\nWildberries также изменил условия.';
    const fetchImpl = reply(value, {}, { entities: { ...sourceWire(value.extraction).entities, platforms: [{ value: 'Ozon', quoteId: 'q2' }, { value: 'Wildberries', quoteId: 'q1' }] } });
    await expect(analyzePersonalNews(data, { env, fetchImpl })).rejects.toMatchObject({ code: 'GROQ_SOURCE_EVIDENCE' });
    expect(newsRequest(fetchImpl)).toBeUndefined();
  });
  it.each(['affectedResources', 'address'] as const)('rejects a reference to a different fragment for %s', async (field) => {
    const { data, value } = localCase(); data.source.text += '\nИнтернет доступен. Санкт-Петербург, улица Морская, дом 9.';
    const extras = field === 'affectedResources' ? { affectedResources: [{ value: 'water', quoteId: 'q2' }] } : { address: { value: value.extraction.address, quoteId: 'q2' } };
    const fetchImpl = reply(value, {}, extras);
    await expect(analyzePersonalNews(data, { env, fetchImpl })).rejects.toMatchObject({ code: 'GROQ_SOURCE_EVIDENCE' });
    expect(newsRequest(fetchImpl)).toBeUndefined();
  });
  it.each(['long line', 'many short lines'])('bounds source fragments as unchanged continuous slices for %s', async (layout) => {
    const data = input(), value = output();
    const remainder = layout === 'long line' ? 'Текст 🗺️ '.repeat(1500) : 'Я\r\n'.repeat(5000);
    data.source.text += `\n${remainder}`;
    const fetchImpl = reply(value);
    const result = await analyzePersonalNews(data, { env, fetchImpl });
    expect(result.recommendations).toHaveLength(1);
    const payload = JSON.parse(sourceRequests(fetchImpl)[0].messages[1].content);
    const fragments = payload.source.fragments as { id: string; text: string }[];
    expect(fragments.length).toBeLessThanOrEqual(64);
    expect(payload.source).not.toHaveProperty('text');
    expect(new Set(fragments.map(item => item.id)).size).toBe(fragments.length);
    for (const fragment of fragments) {
      expect(fragment.text.length).toBeLessThanOrEqual(1500);
      expect(data.source.text.includes(fragment.text)).toBe(true);
      expect(fragment.text.includes(data.source.publisher)).toBe(false);
    }
    expect(fragments.map(item => item.text).join('')).toBe(layout === 'long line' ? data.source.text.replace('\n', '') : data.source.text);
    expect(result.extraction.evidence.every(item => fragments.some(fragment => fragment.text === item.quote))).toBe(true);
  });
  it.each(['Москва, улица Тестовая, дом 7 корпус 2', 'Москва, улица Тестовая, дом 7/2'])('rejects a shortened address when the source identifies %s', async (fullAddress) => {
    const { data, value } = localCase();
    data.source.text = data.source.text.replace('Москва, улица Тестовая, дом 7', fullAddress);
    value.extraction.evidence.forEach(item => { item.quote = data.source.text; });
    value.extraction.evidence.find(item => item.field === 'address')!.quote = 'Москва, улица Тестовая, дом 7';
    const fetchImpl = reply(value);
    await expect(analyzePersonalNews(data, { env, fetchImpl })).rejects.toMatchObject({ code: 'GROQ_SOURCE_EVIDENCE' });
    expect(newsRequest(fetchImpl)).toBeUndefined();
  });
  it('parses a profile once across different news and never sends news to the profile stage', async () => {
    const data = input(), fetchImpl = reply(output());
    await analyzePersonalNews(data, { env, fetchImpl });
    await analyzePersonalNews({ ...data, source: { ...data.source, messageId: '22', text: `${data.source.text}\nДополнение.` } }, { env, fetchImpl });
    const requests = fetchImpl.mock.calls.map((call) => JSON.parse(call[1]!.body as string));
    const profiles = requests.filter((request) => request.response_format.json_schema.schema.properties.contexts);
    expect(fetchImpl).toHaveBeenCalledTimes(5); expect(profiles).toHaveLength(1);
    expect(JSON.parse(profiles[0].messages[1].content)).toEqual({ descriptions: [{ scope: 'business', text: data.business.about }] });
    const news = requests.filter((request) => request.response_format.json_schema.schema.properties.relevance);
    expect(news).toHaveLength(2);
    for (const request of news) {
      expect(request.response_format.json_schema.schema.properties).not.toHaveProperty('businessContext');
      expect(request.response_format.json_schema.schema.properties).not.toHaveProperty('locationContexts');
      expect(request.response_format.json_schema.schema.properties).not.toHaveProperty('extraction');
      expect(JSON.parse(request.messages[1].content).verifiedProfileContexts.businessContext.platforms).toEqual(['Ozon']);
    }
  });
  it('shares validated source facts across users and invalidates changed source text', async () => {
    const data = input(), fetchImpl = reply(output());
    await analyzePersonalNews(data, { env, fetchImpl });
    data.business.id = 'other-user';
    await analyzePersonalNews(data, { env, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(5); expect(sourceRequests(fetchImpl)).toHaveLength(1);
    const sourcePayload = JSON.parse(sourceRequests(fetchImpl)[0].messages[1].content);
    expect(Object.keys(sourcePayload)).toEqual(['source']);
    expect(sourcePayload.source).not.toHaveProperty('business');
    expect(sourcePayload.source).not.toHaveProperty('locations');
    expect(sourcePayload.source).not.toHaveProperty('text');
    expect(sourcePayload.source.fragments).toEqual([{ id: 'q1', text: data.source.text }]);
    data.source.text += '\nДополнение источника.';
    await analyzePersonalNews(data, { env, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(7); expect(sourceRequests(fetchImpl)).toHaveLength(2);
  });
  it('never caches invalid source evidence and permits a later controlled retry', async () => {
    const value = output(); value.extraction.evidence[0].quote = 'Нет такой цитаты';
    const fetchImpl = reply(value);
    await expect(analyzePersonalNews(input(), { env, fetchImpl })).rejects.toMatchObject({ code: 'GROQ_SOURCE_EVIDENCE' });
    expect(newsRequest(fetchImpl)).toBeUndefined();
    value.extraction.evidence = output().extraction.evidence;
    expect((await analyzePersonalNews(input(), { env, fetchImpl })).relevance).toBe('relevant');
    expect(fetchImpl).toHaveBeenCalledTimes(4); expect(sourceRequests(fetchImpl)).toHaveLength(2);
  });
  it('evicts old source entries after 64 distinct publications', async () => {
    const fetchImpl = reply(output());
    for (let index = 0; index < 65; index++) {
      const data = input(); data.source.messageId = String(index);
      await analyzePersonalNews(data, { env, fetchImpl });
    }
    const data = input(); data.source.messageId = '0';
    await analyzePersonalNews(data, { env, fetchImpl });
    expect(sourceRequests(fetchImpl)).toHaveLength(66);
    expect(fetchImpl).toHaveBeenCalledTimes(133);
  });
  it('invalidates the profile cache on description changes and isolates actual user IDs', async () => {
    const data = input(), fetchImpl = reply(output());
    await analyzePersonalNews(data, { env, fetchImpl });
    data.business.about += ' Ассортимент уточняется.';
    await analyzePersonalNews(data, { env, fetchImpl });
    data.business.id = 'another-user';
    await analyzePersonalNews(data, { env, fetchImpl });
    data.locations[0].businessDescription = 'Ресурсы не указаны.';
    await analyzePersonalNews(data, { env, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(9); expect(sourceRequests(fetchImpl)).toHaveLength(1);
  });
  it('does not call the model for empty descriptions', async () => {
    const data = input(); data.business.about = '';
    const fetchImpl = reply(output());
    const result = await analyzePersonalNews(data, { env, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.recommendations).toEqual([]);
    expect(sourceRequests(fetchImpl)).toHaveLength(1); expect(newsRequest(fetchImpl)).toBeUndefined();
  });
  it('shares an in-flight profile parse between concurrent news', async () => {
    const fetchImpl = reply(output());
    await Promise.all([analyzePersonalNews(input(), { env, fetchImpl }), analyzePersonalNews(input(), { env, fetchImpl })]);
    expect(fetchImpl).toHaveBeenCalledTimes(4); expect(sourceRequests(fetchImpl)).toHaveLength(1);
  });
  it('removes a failed profile promise so a later controlled retry can succeed', async () => {
    const value = output(); value.businessContext.platforms = ['Not in profile'];
    const fetchImpl = reply(value);
    await expect(analyzePersonalNews(input(), { env, fetchImpl })).rejects.toMatchObject({ code: 'GROQ_PROFILE_EVIDENCE' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    value.businessContext = output().businessContext;
    expect((await analyzePersonalNews(input(), { env, fetchImpl })).relevance).toBe('relevant');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
  it('never validates one point using another description', async () => {
    const data = input(), value = output(); data.locations[0].businessDescription = 'Доставка ежедневно.';
    value.locationContexts = [{ locationId: 'point-a', context: value.businessContext }];
    const fetchImpl = reply(value);
    await expect(analyzePersonalNews(data, { env, fetchImpl })).rejects.toMatchObject({ code: 'GROQ_PROFILE_EVIDENCE' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('bounds retained profile entries instead of accumulating users indefinitely', async () => {
    const fetchImpl = reply(output());
    for (let index = 0; index < 33; index++) {
      const data = input(); data.business.id = `user-${index}`;
      await analyzePersonalNews(data, { env, fetchImpl });
    }
    const data = input(); data.business.id = 'user-0';
    await analyzePersonalNews(data, { env, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(69); expect(sourceRequests(fetchImpl)).toHaveLength(1);
  });
  it('uses actual free profile, allows unknown nonlocal period and owns source URL', async () => {
    const fetchImpl = reply(output());
    const result = await analyzePersonalNews(input(), { env, fetchImpl });
    expect(result.relevance).toBe('relevant'); expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(result.recommendations[0]).toMatchObject({ sourceUrl: input().source.url, startsAt: null, endsAt: null, locationIds: ['point-a'] });
    const payload = JSON.parse(newsRequest(fetchImpl).messages[1].content);
    expect(payload.business.about).toBe(input().business.about);
    expect(payload.locations[0]).not.toHaveProperty('businessContext');
    expect(payload.allowedLocationIds).toEqual(['point-a']);
  });
  it('forbids invented location entries at wire level for a profile without points', async () => {
    const data = input(); data.locations = [];
    const value = { ...output(), locationContexts: null, affectedLocationIds: null, recommendations: [], relevance: 'needs_clarification' };
    const fetchImpl = reply(value);
    const result = await analyzePersonalNews(data, { env, fetchImpl });
    expect(result.affectedLocationIds).toEqual([]);
    const request = newsRequest(fetchImpl);
    const schema = request.response_format.json_schema.schema;
    const properties = schema.properties;
    expect(properties).not.toHaveProperty('locationContexts'); expect(properties).not.toHaveProperty('businessContext');
    expect(properties.affectedLocationIds.type).toBe('null');
    const reference = properties.recommendations.items.$ref;
    const recommendation = reference ? schema.$defs[reference.split('/').at(-1)] : properties.recommendations.items;
    expect(recommendation.properties.locationIds.type).toBe('null');
    const example = JSON.parse(request.messages[0].content.split('\n').at(-1));
    expect(example).not.toHaveProperty('locationContexts'); expect(example.affectedLocationIds).toBeNull();
    expect(personalAnalysisWireSchema.safeParse({ ...example, extraction: output().extraction, businessContext: emptyContext(), locationContexts: [], affectedLocationIds: [] }).success).toBe(true);
    expect(request.messages[0].content).toContain('FORMAT EXAMPLE ONLY');
  });
  it.each([{ locationContexts: [] }, { locationContexts: [{ locationId: 'invented', context: emptyContext() }] }])('rejects profile contexts returned by the news model', async ({ locationContexts }) => {
    const data = input(); data.locations = [];
    const value = { ...output(), locationContexts, affectedLocationIds: null, recommendations: [] };
    await expect(analyzePersonalNews(data, { env, fetchImpl: reply(value, { locationContexts }) })).rejects.toMatchObject({ code: 'GROQ_INVALID_SCHEMA' });
  });
  it('keeps ordinary point arrays required when saved locations exist', async () => {
    const value = { ...output(), locationContexts: null, affectedLocationIds: null, recommendations: [] };
    await expect(analyzePersonalNews(input(), { env, fetchImpl: reply(value) })).rejects.toMatchObject({ code: 'GROQ_INVALID_SCHEMA' });
  });
  it('normalizes zero-point recommendation IDs to an empty public array for a verified global process', async () => {
    const data = input(); data.locations = []; data.business.about = 'Продажи на Ozon.';
    const value = {
      ...output(), locationContexts: null, affectedLocationIds: null, affectedProcesses: ['Продажи'],
      businessContext: { ...emptyContext(), platforms: ['Ozon'], processes: [{ name: 'Продажи', resources: [], platforms: ['Ozon'], suppliers: [], products: [], routes: [], schedule: [] }], evidence: [
        { field: 'platforms', quote: 'Ozon' }, { field: 'processes.0.name', quote: 'Продажи' }, { field: 'processes.0.platforms', quote: 'Ozon' },
      ] },
      recommendations: output().recommendations.map((item) => ({ ...item, locationIds: null, processes: ['Продажи'] })),
    };
    const result = await analyzePersonalNews(data, { env, fetchImpl: reply(value) });
    expect(result.recommendations).toHaveLength(1); expect(result.recommendations[0].locationIds).toEqual([]);
    expect(result.affectedLocationIds).toEqual([]);
  });
  it('rejects invented point IDs', async () => {
    const value = output(); value.recommendations[0].locationIds = ['other-account-point'];
    await expect(analyzePersonalNews(input(), { env, fetchImpl: reply(value) })).rejects.toMatchObject({ code: 'GROQ_UNKNOWN_LOCATION' });
  });
  it('rejects model invented processes and forged profile evidence', async () => {
    const value = output(); value.affectedProcesses = ['Доставка'];
    await expect(analyzePersonalNews(input(), { env, fetchImpl: reply(value) })).rejects.toMatchObject({ code: 'GROQ_UNKNOWN_PROCESS' });
    value.affectedProcesses = []; value.businessContext.platforms = ['Wildberries'];
    await expect(createPersonalAnalyzer()(input(), { env, fetchImpl: reply(value) })).rejects.toMatchObject({ code: 'GROQ_PROFILE_EVIDENCE' });
  });
  it('rejects fake source quotes and numerical coordinates absent from source', async () => {
    const value = output(); value.quotes = ['Поддельная цитата'];
    await expect(analyzePersonalNews(input(), { env, fetchImpl: reply(value) })).rejects.toMatchObject({ code: 'GROQ_SOURCE_EVIDENCE' });
    value.quotes = [input().source.text]; value.extraction.latitude = 55.7; value.extraction.longitude = 37.6;
    value.extraction.evidence.push({ field: 'latitude', quote: input().source.text }, { field: 'longitude', quote: input().source.text });
    await expect(createPersonalAnalyzer()(input(), { env, fetchImpl: reply(value) })).rejects.toMatchObject({ code: 'GROQ_SOURCE_EVIDENCE' });
  });
  it('keeps irrelevant model result free of recommendations', async () => {
    const value = output(); value.relevance = 'irrelevant';
    expect((await analyzePersonalNews(input(), { env, fetchImpl: reply(value) })).recommendations).toEqual([]);
  });
  it('allows a precise local address with overlapping operating hours', async () => {
    const { data, value } = localCase();
    const result = await analyzePersonalNews(data, { env, fetchImpl: reply(value) });
    expect(data.source.timezone).toBeNull();
    expect(result.extraction.startsAt).toBe('2026-11-16T10:00:00+03:00');
    expect(result.extraction.endsAt).toBe('2026-11-16T12:00:00+03:00');
    expect(result.extraction.affectedResources).toEqual(['water']);
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]).toMatchObject({ action: 'Проверить запас воды и порядок работы на время отключения.', locationIds: ['point-a'], processes: ['Работа с водой'] });
  });
  it('rejects the same local event in another city', async () => {
    const { data, value } = localCase(); data.locations[0].city = 'Тверь';
    const fetchImpl = reply(value);
    const result = await analyzePersonalNews(data, { env, fetchImpl });
    expect(result.relevance).toBe('irrelevant'); expect(result.recommendations).toEqual([]);
    expect(newsRequest(fetchImpl)).toBeUndefined(); expect(result.possibleImpact).toBeNull();
  });
  it('asks a question for unknown local time and emits no recommendation', async () => {
    const { data, value } = localCase(); value.extraction.startsAt = null; value.extraction.endsAt = null;
    const fetchImpl = reply(value);
    const result = await analyzePersonalNews(data, { env, fetchImpl });
    expect(result.relevance).toBe('needs_clarification'); expect(result.question).toBeTruthy(); expect(result.recommendations).toEqual([]);
    expect(result.extraction).toMatchObject({ startsAt: null, endsAt: null, latitude: null, longitude: null });
    expect(result.extraction.evidence.some(item => ['startsAt', 'endsAt', 'latitude', 'longitude'].includes(item.field))).toBe(false);
    expect(newsRequest(fetchImpl)).toBeUndefined(); expect(result.possibleImpact).toBeNull();
    expect(result.fact).toBe(data.source.text); expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('does not resolve tomorrow from a UTC Telegram timestamp without source timezone', async () => {
    const { data, value } = localCase(); data.source.text = data.source.text.replace('16 ноября 2026', 'завтра');
    value.extraction.evidence.forEach((item) => { item.quote = data.source.text; }); value.quotes = [data.source.text]; value.fact = data.source.text;
    const result = await analyzePersonalNews(data, { env, fetchImpl: reply(value) });
    expect(result.extraction.startsAt).toBeNull(); expect(result.recommendations).toEqual([]);
  });
  it('does not promote expired events to current opportunities', async () => {
    const { data, value } = localCase(); data.now = '2026-11-18T00:00:00Z';
    const fetchImpl = reply(value);
    const result = await analyzePersonalNews(data, { env, fetchImpl });
    expect(result.relevance).toBe('irrelevant'); expect(result.recommendations).toEqual([]);
    expect(newsRequest(fetchImpl)).toBeUndefined(); expect(result.possibleImpact).toBeNull();
  });
  it.each(['Кофейня', 'Пекарня', 'Ресторан', 'Магазин'])('uses explicitly selected Russian industry %s', async (industry) => {
    const data = input(), value = output();
    data.business.industry = industry; data.business.about = ''; value.businessContext = personalAnalysisWireSchema.shape.businessContext.parse(emptyContext());
    const entity = industry === 'Магазин' ? 'retail' : 'foodservice';
    data.source.text = `Объявлены новые условия для ${entity}.`;
    value.extraction.entities.platforms = []; value.extraction.entities.industries = [entity];
    value.extraction.evidence = ['category', 'categories', 'title', 'summary', 'status', 'factStatus', 'influence', 'entities.industries'].map((field) => ({ field, quote: data.source.text }));
    value.quotes = [data.source.text]; value.fact = data.source.text;
    expect((await analyzePersonalNews(data, { env, fetchImpl: reply(value) })).recommendations).toHaveLength(1);
  });
  it('accepts a process explicitly defined by saved delivery windows', async () => {
    const data = input(), value = output();
    data.locations[0].deliveryWindows = [{ days: [1], start: '10:00', end: '12:00' }];
    value.recommendations[0].processes = ['Доставка']; value.affectedProcesses = ['Доставка'];
    const fetchImpl = reply(value);
    expect((await analyzePersonalNews(data, { env, fetchImpl })).recommendations[0].processes).toEqual(['Доставка']);
    const sent = JSON.parse(newsRequest(fetchImpl).messages[1].content);
    expect(sent.locations[0].declaredProcesses).toContain('Доставка');
  });
  it.each(['fact', 'possibleImpact'] as const)('rejects recommendations lacking %s', async (field) => {
    const value = output(); value[field] = null;
    await expect(analyzePersonalNews(input(), { env, fetchImpl: reply(value) })).rejects.toMatchObject({ code: 'GROQ_UNSUPPORTED_IMPACT' });
  });
  it('rejects recommendations lacking source quotes', async () => {
    const value = output(); value.fact = null; value.quotes = [];
    await expect(analyzePersonalNews(input(), { env, fetchImpl: reply(value) })).rejects.toMatchObject({ code: 'GROQ_UNSUPPORTED_IMPACT' });
  });
  it('rejects fabricated quantitative revenue forecasts', async () => {
    const value = output(); value.possibleImpact = 'Выручка может вырасти на 20%.';
    await expect(analyzePersonalNews(input(), { env, fetchImpl: reply(value) })).rejects.toMatchObject({ code: 'GROQ_UNSUPPORTED_FORECAST' });
  });
  it('keeps exactly one clarification question', async () => {
    const value = output(); value.relevance = 'needs_clarification'; value.question = 'Какой товар продаёте? Какая комиссия?';
    const result = await analyzePersonalNews(input(), { env, fetchImpl: reply(value) });
    expect(result.question).toBe('Какой товар продаёте?'); expect(result.recommendations).toEqual([]);
  });
  it('requires local time even when the local category is secondary to commercial', async () => {
    const data = input(), value = output();
    data.source.text = 'Москва, улица Тестовая, дом 7: авария. Ozon объявил изменение условий на время аварии.';
    value.extraction.categories = ['commercial', 'incident']; value.extraction.city = 'Москва'; value.extraction.address = 'Москва, улица Тестовая, дом 7';
    value.extraction.evidence = ['category', 'categories', 'title', 'summary', 'status', 'factStatus', 'influence', 'entities.platforms', 'city', 'address'].map((field) => ({ field, quote: data.source.text }));
    value.fact = data.source.text; value.quotes = [data.source.text];
    const result = await analyzePersonalNews(data, { env, fetchImpl: reply(value) });
    expect(result.relevance).toBe('needs_clarification'); expect(result.recommendations).toEqual([]);
  });
  it('keeps through-next-week relative time unknown without publication timezone', async () => {
    const { data, value } = localCase();
    data.source.text = data.source.text.replace('16 ноября 2026', 'через неделю');
    value.extraction.evidence.forEach((item) => { item.quote = data.source.text; }); value.quotes = [data.source.text]; value.fact = data.source.text;
    const result = await analyzePersonalNews(data, { env, fetchImpl: reply(value) });
    expect(result.extraction.startsAt).toBeNull(); expect(result.recommendations).toEqual([]);
  });
  it('also checks the city of a secondary local category with a known period', async () => {
    const { data, value } = localCase(); data.locations[0].city = 'Тверь';
    data.source.text = 'Москва, улица Тестовая, дом 7: 16 ноября 2026 с 10:00 до 12:00 авария. Ozon объявил изменение условий на время аварии.';
    data.business.about = 'Продаём на Ozon.'; value.businessContext = output().businessContext;
    value.extraction.category = 'commercial'; value.extraction.categories = ['commercial', 'incident']; value.extraction.entities.platforms = ['Ozon']; value.extraction.affectedResources = [];
    value.extraction.evidence = ['category', 'categories', 'title', 'summary', 'status', 'factStatus', 'influence', 'timezone', 'entities.platforms', 'city', 'address', 'startsAt', 'endsAt'].map((field) => ({ field, quote: data.source.text }));
    value.fact = data.source.text; value.quotes = [data.source.text];
    const result = await analyzePersonalNews(data, { env, fetchImpl: reply(value) });
    expect(result.relevance).toBe('irrelevant'); expect(result.recommendations).toEqual([]);
  });
});
