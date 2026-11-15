import { describe, expect, it } from 'vitest';
import { demoLocations, demoMessages, demoNow } from '../../src/data/demo';
import { assessProductImpact } from '../../src/server/product-impact';
import { BUSINESS_TYPES, EVENT_RADIUS_METERS, normalizeBusinessType } from '../../src/lib/product-config';

const source = (key: string) => structuredClone(demoMessages.find(item => item.key === key)!.extraction);
const point = (index = 0) => structuredClone(demoLocations[index]);

describe('product impact explains verified conditions without claiming certainty', () => {
  it('offers an opportunity only when distance and working hours match, using the common radius', () => {
    const nearby = point();
    nearby.eventRadiusMeters = 1;
    const result = assessProductImpact([nearby], source('concert-arena'), demoNow);
    expect(result.impactKind).toBe('opportunity');
    expect(result.affectedLocationNames).toEqual([nearby.name]);
    expect(result.impactExplanation).toContain('1000 м');
    expect(result.impactExplanation).toContain('19:00');
    expect(result.impactExplanation).toContain('08:00–23:00');
    expect(result.impactExplanation).toContain('гипотеза');
    expect(result.impactExplanation).toContain('не гарантированы');
    nearby.latitude = 55.74;
    nearby.eventRadiusMeters = 100_000;
    expect(assessProductImpact([nearby], source('concert-arena'), demoNow).impactKind).toBe('neutral');
  });

  it('does not turn an unknown place or missing working hours into an opportunity', () => {
    const unknownPlace = assessProductImpact([point()], source('concert-place-unknown'), demoNow);
    expect(unknownPlace.impactKind).toBe('neutral');
    expect(unknownPlace.affectedLocationNames).toEqual([]);
    expect(unknownPlace.impactExplanation).toContain('координаты');
    const missingHours = point(); missingHours.openingHours = [];
    expect(assessProductImpact([missingHours], source('concert-arena'), demoNow).impactExplanation).toContain('часов работы');
  });

  it('flags delivery risk only for the known route and overlapping delivery window', () => {
    const delivery = point();
    const result = assessProductImpact([delivery], source('road-delivery'), demoNow);
    expect(result.impactKind).toBe('risk');
    expect(result.impactExplanation).toContain(delivery.name);
    expect(result.impactExplanation).toContain('Учебная улица');
    expect(result.impactExplanation).toContain('10:00–11:00');
    expect(result.impactExplanation).toContain('09:00');
    delivery.deliveryWindows = [{ days: [1], start: '07:00', end: '09:00' }];
    expect(assessProductImpact([delivery], source('road-delivery'), demoNow).impactKind).toBe('neutral');
    delivery.deliveryWindows = point().deliveryWindows;
    delivery.deliveryRouteStreets = [];
    expect(assessProductImpact([delivery], source('road-delivery'), demoNow).impactKind).toBe('neutral');
  });

  it.each(['essential', 'optional'] as const)('flags water risk for matching address, working time and %s dependency', dependency => {
    const bakery = point(1); bakery.waterDependency = dependency;
    const result = assessProductImpact([bakery], source('water-bakery'), demoNow);
    expect(result.impactKind).toBe('risk');
    expect(result.affectedLocationNames).toEqual([bakery.name]);
    expect(result.impactExplanation).toContain('корпус 2');
    expect(result.impactExplanation).toContain('08:00');
    expect(result.impactExplanation).toContain('07:00–20:00');
    expect(result.impactExplanation).toContain(dependency === 'essential' ? 'основных операций' : 'ограниченная зависимость');
  });

  it('keeps unknown water dependency, another building and off-hours neutral', () => {
    const bakery = point(1); bakery.waterDependency = 'unknown';
    expect(assessProductImpact([bakery], source('water-bakery'), demoNow).impactKind).toBe('neutral');
    expect(assessProductImpact([point(1)], source('water-neighbor'), demoNow).impactKind).toBe('neutral');
    bakery.waterDependency = 'essential'; bakery.openingHours = [{ days: [1], start: '12:00', end: '20:00' }];
    expect(assessProductImpact([bakery], source('water-bakery'), demoNow).impactKind).toBe('neutral');
  });

  it('keeps cancelled, completed and unsupported events neutral without affected points', () => {
    for (const key of ['road-cancelled', 'concert-past', 'unsupported-power']) {
      const result = assessProductImpact([point()], source(key), demoNow);
      expect(result.impactKind, key).toBe('neutral');
      expect(result.affectedLocationNames, key).toEqual([]);
    }
    const concert = source('concert-arena');
    expect(assessProductImpact([point()], concert, concert.endsAt!).impactKind).toBe('neutral');
    expect(assessProductImpact([], concert, demoNow).impactExplanation).toContain('Добавьте свою точку');
    expect(assessProductImpact([point()], null, demoNow).impactKind).toBe('neutral');
  });

  it('uses six fixed industries and a safe fallback for previous free text', () => {
    expect(BUSINESS_TYPES).toEqual(['Кофейня', 'Пекарня', 'Ресторан', 'Магазин', 'Услуги', 'Другое']);
    expect(EVENT_RADIUS_METERS).toBe(1000);
    expect(normalizeBusinessType('')).toBe('');
    expect(normalizeBusinessType('Ресторан')).toBe('Ресторан');
    expect(normalizeBusinessType('Свободное старое значение')).toBe('Другое');
  });

  it('uses business dependency recommendations for new categories without pretending they are water outages', () => {
    const publication = source('road-delivery');
    publication.category = 'digital_platform'; publication.categories = ['digital_platform']; publication.influence = 'risk';
    publication.entities = { platforms: ['CloudCart'] };
    publication.city = null; publication.street = null; publication.address = null; publication.vehicleRestriction = null;
    publication.evidence = [
      { field: 'category', quote: 'В сервисе CloudCart возможны перебои обработки заказов.' },
      { field: 'status', quote: 'Запланированы работы.' },
      { field: 'entities.platforms', quote: 'В сервисе CloudCart возможны перебои обработки заказов.' },
      { field: 'startsAt', quote: '14 ноября 2026 года с 09:00' }, { field: 'endsAt', quote: 'до 12:00' },
    ];
    const shop = { ...point(), businessContext: { platforms: ['CloudCart'], processes: [{ name: 'Приём заказов', platforms: ['CloudCart'] }], evidence: [] } };
    const result = assessProductImpact([shop], publication, demoNow);
    expect(result.impactKind).toBe('risk');
    expect(result.impactStatus).toBe('complete');
    expect(result.impactExplanation).toContain('Приём заказов');
    expect(result.impactExplanation).not.toContain('отключение воды');
    expect(result.recommendedAction).toContain('интеграции');
    expect(assessProductImpact([{ ...shop, businessContext: { platforms: ['CloudCart'], evidence: [] } }], publication, demoNow).impactKind).toBe('neutral');
  });

  it('keeps personal LIVE analysis pending without silently replacing it with a demo signal', () => {
    const fixture = demoMessages.find(item => item.key === 'road-delivery')!;
    const result = assessProductImpact([point()], fixture.extraction, demoNow, { isDemo: false,
      source: { text: fixture.text, publisher: fixture.publisher, publishedAt: fixture.publishedAt, timezone: fixture.timezone, sourceUrl: null } });
    expect(result.impactKind).toBe('neutral');
    expect(result.impactStatus).toBe('needs_clarification');
    expect(result.recommendedAction).toBeTruthy();
    expect(result.impactExplanation).toContain('оценку влияния');
    expect(result.impact).not.toContain('Учебный');
  });
});
