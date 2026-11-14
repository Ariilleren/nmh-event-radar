import type { Extraction, Hours, LocationInput } from './schemas';
import { literalInQuote, resourceInQuote } from './schemas';
import { INDUSTRY_CONFIG, normalizeIdentity, normalizeResource, RESOURCE_LABELS } from './business';

export type Condition = { key: string; label: string; result: 'match' | 'mismatch' | 'unknown'; reason: string; quote?: string };
export type Evaluation = {
  status: 'relevant' | 'needs_review' | 'excluded' | 'inactive';
  priority: 'urgent' | 'upcoming' | 'routine';
  conditions: Condition[];
  nextAction: string;
  distanceMeters?: number;
  relevance?: 'direct' | 'potential' | 'unrelated' | 'insufficient_data';
  influence?: 'risk' | 'opportunity' | 'mixed' | 'information';
  reason?: string;
  actions?: string[];
  consequences?: string[];
  missingData?: string[];
  responseDeadline?: string | null;
  priorityReason?: string;
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
  const cityPrefix = city ? canonicalAddress(city) : '';
  const withoutCity = (address: string) => cityPrefix && address.startsWith(`${cityPrefix} `) ? address.slice(cityPrefix.length).trim() : address;
  const a = withoutCity(canonicalAddress(known)), b = withoutCity(canonicalAddress(target));
  // A street-only phrase is never an exact address, even when both inputs repeat it.
  if (!/дом\s*\d/.test(a) || !/дом\s*\d/.test(b)) return 'unknown';
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

function evaluateLegacy(location: LocationInput, event: Extraction, now: Date | string = new Date()): Evaluation {
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

type Relevance = NonNullable<Evaluation['relevance']>;
type Influence = NonNullable<Evaluation['influence']>;

/** Facts remain in Extraction; only user-confirmed dependencies participate in matching. */
function evaluateBusiness(location: LocationInput, event: Extraction, now: Date | string): Evaluation {
  const conditions: Condition[] = [];
  const missingData: string[] = [];
  const context = location.businessContext;
  const categories = new Set([event.category, ...(event.categories ?? [])]);
  const quote = (field: string) => event.evidence.filter((item) => item.field === field || item.field.startsWith(`${field}.`)).map((item) => item.quote).join('\n');
  const has = (field: keyof Extraction) => event[field] !== null && event[field] !== undefined && Boolean(quote(field));
  const add = (key: string, label: string, result: Condition['result'], reason: string, field?: string) => {
    conditions.push({ key, label, result, reason, ...(field && quote(field) ? { quote: quote(field) } : {}) });
  };
  const missing = (text: string) => { if (!missingData.includes(text)) missingData.push(text); };
  const nowTime = new Date(now).getTime();
  const start = has('startsAt') ? Date.parse(event.startsAt!) : NaN;
  const end = has('endsAt') ? Date.parse(event.endsAt!) : NaN;
  const intervalKnown = Number.isFinite(start) && Number.isFinite(end) && end > start && Boolean(event.timezone);
  const deadline = has('responseDeadline') ? event.responseDeadline ?? null : null;
  const utility = categories.has('water_outage') || categories.has('utilities');
  const movement = categories.has('road_closure') || categories.has('movement_access');
  const gathering = categories.has('mass_event');
  const influence: Influence = event.influence ?? (gathering || categories.has('procurement') ? 'opportunity' : utility || movement || categories.has('incident') || categories.has('digital_platform') || categories.has('supplier_product') ? 'risk' : 'information');
  let distanceMeters: number | undefined;

  const finish = (relevance: Relevance, reason: string, actions: string[], consequences: string[] = [], inactive = false): Evaluation => {
    if (!inactive && relevance === 'direct' && (event.factStatus === 'forecast' || event.factStatus === 'proposed')) {
      relevance = 'potential';
      reason += event.factStatus === 'forecast' ? ' Источник описывает прогноз, а не произошедший факт.' : ' Источник описывает предложение; вступление требований в силу не подтверждено.';
    }
    const status = inactive ? 'inactive' : relevance === 'unrelated' ? 'excluded' : relevance === 'insufficient_data' ? 'needs_review' : 'relevant';
    const actionTime = deadline ? Date.parse(deadline) : start;
    let priority: Evaluation['priority'] = 'routine';
    let priorityReason = inactive ? 'Предупреждение больше не действует.' : relevance === 'unrelated' ? 'Связь с указанным профилем не подтверждается.' : 'Подтверждённого близкого срока действия нет; категория сама по себе не определяет срочность.';
    if (status === 'relevant' && Number.isFinite(actionTime)) {
      if ((deadline || (relevance === 'direct' && (influence === 'risk' || influence === 'mixed'))) && actionTime - nowTime <= dayMs) {
        priority = 'urgent'; priorityReason = deadline ? 'Указанный источником срок реакции наступил или наступает в течение суток.' : 'Прямая связь с рабочим процессом; событие уже началось или начнётся в течение суток.';
      } else if (actionTime - nowTime <= 3 * dayMs) {
        priority = 'upcoming'; priorityReason = 'Связанное событие началось или начинается в ближайшие три дня; влияние требует проверки.';
      }
    }
    add('business_link', 'Связь с бизнесом', relevance === 'unrelated' ? 'mismatch' : relevance === 'insufficient_data' ? 'unknown' : 'match', reason);
    const safeActions = actions.slice(0, 3);
    return { status, priority, conditions, nextAction: safeActions.join(' '), relevance, influence, reason, actions: safeActions, consequences, missingData, responseDeadline: deadline, priorityReason, ...(distanceMeters === undefined ? {} : { distanceMeters }) };
  };

  if ((event.status === 'cancelled' || event.status === 'completed') && has('status')) {
    add('status', 'Статус источника', 'mismatch', event.status === 'cancelled' ? 'Источник сообщил об отмене.' : 'Источник сообщил о завершении.', 'status');
    return finish('unrelated', event.status === 'cancelled' ? 'Событие отменено; прежнее предупреждение не действует.' : 'Событие завершено.', ['Проверьте ранее назначенные задачи и необходимость их изменения.'], [], true);
  }
  if (intervalKnown && end <= nowTime) return finish('unrelated', 'Подтверждённый период события завершился.', ['При необходимости сохраните итог по ранее назначенным задачам.'], [], true);
  if (event.status === 'postponed' && !Number.isFinite(start)) {
    missing('Новая дата события');
    return finish('insufficient_data', 'Событие отложено, новая дата неизвестна.', ['Уточните новую дату; проверьте ранее назначенные задачи.']);
  }
  if (location.businessDescription && !context) {
    missing('Проверенный разбор описания бизнеса');
    add('profile', 'Процессы пользователя', 'unknown', location.businessContextError ? 'Описание сохранено, но его разбор не завершён. Из текста не делаются догадки о процессах.' : 'Описание ещё не преобразовано в проверяемые сведения о процессах.');
    return finish('insufficient_data', 'Недостаточно проверенных сведений о бизнес-процессах.', ['Повторите разбор описания бизнеса и проверьте его результат.']);
  }
  if (!has('category') || !has('status')) {
    missing('Цитата категории или статуса');
    return finish('insufficient_data', 'Ключевые факты события не подтверждены цитатами.', ['Сверьте категорию и статус с исходной публикацией.']);
  }
  if ([...categories].every((category) => category === 'unsupported')) {
    missing('Известная категория и проверяемая связь');
    return finish('insufficient_data', 'Публикация не отнесена к поддерживаемой категории.', ['Проверьте публикацию и укажите конкретный процесс, на который она может повлиять.']);
  }
  add('category', 'Категория события', 'match', 'Категория подтверждена исходной публикацией.', 'category');
  add('status', 'Статус источника', 'match', 'Статус взят из публикации; независимая проверка не выполнялась.', 'status');

  const checkCity = () => {
    const result = location.city && has('city') ? (normalize(location.city) === normalize(event.city!) ? 'match' : 'mismatch') : 'unknown';
    add('city', 'Город', result, result === 'match' ? 'Города совпадают.' : result === 'mismatch' ? 'Известные города различаются.' : 'Город точки или события неизвестен.', 'city');
    return result;
  };
  const schedule = (windows: Hours[][], unknownProcess: boolean, label: string) => {
    const checks = intervalKnown ? windows.map((hours) => scheduleOverlap(start, end, hours, location.timezone)) : [];
    const result = checks.includes('match') ? 'match' : !intervalKnown || unknownProcess || !checks.length || checks.includes('unknown') ? 'unknown' : 'mismatch';
    add('process_time', label, result, result === 'match' ? 'Интервал события пересекается с указанным графиком рабочего процесса.' : result === 'mismatch' ? 'Интервал события не пересекается с известными графиками затронутых процессов.' : 'Не хватает периода события или полного графика рабочего процесса.', 'startsAt');
    if (result === 'unknown') missing(intervalKnown ? 'Полный график затронутого процесса' : 'Начало, конец и часовой пояс события');
    return result;
  };
  const exactAddress = () => {
    const addresses = [has('address') ? event.address : null, ...(event.affectedAddresses ?? []).filter((value) => literalInQuote(value, quote('affectedAddresses')))].filter((value): value is string => Boolean(value));
    const matches = addresses.map((value) => compareAddress(location.address, value, location.city));
    const result = matches.includes('match') ? 'match' : matches.length && matches.every((value) => value === 'mismatch') ? 'mismatch' : 'unknown';
    add('address', 'Точный адрес и корпус', result, result === 'match' ? 'Указанный адрес и известный корпус совпадают.' : result === 'mismatch' ? 'Известные адреса различаются; соседний дом не является совпадением.' : 'Нужен полный адрес, включая дом и необходимый корпус; близость не заменяет совпадение.', has('address') ? 'address' : 'affectedAddresses');
    if (result === 'unknown') missing('Полный адрес затронутого здания');
    return result;
  };

  if (utility) {
    const cityResult = checkCity();
    if (cityResult === 'unknown') missing('Город точки и отключения');
    const addressResult = exactAddress();
    if (cityResult === 'mismatch' || addressResult === 'mismatch') return finish('unrelated', 'Отключение относится к другому адресу.', ['Персональное предупреждение для этой точки не требуется.']);
    const affected = categories.has('water_outage') ? ['water'] : (event.affectedResources ?? []).filter((value) => resourceInQuote(value, quote('affectedResources'))).map(normalizeResource);
    const globalResources = [...(context?.resources ?? []), ...(location.waterDependency !== 'unknown' ? ['water'] : [])].map(normalizeResource);
    const declared = [...globalResources, ...(context?.processes ?? []).flatMap((process) => process.resources ?? []).map(normalizeResource)];
    const resources = affected.filter((value) => declared.includes(value));
    const dependency = resources.length ? 'match' : 'unknown';
    const resourceNames = resources.map((value) => RESOURCE_LABELS[value] ?? value).join(', ');
    add('resources', 'Ресурсы рабочего процесса', dependency, resources.length ? `Пользователь указал зависимость от ресурса: ${resourceNames}.` : 'В источнике или профиле недостаточно сведений о затронутом ресурсе. Отрасль не доказывает зависимость.', categories.has('water_outage') ? 'category' : 'affectedResources');
    if (!resources.length) missing('Затронутый ресурс и его использование в бизнесе');
    const processes = (context?.processes ?? []).filter((process) => process.resources?.some((value) => resources.includes(normalizeResource(value))));
    const processNames = processes.filter((process) => intervalKnown && process.schedule?.length && scheduleOverlap(start, end, process.schedule, location.timezone) === 'match').map((process) => process.name);
    const globalDependency = resources.some((value) => globalResources.includes(value));
    const windows = [...(globalDependency && context?.productionHours?.length ? [context.productionHours] : []), ...processes.filter((process) => process.schedule?.length).map((process) => process.schedule!), ...(globalDependency && location.openingHours.length ? [location.openingHours] : [])];
    const uncertainProcesses = (context?.processes ?? []).some((process) => !process.resources?.length) || processes.some((process) => !process.schedule?.length);
    const hoursResult = schedule(windows, uncertainProcesses, 'Рабочее и производственное время');
    if (dependency === 'match' && hoursResult === 'mismatch') return finish('unrelated', 'Отключение не пересекается с указанными часами работы и затронутых процессов.', ['Проверьте, требуется ли подготовка вне указанных графиков.']);
    if (cityResult !== 'match' || addressResult !== 'match' || dependency === 'unknown' || hoursResult === 'unknown') return finish('insufficient_data', 'Связь отключения с адресом, ресурсом и временем процесса требует уточнения.', ['Уточните город, адрес отключения и график процесса, использующего затронутый ресурс.']);
    const processText = processNames.length ? processNames.join(', ') : context?.productionHours?.length ? 'производственная смена или работа точки' : 'работа точки';
    return finish('direct', `Совпадают адрес, ресурс (${resourceNames}) и время процесса: ${processText}.`, [`Проверьте возможность выполнения процесса «${processText}» в период отключения; согласуйте резервный способ работы.`], [`Возможно ограничение процесса «${processText}» из-за недоступности ресурса: ${resourceNames}.`]);
  }

  if (movement) {
    const cityResult = checkCity();
    if (cityResult === 'mismatch') return finish('unrelated', 'Ограничение находится в другом городе.', ['Персональное предупреждение для этой точки не требуется.']);
    if (cityResult === 'unknown') missing('Город маршрута и ограничения');
    const routeProcesses = (context?.processes ?? []).filter((process) => process.routes?.length);
    const routes = [...location.deliveryRouteStreets, ...routeProcesses.flatMap((process) => process.routes ?? [])];
    const result = routes.length && has('street') ? (routes.some((value) => street(value) === street(event.street!)) ? 'match' : 'mismatch') : 'unknown';
    add('route', 'Маршрут рабочего процесса', result, result === 'match' ? 'Улица ограничения совпадает с указанным маршрутом.' : result === 'mismatch' ? 'Улица отсутствует в указанных маршрутах.' : 'Неизвестна улица ограничения или маршрут рабочего процесса.', 'street');
    if (result === 'mismatch') return finish('unrelated', 'Ограничение не пересекает указанные маршруты.', ['Проверьте другие маршруты только при появлении новых сведений.']);
    if (result === 'unknown') missing('Улица ограничения и маршрут процесса');
    const vehicleResult = has('vehicleRestriction') ? (event.vehicleRestriction ? 'match' : 'mismatch') : 'unknown';
    add('vehicles', 'Ограничение транспорта', vehicleResult, vehicleResult === 'match' ? 'Источник подтверждает ограничение автомобилей.' : vehicleResult === 'mismatch' ? 'Движение автомобилей явно не ограничено.' : 'Ограничение движения автомобилей не подтверждено.', 'vehicleRestriction');
    if (vehicleResult === 'mismatch') return finish('unrelated', 'Публикация не подтверждает ограничение автомобилей на маршруте.', ['При необходимости отдельно проверьте условия доступа пешеходов.']);
    if (vehicleResult === 'unknown') missing('Условия ограничения транспорта');
    const matchedProcesses = routeProcesses.filter((process) => process.routes!.some((value) => event.street && street(value) === street(event.street)));
    const baseRoute = location.deliveryRouteStreets.some((value) => event.street && street(value) === street(event.street));
    const windows = [...(baseRoute && location.deliveryWindows.length ? [location.deliveryWindows] : []), ...matchedProcesses.filter((process) => process.schedule?.length).map((process) => process.schedule!)];
    const hoursResult = schedule(windows, (baseRoute && !location.deliveryWindows.length) || matchedProcesses.some((process) => !process.schedule?.length), 'Время рейса или доставки');
    if (hoursResult === 'mismatch') return finish('unrelated', 'Известное время доставки или рейса не пересекается с ограничением.', ['Проверьте изменения графика при получении уточнений.']);
    if (cityResult !== 'match' || result !== 'match' || vehicleResult !== 'match' || hoursResult !== 'match') return finish('insufficient_data', 'Недостаточно данных о городе, маршруте, транспортном ограничении или времени процесса.', ['Уточните город, улицу, вид ограничения и время рейса; затем проверьте доступный объезд.']);
    return finish('direct', `Ограничение пересекает указанный маршрут${matchedProcesses.length ? ` процесса «${matchedProcesses.map((process) => process.name).join(', ')}»` : ' доставки'} и его график.`, ['Проверьте доступный объезд и согласуйте время доставки с ответственным.'], ['Возможна задержка выполнения рейса или доставки по указанному маршруту.']);
  }

  if (gathering) {
    if (checkCity() === 'mismatch') return finish('unrelated', 'Мероприятие проходит в другом городе.', ['Персональное предупреждение для этой точки не требуется.']);
    const coordsKnown = location.latitude !== null && location.longitude !== null && has('latitude') && has('longitude') && location.eventRadiusMeters !== null;
    let distanceResult: Condition['result'] = 'unknown';
    if (coordsKnown) {
      distanceMeters = haversineMeters(location.latitude!, location.longitude!, event.latitude!, event.longitude!);
      distanceResult = distanceMeters <= location.eventRadiusMeters! ? 'match' : 'mismatch';
    }
    add('distance', 'Радиус точки', distanceResult, distanceResult === 'unknown' ? 'Для проверки радиуса нужны подтверждённые координаты события и точки и указанный радиус.' : `Расстояние по указанным координатам: ${Math.round(distanceMeters!)} м; радиус точки: ${location.eventRadiusMeters} м.`, 'latitude');
    if (distanceResult === 'mismatch') return finish('unrelated', 'Мероприятие находится за пределами заданного радиуса точки.', ['Не требуется персональное уведомление в рамках заданного радиуса.']);
    if (distanceResult === 'unknown') missing('Подтверждённые координаты и радиус точки');
    const hoursResult = schedule(location.openingHours.length ? [location.openingHours] : [], false, 'Часы обслуживания клиентов');
    if (hoursResult === 'mismatch') return finish('unrelated', 'Мероприятие не пересекается с указанными часами обслуживания.', ['Проверьте возможность изменения графика только при подтверждённой потребности.']);
    if (distanceResult === 'unknown' || hoursResult === 'unknown') return finish('insufficient_data', 'Близость мероприятия и совпадение с часами обслуживания не проверены.', ['Уточните место и время мероприятия и сопоставьте их с графиком точки.']);
    const servesVisitors = context?.industry && ['foodservice', 'retail', 'household_services', 'hospitality'].includes(context.industry) || context?.audiences?.length || context?.services?.length;
    if (!servesVisitors) {
      missing('Связь посетителей мероприятия с услугами или клиентами бизнеса');
      return finish('insufficient_data', 'Мероприятие рядом, но связь его посетителей с указанными бизнес-процессами не установлена.', ['Уточните услуги и аудиторию бизнеса, которым может быть полезно мероприятие.']);
    }
    return finish('potential', 'Мероприятие проходит в заданном радиусе во время работы точки; возможная потребность посетителей требует проверки.', [context?.industry === 'hospitality' ? 'Проверьте у организаторов потребность в размещении гостей и условия группового бронирования.' : 'Проверьте программу мероприятия и потребности его посетителей; оцените подготовку обслуживания в этот интервал.'], ['Может возникнуть дополнительная потребность в обслуживании; рост посещаемости или выручки не подтверждён.']);
  }

  const local = ['weather', 'incident', 'neighborhood', 'competition'].some((value) => categories.has(value as Extraction['category']));
  const dependencyWide = ['commercial', 'digital_platform', 'supplier_product', 'regulation', 'procurement', 'labor', 'reputation'].some((value) => categories.has(value as Extraction['category']));
  const primarilyLocal = ['weather', 'incident', 'neighborhood', 'competition'].includes(event.category);
  if (local && (!dependencyWide || primarilyLocal)) {
    const cityResult = checkCity();
    if (cityResult === 'mismatch') return finish('unrelated', 'Локальное событие относится к другому городу.', ['Персональное предупреждение для этой точки не требуется.']);
    if (has('address') || event.affectedAddresses?.length) {
      const addressResult = exactAddress();
      if (addressResult === 'match' && cityResult === 'match') return finish('potential', 'Совпадает адрес точки; конкретные последствия для указанного рабочего процесса ещё не подтверждены.', ['Уточните ограничения по адресу и проверьте затронутый график или процесс.']);
      if (addressResult === 'mismatch' && categories.has('incident')) return finish('unrelated', 'Происшествие относится к другому адресу; распространение ограничений на точку не подтверждено.', ['Следите за уточнением границ ограничений в источнике.']);
    }
    if (cityResult === 'match') {
      missing('Территория события и её связь с конкретной точкой или процессом');
      return finish('insufficient_data', 'Совпадает только город; связь с конкретным адресом или процессом не подтверждена.', ['Уточните территорию действия события и её связь с адресом, маршрутом или графиком бизнеса.']);
    }
    missing('Город и территория действия локального события');
    return finish('insufficient_data', 'Локальное событие пока нельзя связать с территорией бизнеса; совпадение названия платформы или товара недостаточно.', ['Уточните территорию события и затронутые процессы.']);
  }

  // Provider/product identity is independent of geography for nonlocal events only.
  const entityKinds = ['platforms', 'suppliers', 'brands', 'products', 'services'] as const;
  const entityLabels = { platforms: 'Платформа', suppliers: 'Поставщик', brands: 'Бренд', products: 'Товар', services: 'Услуга' };
  const matches: { kind: typeof entityKinds[number]; value: string }[] = [];
  let sourceEntities = 0, knownComparisons = 0, unknownComparisons = 0;
  for (const kind of entityKinds) {
    const values = (event.entities?.[kind] ?? []).filter((value) => literalInQuote(value, quote(`entities.${kind}`)));
    if (!values.length) continue;
    sourceEntities += values.length;
    const declared = [...(context?.[kind] ?? []), ...(context?.processes ?? []).flatMap((process) => kind === 'brands' || kind === 'services' ? [] : process[kind] ?? [])];
    const linked = values.filter((value) => declared.some((name) => normalizeIdentity(name) === normalizeIdentity(value)));
    if (declared.length) knownComparisons++; else { unknownComparisons++; missing(`Используемые ${entityLabels[kind].toLocaleLowerCase('ru-RU')}: сведения профиля`); }
    matches.push(...linked.map((value) => ({ kind, value })));
    add(`entity_${kind}`, entityLabels[kind], linked.length ? 'match' : declared.length ? 'mismatch' : 'unknown', linked.length ? `Точное совпадение с профилем: ${linked.join(', ')}.` : declared.length ? 'В указанных значениях профиля совпадений нет.' : 'Профиль не содержит сведений для проверки этой зависимости.', `entities.${kind}`);
  }
  if (matches.length) {
    // A platform-wide change and a category-limited change are different claims.
    const productLimited = (event.entities?.products?.length ?? 0) > 0;
    const providerMatch = matches.some((item) => item.kind === 'platforms' || item.kind === 'suppliers');
    const productMatch = matches.some((item) => item.kind === 'products');
    const productKnown = Boolean(context?.products?.length || context?.processes?.some((process) => process.products?.length));
    const providerSpecified = Boolean(event.entities?.platforms?.length || event.entities?.suppliers?.length);
    if (providerSpecified && !providerMatch) {
      if (unknownComparisons) return finish('insufficient_data', 'Товар совпадает, но использование указанного поставщика или платформы не подтверждено.', ['Уточните поставщика или платформу, к которым относятся условия публикации.']);
      return finish('unrelated', 'Товар совпадает, но условия относятся к другому указанному поставщику или платформе.', ['Персональное предупреждение по указанным зависимостям не требуется.']);
    }
    if ((providerMatch || matches.some((item) => item.kind === 'brands')) && productLimited && !productMatch) {
      if (productKnown) return finish('unrelated', 'Поставщик или платформа совпадают, но указанные в публикации товары не совпадают с ассортиментом профиля.', ['Проверьте применимость условий, если ассортимент изменится.']);
      missing('Ассортимент или товарная категория бизнеса');
      return finish('insufficient_data', 'Платформа или поставщик совпадают, но применимость условий к товарам бизнеса неизвестна.', ['Уточните ассортимент и проверьте, распространяются ли новые условия на эти позиции.']);
    }
    const matchedText = matches.map((item) => `${entityLabels[item.kind].toLocaleLowerCase('ru-RU')} «${item.value}»`).join(', ');
    if (matches.every((item) => item.kind === 'services')) return finish('potential', `С профилем точно совпадает ${matchedText}; остальные условия применимости требуют проверки.`, ['Проверьте требования к исполнителю, объём услуги и сроки публикации; оцените возможность участия.'], ['Может появиться возможность заказа или необходимость проверить требования к оказываемой услуге.']);
    const processes = context?.processes?.filter((process) => matches.some((item) => item.kind !== 'brands' && item.kind !== 'services' && process[item.kind]?.some((value) => normalizeIdentity(value) === normalizeIdentity(item.value)))).map((process) => process.name) ?? [];
    const action = categories.has('commercial') ? 'Проверьте дату применения и новые условия для используемой платформы, поставщика или соответствующих товарных позиций.' : categories.has('digital_platform') ? 'Проверьте статус используемого сервиса и затронутые интеграции; согласуйте резервный порядок работы.' : categories.has('supplier_product') ? 'Сверьте затронутые товары и поставки с вашими заказами; уточните сроки и доступную замену у поставщика.' : 'Сверьте условия публикации с указанным договором, продуктом или процессом и назначьте ответственного за проверку.';
    return finish('direct', `С профилем точно совпадает ${matchedText}${processes.length ? `; затронутый процесс: ${processes.join(', ')}` : ''}. Географическое совпадение для этой связи не требуется.`, [action], [`Возможное изменение условий выполнения ${processes.length ? `процесса «${processes.join(', ')}»` : 'работы с указанной зависимостью'}; конкретный масштаб нужно проверить.`]);
  }
  if (sourceEntities && knownComparisons && !unknownComparisons) return finish('unrelated', 'Названные в публикации поставщики, платформы или товары не совпадают с указанным профилем.', ['Персональное предупреждение по указанным зависимостям не требуется.']);

  const industry = context?.industry;
  const industryTerms = industry ? [industry, INDUSTRY_CONFIG[industry].label] : [];
  const industryMatch = (event.entities?.industries ?? []).some((value) => literalInQuote(value, quote('entities.industries')) && industryTerms.some((term) => normalizeIdentity(term) === normalizeIdentity(value)));
  const audienceMatch = (event.entities?.audiences ?? []).some((value) => literalInQuote(value, quote('entities.audiences')) && context?.audiences?.some((audience) => normalizeIdentity(audience) === normalizeIdentity(value)));
  if (industryMatch || audienceMatch) {
    add('business_scope', 'Отрасль или аудитория', 'match', industryMatch ? 'Совпадает явно указанная отрасль.' : 'Совпадает указанная клиентская аудитория.', industryMatch ? 'entities.industries' : 'entities.audiences');
    return finish('potential', 'Совпадает отрасль или клиентская аудитория; применимость конкретных условий к бизнесу требует проверки.', ['Проверьте условия участия или требования публикации применительно к вашим услугам и клиентам.'], ['Возможность или требование может относиться к бизнесу после проверки конкретных условий.']);
  }
  missing(sourceEntities ? 'Сведения профиля о названной зависимости' : 'Конкретный адрес, маршрут, поставщик, платформа, товар, отрасль или аудитория');
  return finish('insufficient_data', 'В доступных сведениях нет проверяемой связи события с указанными бизнес-процессами.', ['Уточните указанную в публикации зависимость и соответствующие сведения бизнес-профиля.']);
}

export function evaluate(location: LocationInput, event: Extraction, now: Date | string = new Date()): Evaluation {
  const legacy = !location.businessDescription && !location.businessContext && !location.businessContextError && !event.categories && !event.entities && !event.affectedResources && ['mass_event', 'road_closure', 'water_outage', 'unsupported'].includes(event.category) && ['scheduled', 'cancelled', 'rescheduled'].includes(event.status);
  if (!legacy) return evaluateBusiness(location, event, now);
  const result = evaluateLegacy(location, event, now);
  const relevance: Relevance = result.status === 'relevant' ? event.category === 'mass_event' ? 'potential' : 'direct' : result.status === 'excluded' || result.status === 'inactive' ? 'unrelated' : 'insufficient_data';
  return { ...result, relevance, influence: event.category === 'mass_event' ? 'opportunity' : event.category === 'unsupported' ? 'information' : 'risk', reason: result.conditions.filter((item) => item.result !== 'match').map((item) => item.reason).join(' ') || (event.category === 'mass_event' ? 'Мероприятие рядом с открытой точкой; возможность требует проверки.' : 'Подтверждённые условия источника совпадают с указанным профилем.'), actions: [result.nextAction], consequences: [], missingData: result.conditions.filter((item) => item.result === 'unknown').map((item) => item.label), responseDeadline: null, priorityReason: result.priority === 'routine' ? 'Близкий срок реакции не подтверждён или событие неактуально.' : 'Приоритет по подтверждённому времени события.' };
}
