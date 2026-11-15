import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { demoLocations, demoMessages } from '../../src/data/demo';
import type { PersonalAnalysisInput, PersonalAnalysisResult } from '../../src/ai/personal';
import type { TelegramMessage } from '../../src/server/telegram';

if (!process.env.DATABASE_URL || !new URL(process.env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('News pipeline requires isolated *_test DATABASE_URL. No database was changed.');
process.env.RADAR_DEMO_MODE = 'false'; process.env.RADAR_SYNC_ENABLED = 'false';
let db: typeof import('../../src/server/db').db;
let pipeline: typeof import('../../src/server/news-pipeline');
let product: typeof import('../../src/server/product');
const fixture = demoMessages.find(item => item.key === 'water-bakery')!;
const post = (id = '501', text = fixture.text): TelegramMessage => ({ channel: 'newsssss09', messageId: id, text, links: [], publisher: '@newsssss09',
  url: `https://t.me/newsssss09/${id}`, publishedAt: fixture.publishedAt, timezone: null, origin: 'telegram' });
function answer(input: PersonalAnalysisInput): PersonalAnalysisResult {
  const point = input.locations[0];
  return { extraction: fixture.extraction, relevance: point ? 'relevant' : 'needs_clarification', relevanceExplanation: point ? 'Совпадают адрес и процесс с водой.' : 'Точки не указаны.',
    affectedLocationIds: point ? [point.id] : [], affectedProcesses: point ? ['Приготовление'] : [], fact: 'плановое отключение воды', quotes: ['плановое отключение воды'],
    possibleImpact: point ? 'Приготовление может потребовать запаса воды.' : null, assumptions: ['Резерв воды неизвестен.'], question: point ? null : 'Где находится ваша точка?',
    recommendations: point ? [{ type: 'threat', title: 'Проверьте запас воды', action: 'Уточните резерв воды для приготовления.', reason: 'Отключение пересекает часы работы.',
      locationIds: [point.id], processes: ['Приготовление'], startsAt: fixture.extraction.startsAt, endsAt: fixture.extraction.endsAt, sourceUrl: input.source.url }] : [],
    model: 'isolated-test-model', durationMs: 1 };
}
async function account(withPoint = true) {
  const result = await product.register({ name: 'Владелец', email: `${randomUUID()}@example.test`, password: 'Personal test password 2026', businessType: 'Пекарня' });
  if (withPoint) await product.savePersonalLocation(result.user.id, demoLocations[1]);
  return result.user;
}
beforeAll(async () => {
  db = (await import('../../src/server/db')).db; pipeline = await import('../../src/server/news-pipeline'); product = await import('../../src/server/product'); await db.$connect();
});
beforeEach(async () => {
  // Integration tests never inherit the developer's live provider or credentials.
  vi.stubEnv('NEWS_AI_PROVIDER', 'groq');
  vi.stubEnv('GROQ_API_KEY', 'isolated-groq-test-key');
  vi.stubEnv('GROQ_MODEL', 'openai/gpt-oss-20b');
  vi.stubEnv('GROQ_BASE_URL', 'https://api.groq.com/openai/v1');
  vi.stubEnv('GEMINI_API_KEY', 'isolated-gemini-test-key');
  vi.stubEnv('GEMINI_MODEL', 'gemini-3.1-flash-lite');
  vi.stubEnv('GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta/openai');
  await db.$transaction([db.user.deleteMany(), db.task.deleteMany(), db.assessment.deleteMany(), db.analysis.deleteMany(), db.messageVersion.deleteMany(), db.sourceMessage.deleteMany(), db.event.deleteMany(), db.location.deleteMany(), db.audit.deleteMany(), db.company.deleteMany(), db.sourceHealth.deleteMany()]);
});
afterAll(async () => { await db?.$disconnect(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('durable public source and personal analysis pipeline', () => {
  it('limits an internal bootstrap to the requested account and saved messages without bypassing normal claims', async () => {
    const a = await account(), b = await account();
    const first = await pipeline.saveTelegramPost(post('401'));
    const second = await pipeline.saveTelegramPost(post('402'));
    const analyze = vi.fn(async (input: PersonalAnalysisInput) => answer(input));
    await pipeline.analyzePendingNews(analyze, 20, false);
    const scope = { userId: a.id, messageIds: [first.messageId] };
    await pipeline.analyzePendingNews(analyze, 20, true, scope);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(analyze.mock.calls[0][0]).toMatchObject({ business: { id: a.id }, source: { messageId: '401' } });
    expect(await db.personalNewsAnalysis.count({ where: { status: 'pending', attempts: 0 } })).toBe(3);
    expect(await db.personalNewsAnalysis.count({ where: { userId: b.id, status: 'pending', attempts: 0 } })).toBe(2);
    expect(await db.personalNewsAnalysis.findFirst({ where: { userId: a.id, messageId: second.messageId } })).toMatchObject({ status: 'pending', attempts: 0 });
    await pipeline.analyzePendingNews(analyze, 20, true, scope);
    await pipeline.analyzePendingNews(analyze, 20, true, { userId: a.id, messageIds: [] });
    expect(analyze).toHaveBeenCalledTimes(1);
    await pipeline.analyzePendingNews(analyze, 20, true);
    expect(analyze).toHaveBeenCalledTimes(4);
    expect(await db.personalNewsAnalysis.count()).toBe(4);
  });

  it('namespaces saved results by provider, model and canonical base URL but not API key', async () => {
    const user = await account(); await pipeline.saveTelegramPost(post('411'));
    const points = await db.userLocation.findMany({ where: { userId: user.id } });
    const originalHash = pipeline.personalProfileSnapshot(user, points).profileHash;
    const analyze = vi.fn(async (input: PersonalAnalysisInput) => answer(input));
    await pipeline.analyzePendingNews(analyze, 20, true);
    expect((await product.getProductState(user)).recommendations).toHaveLength(1);

    vi.stubEnv('NEWS_AI_PROVIDER', 'gemini');
    const geminiHash = pipeline.personalProfileSnapshot(user, points).profileHash;
    expect(geminiHash).not.toBe(originalHash);
    expect((await product.getProductState(user)).recommendations).toEqual([]);
    expect(analyze).toHaveBeenCalledTimes(1);
    await pipeline.analyzePendingNews(analyze, 20, true);
    expect((await product.getProductState(user)).recommendations).toHaveLength(1);
    vi.stubEnv('GEMINI_API_KEY', 'rotated-test-key-not-a-real-secret');
    expect(pipeline.personalProfileSnapshot(user, points).profileHash).toBe(geminiHash);
    await pipeline.analyzePendingNews(analyze, 20, true);
    expect(analyze).toHaveBeenCalledTimes(2);

    vi.stubEnv('GEMINI_MODEL', 'isolated-alternate-model');
    const changedModel = pipeline.personalProfileSnapshot(user, points).profileHash;
    expect(changedModel).not.toBe(geminiHash);
    expect((await product.getProductState(user)).recommendations).toEqual([]);
    await pipeline.analyzePendingNews(analyze, 20, true);
    vi.stubEnv('GEMINI_BASE_URL', 'https://isolated-provider.example.test/openai');
    const changedBase = pipeline.personalProfileSnapshot(user, points).profileHash;
    expect(changedBase).not.toBe(changedModel);
    expect((await product.getProductState(user)).recommendations).toEqual([]);
    await pipeline.analyzePendingNews(analyze, 20, true);
    vi.stubEnv('GEMINI_BASE_URL', 'https://isolated-provider.example.test/openai/');
    expect(pipeline.personalProfileSnapshot(user, points).profileHash).toBe(changedBase);
    await pipeline.recoverAnalysisOnStartup();
    await pipeline.analyzePendingNews(analyze, 20, true);
    expect(analyze).toHaveBeenCalledTimes(4);
    expect(await db.personalNewsAnalysis.count()).toBe(4);
    const state = JSON.stringify(await product.getProductState(user));
    expect(state).not.toMatch(/rotated-test-key|isolated-provider|profileHash|cacheScope/u);
  });

  it('does not apply historical Groq cooldowns to Gemini and preserves them when switching back', async () => {
    const user = await account(); const source = await pipeline.saveTelegramPost(post('421'));
    const version = await db.messageVersion.findFirstOrThrow({ where: { messageId: source.messageId } });
    const retryAt = new Date(Date.now() + 720_000);
    const old = await db.personalNewsAnalysis.create({ data: { userId: user.id, messageId: source.messageId, contentHash: version.contentHash,
      profileHash: pipeline.hash('old-groq-before-provider-namespaces'), status: 'error', errorCode: 'GROQ_RATE_LIMIT', attempts: 0, retryAt } });
    const analyze = vi.fn(async (input: PersonalAnalysisInput) => answer(input));
    vi.stubEnv('NEWS_AI_PROVIDER', 'gemini');
    await pipeline.recoverAnalysisOnStartup();
    expect(await pipeline.analyzePendingNews(analyze, 20, true)).toMatchObject({ processed: 1 });
    const ready = await product.getProductState(user);
    expect(ready.analysisHealth.status).toBe('ready');
    expect(ready.recommendations).toHaveLength(1);
    expect(await db.personalNewsAnalysis.findUnique({ where: { id: old.id } })).toMatchObject({ status: 'error', errorCode: 'GROQ_RATE_LIMIT', retryAt });
    vi.stubEnv('NEWS_AI_PROVIDER', 'groq');
    expect(await pipeline.analyzePendingNews(analyze, 20, true)).toEqual({ processed: 0, deferredUntil: retryAt.toISOString() });
    expect((await product.getProductState(user)).recommendations).toEqual([]);
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it('keeps Gemini quota durable and global within its namespace while other provider and model caches remain independent', async () => {
    vi.stubEnv('NEWS_AI_PROVIDER', 'gemini');
    const a = await account(), b = await account();
    const ready = await pipeline.saveTelegramPost(post('431'));
    const analyze = vi.fn(async (input: PersonalAnalysisInput) => answer(input));
    await pipeline.analyzePendingNews(analyze, 20, true);
    await pipeline.saveTelegramPost(post('432'));
    const limited = vi.fn(async () => { throw Object.assign(new Error('PRIVATE_PROVIDER_DIAGNOSTIC'), { code: 'GEMINI_RATE_LIMIT', retryAfterMs: 720_000 }); });
    await pipeline.analyzePendingNews(limited, 20, true);
    const failed = await db.personalNewsAnalysis.findFirstOrThrow({ where: { errorCode: 'GEMINI_RATE_LIMIT' } });
    expect(failed).toMatchObject({ status: 'error', attempts: 0 });
    const other = failed.userId === a.id ? b : a;
    expect(await db.personalNewsAnalysis.count({ where: { userId: other.id, status: 'error' } })).toBe(0);
    for (const user of [a, b]) {
      const state = await product.getProductState(user);
      expect(state.analysisHealth.status).toBe('error');
      expect(state.analysisHealth.message).toContain('Gemini');
      expect(state.analysisHealth.message).toContain('Повторим автоматически после');
      expect(state.analysisHealth.message).toContain('МСК');
      expect(state.analysisHealth.message).not.toMatch(/GROQ|API|PRIVATE|DIAGNOSTIC/i);
      expect(state.recommendations.some(item => item.eventId === ready.eventId)).toBe(true);
    }
    await pipeline.recoverAnalysisOnStartup();
    expect(await pipeline.analyzePendingNews(analyze, 20, true, { userId: other.id })).toEqual({ processed: 0, deferredUntil: failed.retryAt!.toISOString() });
    expect(limited).toHaveBeenCalledTimes(1);
    expect(analyze).toHaveBeenCalledTimes(2);
    vi.stubEnv('NEWS_AI_PROVIDER', 'groq');
    expect(await pipeline.analyzePendingNews(analyze, 20, true)).toMatchObject({ processed: 4 });
    expect((await product.getProductState(a)).analysisHealth.status).toBe('ready');
    vi.stubEnv('NEWS_AI_PROVIDER', 'gemini');
    vi.stubEnv('GEMINI_MODEL', 'isolated-other-model');
    expect(await pipeline.analyzePendingNews(analyze, 20, true)).toMatchObject({ processed: 4 });
    expect((await product.getProductState(a)).analysisHealth.status).toBe('ready');
    vi.stubEnv('GEMINI_MODEL', 'gemini-3.1-flash-lite');
    await pipeline.recoverAnalysisOnStartup();
    expect(await pipeline.analyzePendingNews(analyze, 20, true)).toEqual({ processed: 0, deferredUntil: failed.retryAt!.toISOString() });
    expect(await db.personalNewsAnalysis.findUnique({ where: { id: failed.id } })).toMatchObject({ status: 'error', attempts: 0, retryAt: failed.retryAt });
    expect(analyze).toHaveBeenCalledTimes(10);
  });

  it('recovers credential failures only for the active provider and model namespace', async () => {
    await account(); await pipeline.saveTelegramPost(post('441'));
    const groqRejected = vi.fn(async () => { throw Object.assign(new Error('private'), { code: 'GROQ_AUTH' }); });
    await pipeline.analyzePendingNews(groqRejected, 20, true);
    const groq = await db.personalNewsAnalysis.findFirstOrThrow({ where: { errorCode: 'GROQ_AUTH' } });
    vi.stubEnv('NEWS_AI_PROVIDER', 'gemini');
    const rejected = vi.fn(async () => { throw Object.assign(new Error('private'), { code: 'GEMINI_AUTH' }); });
    await pipeline.analyzePendingNews(rejected, 20, true);
    const original = await db.personalNewsAnalysis.findFirstOrThrow({ where: { errorCode: 'GEMINI_AUTH' } });
    vi.stubEnv('GEMINI_MODEL', 'isolated-other-model');
    await pipeline.analyzePendingNews(rejected, 20, true);
    const current = await db.personalNewsAnalysis.findFirstOrThrow({ where: { errorCode: 'GEMINI_AUTH', id: { not: original.id } } });
    expect(await pipeline.recoverAnalysisOnStartup()).toEqual({ count: 1 });
    expect(await db.personalNewsAnalysis.findUnique({ where: { id: current.id } })).toMatchObject({ status: 'pending', attempts: 0, retryAt: null });
    for (const old of [groq, original]) expect(await db.personalNewsAnalysis.findUnique({ where: { id: old.id } })).toMatchObject({ status: 'error', attempts: 1, retryAt: old.retryAt });
  });

  it('does not fall back to Groq for an unknown provider or missing Gemini configuration', async () => {
    const user = await account(); await pipeline.saveTelegramPost(post('451'));
    const analyze = vi.fn(async (input: PersonalAnalysisInput) => answer(input));
    vi.stubEnv('NEWS_AI_PROVIDER', 'unsupported-provider');
    await pipeline.analyzePendingNews(analyze);
    expect((await product.getProductState(user)).analysisHealth.status).toBe('missing_config');
    vi.stubEnv('NEWS_AI_PROVIDER', 'gemini');
    vi.stubEnv('GEMINI_API_KEY', '');
    await pipeline.analyzePendingNews(analyze);
    const state = await product.getProductState(user);
    expect(state.analysisHealth.status).toBe('missing_config');
    expect(state.recommendations).toEqual([]);
    expect(analyze).not.toHaveBeenCalled();
    expect(await db.personalNewsAnalysis.count({ where: { attempts: { gt: 0 } } })).toBe(0);
    expect(await db.personalNewsAnalysis.count({ where: { status: 'pending' } })).toBe(2);
  });

  it('deduplicates concurrent channel/post imports and preserves edited and reverted originals', async () => {
    const first = post();
    const outcomes = await Promise.all([pipeline.saveTelegramPost(first), pipeline.saveTelegramPost(first), pipeline.saveTelegramPost(first)]);
    expect(outcomes.filter(item => item.changed)).toHaveLength(1);
    expect(await db.event.count()).toBe(1); expect(await db.sourceMessage.count()).toBe(1); expect(await db.messageVersion.count()).toBe(1);
    const changed = { ...first, text: `${first.text}\nНовое уточнение.`, links: [{ text: 'источник', url: 'https://example.test/saved-link' }] };
    await pipeline.saveTelegramPost(changed); await pipeline.saveTelegramPost(first);
    expect(await db.event.count()).toBe(1);
    const saved = await db.sourceMessage.findFirstOrThrow({ include: { versions: { orderBy: { version: 'asc' } }, event: true } });
    expect(saved.versions.map(item => item.text)).toEqual([first.text, changed.text, first.text]);
    expect(saved.versions[1].metadata).toMatchObject({ links: changed.links });
    expect(saved.event.version).toBe(3);
    expect(saved).toMatchObject({ channel: 'newsssss09', channelMessageId: first.messageId, url: first.url, isDemo: false });
  });

  it('claims each profile/post/hash once, stores isolated recommendations and spends no quota on GET', async () => {
    const a = await account(), b = await account(false);
    await pipeline.saveTelegramPost(post());
    const analyze = vi.fn(async (input: PersonalAnalysisInput) => answer(input));
    await Promise.all([pipeline.analyzePendingNews(analyze, 20, true), pipeline.analyzePendingNews(analyze, 20, true)]);
    expect(analyze).toHaveBeenCalledTimes(2);
    const first = await product.getProductState(a), second = await product.getProductState(b);
    expect(first.recommendations).toHaveLength(1); expect(second.recommendations).toEqual([]);
    expect(first.recommendations[0].locationIds).toEqual([first.locations[0].id]);
    expect(second.events[0].impactStatus).toBe('needs_clarification');
    await product.getProductState(a); await product.getProductState(a);
    await pipeline.analyzePendingNews(analyze, 20, true);
    expect(analyze).toHaveBeenCalledTimes(2);
    expect((await product.getProductState(null)).recommendations).toEqual([]);
    expect(JSON.stringify(first)).not.toContain('passwordHash');
    expect(JSON.stringify(second)).not.toContain(first.locations[0].id);
  });

  it('invalidates changed source and significant profile data but not photos or feedback', async () => {
    const user = await account(); const saved = await pipeline.saveTelegramPost(post());
    const analyze = vi.fn(async (input: PersonalAnalysisInput) => answer(input));
    await pipeline.analyzePendingNews(analyze, 20, true);
    await db.user.update({ where: { id: user.id }, data: { photo: 'not sent to model', name: 'Новое имя владельца' } });
    await product.setFeedback(user.id, saved.eventId, { value: -1 });
    await pipeline.analyzePendingNews(analyze, 20, true); expect(analyze).toHaveBeenCalledTimes(1);
    await product.updateProfile(user.id, { about: 'Готовим выпечку; вода нужна ежедневно.' });
    expect((await product.getProductState(await db.user.findUniqueOrThrow({ where: { id: user.id } }))).recommendations).toEqual([]);
    await pipeline.analyzePendingNews(analyze, 20, true); expect(analyze).toHaveBeenCalledTimes(2);
    expect(analyze.mock.calls[1][0].business.about).toContain('вода');
    await pipeline.saveTelegramPost(post('501', `${fixture.text}\nИзменено время проверки.`));
    expect((await product.getProductState(await db.user.findUniqueOrThrow({ where: { id: user.id } }))).recommendations).toEqual([]);
    await pipeline.analyzePendingNews(analyze, 20, true); expect(analyze).toHaveBeenCalledTimes(3);
    expect(await db.personalNewsAnalysis.count()).toBe(3);
  });

  it('retains the old analyzer result as history and computes the current revision once without model work on GET', async () => {
    const user = await account(); const received = await pipeline.saveTelegramPost(post());
    const points = await db.userLocation.findMany({ where: { userId: user.id } });
    const snapshot = pipeline.personalProfileSnapshot(user, points);
    // Exact pre-revision cache serialization: the old key contained business and
    // locations only, without any analysis implementation namespace.
    const oldPayload = JSON.stringify({ business: snapshot.business, locations: snapshot.locations }, (_key, value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
    const oldProfileHash = pipeline.hash(oldPayload);
    expect(snapshot.profileHash).not.toBe(oldProfileHash);
    const source = await db.sourceMessage.findUniqueOrThrow({ where: { id: received.messageId }, include: { versions: { orderBy: { version: 'desc' }, take: 1 } } });
    const original = answer({ source: { ...post(), receivedAt: source.receivedAt.toISOString() }, business: snapshot.business, locations: snapshot.locations });
    const oldResult: PersonalAnalysisResult = { ...original,
      extraction: { ...original.extraction, city: null, address: null, startsAt: null, endsAt: null },
      relevance: 'needs_clarification', relevanceExplanation: 'Место или период события не подтверждены цитатами источника.',
      affectedLocationIds: [], affectedProcesses: [], possibleImpact: null, recommendations: [], question: 'Какое точное место и время события?' };
    const old = await db.personalNewsAnalysis.create({ data: { userId: user.id, messageId: source.id, contentHash: source.versions[0].contentHash,
      profileHash: oldProfileHash, status: 'needs_clarification', attempts: 1, result: oldResult } });
    const analyze = vi.fn(async (input: PersonalAnalysisInput) => answer(input));
    const before = await product.getProductState(user);
    expect(before.recommendations).toEqual([]);
    expect(before.events[0].relevance).not.toBe(oldResult.relevanceExplanation);
    expect(analyze).not.toHaveBeenCalled();
    await pipeline.analyzePendingNews(analyze, 20, true);
    expect(analyze).toHaveBeenCalledTimes(1);
    const current = await product.getProductState(user);
    expect(current.recommendations).toHaveLength(1);
    expect(await db.personalNewsAnalysis.count({ where: { userId: user.id, messageId: source.id } })).toBe(2);
    expect(await db.personalNewsAnalysis.findUnique({ where: { id: old.id } })).toMatchObject({ profileHash: oldProfileHash, status: 'needs_clarification', attempts: 1, result: oldResult });
    await pipeline.recoverAnalysisOnStartup();
    await pipeline.analyzePendingNews(analyze, 20, true);
    await product.getProductState(user);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(await db.personalNewsAnalysis.count({ where: { userId: user.id, messageId: source.id, profileHash: snapshot.profileHash } })).toBe(1);
    expect(await db.messageVersion.count({ where: { messageId: source.id } })).toBe(1);
  });

  it('honors historical-revision provider cooldowns before creating or claiming new-revision work', async () => {
    const user = await account(); const received = await pipeline.saveTelegramPost(post());
    const version = await db.messageVersion.findFirstOrThrow({ where: { messageId: received.messageId } });
    const retryAt = new Date(Date.now() + 720_000);
    const old = await db.personalNewsAnalysis.create({ data: { userId: user.id, messageId: received.messageId, contentHash: version.contentHash,
      profileHash: pipeline.hash('historical-revision'), status: 'error', errorCode: 'GROQ_RATE_LIMIT', attempts: 2, retryAt } });
    const analyze = vi.fn(async (input: PersonalAnalysisInput) => answer(input));
    await pipeline.recoverAnalysisOnStartup();
    expect(await pipeline.analyzePendingNews(analyze, 20, true)).toEqual({ processed: 0, deferredUntil: retryAt.toISOString() });
    expect(analyze).not.toHaveBeenCalled();
    expect(await db.personalNewsAnalysis.count()).toBe(1);
    expect(await db.personalNewsAnalysis.findUnique({ where: { id: old.id } })).toMatchObject({ status: 'error', attempts: 2, retryAt });
  });

  it('persists source failure separately from successful unchanged polls without deleting data', async () => {
    const html = `<div class="tgme_channel_info">newsssss09</div><div class="tgme_widget_message" data-post="newsssss09/501"><div class="tgme_widget_message_text">Короткая публикация</div><time datetime="2026-11-15T00:00:00Z"></time></div>`;
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => new Response(html, { headers: { 'content-type': 'text/html' } }));
    expect(await pipeline.syncTelegram(transport)).toMatchObject({ fetched: 1, changed: 1 });
    expect(await pipeline.syncTelegram(transport)).toMatchObject({ fetched: 1, changed: 0 });
    expect(await db.sourceHealth.findUnique({ where: { channel: 'newsssss09' } })).toMatchObject({ status: 'ok', changed: 0 });
    await pipeline.syncTelegram(vi.fn<typeof fetch>().mockRejectedValue(new Error('private proxy credential')));
    expect(await db.sourceHealth.findUnique({ where: { channel: 'newsssss09' } })).toMatchObject({ status: 'error', initialized: true });
    expect(await db.sourceMessage.count()).toBe(1);
    expect(JSON.stringify(await product.getProductState(null))).not.toContain('private proxy credential');
  });

  it('keeps missing configuration pending without attempts and bounds transient errors without fabricated success', async () => {
    const user = await account(); await pipeline.saveTelegramPost(post());
    const analyze = vi.fn(async () => { throw Object.assign(new Error('SECRET_PROVIDER_DETAIL'), { code: 'GROQ_QUOTA' }); });
    await pipeline.analyzePendingNews(analyze, 20, false); expect(analyze).not.toHaveBeenCalled();
    expect(await db.personalNewsAnalysis.findFirst()).toMatchObject({ status: 'pending', attempts: 0 });
    await pipeline.analyzePendingNews(analyze, 20, true); expect(analyze).toHaveBeenCalledTimes(1);
    await pipeline.analyzePendingNews(analyze, 20, true); expect(analyze).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 3; i++) {
      await db.personalNewsAnalysis.updateMany({ data: { retryAt: new Date(0) } });
      await pipeline.analyzePendingNews(analyze, 20, true);
    }
    expect(analyze).toHaveBeenCalledTimes(3);
    const state = await product.getProductState(user);
    expect(state.recommendations).toEqual([]); expect(state.events[0].impactStatus).toBe('error');
    expect(JSON.stringify(state)).not.toContain('SECRET_PROVIDER_DETAIL');
  });

  it('stops all accounts after a rate limit and preserves a durable cooldown without spending pending attempts', async () => {
    await account(); await account(false);
    await pipeline.saveTelegramPost(post('601')); await pipeline.saveTelegramPost(post('602'));
    const unused = vi.fn(async (input: PersonalAnalysisInput) => answer(input));
    await pipeline.analyzePendingNews(unused, 20, false);
    const limited = vi.fn(async () => { throw Object.assign(new Error('private quota diagnostic'), { code: 'GROQ_RATE_LIMIT', retryAfterMs: 720_000 }); });
    const before = Date.now();
    const stopped = await pipeline.analyzePendingNews(limited, 20, true);
    expect(limited).toHaveBeenCalledTimes(1);
    expect(stopped.processed).toBe(1);
    const failed = await db.personalNewsAnalysis.findFirstOrThrow({ where: { status: 'error' } });
    expect(failed.retryAt!.getTime()).toBeGreaterThanOrEqual(before + 720_000);
    expect(await db.personalNewsAnalysis.count({ where: { status: 'pending', attempts: 0 } })).toBe(3);
    await pipeline.recoverAnalysisOnStartup();
    expect(await db.personalNewsAnalysis.findUnique({ where: { id: failed.id } })).toMatchObject({ status: 'error', attempts: 0, retryAt: failed.retryAt });
    const later = vi.fn(async (input: PersonalAnalysisInput) => answer(input));
    const skipped = await pipeline.analyzePendingNews(later, 20, true);
    expect(skipped.processed).toBe(0); expect(later).not.toHaveBeenCalled();
    expect(skipped.deferredUntil).toBe(failed.retryAt!.toISOString());
    // Expiry permits work again; repeated GETs never participate in this budget.
    await db.personalNewsAnalysis.update({ where: { id: failed.id }, data: { retryAt: new Date(0) } });
    await pipeline.analyzePendingNews(later, 20, true);
    expect(later).toHaveBeenCalledTimes(4);
    expect(await db.personalNewsAnalysis.count({ where: { status: 'pending' } })).toBe(0);
  });

  it('stops a batch on shared credential errors instead of failing every news item', async () => {
    await account(); await pipeline.saveTelegramPost(post('701')); await pipeline.saveTelegramPost(post('702'));
    await pipeline.analyzePendingNews(async input => answer(input), 20, false);
    const rejected = vi.fn(async () => { throw Object.assign(new Error('do not expose upstream body'), { code: 'GROQ_AUTH' }); });
    await pipeline.analyzePendingNews(rejected, 20, true);
    await pipeline.analyzePendingNews(rejected, 20, true);
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(await db.personalNewsAnalysis.count({ where: { status: 'pending', attempts: 0 } })).toBe(1);
    expect(await db.personalNewsAnalysis.count({ where: { status: 'error', attempts: 1 } })).toBe(1);
    await pipeline.recoverAnalysisOnStartup();
    expect(await db.personalNewsAnalysis.count({ where: { status: 'pending', attempts: 0 } })).toBe(2);
  });

  it('does not exhaust a post through repeated quota cycles and analyzes it once after quota returns', async () => {
    await account(); await pipeline.saveTelegramPost(post('801'));
    const limited = vi.fn(async () => { throw Object.assign(new Error('quota'), { code: 'GROQ_RATE_LIMIT', retryAfterMs: 2_214_000 }); });
    for (let cycle = 1; cycle <= 4; cycle++) {
      const result = await pipeline.analyzePendingNews(limited, 20, true);
      expect(result.processed).toBe(1);
      expect(limited).toHaveBeenCalledTimes(cycle);
      const current = await db.personalNewsAnalysis.findFirstOrThrow();
      expect(current).toMatchObject({ status: 'error', errorCode: 'GROQ_RATE_LIMIT', attempts: 0, leaseUntil: null });
      expect(current.retryAt!.getTime()).toBeGreaterThan(Date.now());
      await pipeline.recoverAnalysisOnStartup();
      expect(await pipeline.analyzePendingNews(limited, 20, true)).toEqual({ processed: 0, deferredUntil: current.retryAt!.toISOString() });
      expect(limited).toHaveBeenCalledTimes(cycle);
      expect(await db.personalNewsAnalysis.findUnique({ where: { id: current.id } })).toMatchObject({ attempts: 0, retryAt: current.retryAt });
      // Advance the persisted provider deadline only in this isolated test database.
      await db.personalNewsAnalysis.update({ where: { id: current.id }, data: { retryAt: new Date(0) } });
    }
    const analyze = vi.fn(async (input: PersonalAnalysisInput) => answer(input));
    await pipeline.analyzePendingNews(analyze, 20, true);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(await db.personalNewsAnalysis.findFirst()).toMatchObject({ status: 'relevant', attempts: 1, errorCode: null, retryAt: null, leaseUntil: null });
    await pipeline.recoverAnalysisOnStartup();
    await pipeline.analyzePendingNews(analyze, 20, true);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(await db.personalNewsAnalysis.count()).toBe(1);
  });

  it('shows the shared quota deadline to both accounts while retaining ready cards and keeping guests signed out', async () => {
    vi.stubEnv('GROQ_API_KEY', 'isolated-quota-test-key');
    const a = await account(), b = await account();
    const ready = await pipeline.saveTelegramPost(post('901'));
    await pipeline.analyzePendingNews(async input => answer(input), 20, true);
    await pipeline.saveTelegramPost(post('902'));
    const limited = vi.fn(async () => { throw Object.assign(new Error('PRIVATE_PROVIDER_DIAGNOSTIC'), { code: 'GROQ_RATE_LIMIT', retryAfterMs: 2_214_000 }); });
    await pipeline.analyzePendingNews(limited, 20, true);
    const failed = await db.personalNewsAnalysis.findFirstOrThrow({ where: { errorCode: 'GROQ_RATE_LIMIT' } });
    const otherUser = failed.userId === a.id ? b : a;
    expect(await db.personalNewsAnalysis.count({ where: { userId: otherUser.id, status: 'error' } })).toBe(0);
    for (const user of [a, b]) {
      const state = await product.getProductState(user);
      expect(state.analysisHealth.status).toBe('error');
      expect(state.analysisHealth.message).toContain('Достигнут лимит анализа.');
      expect(state.analysisHealth.message).toContain('Повторим автоматически после');
      expect(state.analysisHealth.message).toContain('МСК');
      expect(state.analysisHealth.message).not.toMatch(/GROQ|API|PRIVATE|DIAGNOSTIC/i);
      expect(state.recommendations.some(item => item.eventId === ready.eventId)).toBe(true);
    }
    expect((await product.getProductState(null)).analysisHealth.status).toBe('sign_in');
    expect(limited).toHaveBeenCalledTimes(1);
    await db.personalNewsAnalysis.update({ where: { id: failed.id }, data: { retryAt: new Date(0) } });
    for (const user of [a, b]) expect((await product.getProductState(user)).analysisHealth.message).not.toContain('Повторим автоматически после');
  });
});
