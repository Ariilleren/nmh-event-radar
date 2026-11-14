import { test, expect } from '@playwright/test';

test('проверенный учебный сигнал показывает факт, процесс, гипотезу и действие для точки', async ({ page, request }) => {
  const state=await (await request.get('/api/state')).json();
  const event=state.events.find((item: {assessments:{impact?:{signal?:unknown}}[]})=>item.assessments.some(assessment=>assessment.impact?.signal));
  expect(event).toBeTruthy();
  const assessment=event.assessments.find((item:{impact?:{signal?:unknown}})=>item.impact?.signal);
  await page.goto(`/events/${event.id}`);
  const analysis=page.getByTestId('impact-analysis').filter({has:page.getByTestId('business-signal')}).first();
  await expect(analysis.getByText('Факт из публикации',{exact:true})).toBeVisible();
  await expect(analysis.getByText('Гипотеза влияния',{exact:true})).toBeVisible();
  await expect(analysis.getByText(/Затронутый процесс:/)).toBeVisible();
  await expect(analysis.getByTestId('business-signal').getByText(/Рекомендуемое действие:/)).toHaveCount(1);
  await expect(analysis.getByText(assessment.impact.signal.title,{exact:true})).toBeVisible();
});

test('ошибка оценки влияния видна и итоговый сигнал отсутствует', async ({ page, request }) => {
  const state=await (await request.get('/api/state')).json();
  const event=state.events.find((item:{assessments:unknown[]})=>item.assessments.length);
  for(const assessment of event.assessments) {
    if(assessment.impact) assessment.impact={...assessment.impact,status:'error',signal:null,question:null,error:{code:'AI_HTTP_ERROR',message:'Ошибка LIVE API: HTTP 429. Лимит запросов или квота исчерпаны.'}};
  }
  await page.route('**/api/state',route=>route.fulfill({json:state}));
  await page.goto(`/events/${event.id}`);
  await expect(page.getByRole('alert').filter({hasText:'HTTP 429'}).first()).toBeVisible();
  await expect(page.getByTestId('business-signal')).toHaveCount(0);
});

test('источник Telegram доступен в форме получения сообщений', async ({ page, request }) => {
  const config=await (await request.get('/api/sources/telegram')).json();
  expect(config.source.channel).toBe('newsssss09');
  await page.goto('/events');
  await page.getByRole('button',{name:'Добавить сообщение',exact:true}).click();
  await page.getByRole('button',{name:'Telegram',exact:true}).click();
  await expect(page.getByRole('link',{name:'@newsssss09',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Получить сообщения Telegram',exact:true})).toBeVisible();
});
