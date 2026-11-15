import { describe, expect, it } from 'vitest';
import { evaluate } from '../../src/domain/evaluate';
import { extractionSchema, locationSchema, validateQuotes, type Extraction } from '../../src/domain/schemas';

const now = '2026-11-16T04:00:00+03:00';
const everyDay = [1, 2, 3, 4, 5, 6, 7];
it('matches Russian grammatical forms without merging different streets or cities', () => {
  const location = point();
  const event = road('Складской улице'); event.city = 'Москве';
  expect(evaluate(location, event, now).status).toBe('relevant');
  expect(evaluate(location, { ...event, street: 'Лесной улице' }, now).status).toBe('excluded');
  expect(evaluate(location, { ...event, street: 'Складской проезд' }, now).status).toBe('excluded');
  expect(evaluate(location, { ...event, city: 'Санкт-Петербурге' }, now).status).toBe('excluded');
});
const point = () => locationSchema.parse({
  locationId: 'relevance-bakery', name: 'Пекарня на Тестовой',
  city: 'Москва', address: 'Москва, улица Тестовая, дом 7', timezone: 'Europe/Moscow',
  latitude: 55.75, longitude: 37.6, eventRadiusMeters: 500,
  openingHours: [{ days: everyDay, start: '08:00', end: '20:00' }],
  deliveryRouteStreets: ['улица Складская'],
  deliveryWindows: [{ days: everyDay, start: '05:00', end: '07:00' }],
  businessDescription: 'Ежедневно выпекаем хлеб с 05:00 до 08:00, для выпечки нужна вода.',
  businessContext: {
    industry: 'foodservice', resources: ['water'],
    processes: [{ name: 'Выпечка', resources: ['water'], schedule: [{ days: everyDay, start: '05:00', end: '08:00' }] }],
    evidence: [{ field: 'resources', quote: 'для выпечки нужна вода' }],
  },
});

function water(city: string | null = 'Москва', address: string | null = 'Москва, улица Тестовая, дом 7'): Extraction {
  const text = `${city ? `${city}. ` : ''}${address ? `${address}. ` : ''}16 ноября 2026 года с 05:30 до 07:00 запланировано отключение воды.`;
  const values = {
    category: 'water_outage', title: 'Отключение воды', summary: text, status: 'scheduled',
    startsAt: '2026-11-16T05:30:00+03:00', endsAt: '2026-11-16T07:00:00+03:00', timezone: 'Europe/Moscow',
    city, address, street: null, latitude: null, longitude: null, vehicleRestriction: null,
    impactHypothesis: 'Возможно ограничение выпечки.', recommendedAction: 'Проверить работу.',
    evidence: ['category', 'status', 'startsAt', 'endsAt', ...(city ? ['city'] : []), ...(address ? ['address'] : [])]
      .map((field) => ({ field, quote: text })),
  };
  const result = extractionSchema.parse(values);
  validateQuotes(result, text);
  return result;
}

function road(street: string | null, start = '05:30', end = '06:30'): Extraction {
  const text = `Москва. ${street ? `${street}: ` : ''}16 ноября 2026 года с ${start} до ${end} запланировано перекрытие движения автомобилей.`;
  const result = extractionSchema.parse({
    ...water(), category: 'road_closure', address: null, street, vehicleRestriction: true,
    startsAt: `2026-11-16T${start}:00+03:00`, endsAt: `2026-11-16T${end}:00+03:00`,
    evidence: ['category', 'status', 'city', 'startsAt', 'endsAt', 'vehicleRestriction', ...(street ? ['street'] : [])]
      .map((field) => ({ field, quote: text })),
  });
  validateQuotes(result, text);
  return result;
}

describe('news relevance examples and unknown data', () => {
  it('links a quoted matching outage to the production process before the shop opens', () => {
    const result = evaluate(point(), water(), now);
    expect(result).toMatchObject({ status: 'relevant', relevance: 'direct' });
    expect(result.reason).toContain('Выпечка');
    expect(result.conditions.filter((item) => ['city', 'address', 'resources', 'process_time'].includes(item.key)))
      .toHaveLength(4);
    expect(result.conditions.every((item) => item.result === 'match')).toBe(true);
  });

  it('rejects the same street and period in a different city', () => {
    const result = evaluate(point(), water('Тверь', 'Тверь, улица Тестовая, дом 7'), now);
    expect(result).toMatchObject({ status: 'excluded', relevance: 'unrelated' });
    expect(result.conditions.find((item) => item.key === 'city')?.result).toBe('mismatch');
  });

  it('requires clarification for an outage message without any place', () => {
    const result = evaluate(point(), water(null, null), now);
    expect(result).toMatchObject({ status: 'needs_review', relevance: 'insufficient_data' });
    expect(result.conditions.find((item) => item.key === 'address')?.result).toBe('unknown');
    expect(result.missingData).toContain('Полный адрес затронутого здания');
  });

  it('requires a known matching route and an intersecting delivery period', () => {
    const matching = evaluate(point(), road('ул. Складская'), now);
    expect(matching).toMatchObject({ status: 'relevant', relevance: 'direct' });
    expect(matching.conditions.find((item) => item.key === 'route')?.result).toBe('match');
    expect(evaluate(point(), road('улица Другая'), now).relevance).toBe('unrelated');
    expect(evaluate(point(), road(null), now).relevance).toBe('insufficient_data');
    // Interval boundaries do not overlap when the event starts as delivery ends.
    expect(evaluate(point(), road('улица Складская', '07:00', '08:00'), now).relevance).toBe('unrelated');
  });

  it('keeps unknown coordinates uncertain and calculates known distance', () => {
    const concert: Extraction = {
      ...water(), category: 'mass_event', address: null,
      startsAt: '2026-11-16T12:00:00+03:00', endsAt: '2026-11-16T14:00:00+03:00',
      latitude: 55.751, longitude: 37.6,
    };
    concert.evidence.push({ field: 'latitude', quote: '55.751' }, { field: 'longitude', quote: '37.6' });
    const near = evaluate(point(), concert, now);
    expect(near.relevance).toBe('potential');
    expect(near.distanceMeters).toBeCloseTo(111.19, 1);
    concert.latitude = 55.76;
    expect(evaluate(point(), concert, now).relevance).toBe('unrelated');
    concert.latitude = null; concert.longitude = null;
    expect(evaluate(point(), concert, now).relevance).toBe('insufficient_data');
  });

  it('does not treat city-only local news as a verified business link', () => {
    const event: Extraction = { ...water(), category: 'incident', address: null };
    const result = evaluate(point(), event, now);
    expect(result).toMatchObject({ status: 'needs_review', relevance: 'insufficient_data' });
    expect(result.reason).toContain('только город');
    expect(result.consequences).toEqual([]);
  });

  it('does not let a secondary commercial label override a contradictory incident city', () => {
    const event: Extraction = {
      ...water('Тверь', null), category: 'incident', categories: ['incident', 'commercial'],
      entities: { platforms: ['Тестовая площадка'] },
    };
    event.evidence.push({ field: 'entities.platforms', quote: 'Тестовая площадка' });
    const profile = point();
    profile.businessContext!.platforms = ['Тестовая площадка'];
    expect(evaluate(profile, event, now).relevance).toBe('unrelated');
  });
});
