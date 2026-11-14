import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const base = process.env.UI_BASE_URL || 'http://127.0.0.1:3000';
const directory = new URL('../.local/screenshots/', import.meta.url);
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('response', (response) => { if (response.url().includes('/api/') && !response.ok()) console.log('API ERROR', response.status(), response.url()); });
page.setDefaultTimeout(45000);
const checks = [];
async function snapshot(name, width) {
  await page.setViewportSize({ width, height: 1000 });
  await page.waitForTimeout(200);
  const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  assert.ok(dimensions.scroll <= dimensions.width, `${name}: document overflow ${JSON.stringify(dimensions)}`);
  await page.screenshot({ path: new URL(`${name}-${width}.png`, directory).pathname.replace(/^\/(.:)/, '$1'), fullPage: true });
  checks.push(`${name} ${width}px: no global overflow`);
}
try {
  await page.goto(base, { waitUntil: 'networkidle', timeout: 120000 });
  await page.getByRole('heading', { name: 'Что требует решения' }).waitFor();
  for (const width of [1440, 768, 320]) await snapshot('overview', width);
  await page.goto(`${base}/locations`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Редактировать профиль' }).first().click();
  await snapshot('location-editor', 320);
  await page.goto(`${base}/events`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Добавить сообщение' }).click();
  await page.getByLabel('Подставить учебный текст').selectOption('concert-arena');
  const publisher = `Учебный UI QA ${Date.now()}`;
  const owner = `Сотрудник UI QA ${Date.now()}`;
  await page.getByLabel('Издатель или источник').fill(publisher);
  await page.getByRole('button', { name: 'Сохранить сообщение', exact: true }).click();
  await page.waitForTimeout(1000);
  console.log('AFTER SUBMIT', await page.getByRole('alert').allTextContents(), await page.locator('input:invalid,textarea:invalid,select:invalid').evaluateAll((items) => items.map((item) => ({ id: item.id, value: item.value, message: item.validationMessage }))));
  await page.getByRole('status').filter({ hasText: 'Исходное сообщение сохранено' }).waitFor();
  let state = await (await page.request.get(`${base}/api/state`)).json();
  const event = state.events.find((item) => item.messages.some((message) => message.publisher === publisher));
  assert.ok(event, 'UI saved a source message to PostgreSQL');
  await page.goto(`${base}/events/${event.id}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Разобрать сообщение', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Разбор сохранён' }).waitFor();
  await page.getByRole('button', { name: 'Подтвердить сведения', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Сведения отмечены' }).waitFor();
  await page.getByRole('button', { name: 'Создать задачу', exact: true }).first().click();
  await page.getByLabel('Ответственный', { exact: false }).fill(owner);
  await page.getByLabel('Срок', { exact: false }).fill('2026-11-15T17:00');
  await page.getByRole('button', { name: 'Создать задачу', exact: true }).last().click();
  await page.getByRole('status').filter({ hasText: 'Внутренняя задача создана' }).waitFor();
  state = await (await page.request.get(`${base}/api/state`)).json();
  const task = state.tasks.find((item) => item.owner === owner);
  assert.ok(task, 'UI created the task');
  await page.goto(`${base}/tasks`, { waitUntil: 'networkidle' });
  const card = page.locator(`[data-task-id="${task.id}"]`);
  await card.getByRole('button', { name: 'Изменить статус' }).click();
  await card.getByLabel('Статус', { exact: true }).selectOption('done');
  await card.getByLabel('Решение и объяснение', { exact: false }).fill('Учебная проверка: вечерняя смена и запас согласованы с ответственным.');
  await card.getByRole('button', { name: 'Сохранить решение' }).click();
  await page.getByRole('status').filter({ hasText: 'Статус и решение сохранены' }).waitFor();
  state = await (await page.request.get(`${base}/api/state`)).json();
  assert.equal(state.tasks.find((item) => item.id === task.id).status, 'done');
  assert.ok(state.history.some((entry) => entry.entityId === task.id && entry.action.includes('Решение')));
  checks.push('manual source → DEMO analysis → human confirmation → task → decision: real API + PostgreSQL');
  await page.goto(`${base}/events/${event.id}`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'История события и решений' }).waitFor();
  for (const width of [1440, 768, 320]) await snapshot('event-detail', width);
  for (const route of ['events', 'tasks', 'history', 'settings']) {
    await page.goto(`${base}/${route}`, { waitUntil: 'networkidle' });
    await snapshot(route, 320);
  }
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'К содержимому');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'main-content');
  checks.push('keyboard skip link focuses main content');
  assert.deepEqual(errors, [], 'No client runtime errors');
  await writeFile(new URL('ui-results.json', directory), JSON.stringify({ checks, eventId: event.id, taskId: task.id, errors }, null, 2));
  console.log(JSON.stringify({ checks, eventId: event.id, taskId: task.id, errors }, null, 2));
} catch (error) {
  console.log('VISIBLE ALERTS', await page.getByRole('alert').allTextContents());
  console.log('INVALID INPUTS', await page.locator(':invalid').evaluateAll((items) => items.map((item) => ({ id: item.id, value: item.value, message: item.validationMessage }))));
  await page.screenshot({ path: new URL('failure.png', directory).pathname.replace(/^\/(.:)/, '$1'), fullPage: true });
  throw error;
} finally { await browser.close(); }
