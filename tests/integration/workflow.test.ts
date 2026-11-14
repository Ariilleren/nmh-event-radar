import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { demoLocations, demoMessages } from '../../src/data/demo';

// Fail closed before importing or connecting a database client.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_test')) {
  throw new Error('Integration tests require a dedicated DATABASE_URL with database name ending in _test. No database was changed.');
}
process.env.AI_MODE = 'DEMO';
let db: typeof import('../../src/server/db').db;
let workflow: typeof import('../../src/server/workflow');
const actor = 'Интеграционный тест · не пользователь';

async function cleanTestDatabase() {
  // This function can only be reached after the mandatory _test guard above.
  await db.$transaction([
    db.task.deleteMany(), db.assessment.deleteMany(), db.analysis.deleteMany(), db.messageVersion.deleteMany(),
    db.sourceMessage.deleteMany(), db.event.deleteMany(), db.location.deleteMany(), db.audit.deleteMany(), db.company.deleteMany(),
  ]);
}

function inputFor(key: string, eventId?: string) {
  const fixture = demoMessages.find((item) => item.key === key)!;
  return { text: fixture.text, publisher: fixture.publisher, url: fixture.url, publishedAt: fixture.publishedAt,
    timezone: fixture.timezone, origin: 'manual', actor, ...(eventId ? { eventId } : {}) };
}

async function basicEvent(key = 'concert-arena') {
  const point = await workflow.saveLocation({ ...demoLocations[0], locationId: 'TEST-001', actor });
  const event = await workflow.addMessage(inputFor(key));
  await workflow.analyzeEvent(event.eventId, actor);
  return { point, eventId: event.eventId };
}

async function taskFor(eventId: string, locationId: string) {
  return workflow.createTask({ eventId, locationId, actor, owner: 'Тестовый менеджер', dueAt: '2026-11-15T12:00:00+03:00', comment: 'Уточнить условия и согласовать план работы' });
}

beforeAll(async () => {
  db = (await import('../../src/server/db')).db;
  workflow = await import('../../src/server/workflow');
  await db.$connect();
}, 30_000);
beforeEach(cleanTestDatabase, 30_000);
afterAll(async () => { if (db) await db.$disconnect(); });

describe('PostgreSQL workflow: identity, versions and preserved human decisions', () => {
  it('keeps a new source and a replacement of a cancelled event pending until analysis', async () => {
    await workflow.saveLocation({ ...demoLocations[0], locationId: 'TEST-001', actor });
    const created = await workflow.addMessage(inputFor('road-cancelled'));
    const unprocessed = await db.event.findUniqueOrThrow({ where: { id: created.eventId }, include: { assessments: true } });
    expect(unprocessed.status).toBe('pending');
    expect(unprocessed.extracted).toBeNull();
    expect(unprocessed.assessments[0].status).toBe('needs_review');
    await workflow.analyzeEvent(created.eventId, actor);
    expect((await db.event.findUniqueOrThrow({ where: { id: created.eventId } })).status).toBe('cancelled');
    await workflow.addMessage(inputFor('road-delivery', created.eventId));
    const replacement = await db.event.findUniqueOrThrow({ where: { id: created.eventId }, include: { assessments: true } });
    expect(replacement.status).toBe('pending');
    expect(replacement.extracted).toBeNull();
    expect(replacement.confirmed).toBe(false);
    expect(replacement.assessments[0].status).toBe('needs_review');
  });

  it('a different reanalysis after manual correction creates another event version and preserves the decision', async () => {
    const { point, eventId } = await basicEvent();
    const corrected = structuredClone(demoMessages.find((item) => item.key === 'concert-arena')!.extraction);
    corrected.recommendedAction = 'Проверить только подтверждённую заявку на дополнительную смену.';
    await workflow.correctEvent(eventId, { extraction: corrected, actor, comment: 'Уточнили рекомендуемое действие вручную.' });
    await workflow.confirmEvent(eventId, actor);
    const task = await taskFor(eventId, point.id);
    await workflow.updateTask(task.id, { status: 'done', decision: 'Проверили заявку по версии с ручным уточнением.', actor });
    const before = await db.event.findUniqueOrThrow({ where: { id: eventId } });
    await workflow.analyzeEvent(eventId, actor);
    const after = await db.event.findUniqueOrThrow({ where: { id: eventId }, include: { analyses: { orderBy: { createdAt: 'desc' } } } });
    expect(after.version).toBe(before.version + 1);
    expect(after.confirmed).toBe(false);
    expect(after.analyses[0].version).toBe(after.version);
    const savedTask = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(savedTask.eventVersion).toBe(before.version);
    expect(savedTask.needsReview).toBe(true);
    expect(savedTask.decision).toContain('с ручным уточнением');
    expect(await db.audit.count({ where: { entityId: eventId, action: 'Извлечение исправлено человеком' } })).toBe(1);
  });

  it('identical reanalysis keeps the version, human confirmation and reviewed task unchanged', async () => {
    const { point, eventId } = await basicEvent();
    await workflow.confirmEvent(eventId, actor);
    const task = await taskFor(eventId, point.id);
    await workflow.updateTask(task.id, { status: 'done', decision: 'Согласован план работы по указанным условиям.', actor });
    const before = await db.event.findUniqueOrThrow({ where: { id: eventId } });
    await workflow.analyzeEvent(eventId, actor);
    const after = await db.event.findUniqueOrThrow({ where: { id: eventId } });
    expect(after.version).toBe(before.version);
    expect(after.confirmed).toBe(true);
    const savedTask = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(savedTask.needsReview).toBe(false);
    expect(savedTask.status).toBe('done');
    expect(savedTask.eventVersion).toBe(before.version);
  });

  it('rejects a fabricated quotation spanning two source versions atomically', async () => {
    const original = inputFor('concert-arena');
    const { eventId } = await workflow.addMessage(original);
    const secondText = 'ГРАНИЦА ВТОРОГО ДОКУМЕНТА. Добавлены сведения для ручной проверки.';
    await workflow.addMessage({ ...original, eventId, text: secondText });
    const crossingQuote = 'Число посетителей неизвестно. ГРАНИЦА ВТОРОГО ДОКУМЕНТА.';
    expect(original.text).not.toContain(crossingQuote);
    expect(secondText).not.toContain(crossingQuote);
    expect(`${original.text}\n${secondText}`.replace(/\s+/g, ' ')).toContain(crossingQuote);
    const corrected = structuredClone(demoMessages.find((item) => item.key === 'concert-arena')!.extraction);
    corrected.evidence.find((item) => item.field === 'category')!.quote = crossingQuote;
    await expect(workflow.correctEvent(eventId, { extraction: corrected, actor, comment: 'Попытка склеить цитату из двух источников.' })).rejects.toThrow(/одном сохранённом исходнике/);
    const unchanged = await db.event.findUniqueOrThrow({ where: { id: eventId } });
    expect(unchanged.version).toBe(2);
    expect(unchanged.extracted).toBeNull();
    expect(await db.audit.count({ where: { entityId: eventId, action: 'Извлечение исправлено человеком' } })).toBe(0);
  });

  it('preserves both ends of a manually established source link during demo reset', async () => {
    await workflow.seedDemo(actor);
    const from = await db.event.findUniqueOrThrow({ where: { demoKey: 'concert-arena' } });
    const target = await db.event.findUniqueOrThrow({ where: { demoKey: 'road-delivery' } });
    await workflow.groupEvent(from.id, { targetEventId: target.id, actor, comment: 'Ручная учебная связь для проверки сохранности исходников.' });
    await workflow.resetDemo({ confirmation: 'СБРОСИТЬ ДЕМО', actor });
    const persisted = await db.event.findUniqueOrThrow({ where: { id: from.id } });
    expect(persisted.relatedEventId).toBe(target.id);
    const referenced = await db.event.findUniqueOrThrow({ where: { id: target.id }, include: { messages: { include: { versions: true } } } });
    expect(referenced.messages[0].versions[0].text).toBe(demoMessages.find((item) => item.key === 'road-delivery')!.text);
    expect(await db.audit.count({ where: { entityId: from.id, action: 'Указана возможная перепечатка; это не независимое подтверждение' } })).toBe(1);
  }, 30_000);

  it('imports the same message twice without another event, version or task', async () => {
    const { point, eventId } = await basicEvent();
    const task = await taskFor(eventId, point.id);
    const repeated = await workflow.addMessage(inputFor('concert-arena'));
    expect(repeated).toEqual({ eventId, duplicate: true });
    expect(await db.event.count()).toBe(1);
    expect(await db.messageVersion.count()).toBe(1);
    expect(await db.task.count()).toBe(1);
    expect((await taskFor(eventId, point.id)).id).toBe(task.id);
    expect(await db.task.count()).toBe(1);
  });

  it('new source version reevaluates, flags completed tasks and retains previous decision/history', async () => {
    const { point, eventId } = await basicEvent('festival-original');
    await workflow.confirmEvent(eventId, actor);
    const task = await taskFor(eventId, point.id);
    await workflow.updateTask(task.id, { status: 'done', decision: 'Согласовали смену по первоначальному расписанию.', actor });
    const changed = await workflow.addMessage(inputFor('festival-moved', eventId));
    expect(changed.duplicate).toBe(false);
    await workflow.analyzeEvent(eventId, actor);
    const updated = await db.event.findUniqueOrThrow({ where: { id: eventId }, include: { messages: { include: { versions: true } }, assessments: true } });
    expect(updated.version).toBe(2);
    expect(updated.confirmed).toBe(false);
    expect(updated.messages).toHaveLength(1);
    expect(updated.messages[0].versions).toHaveLength(2);
    expect(updated.assessments[0].eventVersion).toBe(2);
    const preserved = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(preserved.status).toBe('done');
    expect(preserved.needsReview).toBe(true);
    expect(preserved.decision).toContain('первоначальному расписанию');
    expect(await db.audit.count({ where: { entityId: task.id, action: 'Решение сотрудника сохранено' } })).toBe(1);
    // An explicit human re-affirmation may keep the same wording, but must record a new decision action.
    await workflow.updateTask(task.id, { status: 'done', decision: preserved.decision!, actor });
    const reaffirmed = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(reaffirmed.needsReview).toBe(false);
    expect(reaffirmed.eventVersion).toBe(updated.version);
    expect(reaffirmed.decision).toBe(preserved.decision);
    expect(await db.audit.count({ where: { entityId: task.id, action: 'Решение сотрудника сохранено' } })).toBe(2);
  });

  it('changing a location radius recomputes relevance and marks its tasks for review', async () => {
    const { point, eventId } = await basicEvent();
    const task = await taskFor(eventId, point.id);
    expect((await db.assessment.findFirstOrThrow({ where: { eventId } })).status).toBe('relevant');
    await workflow.saveLocation({ ...demoLocations[0], locationId: 'TEST-001', eventRadiusMeters: 10, actor }, point.id);
    const assessment = await db.assessment.findFirstOrThrow({ where: { eventId } });
    expect(assessment.status).toBe('excluded');
    expect(assessment.locationRevision).toBe(2);
    expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).needsReview).toBe(true);
  });

  it('transactional CSV import updates repeated ids and does not erase nonempty fields', async () => {
    const first = 'locationId;name;address;timezone;city;responsibleName\n00001;Первая;Москва, Учебная улица, дом 1;Europe/Moscow;Москва;Анна';
    expect(await workflow.importLocations(first, actor)).toEqual({ created: 1, updated: 0 });
    const repeat = 'locationId;name;address;timezone;city;responsibleName\n00001;Вторая;Москва, Учебная улица, дом 1;;;\n00001;Третья;Москва, Учебная улица, дом 1;;;';
    expect(await workflow.importLocations(repeat, actor)).toEqual({ created: 0, updated: 2 });
    const saved = await db.location.findUniqueOrThrow({ where: { locationId: '00001' } });
    expect(await db.location.count()).toBe(1);
    expect(saved.profile).toMatchObject({ name: 'Третья', city: 'Москва', responsibleName: 'Анна', timezone: 'Europe/Moscow' });
    await expect(workflow.importLocations('locationId;name;address;timezone\n00002;Верная;Адрес;Europe/Moscow\n00003;;Адрес;Europe/Moscow', actor)).rejects.toThrow(/предпросмотра/);
    expect(await db.location.count()).toBe(1);
  });

  it('demo reset retains manual records and a user task attached to a demo event', async () => {
    await workflow.seedDemo(actor);
    const demoEvent = await db.event.findUniqueOrThrow({ where: { demoKey: 'concert-arena' } });
    const demoPoint = await db.location.findUniqueOrThrow({ where: { locationId: 'DEMO-001' } });
    const task = await taskFor(demoEvent.id, demoPoint.id);
    const manualPoint = await workflow.saveLocation({ ...demoLocations[1], locationId: 'MANUAL-001', actor });
    const manualEvent = await workflow.addMessage({ ...inputFor('water-bakery'), publisher: 'Ввод пользователя' });
    await expect(workflow.resetDemo({ confirmation: 'случайный клик', actor })).rejects.toThrow();
    await workflow.resetDemo({ confirmation: 'СБРОСИТЬ ДЕМО', actor });
    expect(await db.task.findUnique({ where: { id: task.id } })).not.toBeNull();
    expect(await db.event.findUnique({ where: { id: demoEvent.id } })).not.toBeNull();
    expect(await db.location.findUnique({ where: { id: demoPoint.id } })).not.toBeNull();
    expect(await db.location.findUnique({ where: { id: manualPoint.id } })).not.toBeNull();
    expect(await db.event.findUnique({ where: { id: manualEvent.eventId } })).not.toBeNull();
    expect(await db.event.count({ where: { isDemo: true } })).toBe(1);
  }, 30_000);

  it('does not reset user modifications on repeated one-time seed', async () => {
    await workflow.seedDemo(actor, true);
    const point = await db.location.findUniqueOrThrow({ where: { locationId: 'DEMO-001' } });
    await workflow.saveLocation({ ...demoLocations[0], name: 'Сохранённое пользовательское название', actor }, point.id);
    const count = await db.event.count();
    expect(await workflow.seedDemo(actor, true)).toEqual({ skipped: true });
    expect((await db.location.findUniqueOrThrow({ where: { id: point.id } })).name).toBe('Сохранённое пользовательское название');
    expect(await db.event.count()).toBe(count);
  }, 30_000);

  it('keeps decision and audit after disconnect and a new Prisma client connection', async () => {
    const { point, eventId } = await basicEvent();
    const task = await taskFor(eventId, point.id);
    await expect(workflow.updateTask(task.id, { status: 'done', actor })).rejects.toThrow(/решение/);
    await workflow.updateTask(task.id, { status: 'done', decision: 'План подтверждён: перенесли доставку, объяснение сохранено.', actor });
    await db.$disconnect();
    const { PrismaClient } = await import('../../src/generated/prisma/client');
    const { PrismaPg } = await import('@prisma/adapter-pg');
    const fresh = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    try {
      const saved = await fresh.task.findUniqueOrThrow({ where: { id: task.id } });
      expect(saved.decision).toContain('перенесли доставку');
      expect(saved.status).toBe('done');
      expect(await fresh.audit.count({ where: { entityId: task.id, action: 'Решение сотрудника сохранено' } })).toBe(1);
    } finally { await fresh.$disconnect(); }
  });
});
