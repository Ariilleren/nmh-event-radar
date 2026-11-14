import { test, expect } from '@playwright/test';

test('описание процессов сохраняется; DEMO честно сообщает, что новый профиль не разобран', async ({ page, request }) => {
  const locationId = `business-e2e-${Date.now()}`;
  const description = 'Пекарня. Выпечка ежедневно с 05:00 до 09:00, нужна вода. Продаём на Ozon.';
  await page.goto('/locations');
  await page.getByRole('button', { name: 'Добавить точку', exact: true }).click();
  await page.getByLabel(/Идентификатор/).fill(locationId);
  await page.getByLabel('Название *', { exact: true }).fill('Проверка бизнес-процессов');
  await page.getByLabel('Полный адрес, включая корпус *', { exact: true }).fill('Москва, Пекарский проезд, дом 7, корпус 2');
  await page.getByLabel('Бизнес и рабочие процессы', { exact: true }).fill(description);
  await page.getByRole('button', { name: 'Сохранить точку', exact: true }).click();
  await expect(page.getByText(/Разбор бизнес-процессов не выполнен/)).toBeVisible();
  const state = await (await request.get('/api/state')).json();
  const location = state.locations.find((item: { locationId: string }) => item.locationId === locationId);
  expect(location.businessDescription).toBe(description);
  expect(location.businessContext).toBeUndefined();
  expect(location.businessContextError).toContain('LIVE');
  await page.reload();
  const saved = await (await request.get('/api/state')).json();
  expect(saved.locations.find((item: { id: string }) => item.id === location.id).businessDescription).toBe(description);
});
