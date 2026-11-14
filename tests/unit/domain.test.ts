import { describe, expect, it } from 'vitest';
import { compareAddress, evaluate, haversineMeters, intervalsOverlap, scheduleOverlap } from '../../src/domain/evaluate';
import { demoExpected, demoLocations, demoMessages, demoNow } from '../../src/data/demo';
import { extractionSchema, locationSchema, messageInputSchema, validateQuotes, type Extraction } from '../../src/domain/schemas';

const event = (key: string) => structuredClone(demoMessages.find((item) => item.key === key)!.extraction);
const location = (index = 0) => structuredClone(demoLocations[index]);
const condition = (extraction: Extraction, key: string) => evaluate(location(), extraction, demoNow).conditions.find((item) => item.key === key);

describe('reproducible demonstration and schema boundaries', () => {
  it('contains three explicit fictional locations and fourteen quoted messages', () => {
    expect(demoLocations).toHaveLength(3);
    expect(demoMessages).toHaveLength(14);
    for (const item of demoLocations) expect(locationSchema.safeParse(item).success).toBe(true);
    for (const item of demoMessages) {
      expect(extractionSchema.safeParse(item.extraction).success, item.key).toBe(true);
      expect(() => validateQuotes(item.extraction, item.text), item.key).not.toThrow();
      expect(item.url).toBeNull();
    }
  });
  it.each(demoExpected)('expected $messageKey at $locationId is $status', (example) => {
    const actual = evaluate(demoLocations.find((item) => item.locationId === example.locationId)!, event(example.messageKey), demoNow);
    expect(actual.status).toBe(example.status);
    if ('distanceMetersRange' in example) {
      expect(actual.distanceMeters).toBeGreaterThan(example.distanceMetersRange[0]);
      expect(actual.distanceMeters).toBeLessThan(example.distanceMetersRange[1]);
    }
  });
  it('accepts explicit unknown fields, rejects half coordinate and invalid timezone', () => {
    expect(locationSchema.safeParse({ locationId: '001', name: 'Точка', address: 'Адрес', timezone: 'Europe/Moscow' }).success).toBe(true);
    expect(locationSchema.safeParse({ ...location(), latitude: null }).success).toBe(false);
    expect(locationSchema.safeParse({ ...location(), timezone: 'Not/AZone' }).success).toBe(false);
    expect(messageInputSchema.safeParse({ text: 'Учебное сообщение', publisher: 'Демо', url: 'javascript:alert(1)' }).success).toBe(false);
  });
  it('rejects invalid event intervals and unconfirmed quotes', () => {
    expect(extractionSchema.safeParse({ ...event('concert-arena'), endsAt: '2026-11-15T19:00:00+03:00' }).success).toBe(false);
    const bad = event('concert-arena'); bad.evidence[0].quote = 'Это выдуманная цитата';
    expect(() => validateQuotes(bad, demoMessages[0].text)).toThrow(/отсутствует/);
  });
  it('only whitespace normalization is allowed for a quotation', () => {
    const source = demoMessages[0];
    expect(() => validateQuotes(source.extraction, source.text.replace(/ /g, '  \n'))).not.toThrow();
    expect(() => validateQuotes(source.extraction, source.text.toUpperCase())).toThrow();
  });
});

describe('time intervals and schedules', () => {
  it('treats intervals as half open, including their end boundary', () => {
    expect(intervalsOverlap(9, 13, 10, 11)).toBe(true);
    expect(intervalsOverlap(9, 13, 7, 9)).toBe(false);
    expect(intervalsOverlap(9, 13, 13, 14)).toBe(false);
  });
  it('computes local working hours in the location timezone', () => {
    const start = Date.parse('2026-11-16T10:00:00+03:00'), end = Date.parse('2026-11-16T11:00:00+03:00');
    expect(scheduleOverlap(start, end, [{ days: [1], start: '07:00', end: '08:00' }], 'UTC')).toBe('match');
    expect(scheduleOverlap(start, end, [{ days: [1], start: '07:00', end: '08:00' }], 'Europe/Moscow')).toBe('mismatch');
  });
  it('supports a preceding-day overnight shift and excludes its ending instant', () => {
    const hours = [{ days: [6], start: '22:00', end: '02:00' }];
    expect(scheduleOverlap(Date.parse('2026-11-15T01:00:00+03:00'), Date.parse('2026-11-15T02:00:00+03:00'), hours, 'Europe/Moscow')).toBe('match');
    expect(scheduleOverlap(Date.parse('2026-11-15T02:00:00+03:00'), Date.parse('2026-11-15T03:00:00+03:00'), hours, 'Europe/Moscow')).toBe('mismatch');
  });
  it('does not assume opening hours or date ranges when missing', () => {
    expect(scheduleOverlap(0, 1000, [], 'Europe/Moscow')).toBe('unknown');
    const incomplete = event('concert-arena'); incomplete.timezone = null;
    expect(evaluate(location(), incomplete, demoNow).status).toBe('needs_review');
    incomplete.startsAt = null;
    expect(condition(incomplete, 'time')?.result).toBe('unknown');
  });
  it('marks event inactive exactly at the end, not at its beginning', () => {
    const concert = event('concert-arena');
    expect(evaluate(location(), concert, concert.endsAt!).status).toBe('inactive');
    expect(evaluate(location(), concert, concert.startsAt!).status).toBe('relevant');
  });
  it('returns unknown for nonexistent spring-forward local times', () => {
    const result = scheduleOverlap(Date.parse('2026-03-29T00:00:00Z'), Date.parse('2026-03-29T04:00:00Z'), [{ days: [7], start: '02:30', end: '03:00' }], 'Europe/Berlin');
    expect(result).toBe('unknown');
  });
});

describe('applicability keeps exact contradictions and unknowns distinct', () => {
  it('calculates distance instead of using a prepared distance score', () => {
    expect(haversineMeters(55.755, 37.62, 55.76085, 37.62)).toBeCloseTo(650.49, 0);
    const near = location(); near.eventRadiusMeters = 650;
    expect(evaluate(near, event('concert-arena'), demoNow).status).toBe('excluded');
    near.eventRadiusMeters = 651;
    expect(evaluate(near, event('concert-arena'), demoNow).status).toBe('relevant');
  });
  it('unknown location never becomes no risk, but a known contradiction can exclude', () => {
    const unknown = event('concert-place-unknown');
    expect(evaluate(location(), unknown, demoNow).status).toBe('needs_review');
    unknown.city = 'Тверь';
    expect(evaluate(location(), unknown, demoNow).status).toBe('excluded');
  });
  it('same street in a different city is not merged', () => {
    const road = event('road-delivery'); road.city = 'Тверь';
    expect(evaluate(location(), road, demoNow).conditions.find((item) => item.key === 'city')?.result).toBe('mismatch');
    expect(evaluate(location(), road, demoNow).status).toBe('excluded');
  });
  it('unknown route needs clarification and a known different route excludes', () => {
    const point = location(); point.deliveryRouteStreets = [];
    expect(evaluate(point, event('road-delivery'), demoNow).status).toBe('needs_review');
    point.deliveryRouteStreets = ['Пекарский проезд'];
    expect(evaluate(point, event('road-delivery'), demoNow).status).toBe('excluded');
  });
  it('delivery before the restriction is excluded without inventing pedestrian impact', () => {
    const result = evaluate(location(2), event('road-delivery'), demoNow);
    expect(result.conditions.find((item) => item.key === 'delivery')?.result).toBe('mismatch');
    expect(result.status).toBe('excluded');
    expect(result.conditions.find((item) => item.key === 'vehicles')?.reason).toContain('не следует');
  });
  it('distinguishes exact house and unit from missing unit or neighboring address', () => {
    const address = 'Москва, Пекарский проезд, дом 7, корпус 2';
    expect(compareAddress(address, 'г. Москва, Пекарский проезд, д. 7, корп. 2')).toBe('match');
    expect(compareAddress(address, 'Москва, Пекарский проезд, дом 7')).toBe('unknown');
    expect(compareAddress(address, 'Москва, Пекарский проезд, дом 7, корпус 3')).toBe('mismatch');
    expect(compareAddress(address, 'Москва, Пекарский проезд, дом 9')).toBe('mismatch');
    expect(compareAddress(address, 'Пекарский проезд')).toBe('unknown');
    expect(compareAddress(address, 'Москва, Пекарский проезд, дом 7, корпус неизвестен')).toBe('unknown');
    expect(compareAddress('дом 7', 'дом 7')).toBe('unknown');
    expect(compareAddress('Нижний Новгород, дом 7', 'Нижний Новгород, дом 7', 'Нижний Новгород')).toBe('unknown');
  });
  it('water applicability never substitutes a nearby coordinate for exact address', () => {
    const water = event('water-bakery'); water.address = null; water.latitude = 55.76; water.longitude = 37.64;
    expect(evaluate(location(1), water, demoNow).status).toBe('needs_review');
  });
  it('an unsupported field without citation is not treated as a match', () => {
    const concert = event('concert-arena'); concert.evidence = concert.evidence.filter((item) => item.field !== 'latitude');
    expect(evaluate(location(), concert, demoNow).status).toBe('needs_review');
    expect(() => validateQuotes(concert, demoMessages[0].text)).toThrow(/Нет цитаты/);
  });
  it('explicit rescheduling uses the new interval, cancellation makes old action inactive', () => {
    const moved = event('festival-moved');
    expect(evaluate(location(), moved, demoNow).status).toBe('relevant');
    expect(moved.startsAt).toContain('2026-11-19');
    expect(evaluate(location(), event('road-cancelled'), demoNow).status).toBe('inactive');
  });
  it('does not mutate stored location or extracted evidence during evaluation', () => {
    const before = JSON.stringify([demoLocations, demoMessages]);
    for (const message of demoMessages) for (const point of demoLocations) evaluate(point, message.extraction, demoNow);
    expect(JSON.stringify([demoLocations, demoMessages])).toBe(before);
  });
});
