import type { Extraction, LocationInput } from '../domain/schemas';

/** Entire dataset is fictional. Coordinates are teaching inputs, not geocoded addresses. */
export const demoNow = '2026-11-14T06:00:00.000Z';
export const demoTimezone = 'Europe/Moscow';
const everyDay = [1, 2, 3, 4, 5, 6, 7];
export const demoLocations: LocationInput[] = [
  {
    locationId: 'DEMO-001', name: 'У Арены', address: 'Москва, Учебная улица, дом 10', city: 'Москва',
    latitude: 55.755, longitude: 37.62, timezone: demoTimezone,
    openingHours: [{ days: everyDay, start: '08:00', end: '23:00' }],
    deliveryWindows: [{ days: everyDay, start: '10:00', end: '11:00' }],
    deliveryRouteStreets: ['Учебная улица'], eventRadiusMeters: 1000, waterDependency: 'essential', responsibleName: 'Анна · демо',
  },
  {
    locationId: 'DEMO-002', name: 'Пекарня на углу', address: 'Москва, Пекарский проезд, дом 7, корпус 2', city: 'Москва',
    latitude: 55.76, longitude: 37.64, timezone: demoTimezone,
    openingHours: [{ days: everyDay, start: '07:00', end: '20:00' }],
    deliveryWindows: [{ days: everyDay, start: '10:00', end: '11:00' }],
    deliveryRouteStreets: ['Учебная улица', 'Пекарский проезд'], eventRadiusMeters: 700, waterDependency: 'essential', responsibleName: 'Михаил · демо',
  },
  {
    locationId: 'DEMO-003', name: 'Ранний кофе', address: 'Москва, Тихая учебная улица, дом 3', city: 'Москва',
    latitude: 55.74, longitude: 37.6, timezone: demoTimezone,
    openingHours: [{ days: everyDay, start: '06:00', end: '14:00' }],
    deliveryWindows: [{ days: everyDay, start: '07:00', end: '08:00' }],
    deliveryRouteStreets: ['Учебная улица'], eventRadiusMeters: 500, waterDependency: 'essential', responsibleName: 'Анна · демо',
  },
];

export type DemoMessage = {
  key: string;
  text: string;
  publisher: string;
  url: null;
  publishedAt: string;
  timezone: string;
  origin: 'demo';
  extraction: Extraction;
  duplicateOf?: string;
  replacesKey?: string;
};
type Fields = Partial<Extraction> & Pick<Extraction, 'title' | 'category' | 'startsAt' | 'endsAt'>;
function message(key: string, text: string, fields: Fields, citations: Record<string, string> = {}): DemoMessage {
  const impact = fields.category === 'mass_event' ? 'Возможна дополнительная нагрузка на вечернюю смену. Поток посетителей и продажи неизвестны.'
    : fields.category === 'road_closure' ? 'Может потребоваться изменение маршрута или времени доставки. Ограничение автомобилей не доказывает снижение пешеходного спроса.'
    : fields.category === 'water_outage' ? 'Возможны ограничения водозависимых операций. Решение о режиме работы принимает сотрудник.'
    : 'Для этой категории правила применимости в MVP не реализованы.';
  const action = fields.category === 'mass_event' ? 'Проверить вечернюю смену и запас; подтвердить условия у ответственного.'
    : fields.category === 'road_closure' ? 'Согласовать перенос доставки или объезд с поставщиком.'
    : fields.category === 'water_outage' ? 'Уточнить резерв воды и согласовать план работы точки.'
    : 'Проверить сообщение самостоятельно: категория не поддерживается.';
  const extraction: Extraction = {
    summary: text.split('\n')[0], status: 'scheduled', timezone: demoTimezone, city: 'Москва',
    street: null, address: null, latitude: null, longitude: null, vehicleRestriction: null,
    impactHypothesis: impact, recommendedAction: action, evidence: [], ...fields,
  };
  const evidentialFields = ['category', 'status', 'startsAt', 'endsAt', 'city', 'street', 'address', 'latitude', 'longitude', 'vehicleRestriction'] as const;
  extraction.evidence = evidentialFields.filter((field) => extraction[field] !== null)
    .map((field) => ({ field, quote: citations[field] ?? text }));
  return { key, text, publisher: 'Учебный диспетчер сети · вымышленный источник', url: null,
    publishedAt: '2026-11-14T08:00:00+03:00', timezone: demoTimezone, origin: 'demo', extraction };
}

const concert = message('concert-arena',
  'Учебное сообщение: концерт у Арены в Москве.\n15 ноября 2026, 19:00–22:30, время Europe/Moscow. Учебные координаты площадки: 55.760850, 37.620000. Концерт запланирован. Число посетителей неизвестно.',
  { category: 'mass_event', title: 'Концерт у Арены', startsAt: '2026-11-15T19:00:00+03:00', endsAt: '2026-11-15T22:30:00+03:00', latitude: 55.76085, longitude: 37.62 },
  { category: 'концерт у Арены', status: 'Концерт запланирован.', city: 'в Москве', startsAt: '15 ноября 2026, 19:00–22:30', endsAt: '15 ноября 2026, 19:00–22:30', latitude: '55.760850', longitude: '37.620000' });

const road = message('road-delivery',
  'Учебное сообщение: Москва, Учебная улица.\n16 ноября 2026, 09:00–13:00 (Europe/Moscow) запланировано перекрытие движения автомобилей на всей Учебной улице. Пешеходный проход сохраняется.',
  { category: 'road_closure', title: 'Перекрытие на маршруте доставки', startsAt: '2026-11-16T09:00:00+03:00', endsAt: '2026-11-16T13:00:00+03:00', street: 'Учебная улица', vehicleRestriction: true },
  { city: 'Москва', street: 'Учебная улица', category: 'перекрытие движения автомобилей', status: 'запланировано перекрытие', startsAt: '16 ноября 2026, 09:00–13:00', endsAt: '16 ноября 2026, 09:00–13:00', vehicleRestriction: 'перекрытие движения автомобилей' });

const water = message('water-bakery',
  'Учебное сообщение: плановое отключение воды.\nАдрес: Москва, Пекарский проезд, дом 7, корпус 2. Вода будет отключена 16 ноября 2026, 08:00–12:00 (Europe/Moscow). Это вымышленное уведомление для демонстрации.',
  { category: 'water_outage', title: 'Плановое отключение воды у пекарни', startsAt: '2026-11-16T08:00:00+03:00', endsAt: '2026-11-16T12:00:00+03:00', address: 'Москва, Пекарский проезд, дом 7, корпус 2' },
  { category: 'плановое отключение воды', status: 'Вода будет отключена', city: 'Москва', address: 'Москва, Пекарский проезд, дом 7, корпус 2', startsAt: '16 ноября 2026, 08:00–12:00', endsAt: '16 ноября 2026, 08:00–12:00' });

const relocated = message('festival-original',
  'Учебное сообщение: ярмарка в Москве запланирована на 18 ноября 2026, 16:00–20:00 (Europe/Moscow). Место и координаты будут опубликованы отдельно.',
  { category: 'mass_event', title: 'Ярмарка: место уточняется', startsAt: '2026-11-18T16:00:00+03:00', endsAt: '2026-11-18T20:00:00+03:00' });
const relocation = message('festival-moved',
  'Учебное обновление: ярмарка в Москве перенесена с 18 на 19 ноября 2026, 17:00–21:00 (Europe/Moscow). Учебные координаты новой площадки: 55.760850, 37.620000. Прежнее расписание не действует.',
  { category: 'mass_event', title: 'Ярмарка перенесена на 19 ноября', status: 'rescheduled', startsAt: '2026-11-19T17:00:00+03:00', endsAt: '2026-11-19T21:00:00+03:00', latitude: 55.76085, longitude: 37.62 });

/** key is seed identity; replacesKey explicitly identifies a new source version, never a fuzzy AI merge. */
export const demoMessages: DemoMessage[] = [
  concert, road, water,
  { ...concert, key: 'concert-exact-duplicate', duplicateOf: concert.key },
  message('concert-place-unknown',
    'Учебное сообщение: Москва. Концерт запланирован на 17 ноября 2026, 18:00–21:00 (Europe/Moscow). Площадка не объявлена, координаты неизвестны.',
    { category: 'mass_event', title: 'Концерт: площадка неизвестна', startsAt: '2026-11-17T18:00:00+03:00', endsAt: '2026-11-17T21:00:00+03:00' }),
  message('road-street-unknown',
    'Учебное сообщение: Москва. Перекрытие автомобилей запланировано на 16 ноября 2026, 10:00–12:00 (Europe/Moscow). Точный участок и улицу ещё уточняют.',
    { category: 'road_closure', title: 'Перекрытие: участок не указан', startsAt: '2026-11-16T10:00:00+03:00', endsAt: '2026-11-16T12:00:00+03:00', vehicleRestriction: true }),
  message('water-corpus-unknown',
    'Учебное сообщение: плановое отключение воды 16 ноября 2026, 08:00–12:00 (Europe/Moscow). Адрес: Москва, Пекарский проезд, дом 7. Корпус в уведомлении не указан.',
    { category: 'water_outage', title: 'Вода: требуется уточнить корпус', startsAt: '2026-11-16T08:00:00+03:00', endsAt: '2026-11-16T12:00:00+03:00', address: 'Москва, Пекарский проезд, дом 7' }),
  message('concert-past',
    'Учебное сообщение: концерт в Москве был запланирован на 13 ноября 2026, 18:00–21:00 (Europe/Moscow). Учебные координаты площадки: 55.760850, 37.620000.',
    { category: 'mass_event', title: 'Вчерашний концерт', startsAt: '2026-11-13T18:00:00+03:00', endsAt: '2026-11-13T21:00:00+03:00', latitude: 55.76085, longitude: 37.62 }),
  message('road-cancelled',
    'Учебное сообщение: Москва, Учебная улица. Перекрытие движения автомобилей, ранее запланированное на 17 ноября 2026, 09:00–13:00 (Europe/Moscow), отменено. Ограничение не будет введено.',
    { category: 'road_closure', title: 'Перекрытие 17 ноября отменено', status: 'cancelled', startsAt: '2026-11-17T09:00:00+03:00', endsAt: '2026-11-17T13:00:00+03:00', street: 'Учебная улица', vehicleRestriction: true }),
  message('water-neighbor',
    'Учебное сообщение: плановое отключение воды 16 ноября 2026, 08:00–12:00 (Europe/Moscow). Адрес: Москва, Пекарский проезд, дом 9. Соседние дома в перечне не указаны.',
    { category: 'water_outage', title: 'Отключение в соседнем доме', startsAt: '2026-11-16T08:00:00+03:00', endsAt: '2026-11-16T12:00:00+03:00', address: 'Москва, Пекарский проезд, дом 9' }),
  message('concert-midnight',
    'Учебное сообщение: Москва. Ночное мероприятие запланировано с 14 ноября 2026, 22:30 до 15 ноября 2026, 02:00 (Europe/Moscow). Учебные координаты площадки: 55.760850, 37.620000.',
    { category: 'mass_event', title: 'Ночное мероприятие через полночь', startsAt: '2026-11-14T22:30:00+03:00', endsAt: '2026-11-15T02:00:00+03:00', latitude: 55.76085, longitude: 37.62 }),
  relocated,
  { ...relocation, replacesKey: relocated.key, publishedAt: '2026-11-14T08:30:00+03:00' },
  message('unsupported-power',
    'Учебное сообщение: Москва. Плановое отключение электричества 16 ноября 2026, 09:00–10:00 (Europe/Moscow). Эта категория не поддерживается в MVP.',
    { category: 'unsupported', title: 'Электричество: категория не поддерживается', startsAt: '2026-11-16T09:00:00+03:00', endsAt: '2026-11-16T10:00:00+03:00' }),
];

/** Explicit assertions for demo wiring; these are not passed to LIVE. */
export const demoExpected = [
  { messageKey: 'concert-arena', locationId: 'DEMO-001', status: 'relevant', distanceMetersRange: [640, 660] },
  { messageKey: 'road-delivery', locationId: 'DEMO-001', status: 'relevant' },
  { messageKey: 'road-delivery', locationId: 'DEMO-003', status: 'excluded' },
  { messageKey: 'water-bakery', locationId: 'DEMO-002', status: 'relevant' },
  { messageKey: 'water-corpus-unknown', locationId: 'DEMO-002', status: 'needs_review' },
  { messageKey: 'water-neighbor', locationId: 'DEMO-002', status: 'excluded' },
  { messageKey: 'concert-place-unknown', locationId: 'DEMO-001', status: 'needs_review' },
  { messageKey: 'concert-past', locationId: 'DEMO-001', status: 'inactive' },
  { messageKey: 'road-cancelled', locationId: 'DEMO-001', status: 'inactive' },
] as const;
