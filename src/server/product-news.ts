import { z } from 'zod';
import { db } from './db';
import type { User } from '@/generated/prisma/client';
import type { ProductEvent, ProductProfile, ProductRecommendation, ProductState } from '@/lib/product-types';
import { personalAnalysisResultSchema } from '@/ai/personal';
import { getNewsAiStatus } from '@/ai/provider';
import { activeAnalysisCooldown, personalProfileSnapshot, syncEnabled } from './news-pipeline';
import { telegramSource } from './telegram';

function rateLimitMessage(until: Date) {
  const time = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }).format(until);
  const provider = getNewsAiStatus().provider === 'gemini' ? ' Провайдер Gemini.' : '';
  return `Достигнут лимит анализа.${provider} Повторим автоматически после ${time} МСК. Новости сохранены.`;
}

/** Reads exact saved results only: opening the product never starts ingestion or a model request. */
export async function getLiveProductState(user: User | null, profile: ProductProfile | null): Promise<ProductState> {
  const ai = getNewsAiStatus();
  const rateLimitCode = ai.provider ? `${ai.provider.toUpperCase()}_RATE_LIMIT` : null;
  const [sources, points, saved, health, feedback, cooldown] = await Promise.all([
    db.sourceMessage.findMany({ where: { channel: telegramSource.channel }, include: { event: true, versions: { orderBy: { version: 'desc' } } }, orderBy: { receivedAt: 'desc' } }),
    user ? db.userLocation.findMany({ where: { userId: user.id } }) : Promise.resolve([]),
    user ? db.personalNewsAnalysis.findMany({ where: { userId: user.id } }) : Promise.resolve([]),
    db.sourceHealth.findUnique({ where: { channel: telegramSource.channel } }),
    user ? db.eventFeedback.findMany({ where: { userId: user.id } }) : Promise.resolve([]),
    user ? activeAnalysisCooldown(true) : Promise.resolve(null),
  ]);
  const snapshot = user ? personalProfileSnapshot(user, points) : null;
  const locations = snapshot?.locations.map(location => ({ ...location, isDemo: false })) ?? [];
  const now = Date.now(), recentSince = now - 30 * 86_400_000;
  const recommendations: ProductRecommendation[] = [];
  let pending = 0, completed = 0, errors = 0;
  const events: ProductEvent[] = sources.flatMap(source => {
    const version = source.versions[0]; if (!version) return [];
    const cache = snapshot ? saved.find(item => item.messageId === source.id && item.contentHash === version.contentHash && item.profileHash === snapshot.profileHash) : null;
    const parsed = personalAnalysisResultSchema.safeParse(cache?.result);
    const result = parsed.success && cache?.status !== 'error' && cache?.status !== 'processing' ? parsed.data : null;
    const recent = source.receivedAt.getTime() >= recentSince;
    if (user && recent) { if (cache?.status === 'error') errors++; else if (result) completed++; else pending++; }
    const active = result?.recommendations.filter(item => !item.endsAt || Date.parse(item.endsAt) > now) ?? [];
    if (recent && result) for (const [index, item] of active.entries()) recommendations.push({
      ...item, id: `${cache!.id}:${index}`, eventId: source.eventId, sourceUrl: source.url!,
      locationNames: locations.filter(location => item.locationIds.includes(location.id)).map(location => location.name),
    });
    const extraction = result?.extraction;
    const actionTime = Date.parse(extraction?.responseDeadline ?? extraction?.startsAt ?? '');
    const priority = active.length && Number.isFinite(actionTime) && actionTime - now <= 86_400_000 ? 'urgent'
      : active.length && Number.isFinite(actionTime) && actionTime - now <= 3 * 86_400_000 ? 'upcoming' : 'routine';
    const vote = feedback.find(item => item.eventId === source.eventId)?.value;
    const impactStatus = cache?.status === 'error' ? 'error' : active.length ? 'complete' : result?.relevance === 'irrelevant' ? 'irrelevant' : 'needs_clarification';
    return [{
      id: source.eventId, title: extraction?.title ?? source.event.title, category: extraction?.category ?? 'unsupported', status: extraction?.status ?? 'pending', version: source.event.version, isDemo: false,
      startsAt: extraction?.startsAt ?? null, endsAt: extraction?.endsAt ?? null, latitude: extraction?.latitude ?? null, longitude: extraction?.longitude ?? null,
      place: extraction?.address ?? ([extraction?.city, extraction?.street].filter(Boolean).join(', ') || 'Место не определено'),
      summary: extraction?.summary ?? 'Публикация получена. Персональный анализ ещё не завершён.',
      sourceName: source.publisher, sourceUrl: source.url, sourceHref: source.url!, sourcePublishedAt: source.publishedAt?.toISOString() ?? null,
      sourceReceivedAt: source.receivedAt.toISOString(), sourceText: version.text, quotes: result?.quotes ?? [],
      sourceVersions: source.versions.map((row, index) => {
        const metadata = z.object({ publisher: z.string().optional(), publishedAt: z.iso.datetime({ offset: true }).nullable().optional() }).safeParse(row.metadata);
        return { version: row.version, text: row.text, savedAt: row.createdAt.toISOString(),
          publisher: metadata.success && metadata.data.publisher !== undefined ? metadata.data.publisher : index === 0 ? source.publisher : 'Издатель в этой версии не сохранён',
          publishedAt: metadata.success && metadata.data.publishedAt !== undefined ? metadata.data.publishedAt : index === 0 ? source.publishedAt?.toISOString() ?? null : null };
      }),
      impact: result?.possibleImpact ?? 'Влияние пока не установлено.', relevance: result?.relevanceExplanation ?? (user ? 'Анализ ожидает обработки.' : 'Войдите, чтобы получить анализ для своего бизнеса.'),
      feedback: vote === 1 || vote === -1 ? vote : null, updatedAt: source.event.updatedAt.toISOString(),
      impactKind: active[0]?.type === 'threat' ? 'risk' : active[0]?.type === 'opportunity' ? 'opportunity' : 'neutral',
      impactExplanation: cache?.status === 'error' ? cache.errorCode === rateLimitCode && cache.retryAt && cache.retryAt.getTime() > now
        ? rateLimitMessage(cache.retryAt) : cache.errorMessage ?? 'Не удалось завершить анализ. Новость сохранена.' : result ? [
        result.quotes[0] ? `В сообщении: «${result.quotes[0]}».` : '',
        `Связь с бизнесом: ${result.relevanceExplanation}`,
        result.possibleImpact ? `Возможное влияние: ${result.possibleImpact}` : '',
        result.assumptions.length ? `Условия: ${result.assumptions.join(' ')}` : '', result.question ?? '',
      ].filter(Boolean).join(' ') : 'Готовой оценки пока нет.',
      affectedLocationNames: locations.filter(location => result?.affectedLocationIds.includes(location.id)).map(location => location.name),
      relevantLocationIds: result?.affectedLocationIds ?? [], priority, recommendedAction: active[0]?.action ?? null,
      priorityReason: active.length ? 'Приоритет рассчитан по подтверждённому периоду и сроку реакции.' : 'Обоснованной активной рекомендации пока нет.', impactStatus,
    } satisfies ProductEvent];
  });
  const rank = { urgent: 0, upcoming: 1, routine: 2 };
  recommendations.sort((a, b) => rank[events.find(item => item.id === a.eventId)!.priority] - rank[events.find(item => item.id === b.eventId)!.priority]
    || (a.type === 'threat' ? 0 : 1) - (b.type === 'threat' ? 0 : 1)
    || (events.find(item => item.id === b.eventId)!.feedback ?? 0) - (events.find(item => item.id === a.eventId)!.feedback ?? 0));
  const recent = events.filter(event => Date.parse(event.sourceReceivedAt!) >= recentSince);
  if (user) await db.userNotification.createMany({ data: recent.map(event => ({ userId: user.id, eventId: event.id, eventVersion: event.version, title: event.title, body: event.summary })), skipDuplicates: true });
  const storedNotifications = user ? await db.userNotification.findMany({ where: { userId: user.id, eventId: { in: recent.map(item => item.id) } }, orderBy: { createdAt: 'desc' } }) : [];
  const notifications = user ? storedNotifications.filter(item => recent.some(event => event.id === item.eventId && event.version === item.eventVersion)).map(item => {
    const current = recent.find(event => event.id === item.eventId)!;
    return { id: item.id, eventId: item.eventId, title: current.title, body: current.summary, createdAt: item.createdAt.toISOString(), readAt: item.readAt?.toISOString() ?? null };
  }) : recent.map(event => ({ id: `guest:${event.id}:${event.version}`, eventId: event.id, title: event.title, body: event.summary, createdAt: event.sourceReceivedAt!, readAt: null }));
  const sourceStatus = !syncEnabled() ? 'disabled' : health?.status === 'ok' ? 'ok' : health?.status === 'error' ? 'error' : 'pending';
  const analysisStatus = !user ? 'sign_in' : !ai.configured ? 'missing_config' : cooldown || errors ? 'error' : pending ? 'pending' : 'ready';
  return { user: profile, events, locations, notifications, unreadCount: notifications.filter(item => !item.readAt).length, mode: 'LIVE', now: new Date(now).toISOString(),
    recommendations, highlightEventIds: [...new Set(recommendations.map(item => item.eventId))].slice(0, 2), notificationWindowDays: 30,
    sourceHealth: { status: sourceStatus, channel: telegramSource.channel, message: sourceStatus === 'disabled' ? 'Получение источника отключено на сервере.' : sourceStatus === 'error' ? health?.errorMessage ?? 'Источник недоступен.'
      : sourceStatus === 'ok' ? health?.changed ? 'Новые публикации сохранены.' : 'Проверка выполнена; новых изменений нет.' : 'Ожидается первая проверка Telegram.',
      lastAttemptAt: health?.lastAttemptAt?.toISOString() ?? null, lastSuccessAt: health?.lastSuccessAt?.toISOString() ?? null, fetched: health?.fetched ?? 0, changed: health?.changed ?? 0 },
    analysisHealth: { status: analysisStatus, pending, completed, errors, message: analysisStatus === 'sign_in' ? 'Войдите, чтобы получить рекомендации для своего бизнеса.'
      : analysisStatus === 'missing_config' ? 'Анализ пока недоступен. Новости продолжают сохраняться.'
      : analysisStatus === 'error' ? cooldown?.retryAt ? rateLimitMessage(cooldown.retryAt) : 'Часть новостей не удалось проанализировать. Готовые результаты сохранены.'
      : analysisStatus === 'pending' ? 'Персональный анализ выполняется в фоне.' : 'Сохранённые результаты актуальны для профиля.' },
  };
}
