import type { Extraction, Hours, LocationInput } from './schemas';

export type Condition = { key: string; label: string; result: 'match' | 'mismatch' | 'unknown'; reason: string; quote?: string };
export type Evaluation = {
  status: 'relevant' | 'needs_review' | 'excluded' | 'inactive';
  priority: 'urgent' | 'upcoming' | 'routine';
  conditions: Condition[];
  nextAction: string;
  distanceMeters?: number;
};

const dayMs = 86_400_000;
const normalize = (text: string) => text.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
const street = (text: string) => normalize(text).replace(/(^|\s)ул(?=\s|$)/g, '$1улица');

export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const radians = (n: number) => n * Math.PI / 180;
  const dLat = radians(lat2 - lat1), dLon = radians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

export function intervalsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function localParts(timestamp: number, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  const read = (key: string) => Number(parts.find((part) => part.type === key)?.value);
  return { year: read('year'), month: read('month'), day: read('day'), hour: read('hour'), minute: read('minute') };
}

/** Return no instant for a nonexistent or ambiguous local clock value (DST). */
function localInstant(date: Date, time: string, timezone: string): number | null {
  const [hour, minute] = time.split(':').map(Number);
  const wall = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute);
  const candidates = new Set<number>();
  for (const shift of [-dayMs, 0, dayMs]) {
    const sample = wall + shift;
    const local = localParts(sample, timezone);
    const offset = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) - sample;
    const candidate = wall - offset;
    const check = localParts(candidate, timezone);
    if (check.year === date.getUTCFullYear() && check.month === date.getUTCMonth() + 1 &&
      check.day === date.getUTCDate() && check.hour === hour && check.minute === minute) candidates.add(candidate);
  }
  return candidates.size === 1 ? [...candidates][0] : null;
}

export function scheduleOverlap(start: number, end: number, hours: Hours[], timezone: string): 'match' | 'mismatch' | 'unknown' {
  if (!hours.length || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 'unknown';
  const first = localParts(start, timezone);
  // The preceding day includes an overnight shift. Nine following days cover a complete recurring week.
  const anchor = Date.UTC(first.year, first.month - 1, first.day);
  let ambiguous = false;
  for (let day = -1; day <= 9 && anchor + day * dayMs <= end + dayMs; day++) {
    const date = new Date(anchor + day * dayMs);
    const weekday = date.getUTCDay() || 7;
    for (const slot of hours) {
      if (!slot.days.includes(weekday)) continue;
      const finishDate = new Date(date.getTime() + (slot.end <= slot.start ? dayMs : 0));
      const opens = localInstant(date, slot.start, timezone);
      const closes = localInstant(finishDate, slot.end, timezone);
      if (opens === null || closes === null) { ambiguous = true; continue; }
      if (intervalsOverlap(start, end, opens, closes)) return 'match';
    }
  }
  return ambiguous ? 'unknown' : 'mismatch';
}

function canonicalAddress(text: string): string {
  return normalize(text).replace(/(^|\s)г(?=\s|$)/g, '$1').replace(/(^|\s)ул(?=\s|$)/g, '$1улица')
    .replace(/(^|\s)д(?=\s|$)/g, '$1дом').replace(/(^|\s)(?:корп|к)(?=\s|$)/g, '$1корпус')
    .replace(/(^|\s)стр(?=\s|$)/g, '$1строение').replace(/\s+/g, ' ').trim();
}

export function compareAddress(known: string, target: string | null, city?: string | null): 'match' | 'mismatch' | 'unknown' {
  if (!target) return 'unknown';
  const a = canonicalAddress(known), b = canonicalAddress(target);
  // A street-only phrase is never an exact address, even when both inputs repeat it.
  if (!/дом\s*\d/.test(a) || !/дом\s*\d/.test(b)) return 'unknown';
  const cityPrefix = city ? canonicalAddress(city) : '';
  const streetPart = (address: string) => address.split(/дом\s*\d/)[0].replace(cityPrefix, '').trim();
  if (!streetPart(a) || !streetPart(b)) return 'unknown';
  const explicitUnit = /(?:корпус|строение)\s*(?:\d+[а-я]?|[а-я])(?:\s|$)/;
  const unit = /\s+(?:корпус|строение)\s*/;
  if ((unit.test(a) && !explicitUnit.test(a)) || (unit.test(b) && !explicitUnit.test(b))) return 'unknown';
  if (a === b) return 'match';
  const aBase = a.split(unit)[0], bBase = b.split(unit)[0];
  if (aBase === bBase && (unit.test(a) !== unit.test(b))) return 'unknown';
  return 'mismatch';
}

export function evaluate(location: LocationInput, event: Extraction, now: Date | string = new Date()): Evaluation {
  const conditions: Condition[] = [];
  const quote = (field: string) => event.evidence.find((item) => item.field === field)?.quote;
  const has = (field: keyof Extraction) => event[field] !== null && Boolean(quote(field));
  const add = (key: string, label: string, result: Condition['result'], reason: string, field?: string) => {
    conditions.push({ key, label, result, reason, ...(field && quote(field) ? { quote: quote(field) } : {}) });
  };
  if (event.category === 'unsupported') {
    add('category', 'Поддерживаемая категория', 'unknown', 'В MVP поддерживаются мероприятия, перекрытия и плановые отключения воды.', 'category');
    return { status: 'needs_review', priority: 'routine', conditions, nextAction: 'Категория не поддерживается. Проверьте сообщение самостоятельно.' };
  }
  add('category', 'Категория события', has('category') ? 'match' : 'unknown', has('category') ? 'Категория имеет цитату из источника.' : 'Категория не подкреплена цитатой.', 'category');
  if (event.status === 'cancelled' && has('status')) {
    add('status', 'Статус сообщения', 'mismatch', 'Источник сообщил об отмене. Сохранённые задачи и решения требуют отдельной проверки.', 'status');
    return { status: 'inactive', priority: 'routine', conditions, nextAction: 'Проверьте отмену и ранее назначенные задачи; они не закрываются автоматически.' };
  }
  add('status', 'Статус источника', has('status') ? 'match' : 'unknown', has('status') ? 'Статус указан в сообщении; это не независимая проверка факта.' : 'Для статуса события нет подтверждающей цитаты.', 'status');
  const start = event.startsAt ? Date.parse(event.startsAt) : NaN;
  const end = event.endsAt ? Date.parse(event.endsAt) : NaN;
  const timeKnown = has('startsAt') && has('endsAt') && Boolean(event.timezone) && end > start;
  const nowTime = new Date(now).getTime();
  if (timeKnown && end <= nowTime) {
    add('time', 'Период события', 'mismatch', 'Период события закончился. Это сообщение не является текущим.', 'endsAt');
    return { status: 'inactive', priority: 'routine', conditions, nextAction: 'При необходимости сохраните итог по ранее назначенным задачам.' };
  }
  add('time', 'Известный период', timeKnown ? 'match' : 'unknown', timeKnown ? 'Начало и конец известны с часовым поясом; конец интервала не включается.' : 'Нужны начало, конец, часовой пояс и подтверждающие цитаты.', 'startsAt');
  const cityResult = location.city && has('city') ? (normalize(location.city) === normalize(event.city!) ? 'match' : 'mismatch') : 'unknown';
  add('city', 'Город', cityResult, cityResult === 'match' ? 'Города совпадают.' : cityResult === 'mismatch' ? 'Известные города различаются; одноимённые улицы не объединяются.' : 'Город точки или сообщения неизвестен.', 'city');

  let distanceMeters: number | undefined;
  if (event.category === 'mass_event') {
    const coordsKnown = location.latitude !== null && location.longitude !== null && has('latitude') && has('longitude') && location.eventRadiusMeters !== null;
    if (coordsKnown) {
      distanceMeters = haversineMeters(location.latitude!, location.longitude!, event.latitude!, event.longitude!);
      add('distance', 'Радиус точки', distanceMeters <= location.eventRadiusMeters! ? 'match' : 'mismatch',
        `По указанным координатам: ${Math.round(distanceMeters)} м, радиус точки: ${location.eventRadiusMeters} м. Геокодирование не выполнялось.`, 'latitude');
    } else add('distance', 'Радиус точки', 'unknown', 'Неизвестны координаты события/точки или радиус; расстояние не предполагается.');
    const hoursResult = timeKnown ? scheduleOverlap(start, end, location.openingHours, location.timezone) : 'unknown';
    add('opening', 'Часы работы', hoursResult, hoursResult === 'match' ? 'Период события пересекается с известными часами работы.' : hoursResult === 'mismatch' ? 'Событие не пересекается с указанными часами работы.' : 'Недостаточно данных для проверки часов работы; неоднозначное местное время требует уточнения.', 'startsAt');
  } else if (event.category === 'road_closure') {
    const routeKnown = location.deliveryRouteStreets.length > 0 && has('street');
    const routeResult = routeKnown ? (location.deliveryRouteStreets.some((item) => street(item) === street(event.street!)) ? 'match' : 'mismatch') : 'unknown';
    add('route', 'Маршрут доставки', routeResult, routeResult === 'match' ? 'Указанная улица есть в известном маршруте доставки.' : routeResult === 'mismatch' ? 'Указанная улица отсутствует в явно заданном маршруте доставки.' : 'Маршрут или улица ограничения неизвестны.', 'street');
    const vehicleResult = has('vehicleRestriction') ? (event.vehicleRestriction ? 'match' : 'mismatch') : 'unknown';
    add('vehicles', 'Ограничение автомобилей', vehicleResult, vehicleResult === 'match' ? 'Источник указывает ограничение автомобилей. Пешеходный спрос из этого не следует.' : vehicleResult === 'mismatch' ? 'Источник явно сообщает, что движение автомобилей не ограничено.' : 'Нужно уточнить, касается ли ограничение автомобилей.', 'vehicleRestriction');
    const delivery = timeKnown ? scheduleOverlap(start, end, location.deliveryWindows, location.timezone) : 'unknown';
    add('delivery', 'Окно доставки', delivery, delivery === 'match' ? 'Окно доставки пересекается с ограничением.' : delivery === 'mismatch' ? 'Известные окна доставки не пересекаются с ограничением.' : 'Время доставки или ограничения неизвестно.', 'startsAt');
  } else {
    const addressResult = has('address') ? compareAddress(location.address, event.address, location.city) : 'unknown';
    add('address', 'Точный адрес и корпус', addressResult, addressResult === 'match' ? 'Адрес, дом и известный корпус совпадают.' : addressResult === 'mismatch' ? 'Известные адреса различаются. Соседний дом не считается совпадением.' : 'Нужен полный адрес с домом и корпусом; радиус вместо адреса не используется.', 'address');
    const opening = timeKnown ? scheduleOverlap(start, end, location.openingHours, location.timezone) : 'unknown';
    add('opening', 'Часы работы', opening, opening === 'match' ? 'Отключение пересекается с известными часами работы.' : opening === 'mismatch' ? 'Отключение вне указанных часов работы.' : 'Нужны часы работы и период отключения.', 'startsAt');
    add('water', 'Зависимость от воды', location.waterDependency === 'unknown' ? 'unknown' : 'match', location.waterDependency === 'essential' ? 'Точка указала существенную зависимость от воды. Решение о работе принимает сотрудник.' : location.waterDependency === 'optional' ? 'Зависимость указана как ограниченная; оцените необходимые меры вручную.' : 'Зависимость точки от воды не указана.');
  }
  const status = conditions.some((item) => item.result === 'mismatch') ? 'excluded'
    : conditions.some((item) => item.result === 'unknown') ? 'needs_review' : 'relevant';
  const priority = status === 'excluded' ? 'routine' : timeKnown && start - nowTime <= dayMs ? 'urgent' : timeKnown && start - nowTime <= 3 * dayMs ? 'upcoming' : 'routine';
  const nextAction = status === 'excluded' ? 'Условия этого уведомления не совпали. Это не подтверждение отсутствия других событий.'
    : status === 'needs_review' ? 'Уточните неизвестные условия и подтвердите сведения перед операционным решением.'
    : event.recommendedAction;
  return { status, priority, conditions, nextAction, ...(distanceMeters === undefined ? {} : { distanceMeters }) };
}
