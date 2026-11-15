import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { db } from './db';
import { AppError } from './errors';
import { Prisma, type User } from '@/generated/prisma/client';
import { demoLocations, demoNow } from '@/data/demo';
import { extractionSchema, locationSchema, normalizeWhitespace, validateBusinessContext, type Industry } from '@/domain/schemas';
import type { ProductEvent, ProductLocation, ProductNotification, ProductProfile, ProductState } from '@/lib/product-types';
import { BUSINESS_TYPES, EVENT_RADIUS_METERS, normalizeBusinessType } from '@/lib/product-config';
import { assessProductImpact } from './product-impact';
import { analyzeBusinessDescription, type AiOptions } from '@/ai';
import { getLiveProductState } from './product-news';

export const sessionCookie = 'radar_session';
export const sessionSeconds = 30 * 24 * 60 * 60;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
const email = z.email().max(254).transform(value => value.toLowerCase());
const password = z.string().min(10, 'Пароль должен содержать не менее 10 символов.').max(128);
const businessType = z.union([z.literal(''), z.enum(BUSINESS_TYPES)]);
const registerSchema = z.object({
  name: z.string().trim().min(1).max(120), email: z.string().trim().pipe(email), password,
  businessName: z.string().trim().max(160).default(''), businessType: businessType.default(''),
  city: z.string().trim().max(120).default(''),
}).strict();
const loginSchema = z.object({ email: z.string().trim().pipe(email), password: z.string().min(1).max(128) }).strict();
const profileSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(), photo: z.string().max(700_000).nullable().optional(),
  businessName: z.string().trim().max(160).optional(), businessType: businessType.optional(),
  city: z.string().trim().max(120).optional(), about: z.string().trim().max(2000).optional(),
}).strict();

function key(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
    (error, result) => error ? reject(error) : resolve(result)));
}
async function passwordHash(password: string) {
  const salt = randomBytes(24).toString('hex');
  return `scrypt:${salt}:${(await key(password, salt)).toString('hex')}`;
}
async function matchesPassword(password: string, encoded: string | undefined) {
  const [, salt, expected] = (encoded ?? `scrypt:${'0'.repeat(48)}:${'0'.repeat(128)}`).split(':');
  const actual = await key(password, salt);
  const expectedBytes = Buffer.from(expected, 'hex');
  return expectedBytes.length === actual.length && timingSafeEqual(actual, expectedBytes) && Boolean(encoded);
}

// Local deployment backstop, not a distributed abuse-prevention service.
const attempts = new Map<string, { count: number; until: number }>();
function throttle(identity: string) {
  const now = Date.now();
  for (const [identity, item] of attempts) if (item.until <= now) attempts.delete(identity);
  const previous = attempts.get(identity);
  if (previous && previous.count >= 12) throw new AppError(429, 'AUTH_LIMIT', 'Слишком много попыток. Повторите через 15 минут.');
  if (attempts.size >= 2000 && !previous) throw new AppError(429, 'AUTH_LIMIT', 'Повторите попытку позже.');
  attempts.set(identity, { count: (previous?.count ?? 0) + 1, until: previous?.until ?? now + 15 * 60_000 });
}

export function publicProfile(user: User): ProductProfile {
  return { id: user.id, name: user.name, email: user.email, photo: user.photo, businessName: user.businessName,
    businessType: normalizeBusinessType(user.businessType), city: user.city, about: user.about };
}
export async function sessionUser(token?: string): Promise<User | null> {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const session = await db.session.findUnique({ where: { tokenHash: digest(token) }, include: { user: true } });
  if (!session || session.expiresAt.getTime() <= Date.now()) return null;
  return session.user;
}
export async function requireUser(token?: string) {
  const user = await sessionUser(token);
  if (!user) throw new AppError(401, 'AUTH_REQUIRED', 'Войдите в аккаунт, чтобы сохранить изменения.');
  return user;
}
async function newSession(userId: string, client: Prisma.TransactionClient = db) {
  const token = randomBytes(32).toString('hex');
  await client.session.create({ data: { tokenHash: digest(token), userId, expiresAt: new Date(Date.now() + sessionSeconds * 1000) } });
  return token;
}
export async function register(input: unknown) {
  const data = registerSchema.parse(input);
  throttle(`register:${data.email}`);
  const encrypted = await passwordHash(data.password);
  return db.$transaction(async tx => {
    const user = await tx.user.create({ data: { name: data.name, email: data.email, passwordHash: encrypted,
      businessName: data.businessName, businessType: data.businessType, city: data.city } });
    return { user, token: await newSession(user.id, tx) };
  });
}
export async function login(input: unknown) {
  const data = loginSchema.parse(input);
  throttle(`login:${data.email}`);
  const user = await db.user.findUnique({ where: { email: data.email } });
  if (!await matchesPassword(data.password, user?.passwordHash) || !user) {
    throw new AppError(401, 'LOGIN', 'Неверный email или пароль.');
  }
  attempts.delete(`login:${data.email}`);
  return { user, token: await newSession(user.id) };
}
export async function logout(token?: string) {
  if (token) await db.session.deleteMany({ where: { tokenHash: digest(token) } });
}

export function validatePhoto(photo: string | null) {
  if (photo === null) return;
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(photo);
  if (!match) throw new AppError(400, 'PHOTO', 'Выберите изображение PNG, JPEG или WebP.');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > 500 * 1024) throw new AppError(413, 'PHOTO_SIZE', 'Фото должно быть не больше 500 КБ.');
  if (bytes.toString('base64') !== match[2]) throw new AppError(400, 'PHOTO', 'Некорректный файл изображения.');
  const png = bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) &&
    bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0;
  const jpeg = bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff &&
    bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  const webp = bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' &&
    ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16)) && bytes.readUInt32LE(4) + 8 === bytes.length;
  if (!(match[1] === 'png' ? png : match[1] === 'jpeg' ? jpeg : webp)) {
    throw new AppError(400, 'PHOTO', 'Содержимое файла не соответствует выбранному формату изображения.');
  }
}
export async function updateProfile(userId: string, input: unknown) {
  const data = profileSchema.parse(input);
  if (data.photo !== undefined) validatePhoto(data.photo);
  return db.user.update({ where: { id: userId }, data });
}

export async function savePersonalLocation(userId: string, input: unknown, id?: string, options: AiOptions = {}) {
  const previous = id ? await db.userLocation.findFirst({ where: { id, userId } }) : null;
  if (id && !previous) throw new AppError(404, 'LOCATION', 'Точка не найдена в вашем аккаунте.');
  const patch = z.record(z.string(), z.unknown()).parse(input);
  const prior = previous ? personalProfile(previous.profile) : null;
  let profile = locationSchema.parse({ ...prior, ...patch, eventRadiusMeters: EVENT_RADIUS_METERS,
    businessContext: prior?.businessContext, businessContextError: prior?.businessContextError });
  const descriptionChanged = Object.hasOwn(patch, 'businessDescription') && profile.businessDescription !== prior?.businessDescription;
  if (descriptionChanged || (Object.hasOwn(patch, 'businessDescription') && profile.businessDescription && (!prior?.businessContext || prior.businessContextError))) {
    profile = { ...profile, businessContext: undefined, businessContextError: null };
    if (profile.businessDescription && process.env.RADAR_DEMO_MODE === 'true') {
      try { profile.businessContext = (await analyzeBusinessDescription(profile.businessDescription, options)).context; }
      catch (error) { profile.businessContextError = error instanceof Error ? error.message : 'Описание сохранено; процессы требуют разбора.'; }
    }
  }
  return id ? db.userLocation.update({ where: { id, userId, revision: previous!.revision }, data: { locationId: profile.locationId, profile: json(profile), revision: { increment: 1 } } })
    : db.userLocation.create({ data: { userId, locationId: profile.locationId, profile: json(profile) } });
}
export async function deletePersonalLocation(userId: string, id: string) {
  const deleted = await db.userLocation.deleteMany({ where: { id, userId } });
  if (!deleted.count) throw new AppError(404, 'LOCATION', 'Точка не найдена в вашем аккаунте.');
}
export async function setFeedback(userId: string, eventId: string, input: unknown) {
  const { value } = z.object({ value: z.union([z.literal(1), z.literal(-1), z.null()]) }).strict().parse(input);
  if (!await db.event.findUnique({ where: { id: eventId }, select: { id: true } })) throw new AppError(404, 'EVENT', 'Новость не найдена.');
  if (value === null) return db.eventFeedback.deleteMany({ where: { userId, eventId } });
  return db.eventFeedback.upsert({ where: { userId_eventId: { userId, eventId } },
    create: { userId, eventId, value }, update: { value } });
}
export async function markNotificationsRead(userId: string, input: unknown) {
  const { eventId } = z.object({ eventId: z.string().min(1).max(100).optional() }).strict().parse(input);
  return db.userNotification.updateMany({ where: { userId, readAt: null, ...(eventId ? { eventId } : {}) }, data: { readAt: new Date() } });
}

function personalProfile(profile: unknown) {
  const parsed = locationSchema.parse({ ...z.record(z.string(), z.unknown()).parse(profile), eventRadiusMeters: EVENT_RADIUS_METERS });
  if (parsed.businessContext) {
    try { validateBusinessContext(parsed.businessContext, parsed.businessDescription ?? ''); }
    catch { return { ...parsed, businessContext: undefined, businessContextError: 'Сохранённый разбор не подтверждён описанием бизнеса; повторите разбор.' }; }
  }
  return parsed;
}
function storedSourceUrl(value?: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export async function getProductState(user: User | null): Promise<ProductState> {
  if (process.env.RADAR_DEMO_MODE !== 'true') return getLiveProductState(user, user ? publicProfile(user) : null);
  const [network, events, ownLocations, feedback] = await Promise.all([
    db.company.findUnique({ where: { id: 'demo-company' } }),
    db.event.findMany({ include: { messages: { include: { versions: { orderBy: { version: 'desc' } } }, orderBy: { receivedAt: 'desc' } } }, orderBy: { updatedAt: 'desc' } }),
    user ? db.userLocation.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } }) : Promise.resolve([]),
    user ? db.eventFeedback.findMany({ where: { userId: user.id }, include: { event: { select: { category: true } } } }) : Promise.resolve([]),
  ]);
  const now = network?.demoClock !== false ? new Date(demoNow) : new Date();
  // Only explicit dropdown choices map to a matching industry. They never infer
  // water, platforms, suppliers, schedules or processes from an industry name.
  const industries: Partial<Record<string, Industry>> = { 'Кофейня': 'foodservice', 'Пекарня': 'foodservice', 'Ресторан': 'foodservice', 'Магазин': 'retail' };
  const industry = user ? industries[normalizeBusinessType(user.businessType)] : undefined;
  const locations: ProductLocation[] = user
    ? ownLocations.map(location => {
      const profile = personalProfile(location.profile);
      const context = profile.businessContext;
      return { ...profile, ...(industry && !context?.industry && !profile.businessContextError ? {
        businessContext: { ...context, industry, evidence: [...(context?.evidence ?? []), { field: 'industry', quote: user.businessType }] },
      } : {}), id: location.id, isDemo: false };
    })
    : demoLocations.map((location, index) => ({ ...location, eventRadiusMeters: EVENT_RADIUS_METERS, id: `demo-${index + 1}`, isDemo: true }));
  const votes = new Map(feedback.map(item => [item.eventId, item.value]));
  const categoryPreferences = new Map<string, number>();
  for (const item of feedback) categoryPreferences.set(item.event.category, (categoryPreferences.get(item.event.category) ?? 0) + item.value);
  const sourceIds = [...new Set(events.flatMap(event => {
    const parsed = extractionSchema.safeParse(event.extracted);
    return parsed.success && parsed.data.provenance ? [parsed.data.provenance.sourceMessageId] : [];
  }))];
  // Split events share the exact source owned by the original publication.
  const inheritedSources = sourceIds.length ? await db.sourceMessage.findMany({ where: { id: { in: sourceIds } }, include: { versions: { orderBy: { version: 'desc' } } } }) : [];
  const notificationWindowDays = 30;
  const receiptClock = Date.now();
  const recentSince = receiptClock - notificationWindowDays * 86_400_000;
  const ranked = events.map(event => {
    const parsed = extractionSchema.safeParse(event.extracted);
    const extraction = parsed.success ? parsed.data : null;
    const provenance = extraction?.provenance;
    const source = provenance ? inheritedSources.find(item => item.id === provenance.sourceMessageId) : event.messages[0];
    const staleSource = Boolean(provenance && (source?.eventId !== provenance.sourceEventId || source?.versions[0]?.version !== provenance.sourceVersion));
    const unavailableReason = event.status === 'superseded' ? 'Это выделенное событие отсутствует в последнем разборе. История сохранена; прежнее влияние больше не назначено.'
      : staleSource ? 'Исходная публикация обновлена. Для этого выделенного события нужен повторный разбор; прежнее влияние больше не назначено.' : undefined;
    const sourceText = source?.versions[0]?.text ?? '';
    const normalized = normalizeWhitespace(sourceText);
    const evidence = extraction?.evidence.filter(item => normalized.includes(normalizeWhitespace(item.quote))) ?? [];
    const sourceCoordinate = (field: 'latitude' | 'longitude') => extraction?.[field] !== null && extraction?.[field] !== undefined &&
      evidence.some(item => item.field === field && [...item.quote.matchAll(/[+-]?\d+(?:[.,]\d+)?/g)]
        .some(match => Number(match[0].replace(',', '.')) === extraction[field]));
    const coordinatesKnown = sourceCoordinate('latitude') && sourceCoordinate('longitude');
    const impact = assessProductImpact(locations, !unavailableReason && extraction ? { ...extraction, evidence,
      ...(!coordinatesKnown ? { latitude: null, longitude: null } : {}) } : null, now,
      { source: { text: sourceText, publisher: source?.publisher ?? 'Источник не указан', publishedAt: source?.publishedAt?.toISOString() ?? null,
        timezone: source?.timezone ?? null, sourceUrl: storedSourceUrl(source?.url) },
        isDemo: event.isDemo && source?.isDemo === true && source.origin === 'demo', unavailableReason });
    const { evaluations } = impact;
    const matching = evaluations.filter(item => item.result.status === 'relevant');
    const uncertain = evaluations.filter(item => item.result.status === 'needs_review');
    const active = matching.length ? matching : uncertain;
    const priority = active.some(item => item.result.priority === 'urgent') ? 'urgent' : active.some(item => item.result.priority === 'upcoming') ? 'upcoming' : 'routine';
    const relevance = unavailableReason ?? (!locations.length ? 'Добавьте свою точку, чтобы проверить влияние.' : !extraction ? 'Источник ещё не разобран: влияние требует проверки.'
      : matching.length ? `Касается точек: ${matching.map(item => item.location.name).join(', ')}.`
      : uncertain.length ? `Нужна проверка для точек: ${uncertain.map(item => item.location.name).join(', ')}.`
      : evaluations.length && evaluations.every(item => item.result.status === 'inactive') ? 'Событие отменено или завершилось.' : 'Совпадение с условиями ваших точек не найдено.');
    const vote = votes.get(event.id);
    const sourceUrl = storedSourceUrl(source?.url);
    const item: ProductEvent = {
      id: event.id, title: event.title, category: event.category, status: event.status, version: event.version, isDemo: event.isDemo,
      startsAt: extraction?.startsAt ?? null, endsAt: extraction?.endsAt ?? null,
      latitude: coordinatesKnown ? extraction!.latitude : null, longitude: coordinatesKnown ? extraction!.longitude : null,
      place: extraction?.address ?? ([extraction?.city, extraction?.street].filter(Boolean).join(', ') || 'Место не определено'),
      summary: extraction?.summary ?? 'Исходное сообщение ожидает разбора.', sourceName: source?.publisher ?? 'Источник не указан',
      sourceUrl, sourceHref: !event.isDemo && !source?.isDemo && source?.origin !== 'demo' && sourceUrl ? sourceUrl : `/sources/${event.id}`,
      sourcePublishedAt: source?.publishedAt?.toISOString() ?? null, sourceReceivedAt: source?.receivedAt?.toISOString() ?? null, sourceText,
      sourceVersions: source?.versions.map((version, index) => {
        const metadata = z.object({ publisher: z.string().optional(), publishedAt: z.iso.datetime({ offset: true }).nullable().optional() }).safeParse(version.metadata);
        return { version: version.version, text: version.text, savedAt: version.createdAt.toISOString(),
          publisher: metadata.success && metadata.data.publisher !== undefined ? metadata.data.publisher : index === 0 ? source.publisher : 'Издатель в этой версии не сохранён',
          publishedAt: metadata.success && metadata.data.publishedAt !== undefined ? metadata.data.publishedAt : index === 0 ? source.publishedAt?.toISOString() ?? null : null };
      }) ?? [],
      quotes: [...new Set(evidence.map(item => item.quote))], impact: impact.impact,
      impactKind: impact.impactKind, impactExplanation: impact.impactExplanation, affectedLocationNames: impact.affectedLocationNames,
      relevance, feedback: vote === 1 || vote === -1 ? vote : null, updatedAt: event.updatedAt.toISOString(),
      relevantLocationIds: matching.map(item => item.location.id), priority,
      recommendedAction: impact.recommendedAction, priorityReason: impact.priorityReason, impactStatus: impact.impactStatus,
    };
    const categoryScore = Math.max(-100, Math.min(100, (categoryPreferences.get(event.category) ?? 0) * 20));
    const score = (vote ?? 0) * 1000 + categoryScore + (matching.length ? 500 : uncertain.length ? 100 : locations.length ? -100 : 0) + (priority === 'urgent' ? 50 : priority === 'upcoming' ? 25 : 0);
    const lastReceipt = Math.max(event.updatedAt.getTime(), source?.receivedAt.getTime() ?? 0);
    return { item, score, recent: lastReceipt >= recentSince };
  }).sort((a, b) => b.score - a.score || b.item.updatedAt.localeCompare(a.item.updatedAt) || a.item.id.localeCompare(b.item.id));
  const priorityOrder = { urgent: 0, upcoming: 1, routine: 2 };
  const highlightEventIds = ranked.filter(row => row.recent && row.item.impactStatus === 'complete' && row.item.impactKind !== 'neutral')
    .sort((a, b) => priorityOrder[a.item.priority] - priorityOrder[b.item.priority] || b.score - a.score || b.item.updatedAt.localeCompare(a.item.updatedAt))
    .slice(0, 2).map(row => row.item.id);
  const recentEventIds = ranked.filter(row => row.recent).map(row => row.item.id);
  if (user) {
    const candidates = ranked.filter(item => item.recent);
    await db.userNotification.createMany({ data: candidates.map(({ item }) => ({ userId: user.id, eventId: item.id, eventVersion: item.version,
      title: item.title, body: `${item.isDemo ? 'Учебное событие. ' : ''}${item.summary}` })), skipDuplicates: true });
  }
  const notificationWhere = user ? { userId: user.id, eventId: { in: recentEventIds } } : null;
  const history = notificationWhere ? await db.userNotification.findMany({ where: notificationWhere, orderBy: { createdAt: 'desc' } }) : [];
  const latest = new Map(ranked.map(({ item }) => [item.id, item.version]));
  const notifications: ProductNotification[] = user ? history.filter(item => item.eventVersion === latest.get(item.eventId)).map(item => ({
    id: item.id, eventId: item.eventId, title: item.title, body: item.body, createdAt: item.createdAt.toISOString(), readAt: item.readAt?.toISOString() ?? null,
  })) : ranked.filter(row => row.recent).map(({ item }) => ({ id: `guest:${item.id}:${item.version}`, eventId: item.id,
    title: item.title, body: `${item.isDemo ? 'Учебное событие. ' : ''}${item.summary}`, createdAt: item.updatedAt, readAt: null }));
  const unreadCount = notifications.filter(item => item.readAt === null).length;
  return { user: user ? publicProfile(user) : null, events: ranked.map(row => row.item), locations,
    notifications, unreadCount,
    highlightEventIds, notificationWindowDays,
    recommendations: ranked.filter(row => highlightEventIds.includes(row.item.id)).map(({ item }) => ({ id: `demo:${item.id}:${item.version}`, eventId: item.id,
      type: item.impactKind === 'risk' ? 'threat' : 'opportunity', title: item.recommendedAction ?? item.title, action: item.recommendedAction ?? '', reason: item.impactExplanation,
      locationIds: item.relevantLocationIds, locationNames: item.affectedLocationNames, processes: [], startsAt: item.startsAt, endsAt: item.endsAt, sourceUrl: item.sourceHref })),
    sourceHealth: { status: 'disabled', channel: 'newsssss09', message: 'Изолированный учебный режим: Telegram не подменяется этими примерами.', lastAttemptAt: null, lastSuccessAt: null, fetched: 0, changed: 0 },
    analysisHealth: { status: 'ready', message: 'Учебный результат правил без вызова модели.', pending: 0, completed: ranked.length, errors: 0 },
    mode: process.env.AI_MODE?.toUpperCase() === 'LIVE' ? 'LIVE' : 'DEMO', now: now.toISOString() };
}
