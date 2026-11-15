import { test, expect } from '@playwright/test';
import type { ProductState } from '../../src/lib/product-types';

test('новости имеют источник; плашка раскрывает персональное объяснение и возвращает фокус', async ({ page }) => {
  await page.goto('/notifications');
  await expect(page.locator('[data-notification-event-id]').first()).toBeVisible();
  const state: ProductState = await (await page.request.get('/api/product')).json();
  const displayedEvents = state.notifications.flatMap(notification => state.events.filter(event => event.id === notification.eventId));
  for (const event of displayedEvents) {
    const card = page.locator(`[data-notification-event-id="${event.id}"]`);
    await expect(card.locator(`a[href="${event.sourceHref}"]`).first()).toBeVisible();
    const label = event.impactKind === 'opportunity' ? 'Возможность' : event.impactKind === 'risk' ? 'Риск' : null;
    if (label) await expect(card.getByRole('button', { name: label, exact: true })).toBeVisible();
    else await expect(card.getByRole('button', { name: /^(Возможность|Риск)$/ })).toHaveCount(0);
  }
  for (const kind of ['opportunity', 'risk'] as const) {
    // Unknown or irrelevant conditions must not be promoted just to exercise a badge.
    const event = displayedEvents.find(item => item.impactKind === kind);
    if (!event) continue;
    const badge = page.locator(`[data-notification-event-id="${event.id}"]`).getByRole('button', { name: kind === 'risk' ? 'Риск' : 'Возможность', exact: true });
    await badge.click();
    const panel = page.getByRole('dialog');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(event.impactExplanation);
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(badge).toBeFocused();
  }
  const original = displayedEvents.find(event => event.sourceHref.startsWith('/sources/'))!;
  await page.locator(`[data-notification-event-id="${original.id}"]`).locator(`a[href="${original.sourceHref}"]`).first().click();
  await expect(page).toHaveURL(new RegExp(original.sourceHref + '$'));
  await expect(page.getByRole('navigation', { name: 'Основное меню' })).toBeVisible();
  await expect(page.locator('.pr-source-text').first()).toHaveText(original.sourceText);
  await expect(page.locator('main')).toContainText(original.sourceName);
  await page.screenshot({ path: '.local/process-screens/source-1440.png' });
});

for (const width of [320, 768, 1440]) test(`новое меню и объяснение ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/');
  const menu = page.getByRole('navigation', { name: 'Основное меню' });
  await expect(menu.getByRole('link')).toHaveCount(3);
  await expect(menu.getByRole('link', { name: 'Лента', exact: true })).toBeVisible();
  await expect(menu.getByRole('link', { name: 'Карта', exact: true })).toBeVisible();
  await expect(menu.getByRole('link', { name: 'Уведомления', exact: true })).toHaveAttribute('href', '/notifications');
  await expect(menu.getByRole('link', { name: 'Профиль', exact: true })).toHaveCount(0);
  await menu.getByRole('link', { name: 'Уведомления', exact: true }).click();
  const state: ProductState = await (await page.request.get('/api/product')).json();
  const eligible = state.events.find(event => event.impactKind !== 'neutral' && state.notifications.some(notification => notification.eventId === event.id));
  if (eligible) {
    await page.locator(`[data-notification-event-id="${eligible.id}"]`).getByRole('button', { name: eligible.impactKind === 'risk' ? 'Риск' : 'Возможность', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `.local/process-screens/impact-${width}.png` });
    await page.keyboard.press('Escape');
  }
  await menu.getByRole('link', { name: 'Уведомления', exact: true }).click();
  await expect(page).toHaveURL(/\/notifications$/);
  await expect(page.getByRole('heading', { name: 'Уведомления.', exact: true, level: 1 })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('редактирование профиля: отказ не теряет черновик, повтор сохраняется после перезагрузки', async ({ page }) => {
  await page.goto('/register');
  const response = await page.evaluate(async email => {
    const result = await fetch('/api/product/auth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ирина', email, password: 'Проверка черновика 2026' }),
    });
    return result.status;
  }, `profile-${crypto.randomUUID()}@example.test`);
  expect(response).toBe(200);
  await page.goto('/profile');
  await page.getByLabel('Ваше имя', { exact: true }).fill('Ирина Петрова');
  await page.getByLabel('Название бизнеса', { exact: true }).fill('Наша пекарня');
  await page.getByLabel('Чем занимаетесь', { exact: true }).selectOption('Пекарня');
  await page.route('**/api/product/profile', route => route.fulfill({
    status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Сохранение временно недоступно' } }),
  }));
  const save = page.getByRole('button', { name: 'Сохранить изменения', exact: true });
  await save.click();
  await expect(page.getByRole('alert').filter({ hasText: 'Сохранение временно недоступно' })).toBeVisible();
  expect((await (await page.request.get('/api/product')).json()).user.name).toBe('Ирина');
  await page.unroute('**/api/product/profile');
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await expect(save).toBeEnabled();
  await expect(page.getByLabel('Ваше имя', { exact: true })).toHaveValue('Ирина Петрова');
  await expect(page.getByLabel('Чем занимаетесь', { exact: true })).toHaveValue('Пекарня');
  await save.click();
  await expect(page.getByRole('status')).toContainText('Профиль сохранён');
  await page.reload();
  await expect(page.getByLabel('Ваше имя', { exact: true })).toHaveValue('Ирина Петрова');
  await expect(page.getByLabel('Название бизнеса', { exact: true })).toHaveValue('Наша пекарня');
  await expect(page.getByLabel('Чем занимаетесь', { exact: true })).toHaveValue('Пекарня');
});


test('подменённый геокодер: адрес точки не теряет ручные правки, повтор и город сохраняются без запросов при открытии', async ({ page }) => {
  // A controlled browser contract test; it does not claim an OSM lookup or authenticated save.
  const snapshot: ProductState = structuredClone(await (await page.request.get('/api/product')).json());
  const location = snapshot.locations[0];
  expect(location).toBeTruthy();
  snapshot.user = { id: 'geocode-ui-user', name: 'Анна', email: 'geocode-ui@example.test', photo: null, businessName: 'Кофе', businessType: 'Кофейня', city: '', about: '' };
  snapshot.locations = [location];
  let lookups = 0;
  let firstReleased = false;
  let clearReleased = false;
  let releaseFirst: (() => void) | undefined;
  let releaseClear: (() => void) | undefined;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const clearGate = new Promise<void>(resolve => { releaseClear = resolve; });
  let submitted: Record<string, unknown> | null = null;
  await page.route('**/api/product', route => route.fulfill({ json: snapshot }));
  await page.route('**/api/product/locations/*', async route => {
    submitted = route.request().postDataJSON();
    snapshot.locations[0] = { ...location, ...submitted };
    await route.fulfill({ json: snapshot });
  });
  await page.route('**/api/product/geocode/reverse?*', async route => {
    lookups += 1;
    const attempt = lookups;
    expect(route.request().method()).toBe('GET');
    if (attempt === 1) {
      await firstGate;
      await route.fulfill({ json: { address: 'Поздний ответ, дом 1', city: 'Поздний город' } }).catch(() => {});
      firstReleased = true;
    } else if (attempt === 2) {
      await route.fulfill({ status: 502, json: { error: { message: 'Адрес временно недоступен' } } });
    } else if (attempt === 6) {
      await clearGate;
      await route.fulfill({ json: { address: 'Ответ для снятой отметки', city: 'Поздний город' } }).catch(() => {});
      clearReleased = true;
    } else {
      await route.fulfill({ json: { address: 'Адрес по отметке, дом ' + attempt, city: attempt === 5 ? 'Зеленоград' : 'Москва' } });
    }
  });
  await page.route('https://tile.openstreetmap.org/**', route => route.abort());
  await page.clock.install();
  await page.goto('/profile');
  await page.getByRole('button', { name: 'Редактировать ' + location.name, exact: true }).click();
  const address = page.getByLabel('Адрес, дом и корпус');
  const city = page.locator('#location-city');
  const status = page.locator('#location-geocode-status');
  const save = page.getByRole('button', { name: 'Сохранить точку', exact: true });
  const choose = page.getByRole('button', { name: 'Поставить точку в центре карты', exact: true });
  await expect(choose).toBeEnabled();
  await page.clock.fastForward(600);
  expect(lookups).toBe(0);
  await expect(address).toHaveValue(location.address);
  await choose.click();
  await expect(save).toBeDisabled();
  await page.clock.fastForward(501);
  await expect.poll(() => lookups).toBe(1);
  await address.fill('Мой ручной адрес, дом 9');
  await city.fill('Тверь');
  await expect(save).toBeEnabled();
  releaseFirst!();
  await expect.poll(() => firstReleased).toBe(true);
  await expect(address).toHaveValue('Мой ручной адрес, дом 9');
  await expect(city).toHaveValue('Тверь');

  await choose.click();
  await page.clock.fastForward(501);
  await expect(status).toContainText('Не удалось определить адрес');
  await expect(address).toHaveValue('Мой ручной адрес, дом 9');
  await expect(save).toBeEnabled();
  await page.getByRole('button', { name: 'Повторить определение адреса', exact: true }).click();
  await expect(save).toBeDisabled();
  await page.clock.fastForward(501);
  await expect(address).toHaveValue('Адрес по отметке, дом 3');
  await expect(city).toHaveValue('Тверь');
  await city.fill('');
  await choose.click();
  await page.clock.fastForward(501);
  await expect(city).toHaveValue('Москва');
  await choose.click();
  await page.clock.fastForward(501);
  await expect(city).toHaveValue('Зеленоград');
  await expect(address).toHaveValue('Адрес по отметке, дом 5');
  await expect(status.getByRole('link', { name: 'OpenStreetMap', exact: true })).toHaveAttribute('href', 'https://www.openstreetmap.org/copyright');
  await save.click();
  await expect(page.locator('.pr-location-form')).toHaveCount(0);
  expect(submitted).toMatchObject({ address: 'Адрес по отметке, дом 5', city: 'Зеленоград', openingHours: location.openingHours, deliveryWindows: location.deliveryWindows });
  await page.getByRole('button', { name: 'Редактировать ' + location.name, exact: true }).click();
  await expect(choose).toBeEnabled();
  await page.clock.fastForward(600);
  expect(lookups).toBe(5);
  await expect(address).toHaveValue('Адрес по отметке, дом 5');
  await choose.click();
  await page.clock.fastForward(501);
  await expect.poll(() => lookups).toBe(6);
  await page.getByRole('button', { name: 'Убрать отметку', exact: true }).click();
  await expect(save).toBeEnabled();
  releaseClear!();
  await expect.poll(() => clearReleased).toBe(true);
  await expect(address).toHaveValue('Адрес по отметке, дом 5');
  await expect(page.locator('input[name="latitude"]')).toHaveValue('');
  await expect(page.locator('input[name="longitude"]')).toHaveValue('');
});
