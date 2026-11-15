import { createHash } from 'node:crypto';
import { db } from './db';
import { Prisma } from '@/generated/prisma/client';
import { locationSchema } from '@/domain/schemas';
import { EVENT_RADIUS_METERS } from '@/lib/product-config';
import { analyzePersonalNews, personalAnalysisResultSchema, type PersonalAnalysisInput, type PersonalAnalysisResult } from '@/ai/personal';
import { getNewsAiCacheScope, getNewsAiStatus } from '@/ai/provider';
import { fetchTelegramMessages, telegramSource, type TelegramMessage } from './telegram';

const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
type BusinessUser = { id: string; businessName: string; businessType: string; about: string; city: string };
// Private cache namespace: retained results from older validation logic remain
// history, while the existing bounded queue computes the current revision once.
const PERSONAL_ANALYSIS_REVISION = 'field-evidence-v2';
export function personalProfileSnapshot(user: BusinessUser, points: { id: string; profile: unknown }[]) {
  const business = { id: user.id, name: user.businessName, industry: user.businessType, about: user.about, city: user.city };
  const locations = points.map(point => {
    const parsed = locationSchema.parse({ ...(point.profile as object), eventRadiusMeters: EVENT_RADIUS_METERS });
    const meaningful = { ...parsed };
    delete meaningful.businessContext; delete meaningful.businessContextError;
    return { ...meaningful, id: point.id };
  }).sort((a, b) => a.id.localeCompare(b.id));
  // Keep the provider namespace queryable for server-wide cooldowns, even after
  // a business changes its profile. Neither this private key nor credentials enter DTOs.
  return { business, locations, profileHash: `${getNewsAiCacheScope()}:${hash(canonical({ analysisRevision: PERSONAL_ANALYSIS_REVISION, business, locations }))}` };
}
export function syncEnabled() { return process.env.RADAR_SYNC_ENABLED !== 'false' && process.env.RADAR_DEMO_MODE !== 'true'; }

function activeAnalysisNamespace() {
  const { provider } = getNewsAiStatus();
  const prefix = provider?.toUpperCase();
  const where: Prisma.PersonalNewsAnalysisWhereInput = { OR: [
    { profileHash: { startsWith: `${getNewsAiCacheScope()}:` } },
    // Before provider namespaces existed, only Groq could create these records.
    // Preserve its historical cooldown conservatively; Gemini never inherits it.
    ...(provider === 'groq' ? [{ AND: [{ NOT: { profileHash: { contains: ':' } } }, { errorCode: { startsWith: 'GROQ_' } }] }] : []),
  ] };
  const errors = prefix ? ['RATE_LIMIT', 'AUTH', 'INVALID_CONFIG', 'NOT_CONFIGURED'].map(code => `${prefix}_${code}`) : [];
  return { provider, prefix, where, errors, rateLimitCode: prefix ? `${prefix}_RATE_LIMIT` : null };
}

/** Shared by the queue and read-only product state; no model calls or cache mutation. */
export async function activeAnalysisCooldown(rateLimitOnly = false) {
  const namespace = activeAnalysisNamespace();
  if (!namespace.provider) return null;
  return db.personalNewsAnalysis.findFirst({
    where: { AND: [namespace.where, { status: 'error', errorCode: { in: rateLimitOnly ? [namespace.rateLimitCode!] : namespace.errors }, retryAt: { gt: new Date() } }] },
    orderBy: { retryAt: 'desc' }, select: { retryAt: true },
  });
}

/** One atomic publication version. Repeated polls and concurrent workers share the same source key. */
export async function saveTelegramPost(post: TelegramMessage) {
  if (post.channel !== telegramSource.channel || !/^[1-9][0-9]*$/.test(post.messageId) || post.url !== `${telegramSource.url}/${post.messageId}`) throw new Error('Unsupported source identity');
  const contentHash = hash(canonical({ text: post.text, links: post.links, publishedAt: post.publishedAt }));
  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${post.channel}:${post.messageId}`}))`;
    const previous = await tx.sourceMessage.findFirst({ where: { OR: [{ channel: post.channel, channelMessageId: post.messageId }, { origin: 'telegram', url: post.url }] }, include: { versions: { orderBy: { version: 'desc' }, take: 1 } } });
    if (previous?.versions[0]?.contentHash === contentHash) return { eventId: previous.eventId, messageId: previous.id, changed: false };
    const event = previous ? await tx.event.update({ where: { id: previous.eventId }, data: { title: post.text.slice(0, 160), status: 'pending', extracted: Prisma.DbNull, confirmed: false, version: { increment: 1 }, isDemo: false } })
      : await tx.event.create({ data: { title: post.text.slice(0, 160), status: 'pending', version: 1, isDemo: false } });
    const metadata = { publisher: post.publisher, url: post.url, publishedAt: post.publishedAt, timezone: post.timezone, origin: 'telegram', channel: post.channel, messageId: post.messageId, links: post.links };
    const source = previous ? await tx.sourceMessage.update({ where: { id: previous.id }, data: { channel: post.channel, channelMessageId: post.messageId, receivedAt: new Date(), publishedAt: new Date(post.publishedAt), isDemo: false } })
      : await tx.sourceMessage.create({ data: { eventId: event.id, publisher: post.publisher, url: post.url, publishedAt: new Date(post.publishedAt), timezone: post.timezone,
        origin: 'telegram', channel: post.channel, channelMessageId: post.messageId, isDemo: false, fingerprint: hash(`${post.channel}:${post.messageId}`) } });
    const version = (previous?.versions[0]?.version ?? 0) + 1;
    await tx.messageVersion.create({ data: { messageId: source.id, version, text: post.text, contentHash, fingerprint: hash(`${source.id}:${version}:${contentHash}`), metadata: json(metadata) } });
    if (previous) {
      await tx.task.updateMany({ where: { eventId: event.id }, data: { needsReview: true } });
      await tx.assessment.deleteMany({ where: { eventId: event.id } });
    }
    return { eventId: event.id, messageId: source.id, changed: true };
  });
}

export async function syncTelegram(transport: typeof fetch = fetch) {
  const health = await db.sourceHealth.upsert({ where: { channel: telegramSource.channel }, create: { channel: telegramSource.channel, lastAttemptAt: new Date() }, update: { lastAttemptAt: new Date() } });
  try {
    const page = await fetchTelegramMessages(health.initialized ? 20 : 50, transport);
    let changed = 0;
    for (const post of page.messages) if ((await saveTelegramPost(post)).changed) changed++;
    await db.sourceHealth.update({ where: { channel: telegramSource.channel }, data: { status: 'ok', lastSuccessAt: new Date(), errorCode: null, errorMessage: null, fetched: page.messages.length, changed, initialized: true } });
    return { fetched: page.messages.length, changed, skipped: page.skipped };
  } catch (error) {
    const known = error as { code?: string };
    const code = known.code?.startsWith('TELEGRAM_') ? known.code : 'SOURCE_STORAGE_ERROR';
    await db.sourceHealth.update({ where: { channel: telegramSource.channel }, data: { status: 'error', errorCode: code,
      errorMessage: code === 'SOURCE_STORAGE_ERROR' ? 'Не удалось сохранить новости. Ранее полученные данные сохранены.' : 'Публичный Telegram сейчас недоступен или изменил разметку. Ранее полученные новости сохранены.' } });
    return { fetched: 0, changed: 0, error: code };
  }
}

type Analyze = (input: PersonalAnalysisInput) => Promise<PersonalAnalysisResult>;
type AnalysisScope = { userId?: string; messageIds?: string[] };
/** No reads of this function from GET handlers. The durable lease also prevents duplicate model work. */
export async function analyzePendingNews(analyze: Analyze = analyzePersonalNews, limit = 20, configured = getNewsAiStatus().configured, scope: AnalysisScope = {}) {
  // The provider quota belongs to the shared server credential, not to one post
  // or account. Persist its cooldown so a later tick or restart cannot bypass it.
  const namespace = activeAnalysisNamespace();
  const enabled = configured && namespace.provider !== null;
  const cooldown = enabled ? await activeAnalysisCooldown() : null;
  if (cooldown?.retryAt) return { processed: 0, deferredUntil: cooldown.retryAt.toISOString() };
  const [users, messages] = await Promise.all([
    db.user.findMany({ where: scope.userId !== undefined ? { id: scope.userId } : undefined, include: { locations: true } }),
    db.sourceMessage.findMany({ where: { ...(scope.messageIds ? { id: { in: scope.messageIds } } : {}), channel: telegramSource.channel, receivedAt: { gte: new Date(Date.now() - 30 * 86_400_000) } }, include: { versions: { orderBy: { version: 'desc' }, take: 1 } }, orderBy: { receivedAt: 'desc' } }),
  ]);
  let processed = 0;
  for (const user of users) {
    const snapshot = personalProfileSnapshot(user, user.locations);
    for (const message of messages) {
      const version = message.versions[0]; if (!version) continue;
      const identity = { userId: user.id, messageId: message.id, contentHash: version.contentHash, profileHash: snapshot.profileHash };
      await db.personalNewsAnalysis.createMany({ data: [identity], skipDuplicates: true });
      if (!enabled || processed >= limit) continue;
      const now = new Date();
      const claimed = await db.personalNewsAnalysis.updateMany({ where: { ...identity, attempts: { lt: 3 }, OR: [
        { status: 'pending' }, { status: 'processing', leaseUntil: { lt: now } }, { status: 'error', retryAt: { lte: now } },
      ] }, data: { status: 'processing', leaseUntil: new Date(Date.now() + 5 * 60_000), attempts: { increment: 1 }, errorCode: null, errorMessage: null } });
      if (!claimed.count) continue;
      processed++;
      try {
        const result = personalAnalysisResultSchema.parse(await analyze({ source: { text: version.text, publisher: message.publisher, url: message.url!, publishedAt: message.publishedAt?.toISOString() ?? null,
          receivedAt: message.receivedAt.toISOString(), timezone: message.timezone, channel: telegramSource.channel, messageId: message.channelMessageId! },
          business: snapshot.business, locations: snapshot.locations, now: new Date().toISOString() }));
        await db.personalNewsAnalysis.updateMany({ where: identity, data: { status: result.relevance, result: json(result), leaseUntil: null, retryAt: null } });
      } catch (error) {
        const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'ANALYSIS_ERROR';
        const allowedCode = /^(?:GROQ|GEMINI)_[A-Z_]+$/.test(code) ? code : 'ANALYSIS_ERROR';
        const hint = (error as { retryAfterMs?: unknown }).retryAfterMs;
        const rateLimited = allowedCode === namespace.rateLimitCode;
        const delay = rateLimited && typeof hint === 'number' && Number.isFinite(hint) && hint > 0
          ? Math.max(60_000, Math.min(24 * 60 * 60_000, hint))
          : namespace.errors.includes(allowedCode) && !rateLimited ? 30 * 60_000 : 5 * 60_000;
        const retryAt = new Date(Date.now() + delay);
        await db.personalNewsAnalysis.updateMany({ where: identity, data: { status: 'error', leaseUntil: null, retryAt,
          // Shared provider quota is not a failed attempt to analyze this post.
          // Refund only the claim above; the durable global cooldown still gates all work.
          ...(rateLimited ? { attempts: { decrement: 1 } } : {}),
          errorCode: allowedCode, errorMessage: 'Анализ временно недоступен. Новость сохранена; неподтверждённые рекомендации не показаны.' } });
        if (namespace.errors.includes(allowedCode)) return { processed, deferredUntil: retryAt.toISOString() };
      }
    }
  }
  return { processed };
}

type RunnerState = { running?: Promise<void>; source?: ReturnType<typeof syncTelegram>; analysis?: ReturnType<typeof analyzePendingNews>; timer?: ReturnType<typeof setTimeout>; started?: boolean };
const runtime = globalThis as typeof globalThis & { radarNewsRuntime?: RunnerState };
function runner() { return runtime.radarNewsRuntime ??= {}; }
export function runNewsPipeline() {
  const state = runner();
  if (state.running) return state.running;
  state.running = (async () => { await pollSource(); await runAnalysis(); })().finally(() => { state.running = undefined; });
  return state.running;
}
function pollSource() {
  const state = runner();
  return state.source ??= syncTelegram().finally(() => { state.source = undefined; });
}
function runAnalysis() {
  const state = runner();
  return state.analysis ??= analyzePendingNews().finally(() => { state.analysis = undefined; });
}
export async function recoverAnalysisOnStartup() {
  const namespace = activeAnalysisNamespace();
  if (!namespace.provider) return { count: 0 };
  return db.personalNewsAnalysis.updateMany({ where: { AND: [namespace.where, { OR: [
    { status: 'error', OR: [{ errorCode: { not: namespace.rateLimitCode! } }, { retryAt: { lte: new Date() } }, { retryAt: null }] },
    { status: 'processing', leaseUntil: { lt: new Date() } },
  ] }] }, data: { status: 'pending', attempts: 0, leaseUntil: null, retryAt: null } });
}
export function startNewsScheduler() {
  const state = runner();
  if (state.started || !syncEnabled()) return;
  state.started = true;
  const tick = () => {
    // A slow model batch never delays the next source poll; each branch has one process-wide lock.
    void pollSource().then(() => runAnalysis()).catch(() => {});
    state.timer = setTimeout(tick, 60_000); state.timer.unref();
  };
  // A deliberate restart after changing credentials permits a fresh bounded retry budget.
  void recoverAnalysisOnStartup().catch(() => {}).finally(tick);
}
