import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { demoLocations, demoMessages } from '../../src/data/demo';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_test')) {
  throw new Error('Product integration tests require an isolated *_test database. No database was changed.');
}
process.env.AI_MODE = 'DEMO';
process.env.RADAR_DEMO_MODE = 'true';
let db: typeof import('../../src/server/db').db;
let product: typeof import('../../src/server/product');
let api: typeof import('../../src/app/api/product/[[...path]]/route');
const password = 'Отдельный пароль 2026';

async function account(name = 'Владелец') {
  return product.register({ name, email: `${randomUUID()}@example.test`, password });
}
async function event(key: string) {
  const fixture = demoMessages.find(item => item.key === key)!;
  const unique = randomUUID();
  return db.event.create({ data: {
    title: fixture.extraction.title, category: fixture.extraction.category, status: fixture.extraction.status,
    extracted: fixture.extraction, version: 1, isDemo: true,
    messages: { create: { publisher: fixture.publisher, url: fixture.url, publishedAt: fixture.publishedAt,
      timezone: fixture.timezone, origin: 'demo', isDemo: true, fingerprint: unique,
      versions: { create: { version: 1, text: fixture.text, contentHash: unique, fingerprint: unique, metadata: {} } } } },
  } });
}
async function request(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path = '', body?: unknown, token?: string, origin: string | null = 'http://localhost:3000') {
  const headers: Record<string, string> = { 'content-type': 'application/json', host: 'localhost:3000' };
  if (token) headers.cookie = `${product.sessionCookie}=${token}`;
  if (origin !== null) headers.origin = origin;
  return api[method](new NextRequest(`http://localhost:3000/api/product${path ? '/' + path : ''}`, {
    method, headers, ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
  }), { params: Promise.resolve({ path: path ? path.split('/') : undefined }) });
}

beforeAll(async () => {
  db = (await import('../../src/server/db')).db;
  product = await import('../../src/server/product');
  api = await import('../../src/app/api/product/[[...path]]/route');
  await db.$connect();
}, 30_000);
beforeEach(async () => {
  await db.$transaction([
    db.user.deleteMany(), db.task.deleteMany(), db.assessment.deleteMany(), db.analysis.deleteMany(),
    db.messageVersion.deleteMany(), db.sourceMessage.deleteMany(), db.event.deleteMany(),
    db.location.deleteMany(), db.audit.deleteMany(), db.company.deleteMany(),
  ]);
  await db.company.create({ data: {} });
}, 30_000);
afterAll(async () => { if (db) await db.$disconnect(); });

describe('Product accounts, ownership, personal ranking and persisted notifications', () => {
  it('stores salted password and session hashes, normalizes email, expires and revokes sessions', async () => {
    const email = `User-${randomUUID()}@EXAMPLE.TEST`;
    const created = await product.register({ name: 'Анна', email, password });
    expect(created.user.email).toBe(email.toLowerCase());
    expect(created.user.passwordHash).toMatch(/^scrypt:[a-f0-9]{48}:[a-f0-9]{128}$/);
    expect(created.user.passwordHash).not.toContain(password);
    const storedSession = await db.session.findFirstOrThrow({ where: { userId: created.user.id } });
    expect(storedSession.tokenHash).not.toBe(created.token);
    expect(storedSession.tokenHash).toBe(createHash('sha256').update(created.token).digest('hex'));
    await expect(product.login({ email, password: 'wrong password' })).rejects.toMatchObject({ statusCode: 401 });
    const loggedIn = await product.login({ email, password });
    expect((await product.sessionUser(loggedIn.token))?.id).toBe(created.user.id);
    const state = await product.getProductState(created.user);
    expect(state.locations).toEqual([]);
    expect(JSON.stringify(state)).not.toContain('passwordHash');
    expect(JSON.stringify(state)).not.toContain(loggedIn.token);
    await product.logout(loggedIn.token);
    expect(await product.sessionUser(loggedIn.token)).toBeNull();
    await db.session.update({ where: { tokenHash: storedSession.tokenHash }, data: { expiresAt: new Date(0) } });
    expect(await product.sessionUser(created.token)).toBeNull();
  });

  it('sets an HttpOnly SameSite cookie and rejects cross-origin or anonymous mutations', async () => {
    const response = await request('POST', 'auth/register', { name: 'Илья', email: `${randomUUID()}@example.test`, password });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(response.headers.get('set-cookie')).toContain('SameSite=lax');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect((await response.json()).user.name).toBe('Илья');
    expect((await request('PATCH', 'profile', { name: 'Чужой' })).status).toBe(401);
    expect((await request('POST', 'auth/login', {}, undefined, 'https://attacker.test')).status).toBe(403);
    expect((await request('POST', 'auth/register', {}, undefined, null)).status).toBe(403);
    const guest = await (await request('GET')).json();
    expect(guest.user).toBeNull();
    expect(guest.locations).toHaveLength(3);
    expect(guest.locations.every((point: { isDemo: boolean }) => point.isDemo)).toBe(true);
    expect(guest.notifications).toEqual([]);
  });

  it('isolates personal points and rejects another account’s update, delete, and owner injection', async () => {
    const a = await account('А'), b = await account('Б');
    const created = await request('POST', 'locations', { ...demoLocations[0], locationId: 'MY-001' }, a.token);
    expect(created.status).toBe(200);
    const point = (await created.json()).locations[0];
    expect((await request('PATCH', `locations/${point.id}`, { name: 'Взлом' }, b.token)).status).toBe(404);
    expect((await request('DELETE', `locations/${point.id}`, {}, b.token)).status).toBe(404);
    expect((await request('PATCH', `locations/${point.id}`, { userId: b.user.id }, a.token)).status).toBe(400);
    expect((await product.getProductState(b.user)).locations).toEqual([]);
    expect((await product.getProductState(a.user)).locations[0].name).toBe(demoLocations[0].name);
    await product.savePersonalLocation(b.user.id, { ...demoLocations[1], locationId: 'MY-001' });
    expect(await db.userLocation.count()).toBe(2);
    expect(await db.location.count()).toBe(0);
    const changed = await request('PATCH', `locations/${point.id}`, { name: 'Моя новая точка' }, a.token);
    expect((await changed.json()).locations[0].name).toBe('Моя новая точка');
    expect((await request('DELETE', `locations/${point.id}`, {}, a.token)).status).toBe(200);
    expect((await product.getProductState(a.user)).locations).toEqual([]);
    expect((await product.getProductState(b.user)).locations).toHaveLength(1);
  });

  it('uses the browser Host for CSRF when Next reconstructs an internal localhost URL', async () => {
    const a = await account('Production origin');
    const invoke = (origin: string, forwardedHost?: string) => api.PATCH(new NextRequest('http://localhost:3100/api/product/profile', {
      method: 'PATCH', headers: { host: '127.0.0.1:3100', origin, 'content-type': 'application/json',
        cookie: `${product.sessionCookie}=${a.token}`, ...(forwardedHost ? { 'x-forwarded-host': forwardedHost } : {}) },
      body: JSON.stringify({ businessName: 'Сохранено с реального origin' }),
    }), { params: Promise.resolve({ path: ['profile'] }) });
    expect((await invoke('http://127.0.0.1:3100')).status).toBe(200);
    expect((await product.requireUser(a.token)).businessName).toBe('Сохранено с реального origin');
    expect((await invoke('http://localhost:3100')).status).toBe(403);
    expect((await invoke('https://127.0.0.1:3100')).status).toBe(403);
    expect((await invoke('https://attacker.test', 'attacker.test')).status).toBe(403);
  });

  it('persists business and photo only for its owner and validates decoded image bytes', async () => {
    const a = await account('Фото'), b = await account('Другой');
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE3sAAAAASUVORK5CYII=';
    const saved = await request('PATCH', 'profile', { photo: png, businessName: 'Кофейня', businessType: 'Кофейня', city: 'Москва', about: 'Две точки' }, a.token);
    expect(saved.status).toBe(200);
    const fresh = await product.getProductState(await product.requireUser(a.token));
    expect(fresh.user).toMatchObject({ photo: png, businessName: 'Кофейня', city: 'Москва' });
    expect((await product.getProductState(b.user)).user?.photo).toBeNull();
    const fake = `data:image/png;base64,${Buffer.from('<svg onload="alert(1)"></svg>').toString('base64')}`;
    expect((await request('PATCH', 'profile', { photo: fake }, a.token)).status).toBe(400);
    expect(() => product.validatePhoto(`data:image/jpeg;base64,${Buffer.alloc(500 * 1024 + 1).toString('base64')}`)).toThrow('500 КБ');
    expect((await product.getProductState(await product.requireUser(a.token))).user?.photo).toBe(png);
    await product.updateProfile(a.user.id, { photo: null });
    expect((await product.requireUser(a.token)).photo).toBeNull();
  });

  it('uses personal evaluation and feedback to reorder news without leaking preferences', async () => {
    const a = await account('Ранжирование'), b = await account('Без предпочтений');
    const concert = await event('concert-arena'), road = await event('road-delivery');
    await product.savePersonalLocation(a.user.id, demoLocations[0]);
    let state = await product.getProductState(a.user);
    expect(state.events.find(item => item.id === concert.id)?.relevantLocationIds).toHaveLength(1);
    await product.setFeedback(a.user.id, road.id, { value: 1 });
    await product.setFeedback(a.user.id, concert.id, { value: -1 });
    state = await product.getProductState(await product.requireUser(a.token));
    expect(state.events[0].id).toBe(road.id);
    expect(state.events.find(item => item.id === concert.id)?.feedback).toBe(-1);
    expect((await product.getProductState(b.user)).events.every(item => item.feedback === null)).toBe(true);
    await product.setFeedback(a.user.id, road.id, { value: null });
    expect((await product.getProductState(a.user)).events.find(item => item.id === road.id)?.feedback).toBeNull();
    await expect(product.setFeedback(a.user.id, road.id, { value: 2 })).rejects.toThrow();
  });

  it('persists notification reads per user and makes a new source version unread', async () => {
    const a = await account('Уведомления'), b = await account('Чужие уведомления');
    const news = await event('concert-arena');
    expect((await product.getProductState(a.user)).unreadCount).toBe(1);
    expect((await product.getProductState(b.user)).unreadCount).toBe(1);
    const read = await request('POST', 'notifications/read', { eventId: news.id }, a.token);
    expect((await read.json()).unreadCount).toBe(0);
    expect((await product.getProductState(await product.requireUser(a.token))).notifications[0].readAt).not.toBeNull();
    expect((await product.getProductState(b.user)).unreadCount).toBe(1);
    await db.event.update({ where: { id: news.id }, data: { version: { increment: 1 }, title: 'Уточнение даты концерта' } });
    const updated = await product.getProductState(a.user);
    expect(updated.unreadCount).toBe(1);
    expect(updated.notifications).toHaveLength(1);
    expect(await db.userNotification.count({ where: { userId: a.user.id, eventId: news.id } })).toBe(2);
    expect(updated.notifications.find(item => item.readAt === null)?.eventId).toBe(news.id);
    await product.markNotificationsRead(a.user.id, {});
    expect((await product.getProductState(a.user)).unreadCount).toBe(0);
  });

  it('never invents map coordinates and exposes only source-backed quotes', async () => {
    const withCoordinates = await event('concert-arena');
    const withoutCoordinates = await event('road-delivery');
    const state = await product.getProductState(null);
    const concert = state.events.find(item => item.id === withCoordinates.id)!;
    expect(concert.latitude).not.toBeNull();
    expect(concert.longitude).not.toBeNull();
    expect(concert.quotes.every(quote => concert.sourceText.includes(quote))).toBe(true);
    expect(state.events.find(item => item.id === withoutCoordinates.id)?.latitude).toBeNull();
    const fixture = structuredClone(demoMessages.find(item => item.key === 'concert-arena')!.extraction);
    fixture.latitude = 99 / 2;
    await db.event.update({ where: { id: withCoordinates.id }, data: { extracted: fixture } });
    expect((await product.getProductState(null)).events.find(item => item.id === withCoordinates.id)?.latitude).toBeNull();
    const owner = await account('Проверка происхождения координат');
    await product.savePersonalLocation(owner.user.id, { ...demoLocations[0], latitude: fixture.latitude, longitude: fixture.longitude });
    expect((await product.getProductState(owner.user)).events.find(item => item.id === withCoordinates.id)?.impactKind).toBe('neutral');
  });

  it('validates fixed industries and safely reads legacy free-text profiles', async () => {
    const a = await account('Сфера бизнеса');
    expect((await product.getProductState(a.user)).user?.businessType).toBe('');
    for (const businessType of ['Кофейня', 'Пекарня', 'Ресторан', 'Магазин', 'Услуги', 'Другое', '']) {
      expect((await request('PATCH', 'profile', { businessType }, a.token)).status).toBe(200);
    }
    expect((await request('PATCH', 'profile', { businessType: 'Новая произвольная отрасль' }, a.token)).status).toBe(400);
    await expect(product.register({ name: 'Ошибка', email: `${randomUUID()}@example.test`, password, businessType: 'Кофе' })).rejects.toThrow();
    await db.user.update({ where: { id: a.user.id }, data: { businessType: 'Старый свободный текст' } });
    expect((await product.getProductState(await product.requireUser(a.token))).user?.businessType).toBe('Другое');
  });

  it('enforces the common radius on save and legacy reads while preserving personal process fields', async () => {
    const a = await account('Процессы'), b = await account('Чужие процессы');
    const road = await event('road-delivery');
    const created = await product.savePersonalLocation(a.user.id, { ...demoLocations[0], eventRadiusMeters: 99_999, waterDependency: 'optional' });
    let state = await product.getProductState(a.user);
    expect(state.locations[0].eventRadiusMeters).toBe(1000);
    expect(state.events.find(item => item.id === road.id)?.impactKind).toBe('risk');
    const windows = [{ days: [1], start: '07:00', end: '09:00' }];
    await product.savePersonalLocation(a.user.id, { deliveryWindows: windows }, created.id);
    state = await product.getProductState(a.user);
    expect(state.locations[0].deliveryWindows).toEqual(windows);
    expect(state.locations[0].waterDependency).toBe('optional');
    expect(state.events.find(item => item.id === road.id)?.impactKind).toBe('neutral');
    await db.userLocation.update({ where: { id: created.id }, data: { profile: { ...demoLocations[0], eventRadiusMeters: 5, deliveryWindows: windows, waterDependency: 'optional' } } });
    expect((await product.getProductState(a.user)).locations[0].eventRadiusMeters).toBe(1000);
    expect((await product.getProductState(null)).locations.every(item => item.eventRadiusMeters === 1000)).toBe(true);
    expect((await request('PATCH', `locations/${created.id}`, { waterDependency: 'essential', deliveryWindows: [] }, b.token)).status).toBe(404);
    expect((await product.getProductState(a.user)).locations[0].waterDependency).toBe('optional');
  });

  it('links every source to stored HTTP(S) or an honest local copy and keeps original versions', async () => {
    const news = await event('concert-arena');
    const savedSource = await db.sourceMessage.findFirstOrThrow({ where: { eventId: news.id } });
    const fixture = demoMessages.find(item => item.key === 'concert-arena')!;
    let state = await product.getProductState(null);
    expect(state.events[0].sourceHref).toBe(`/sources/${news.id}`);
    expect(state.events[0].sourceText).toBe(fixture.text);
    await db.event.update({ where: { id: news.id }, data: { isDemo: false } });
    await db.sourceMessage.update({ where: { id: savedSource.id }, data: { isDemo: false, origin: 'manual', url: 'https://example.test/source/1' } });
    state = await product.getProductState(null);
    expect(state.events[0].sourceHref).toBe('https://example.test/source/1');
    for (const url of [null, 'javascript:alert(1)', 'https://username:password@example.test/source']) {
      await db.sourceMessage.update({ where: { id: savedSource.id }, data: { url } });
      expect((await product.getProductState(null)).events[0].sourceHref).toBe(`/sources/${news.id}`);
    }
    const updatedText = `${fixture.text}\nСохранённое уточнение: проверка времени продолжается.`;
    await db.messageVersion.create({ data: { messageId: savedSource.id, version: 2, text: updatedText,
      contentHash: randomUUID(), fingerprint: randomUUID(), metadata: { publisher: 'Сохранённый издатель', publishedAt: '2026-11-14T09:00:00+03:00', secret: 'MUST-NOT-LEAK' } } });
    state = await product.getProductState(null);
    expect(state.events[0].sourceText).toBe(updatedText);
    expect(state.events[0].sourceVersions.map(item => item.text)).toEqual([updatedText, fixture.text]);
    expect(state.events[0].sourceVersions[0].publisher).toBe('Сохранённый издатель');
    expect(state.events[0].sourceVersions[0].publishedAt).toBe('2026-11-14T09:00:00+03:00');
    expect(state.events[0].sourceVersions[1].publishedAt).toBeNull();
    expect(state.events[0].sourceVersions[1].publisher).toBe('Издатель в этой версии не сохранён');
    expect(JSON.stringify(state)).not.toContain('MUST-NOT-LEAK');
  });

  it('returns every recent event including neutral, disliked and read news, and only the newest notification version', async () => {
    const owner = await account('Вся история');
    const neutral = await event('concert-place-unknown'), disliked = await event('road-cancelled'), expired = await event('concert-past');
    const old = new Date(Date.now() - 31 * 86_400_000);
    await db.event.update({ where: { id: expired.id }, data: { updatedAt: old } });
    await db.sourceMessage.updateMany({ where: { eventId: expired.id }, data: { receivedAt: old } });
    await product.setFeedback(owner.user.id, disliked.id, { value: -1 });
    let state = await product.getProductState(owner.user);
    expect(state.notificationWindowDays).toBe(30);
    expect(state.notifications.map(item => item.eventId).sort()).toEqual([neutral.id, disliked.id].sort());
    await product.markNotificationsRead(owner.user.id, { eventId: neutral.id });
    state = await product.getProductState(owner.user);
    expect(state.notifications.find(item => item.eventId === neutral.id)?.readAt).not.toBeNull();
    expect(state.notifications).toHaveLength(2);
    const guest = await product.getProductState(null);
    expect(guest.notifications.map(item => item.eventId).sort()).toEqual([neutral.id, disliked.id].sort());
    expect(guest.highlightEventIds).toEqual([]);
    await db.event.update({ where: { id: neutral.id }, data: { version: { increment: 1 } } });
    state = await product.getProductState(owner.user);
    expect(state.notifications.filter(item => item.eventId === neutral.id)).toHaveLength(1);
    expect(state.notifications.find(item => item.eventId === neutral.id)?.readAt).toBeNull();
    expect(await db.userNotification.count({ where: { userId: owner.user.id, eventId: neutral.id, readAt: { not: null } } })).toBe(1);
  });

  it('selects at most two recent verified highlights by urgency before votes and keeps them after reading', async () => {
    const owner = await account('Важное');
    const concert = await event('concert-arena'), road = await event('road-delivery'), water = await event('water-bakery');
    for (const [news, key] of [[road, 'road-delivery'], [water, 'water-bakery']] as const) {
      const fixture = demoMessages.find(item => item.key === key)!;
      const extraction = { ...fixture.extraction,
        startsAt: fixture.extraction.startsAt!.replace('11-16', '11-14'), endsAt: fixture.extraction.endsAt!.replace('11-16', '11-14'),
        evidence: fixture.extraction.evidence.map(item => ({ ...item, quote: item.quote.replaceAll('16 ноября', '14 ноября') })) };
      await db.event.update({ where: { id: news.id }, data: { extracted: extraction } });
      await db.messageVersion.updateMany({ where: { message: { eventId: news.id } }, data: { text: fixture.text.replaceAll('16 ноября', '14 ноября') } });
    }
    await product.savePersonalLocation(owner.user.id, { ...demoLocations[0], deliveryWindows: [{ days: [6], start: '10:00', end: '11:00' }] });
    await product.savePersonalLocation(owner.user.id, demoLocations[1]);
    await product.setFeedback(owner.user.id, concert.id, { value: 1 });
    await product.setFeedback(owner.user.id, road.id, { value: -1 });
    let state = await product.getProductState(owner.user);
    expect(state.highlightEventIds).toHaveLength(2);
    expect(state.highlightEventIds).toContain(road.id);
    expect(state.highlightEventIds).toContain(water.id);
    for (const id of state.highlightEventIds) {
      const selected = state.events.find(item => item.id === id)!;
      expect(selected.impactStatus).toBe('complete');
      expect(selected.recommendedAction).toBeTruthy();
      expect(selected.priorityReason).toBeTruthy();
      expect(state.notifications.some(item => item.eventId === id)).toBe(true);
    }
    await product.markNotificationsRead(owner.user.id, {});
    expect((await product.getProductState(owner.user)).highlightEventIds).toEqual(state.highlightEventIds);
    const old = new Date(Date.now() - 31 * 86_400_000);
    await db.event.update({ where: { id: water.id }, data: { updatedAt: old } });
    await db.sourceMessage.updateMany({ where: { eventId: water.id }, data: { receivedAt: old } });
    state = await product.getProductState(owner.user);
    expect(state.highlightEventIds).not.toContain(water.id);
    expect(state.highlightEventIds).toContain(concert.id);
  });

  it('inherits the exact split-event source and hides stale effects until its current version is analyzed', async () => {
    const original = await event('concert-arena');
    const message = await db.sourceMessage.findFirstOrThrow({ where: { eventId: original.id } });
    const fixture = demoMessages.find(item => item.key === 'concert-arena')!;
    const split = await db.event.create({ data: { title: 'Выделенное событие', category: fixture.extraction.category, status: fixture.extraction.status, isDemo: true,
      extracted: { ...fixture.extraction, provenance: { sourceEventId: original.id, sourceMessageId: message.id, sourceVersion: 1, sourceExtractionKey: 'test-split' } } } });
    let state = await product.getProductState(null);
    expect(state.events.find(item => item.id === split.id)).toMatchObject({ sourceText: fixture.text, sourceName: fixture.publisher, impactKind: 'opportunity', impactStatus: 'complete' });
    const updated = `${fixture.text}\nОпубликовано новое уточнение.`;
    await db.messageVersion.create({ data: { messageId: message.id, version: 2, text: updated, contentHash: randomUUID(), fingerprint: randomUUID(), metadata: {} } });
    state = await product.getProductState(null);
    expect(state.events.find(item => item.id === split.id)).toMatchObject({ sourceText: updated, impactKind: 'neutral', impactStatus: 'needs_clarification' });
    expect(state.highlightEventIds).not.toContain(split.id);
    expect(state.events.find(item => item.id === split.id)?.sourceVersions.map(item => item.text)).toEqual([updated, fixture.text]);
    expect(state.events.find(item => item.id === split.id)?.impactExplanation).toContain('повторный разбор');
    expect(state.events.find(item => item.id === split.id)?.relevance).toContain('повторный разбор');
    expect(state.events.find(item => item.id === split.id)?.relevance).not.toContain('отменено');
  });

  it('does not substitute a demo impact for a manual source attached to a former demo event', async () => {
    const news = await event('concert-arena');
    expect((await product.getProductState(null)).events.find(item => item.id === news.id)?.impactStatus).toBe('complete');
    await db.sourceMessage.updateMany({ where: { eventId: news.id }, data: { isDemo: false, origin: 'manual', url: 'https://example.test/manual-source' } });
    const state = await product.getProductState(null);
    expect(state.events.find(item => item.id === news.id)).toMatchObject({ impactKind: 'neutral', impactStatus: 'needs_clarification' });
    expect(state.highlightEventIds).not.toContain(news.id);
    expect(state.events.find(item => item.id === news.id)?.recommendedAction).toBeTruthy();
  });

  it('uses an explicit industry without inventing dependencies and never trusts client-derived business context', async () => {
    const created = await product.register({ name: 'Отрасль', email: `${randomUUID()}@example.test`, password, businessType: 'Пекарня' });
    const news = await event('water-bakery');
    const point = await product.savePersonalLocation(created.user.id, { ...demoLocations[1], waterDependency: 'unknown',
      businessContext: { resources: ['water'], evidence: [] }, businessContextError: null });
    let state = await product.getProductState(created.user);
    expect(state.locations[0].businessContext?.industry).toBe('foodservice');
    expect(state.locations[0].businessContext?.resources).toBeUndefined();
    expect(state.events.find(item => item.id === news.id)?.impactKind).toBe('neutral');
    await product.savePersonalLocation(created.user.id, { businessDescription: 'Выпекаем хлеб, используем воду.', waterDependency: 'essential' }, point.id);
    state = await product.getProductState(created.user);
    expect(state.locations[0].businessContext).toBeUndefined();
    expect(state.locations[0].businessContextError).toContain('LIVE');
    expect(state.events.find(item => item.id === news.id)?.impactKind).toBe('neutral');
  });
});
