import { describe, expect, it } from 'vitest';
import { INDUSTRY_CONFIG } from '../../src/domain/business';
import { compareAddress, evaluate } from '../../src/domain/evaluate';
import { locationSchema, type BusinessContext, type Extraction } from '../../src/domain/schemas';

const days = [1, 2, 3, 4, 5, 6, 7];
const now = '2026-11-16T04:00:00+03:00';
const bakery = (context: Partial<BusinessContext> = {}) => locationSchema.parse({
  locationId: 'bakery', name: 'Тестовая пекарня', address: 'Москва, Пекарский проезд, дом 7, корпус 2', city: 'Москва', timezone: 'Europe/Moscow',
  latitude: 55.755, longitude: 37.62, eventRadiusMeters: 1000,
  openingHours: [{ days, start: '08:00', end: '20:00' }],
  businessDescription: 'Ежедневно выпекаем хлеб с 05:00 до 08:00; для выпечки нужна вода.',
  businessContext: { industry: 'foodservice', resources: ['water'], processes: [{ name: 'Выпечка', resources: ['water'], schedule: [{ days, start: '05:00', end: '08:00' }] }], evidence: [{ field: 'resources', quote: 'для выпечки нужна вода' }], ...context },
});
const water = (changes: Partial<Extraction> = {}): Extraction => ({
  category: 'water_outage', title: 'Тестовое отключение', summary: 'Отключение воды по адресу.', status: 'scheduled',
  startsAt: '2026-11-16T05:30:00+03:00', endsAt: '2026-11-16T07:00:00+03:00', timezone: 'Europe/Moscow',
  city: 'Москва', street: 'Пекарский проезд', address: 'Москва, Пекарский проезд, дом 7, корпус 2',
  latitude: null, longitude: null, vehicleRestriction: null,
  impactHypothesis: 'Может ограничить работу.', recommendedAction: 'Произвольная рекомендация модели',
  evidence: ['category', 'status', 'startsAt', 'endsAt', 'city', 'street', 'address'].map((field) => ({ field, quote: 'Москва, Пекарский проезд, дом 7, корпус 2: 16 ноября с 05:30 до 07:00 запланировано отключение воды.' })),
  ...changes,
});
const platform = (changes: Partial<Extraction> = {}): Extraction => ({
  ...water(), category: 'commercial', title: 'Тестовое изменение комиссии', summary: 'Площадка Маркет Тест меняет комиссию.',
  startsAt: null, endsAt: null, timezone: null, city: null, street: null, address: null,
  entities: { platforms: ['Маркет Тест'] }, influence: 'risk',
  evidence: ['category', 'status', 'entities.platforms'].map((field) => ({ field, quote: 'Маркет Тест объявил об изменении комиссии.' })),
  ...changes,
});

describe('business process matching', () => {
  it('keeps all thirteen industry presets as guidance, without inventing dependencies', () => {
    expect(Object.keys(INDUSTRY_CONFIG)).toHaveLength(13);
    const result = evaluate(bakery({ resources: [], processes: [] }), water(), now);
    expect(result.relevance).toBe('insufficient_data');
    expect(result.missingData).toContain('Затронутый ресурс и его использование в бизнесе');
  });

  it('warns about water during production before the shop opens', () => {
    const result = evaluate(bakery(), water(), now);
    expect(result).toMatchObject({ status: 'relevant', relevance: 'direct', influence: 'risk', priority: 'urgent' });
    expect(result.reason).toContain('Выпечка');
    expect(result.nextAction).toContain('Выпечка');
    expect(result.nextAction).not.toBe(water().recommendedAction);
    expect(result.conditions.find((item) => item.key === 'process_time')?.result).toBe('match');
  });

  it('uses a standalone production schedule independently of opening hours', () => {
    const result = evaluate(bakery({ processes: [], productionHours: [{ days, start: '05:00', end: '08:00' }] }), water(), now);
    expect(result.relevance).toBe('direct');
    expect(result.reason).toContain('производственная смена');
  });

  it('does not exclude early production when the user gave only its starting time', () => {
    const point = bakery({ processes: [{ name: 'Выпечка', resources: ['water'] }] });
    point.businessDescription = 'Выпечка начинается в 5 утра; нужна вода.';
    const result = evaluate(point, water(), now);
    expect(result).toMatchObject({ status: 'needs_review', relevance: 'insufficient_data' });
    expect(result.missingData).toContain('Полный график затронутого процесса');
  });

  it('does not discard an unspecified process schedule when water dependency came from an old profile field', () => {
    const point = bakery({ resources: [], processes: [{ name: 'Выпечка' }] });
    point.waterDependency = 'essential';
    expect(evaluate(point, water(), now).relevance).toBe('insufficient_data');
  });

  it('never assigns a cooking resource to an unrelated delivery process', () => {
    const point = bakery({ resources: [], processes: [
      { name: 'Готовка', resources: ['water'], schedule: [{ days, start: '08:00', end: '10:00' }] },
      { name: 'Доставка', schedule: [{ days, start: '05:00', end: '07:00' }] },
    ] });
    const result = evaluate(point, water(), now);
    expect(result.relevance).toBe('insufficient_data');
    expect(result.reason).not.toContain('Доставка');
    point.businessContext!.processes = point.businessContext!.processes!.slice(0, 1);
    expect(evaluate(point, water({ startsAt: '2026-11-16T11:00:00+03:00', endsAt: '2026-11-16T12:00:00+03:00' }), now).relevance).toBe('unrelated');
  });

  it('rejects a neighboring house even with identical city, resource and production time', () => {
    const result = evaluate(bakery(), water({ address: 'Москва, Пекарский проезд, дом 9, корпус 2' }), now);
    expect(result).toMatchObject({ status: 'excluded', relevance: 'unrelated', priority: 'routine' });
  });

  it('keeps missing building or unit uncertain instead of applying a radius', () => {
    expect(evaluate(bakery(), water({ address: 'Пекарский проезд' }), now).relevance).toBe('insufficient_data');
    expect(evaluate(bakery(), water({ address: 'Москва, Пекарский проезд, дом 7' }), now).relevance).toBe('insufficient_data');
    expect(compareAddress('Москва, Пекарский проезд, дом 7', 'Пекарский проезд, дом 7', 'Москва')).toBe('match');
    const point = bakery(); point.city = null; point.address = 'Пекарский проезд, дом 7';
    expect(evaluate(point, water({ city: null, address: 'Пекарский проезд, дом 7' }), now).relevance).toBe('insufficient_data');
  });

  it('uses a quoted address list and still requires an exact building match', () => {
    const address = 'Москва, Пекарский проезд, дом 7, корпус 2';
    const event = water({ address: null, affectedAddresses: [address] });
    event.evidence.push({ field: 'affectedAddresses', quote: address });
    expect(evaluate(bakery(), event, now).relevance).toBe('direct');
  });

  it('checks resource identity for utility categories beyond water', () => {
    const event = water({ category: 'utilities', affectedResources: ['electricity'] });
    event.evidence.push({ field: 'affectedResources', quote: 'Отключение электричества.' });
    const point = bakery({ resources: ['electricity'], processes: [{ name: 'Выпечка', resources: ['electricity'], schedule: [{ days, start: '05:00', end: '08:00' }] }] });
    expect(evaluate(point, event, now).relevance).toBe('direct');
    expect(evaluate(bakery(), event, now).relevance).toBe('insufficient_data');
  });

  it('treats a nearby concert as an opportunity, without promising revenue', () => {
    const event = water({ category: 'mass_event', startsAt: '2026-11-16T12:00:00+03:00', endsAt: '2026-11-16T14:00:00+03:00', latitude: 55.76085, longitude: 37.62 });
    event.evidence.push({ field: 'latitude', quote: '55.76085' }, { field: 'longitude', quote: '37.62' });
    const result = evaluate(bakery(), event, now);
    expect(result).toMatchObject({ status: 'relevant', relevance: 'potential', influence: 'opportunity', priority: 'upcoming' });
    expect(result.distanceMeters).toBeCloseTo(650.49, 0);
    expect(result.consequences?.join(' ')).toContain('не подтверждён');
    expect(result.nextAction).not.toMatch(/\d+\s*%/u);
  });

  it('matches a delivery process route and schedule independently of retail opening hours', () => {
    const point = bakery({ processes: [{ name: 'Утренний рейс', routes: ['улица Складская'], schedule: [{ days, start: '05:00', end: '07:00' }] }] });
    const event = water({ category: 'road_closure', street: 'ул. Складская', vehicleRestriction: true });
    event.evidence.push({ field: 'vehicleRestriction', quote: 'Движение автомобилей закрыто.' });
    const result = evaluate(point, event, now);
    expect(result).toMatchObject({ relevance: 'direct', status: 'relevant' });
    expect(result.reason).toContain('Утренний рейс');
    expect(result.nextAction).toContain('объезд');
    event.city = null;
    expect(evaluate(point, event, now).relevance).toBe('insufficient_data');
  });

  it('does not infer a route from the industry or location address', () => {
    const event = water({ category: 'road_closure', vehicleRestriction: true });
    event.evidence.push({ field: 'vehicleRestriction', quote: 'Движение закрыто.' });
    expect(evaluate(bakery({ industry: 'logistics' }), event, now).relevance).toBe('insufficient_data');
  });

  it('matches marketplace commission changes without any geography or event end', () => {
    const point = bakery({ industry: 'ecommerce', platforms: ['Маркет Тест'], processes: [{ name: 'Продажа на площадке', platforms: ['Маркет Тест'] }] });
    point.city = null;
    const result = evaluate(point, platform(), now);
    expect(result).toMatchObject({ status: 'relevant', relevance: 'direct', priority: 'routine' });
    expect(result.reason).toContain('Продажа на площадке');
    expect(result.conditions.some((condition) => condition.key === 'city')).toBe(false);
    expect(result.nextAction).toContain('условия');
  });

  it('does not confuse a similarly named provider with the configured one', () => {
    expect(evaluate(bakery({ platforms: ['Маркет Тест Плюс'] }), platform(), now).relevance).toBe('unrelated');
    expect(evaluate(bakery({ platforms: [] }), platform(), now).relevance).toBe('insufficient_data');
  });

  it('ignores provider identities without their own literal source evidence', () => {
    const event = platform();
    event.evidence = event.evidence.filter((item) => item.field !== 'entities.platforms');
    expect(evaluate(bakery({ platforms: ['Маркет Тест'] }), event, now).relevance).toBe('insufficient_data');
  });

  it('does not infer a platform-wide outage from an incident at a distant warehouse', () => {
    const event = platform({ category: 'incident', city: 'Тверь' });
    event.evidence.push({ field: 'city', quote: 'Тверь' });
    expect(evaluate(bakery({ platforms: ['Маркет Тест'] }), event, now).relevance).toBe('unrelated');
  });

  it('matches a requested service as a potential procurement opportunity', () => {
    const event = platform({ category: 'procurement', entities: { services: ['Бухгалтерское сопровождение'] }, influence: 'opportunity' });
    event.evidence.push({ field: 'entities.services', quote: 'Бухгалтерское сопровождение' });
    expect(evaluate(bakery({ services: ['Бухгалтерское сопровождение'] }), event, now)).toMatchObject({ status: 'relevant', relevance: 'potential', influence: 'opportunity' });
  });

  it('checks product scope before applying platform-specific terms', () => {
    const event = platform({ entities: { platforms: ['Маркет Тест'], products: ['Одежда'] } });
    event.evidence.push({ field: 'entities.products', quote: 'Одежда' });
    expect(evaluate(bakery({ platforms: ['Маркет Тест'], products: ['Одежда'] }), event, now).relevance).toBe('direct');
    expect(evaluate(bakery({ platforms: ['Маркет Тест'], products: ['Обувь'] }), event, now).relevance).toBe('unrelated');
    expect(evaluate(bakery({ platforms: ['Маркет Тест'] }), event, now).relevance).toBe('insufficient_data');
    expect(evaluate(bakery({ platforms: ['Другая площадка'], products: ['Одежда'] }), event, now).relevance).toBe('unrelated');
  });

  it('downgrades a proposed change and bases urgency on a quoted deadline', () => {
    const point = bakery({ platforms: ['Маркет Тест'] });
    const proposed = platform({ factStatus: 'proposed' });
    proposed.evidence.push({ field: 'factStatus', quote: 'Предложено изменение.' });
    expect(evaluate(point, proposed, now).relevance).toBe('potential');
    const dated = platform({ responseDeadline: '2026-11-16T12:00:00+03:00' });
    expect(evaluate(point, dated, now).priority).toBe('routine');
    dated.evidence.push({ field: 'responseDeadline', quote: 'Подать заявку до 16 ноября, 12:00.' });
    expect(evaluate(point, dated, now).priority).toBe('urgent');
  });

  it('keeps profile model errors explicit and cancellation inactive', () => {
    const point = bakery();
    delete point.businessContext;
    point.businessContextError = 'Ошибка модели';
    expect(evaluate(point, water(), now)).toMatchObject({ relevance: 'insufficient_data', status: 'needs_review' });
    expect(evaluate(point, water({ status: 'cancelled' }), now)).toMatchObject({ status: 'inactive', priority: 'routine' });
  });

  it('does not mutate source facts or user profile', () => {
    const point = bakery(), event = water();
    const before = JSON.stringify([point, event]);
    evaluate(point, event, now);
    expect(JSON.stringify([point, event])).toBe(before);
  });
});
