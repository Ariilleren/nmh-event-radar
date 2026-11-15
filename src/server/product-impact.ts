import { evaluate, scheduleOverlap, type Evaluation } from '@/domain/evaluate';
import type { Extraction, Hours, LocationInput } from '@/domain/schemas';
import { EVENT_RADIUS_METERS } from '@/lib/product-config';
import { demoImpact, pendingImpact, type ImpactInput, type ImpactResult } from '@/ai/impact';

export type ImpactKind = 'opportunity' | 'risk' | 'neutral';
export type ProductImpact<T extends LocationInput> = {
  impactKind: ImpactKind; impactExplanation: string; affectedLocationNames: string[];
  evaluations: { location: T; result: Evaluation }[];
  impactStatus: ImpactResult['status']; impact: string; recommendedAction: string | null;
  priorityReason: string;
};
const days = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
function period(event: Extraction, timezone: string) {
  if (!event.startsAt || !event.endsAt) return 'период не определён';
  const format = (date: string) => new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: timezone,
  }).format(new Date(date));
  return `${format(event.startsAt)} — ${format(event.endsAt)} (${timezone})`;
}
function overlappingHours(hours: Hours[], event: Extraction, timezone: string) {
  return hours.filter(row => scheduleOverlap(Date.parse(event.startsAt!), Date.parse(event.endsAt!), [row], timezone) === 'match')
    .map(row => `${row.days.map(day => days[day - 1]).join(', ')} ${row.start}–${row.end}`).join('; ');
}

/** Product policy always uses the same radius, including old profiles with a custom value. */
export function assessProductImpact<T extends LocationInput>(locations: T[], event: Extraction | null, now: Date | string,
  options?: { source: ImpactInput['source']; isDemo: boolean; unavailableReason?: string }): ProductImpact<T> {
  const evaluations = event ? locations.map(location => ({ location, result: evaluate({ ...location, eventRadiusMeters: EVENT_RADIUS_METERS }, event, now) })) : [];
  const source = options?.source ?? { text: event?.evidence.map(item => item.quote).join('\n') ?? '', publisher: 'Учебный пример', publishedAt: null, timezone: event?.timezone ?? null, sourceUrl: null };
  const impacts = event ? evaluations.map(({ location, result }) => ({ location, result,
    impact: (options?.isDemo === false ? pendingImpact : demoImpact)({ source, extraction: event, location, evaluation: result }) })) : [];
  const ordered = [...impacts].sort((a, b) => ({ urgent: 0, upcoming: 1, routine: 2 }[a.result.priority] - { urgent: 0, upcoming: 1, routine: 2 }[b.result.priority]));
  const neutral = (impactExplanation: string): ProductImpact<T> => ({ impactKind: 'neutral', impactExplanation,
    impact: impactExplanation, affectedLocationNames: [], evaluations,
    impactStatus: impacts.length && impacts.every(item => item.impact.status === 'irrelevant') ? 'irrelevant' : 'needs_clarification',
    recommendedAction: options?.unavailableReason ? 'Повторно разберите актуальную версию источника и проверьте сведения.'
      : ordered.find(item => item.result.status === 'needs_review' || item.result.status === 'relevant')?.result.actions?.[0] ?? null,
    priorityReason: ordered[0]?.result.priorityReason ?? 'Для определения важности нужны сведения о точке и событии.' });
  if (options?.unavailableReason) return neutral(options.unavailableReason);
  if (!event) return neutral('Сообщение ещё не разобрано. Сначала нужно установить место, время и условия события.');
  if (event.status === 'cancelled' || event.status === 'completed') return neutral('В источнике указана отмена или завершение. Текущее влияние не назначено; прежние действия нужно проверить отдельно.');
  if (event.endsAt && Date.parse(event.endsAt) <= new Date(now).getTime()) return neutral(`Период события закончился: ${period(event, event.timezone ?? 'UTC')}. Это сообщение не является текущим риском или возможностью.`);
  if (!locations.length) return neutral('Добавьте свою точку и её рабочие процессы: без адреса, часов работы и условий доставки личное влияние неизвестно.');
  const matches = ordered.filter(item => item.impact.status === 'complete' && item.impact.signal);
  if (!matches.length) {
    const unknown = evaluations.filter(item => item.result.status === 'needs_review');
    const rows = (unknown.length ? unknown : evaluations).slice(0, 3);
    const reasons = rows.map(({ location, result }) => {
      const conditions = result.conditions.filter(item => item.result === (unknown.length ? 'unknown' : 'mismatch'));
      return `«${location.name}»: ${conditions.map(item => `${item.label.toLowerCase()} — ${item.reason}`).join(' ') || result.nextAction}`;
    }).join(' ');
    const pending = ordered.find(item => item.result.status === 'relevant');
    return neutral(`${pending ? `${pending.result.reason} ${pending.impact.question ?? ''}` : unknown.length ? 'Нужна проверка неизвестных условий.' : 'Условия ваших точек не совпали с сообщением.'} ${reasons} Это не подтверждение отсутствия других рисков.`);
  }
  const affectedLocationNames = matches.map(item => item.location.name);
  const explanations = matches.map(({ location, result, impact }) => {
    const when = period(event, location.timezone);
    if (location.businessContext || event.categories || !['mass_event', 'road_closure', 'water_outage'].includes(event.category)) {
      return `«${location.name}»: ${result.reason} Период: ${when}. ${impact.possibleImpact}`;
    }
    if (event.category === 'mass_event') {
      return `«${location.name}»: площадка примерно в ${Math.round(result.distanceMeters!)} м, внутри общего радиуса ${EVENT_RADIUS_METERS} м; событие ${when} пересекается с часами работы ${overlappingHours(location.openingHours, event, location.timezone)}.`;
    }
    if (event.category === 'road_closure') {
      return `«${location.name}»: ${event.street} входит в указанный маршрут доставки; ограничение автомобилей ${when} пересекается с окнами доставки ${overlappingHours(location.deliveryWindows, event, location.timezone)}.`;
    }
    return `«${location.name}»: совпал точный адрес ${location.address}; отключение ${when} пересекается с часами работы ${overlappingHours(location.openingHours, event, location.timezone)}. ${location.waterDependency === 'essential' ? 'Вода нужна для основных операций.' : 'Указана ограниченная зависимость рабочих процессов от воды.'}`;
  });
  const opportunity = matches[0].impact.signal!.type === 'opportunity';
  const hypothesis = opportunity && event.category === 'mass_event'
    ? 'Возможен дополнительный спрос, но это гипотеза: посещаемость и выручка не гарантированы. Проверьте сведения и готовность точки.'
    : event.category === 'road_closure'
      ? 'Возможна задержка поставки: это гипотеза, а не установленный сбой. Уточните время и маршрут у поставщика.'
      : event.category === 'water_outage' ? 'Возможны ограничения операций с водой: это гипотеза, а не подтверждённая остановка бизнеса. Проверьте уведомление и резерв воды.'
      : 'Это гипотеза возможного влияния на указанные процессы; фактические последствия требуют проверки.';
  return { impactKind: opportunity ? 'opportunity' : 'risk', impactExplanation: `${explanations.join(' ')} ${hypothesis}`, affectedLocationNames, evaluations,
    impactStatus: 'complete', impact: matches[0].impact.possibleImpact!, recommendedAction: matches[0].impact.signal!.recommendedAction,
    priorityReason: matches[0].result.priorityReason ?? matches[0].result.reason ?? '' };
}
