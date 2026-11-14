import { test, expect } from '@playwright/test';

test('точка → исходник → разбор → основания → задача → решение → история',async({page,request})=>{
  await page.goto('/locations');
  await expect(page.getByRole('heading',{name:'Точки бизнеса',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Добавить точку',exact:true}).click();
  await page.getByLabel(/Идентификатор/).fill('e2e-'+Date.now());
  await page.getByLabel('Название *',{exact:true}).fill('E2E учебная кофейня');
  await page.getByLabel('Полный адрес, включая корпус *',{exact:true}).fill('Москва, Учебная улица, д. 55');
  await page.getByRole('button',{name:'Сохранить точку',exact:true}).click();
  await expect(page.getByText('E2E учебная кофейня',{exact:true})).toBeVisible();
  await page.goto('/events');
  await page.getByRole('button',{name:'Добавить сообщение',exact:true}).click();
  await page.getByLabel('Подставить учебный текст').selectOption({index:1});
  const sourceText=await page.getByLabel('Исходный текст *').inputValue();
  await page.getByRole('button',{name:'Сохранить сообщение',exact:true}).click();
  await expect(page.getByText('Исходное сообщение сохранено. Запустите разбор, чтобы оценить влияние.',{exact:true})).toBeVisible();
  const state=await (await request.get('/api/state')).json();
  const event=state.events.find((item:{messages:{origin:string;versions:{text:string}[]}[]})=>item.messages.some(message=>message.origin==='manual' && message.versions.some(version=>version.text===sourceText)));
  expect(event).toBeTruthy();
  await page.goto(`/events/${event.id}`);
  await page.getByRole('button',{name:'Разобрать сообщение',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Почему касается точки',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Подтвердить сведения',exact:true}).click();
  await page.getByRole('button',{name:'Создать задачу',exact:true}).first().click();
  await page.getByLabel('Ответственный *').fill('Менеджер E2E');
  await page.getByLabel('Срок *').fill('2026-11-15T16:00');
  await page.getByLabel('Что нужно сделать *').fill('Согласовать вечернюю смену. Учебная задача E2E.');
  await page.getByRole('button',{name:'Создать задачу',exact:true}).last().click();
  await page.getByRole('button',{name:'Изменить статус',exact:true}).last().click();
  await page.getByLabel('Статус',{exact:true}).selectOption('done');
  await page.getByLabel('Решение и объяснение *').fill('Учебное решение E2E: смена согласована, запас проверен менеджером.');
  await page.getByRole('button',{name:'Сохранить решение',exact:true}).click();
  await page.reload();
  await expect(page.getByText('Учебное решение E2E: смена согласована, запас проверен менеджером.',{exact:true}).first()).toBeVisible();
  await page.goto(`/history?event=${event.id}`);
  await expect(page.getByText('Решение сотрудника сохранено',{exact:true}).first()).toBeVisible();
});

for(const width of [320,768,1440]) test(`обзор ${width}px без переполнения страницы`,async({page})=>{
  await page.setViewportSize({width,height:900});
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'Что требует решения',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.keyboard.press('Tab');
  expect(await page.evaluate(()=>document.activeElement?.tagName!=='BODY')).toBe(true);
});
