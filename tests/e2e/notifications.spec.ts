import { test, expect, type Page } from '@playwright/test';
import type { ProductEvent, ProductState } from '../../src/lib/product-types';

async function getState(page: Page): Promise<ProductState> {
  const response = await page.request.get('/api/product');
  expect(response.ok()).toBe(true);
  return response.json();
}

test('настоящий сервер: главная содержит только рекомендации, свежие новости остаются в уведомлениях', async ({ page }) => {
  // Uses the real test server and isolated demo data, without mocking analysis.
  const state = await getState(page);
  expect(state.notificationWindowDays).toBe(30);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Город меняется.');
  const recommendations = page.locator('[data-recommendation-id]');
  await expect.poll(() => recommendations.evaluateAll(cards => cards.map(card => card.getAttribute('data-recommendation-id')))).toEqual(state.recommendations.map(item => item.id));
  await expect(page.locator('[data-news-id], [data-advice-event-id], .pr-feed-toolbar')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Поиск по ленте' })).toHaveCount(0);
  for (const item of state.recommendations) {
    const card = page.locator('[data-recommendation-id="' + item.id + '"]');
    await expect(card.getByRole('heading', { name: item.title, exact: true })).toBeVisible();
    await expect(card.locator('.pr-recommendation-action')).toHaveText(item.action);
    await expect(card.locator('.pr-recommendation-reason')).toHaveText(item.reason);
    await expect(card.locator('.pr-impact-label')).toHaveText(item.type === 'opportunity' ? 'Возможность' : 'Угроза');
    await expect(card.locator('a[href="' + item.sourceUrl + '"]')).toBeVisible();
  }
  await page.getByRole('navigation', { name: 'Основное меню' }).getByRole('link', { name: 'Уведомления', exact: true }).click();
  await expect(page).toHaveURL(/\/notifications$/);
  await expect(page.getByRole('heading', { name: 'Уведомления.', exact: true, level: 1 })).toBeVisible();
  const cards = page.locator('[data-notification-event-id]');
  await expect.poll(() => cards.evaluateAll(items => items.map(card => card.getAttribute('data-notification-event-id')))).toEqual(state.notifications.map(notification => notification.eventId));
  for (const notification of state.notifications) {
    const event = state.events.find(event => event.id === notification.eventId)!;
    const card = page.locator('[data-notification-event-id="' + event.id + '"]');
    await expect(card.getByRole('button', { name: 'Открыть новость: ' + notification.title, exact: true })).toBeVisible();
    await expect(card.locator('a[href="' + event.sourceHref + '"]')).toBeVisible();
    await expect(card.getByRole('button', { name: 'Полезно: ' + event.title, exact: true })).toBeVisible();
    if (event.recommendedAction) await expect(card.locator('.pr-notification-advice')).toContainText(event.recommendedAction);
    if (event.impactKind === 'neutral') await expect(card.getByRole('button', { name: /^(Возможность|Риск)$/ })).toHaveCount(0);
    else await expect(card.getByRole('button', { name: event.impactKind === 'risk' ? 'Риск' : 'Возможность', exact: true })).toBeVisible();
  }
});

test('контракт UI с подменённым ответом: только серверные рекомендации и GET обновление без вызова анализа', async ({ page }) => {
  // This explicitly mocked DTO verifies rendering, not Groq availability or correctness.
  const snapshot = structuredClone(await getState(page));
  expect(snapshot.events.length).toBeGreaterThan(5);
  snapshot.sourceHealth = { status: 'ok', channel: 'newsssss09', message: '', lastAttemptAt: snapshot.now, lastSuccessAt: snapshot.now, fetched: 20, changed: 0 };
  snapshot.analysisHealth = { status: 'ready', message: '', pending: 0, completed: 6, errors: 0 };
  snapshot.recommendations = snapshot.events.slice(0, 6).reverse().map((event, index) => ({
    id: 'ui-contract-' + index, eventId: event.id, type: index % 2 ? 'threat' : 'opportunity',
    title: index === 0 ? 'Серверный заголовок <img src=x onerror=alert(1)>' : 'Решение сервера ' + index,
    action: 'Подготовьте дополнительную выпечку — совет сервера ' + index,
    reason: 'Влияние подтверждено условиями точки — объяснение сервера ' + index,
    locationIds: [], locationNames: ['Точка для проверки ' + index], processes: ['Доставка'],
    startsAt: '2026-11-17T15:00:00.000Z', endsAt: '2026-11-17T16:00:00.000Z',
    sourceUrl: 'https://t.me/newsssss09/' + (9000 + index),
  }));
  const methods: string[] = [];
  await page.route('**/api/product', route => { methods.push(route.request().method()); return route.fulfill({ json: snapshot }); });
  await page.clock.install();
  await page.goto('/');
  const cards = page.locator('[data-recommendation-id]');
  await expect.poll(() => cards.evaluateAll(items => items.map(card => card.getAttribute('data-recommendation-id')))).toEqual(snapshot.recommendations.map(item => item.id));
  await expect(cards).toHaveCount(6); // Component number 5 is not an arbitrary limit of five cards.
  await expect(cards.first().getByRole('heading')).toHaveText(snapshot.recommendations[0].title);
  await expect(cards.first().locator('img, script')).toHaveCount(0);
  await expect(page.locator('[data-news-id], [data-advice-event-id], .pr-feed-toolbar')).toHaveCount(0);
  for (const item of snapshot.recommendations) {
    const card = page.locator('[data-recommendation-id="' + item.id + '"]');
    await expect(card.locator('.pr-recommendation-action')).toHaveText(item.action);
    await expect(card.locator('.pr-recommendation-reason')).toHaveText(item.reason);
    await expect(card.locator('.pr-recommendation-facts')).toContainText(item.locationNames[0]);
    await expect(card.locator('.pr-recommendation-facts')).toContainText('Доставка');
    await expect(card.locator('.pr-recommendation-facts')).toContainText('17 ноября');
    await expect(card.getByRole('link', { name: 'Исходный пост', exact: true })).toHaveAttribute('href', item.sourceUrl);
  }
  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.bringToFront();
  expect(await page.evaluate(() => document.hidden)).toBe(false);
  snapshot.recommendations = [];
  // Old events/highlights are deliberately left populated: no fallback is allowed.
  await page.clock.fastForward(60_001);
  await expect(cards).toHaveCount(0);
  await expect(page.locator('[data-recommendations-empty]')).toBeVisible();
  expect(methods.length).toBeGreaterThanOrEqual(2);
  expect(methods.every(method => method === 'GET')).toBe(true);
});

test('подменённые статусы: ожидание, пустой результат, недоступный источник и ошибка AI различаются', async ({ page }) => {
  const snapshot = structuredClone(await getState(page));
  snapshot.recommendations = [];
  snapshot.sourceHealth = { status: 'ok', channel: 'newsssss09', message: '', lastAttemptAt: snapshot.now, lastSuccessAt: snapshot.now, fetched: 20, changed: 0 };
  snapshot.analysisHealth = { status: 'ready', message: '', pending: 0, completed: 0, errors: 0 };
  await page.route('**/api/product', route => route.fulfill({ json: snapshot }));
  await page.goto('/');
  await expect(page.locator('[data-recommendations-empty]')).toBeVisible();

  snapshot.sourceHealth.status = 'error';
  await page.reload();
  await expect(page.getByRole('alert').filter({ hasText: 'Источник временно недоступен' })).toBeVisible();
  await expect(page.locator('[data-recommendations-empty]')).toHaveCount(0);

  snapshot.sourceHealth.status = 'ok';
  snapshot.analysisHealth.status = 'missing_config';
  await page.reload();
  await expect(page.getByRole('alert').filter({ hasText: 'Анализ пока недоступен. Новости сохранены.' })).toBeVisible();
  await expect(page.locator('[data-recommendations-empty]')).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText('GROQ_API_KEY');

  snapshot.analysisHealth.status = 'pending';
  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: 'Анализируем новые сообщения' })).toBeVisible();
  await expect(page.locator('[data-recommendations-empty]')).toHaveCount(0);

  snapshot.sourceHealth.status = 'error';
  snapshot.analysisHealth.status = 'error';
  snapshot.recommendations = [{
    id: 'saved-advice', eventId: snapshot.events[0].id, type: 'threat', title: 'Сохранённая рекомендация',
    action: 'Проверьте маршрут доставки.', reason: 'В сохранённом сообщении ограничен проезд.',
    locationIds: [], locationNames: ['Кофейня'], processes: ['Доставка'], startsAt: null, endsAt: null,
    sourceUrl: 'https://t.me/newsssss09/9001',
  }];
  await page.reload();
  await expect(page.getByRole('alert').filter({ hasText: 'Источник временно недоступен' })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Анализ пока недоступен' })).toBeVisible();
  await expect(page.locator('[data-recommendation-id="saved-advice"]')).toBeVisible();
  await expect(page.locator('.pr-recommendation-facts')).toContainText('Период не указан в источнике');
  await expect(page.locator('[data-recommendations-empty]')).toHaveCount(0);
});

test('подменённый ответ: нейтральная новость показывает вопрос для уточнения без технической ошибки', async ({ page }) => {
  const snapshot = structuredClone(await getState(page));
  const event = snapshot.events[0];
  event.impactKind = 'neutral';
  event.impactStatus = 'needs_clarification';
  event.recommendedAction = null;
  event.impactExplanation = 'Нужно уточнить условия бизнеса. Есть ли у вашей точки доставка через указанную улицу?';
  await page.route('**/api/product', route => route.fulfill({ json: snapshot }));
  await page.goto('/news/' + event.id);
  await expect(page.locator('.pr-article-impact > p')).toHaveText(event.impactExplanation);
  await expect(page.locator('.pr-detail-context').getByRole('button', { name: /^(Возможность|Риск)$/ })).toHaveCount(0);
  event.impactStatus = 'error';
  event.impactExplanation = 'ProviderError GROQ_API_KEY token debug payload';
  await page.reload();
  await expect(page.locator('.pr-article-impact > p')).toHaveText('Анализ этой новости пока недоступен. Проверьте исходное сообщение.');
  await expect(page.locator('main')).not.toContainText('GROQ_API_KEY');
});

test('отказ прочтения не меняет статус; свежие новости остаются после дизлайка и прочтения всех', async ({ page }) => {
  await page.goto('/register');
  const registrationStatus = await page.evaluate(async email => {
    const response = await fetch('/api/product/auth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Проверка уведомлений', email, password: 'Уведомления надёжны 2026' }),
    });
    return response.status;
  }, `notices-${crypto.randomUUID()}@example.test`);
  expect(registrationStatus).toBe(200);
  const initial = await getState(page);
  expect(initial.notifications.length).toBeGreaterThan(0);
  const notification = initial.notifications.find(item => !item.readAt)!;
  expect(notification).toBeTruthy();
  const event = initial.events.find(item => item.id === notification.eventId) as ProductEvent;
  await page.goto('/notifications');
  const card = page.locator(`[data-notification-event-id="${event.id}"]`);
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: `Не для меня: ${event.title}`, exact: true }).click();
  await expect(card.getByRole('button', { name: `Не для меня: ${event.title}`, exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(card).toBeVisible();
  expect((await getState(page)).notifications.map(item => item.eventId)).toContain(event.id);
  let attempts = 0;
  await page.route('**/api/product/notifications/read', async route => {
    attempts += 1;
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Прочтение временно недоступно' } }) });
  });
  const open = card.getByRole('button', { name: `Открыть новость: ${notification.title}`, exact: true });
  await open.evaluate((element: HTMLButtonElement) => { element.click(); element.click(); });
  await expect(page.getByRole('alert').filter({ hasText: 'Прочтение временно недоступно' })).toBeVisible();
  expect(attempts).toBe(1);
  await expect(page).toHaveURL(/\/notifications$/);
  await expect(card.locator('.pr-unread-label')).toBeVisible();
  expect((await getState(page)).notifications.find(item => item.eventId === event.id)?.readAt).toBeNull();
  await expect(open).toBeDisabled();
  await page.unroute('**/api/product/notifications/read');
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await expect(open).toBeEnabled();
  await open.click();
  await expect(page).toHaveURL(new RegExp(`/news/${event.id}$`));
  const summary = page.locator('.pr-user-summary');
  await expect(summary.getByRole('heading', { name: 'Сводка для вас', exact: true })).toBeVisible();
  await expect(summary.locator('p')).toHaveCount(1);
  await expect(summary.locator('ul, ol, blockquote')).toHaveCount(0);
  await expect(page.locator('.pr-source details')).toHaveJSProperty('open', false);
  expect((await getState(page)).notifications.find(item => item.eventId === event.id)?.readAt).toBeTruthy();
  await page.getByRole('link', { name: 'К уведомлениям', exact: true }).click();
  await expect(page).toHaveURL(/\/notifications$/);
  await expect(card).toBeVisible();
  await expect(card.locator('.pr-unread-label')).toHaveCount(0);
  await page.getByRole('button', { name: 'Прочитать всё', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Всё прочитано' })).toBeVisible();
  const final = await getState(page);
  expect(final.notifications.every(item => item.readAt !== null)).toBe(true);
  await expect(page.locator('[data-notification-event-id]')).toHaveCount(final.notifications.length);
  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: 'Всё прочитано' })).toBeVisible();
  await expect(card).toBeVisible();
});
