import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { demoLocations, demoMessages } from '../../src/data/demo';
import type { AiOptions } from '../../src/ai';
import type { BusinessContext, Extraction } from '../../src/domain/schemas';

const databaseUrl=process.env.DATABASE_URL;
if(!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Business workflow tests require a dedicated DATABASE_URL ending in _test.');
process.env.AI_MODE='DEMO';
let db:typeof import('../../src/server/db').db;
let workflow:typeof import('../../src/server/workflow');
const actor='Тест персонального разбора';
const fixture=(key:string)=>demoMessages.find(message=>message.key===key)!;
function options(value:unknown,raw=false):AiOptions {
  return {env:{AI_MODE:'LIVE',AI_BASE_URL:'https://example.test/v1',AI_MODEL:'test-model',AI_API_KEY:'test-key'},fetchImpl:async(_url,init)=>{
    const request=JSON.parse(String(init?.body));
    const input=JSON.parse(request.messages.find((item:{role:string})=>item.role==='user').content);
    let response=value;
    if(Array.isArray(input.allowedProcesses)) {
      const process=input.allowedProcesses[0];
      const fact=input.extraction.evidence.find((item:{field:string})=>item.field==='category').quote;
      response={fact,affectedProcess:process,possibleImpact:`Из-за события из публикации процесс «${process}» может потребовать изменения порядка работы.`,assumptions:['Фактические последствия требуют проверки сотрудником.'],evidence:[{field:'fact',quote:fact}],effect:input.extraction.category==='mass_event'?'opportunity':'threat',title:`Проверить влияние на процесс «${process}»`,recommendedAction:`Уточнить порядок работы процесса «${process}» у ответственного за точку.`,question:null};
    }
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:raw ? response : JSON.stringify(response)}}]}),{status:200,headers:{'content-type':'application/json'}});
  }};
}
function message(text:string,eventId?:string) {
  return {text,publisher:'Проверяемый тестовый издатель',url:null,publishedAt:'2026-11-14T08:00:00+03:00',timezone:'Europe/Moscow',origin:'manual',actor,...(eventId?{eventId}:{})};
}
const description='Пекарня. Ежедневно выпечка с 05:00 до 08:00, нужна вода. Используем Ozon.';
const context:BusinessContext={industry:'foodservice',platforms:['Ozon'],resources:['water'],productionHours:[{days:[1,2,3,4,5,6,7],start:'05:00',end:'08:00'}],processes:[{name:'выпечка',resources:['water'],schedule:[{days:[1,2,3,4,5,6,7],start:'05:00',end:'08:00'}]}],evidence:[{field:'industry',quote:'Пекарня.'},{field:'platforms',quote:'Используем Ozon.'},{field:'resources',quote:'нужна вода'},{field:'productionHours',quote:description},{field:'processes.0.name',quote:'выпечка'},{field:'processes.0.resources',quote:'нужна вода'},{field:'processes.0.schedule',quote:description}]};

beforeAll(async()=>{db=(await import('../../src/server/db')).db;workflow=await import('../../src/server/workflow');await db.$connect();});
beforeEach(async()=>{await db.$transaction([db.task.deleteMany(),db.assessment.deleteMany(),db.analysis.deleteMany(),db.messageVersion.deleteMany(),db.sourceMessage.deleteMany(),db.event.deleteMany(),db.location.deleteMany(),db.audit.deleteMany(),db.company.deleteMany()]);});
afterAll(async()=>{if(db) await db.$disconnect();});

describe('Business-aware publication workflow',()=>{
  it('stores description-derived production processes and retains them after an older client edits the location',async()=>{
    const point=await workflow.saveLocation({...demoLocations[1],businessDescription:description,actor},undefined,false,options(context));
    expect(point.profile).toMatchObject({businessDescription:description,businessContext:context,businessContextError:null});
    await workflow.saveLocation({...demoLocations[1],name:'Новое название',businessContext:{evidence:[]},businessContextError:'Подмена',actor},point.id);
    const saved=await db.location.findUniqueOrThrow({where:{id:point.id}});
    expect(saved.profile).toMatchObject({businessDescription:description,businessContext:context,name:'Новое название'});
    const text='Плановое отключение воды: Москва, Пекарский проезд, дом 7, корпус 2. Вода будет отключена 16 ноября 2026 с 05:30 до 06:30 (Europe/Moscow).';
    const extraction:Extraction={...fixture('water-bakery').extraction,summary:text,startsAt:'2026-11-16T05:30:00+03:00',endsAt:'2026-11-16T06:30:00+03:00',evidence:['category','status','city','address','startsAt','endsAt'].map(field=>({field,quote:text}))};
    const created=await workflow.addMessage(message(text));
    await workflow.analyzeEvent(created.eventId,actor,options(extraction));
    const state=await workflow.getState();
    const assessment=state.events[0].assessments[0];
    expect(assessment.status).toBe('relevant');
    expect(JSON.stringify(assessment)).toMatch(/производ|выпечк/iu);
    expect(state.digest[0]).toMatchObject({eventId:created.eventId,locationId:point.id,kind:'risk'});
    expect((await db.location.findUniqueOrThrow({where:{id:point.id}})).profile).toEqual(saved.profile);
  });

  it('retains the description on an invalid profile response and reports insufficient data',async()=>{
    const point=await workflow.saveLocation({...demoLocations[1],businessDescription:description,businessContext:context,businessContextError:null,actor},undefined,false,options('{broken',true));
    expect(point.profile).toMatchObject({businessDescription:description});
    expect((point.profile as {businessContext?:unknown}).businessContext).toBeUndefined();
    expect((point.profile as {businessContextError:string}).businessContextError).toBeTruthy();
    const source=fixture('water-bakery');
    const created=await workflow.addMessage(message(source.text));
    await workflow.analyzeEvent(created.eventId,actor);
    expect((await workflow.getState()).events[0].assessments[0]).toMatchObject({status:'needs_review',relevance:'insufficient_data'});
    const retried=await workflow.saveLocation({...demoLocations[1],businessDescription:description,actor},point.id,false,options(context));
    expect(retried.profile).toMatchObject({businessContext:context,businessContextError:null});
  });

  it('persists separate events from one publication, hydrates its source and keeps identities across reordered reanalysis',async()=>{
    const point=await workflow.saveLocation({...demoLocations[0],actor});
    const concert=fixture('concert-arena'),road=fixture('road-delivery');
    const created=await workflow.addMessage(message(`${concert.text}\n${road.text}`));
    const first=await workflow.analyzeEvent(created.eventId,actor,options({events:[concert.extraction,road.extraction]}));
    expect(first.eventIds).toHaveLength(2);
    expect(await db.sourceMessage.count()).toBe(1);
    expect(await db.messageVersion.count()).toBe(1);
    const second=await workflow.analyzeEvent(first.eventIds[1],actor,options({events:[road.extraction,concert.extraction]}));
    expect(second.eventIds).toEqual(first.eventIds);
    const state=await workflow.getState();
    expect(state.events).toHaveLength(2);
    expect(state.events.every(event=>event.messages[0]?.versions[0].text.includes(road.text))).toBe(true);
    expect(state.digest).toHaveLength(2);
    expect(new Set(state.digest.map(item=>item.id)).size).toBe(2);
    expect(state.events.every(event=>event.version===1)).toBe(true);
    const paraphrased=await workflow.analyzeEvent(created.eventId,actor,options({events:[{...road.extraction,title:'Движение на Учебной улице ограничено'},concert.extraction]}));
    expect(paraphrased.eventIds).toEqual(first.eventIds);
    expect(await db.event.count()).toBe(2);
    const task=await workflow.createTask({eventId:created.eventId,locationId:point.id,owner:'Тест',dueAt:'2026-11-15T12:00:00+03:00',comment:'Проверить первоначальное мероприятие',actor});
    await workflow.addMessage(message(`${road.text}\nУточнение: публикация теперь содержит только перекрытие.`,created.eventId));
    const updated=await workflow.analyzeEvent(created.eventId,actor,options({events:[road.extraction]}));
    expect(updated.eventId).toBe(first.eventIds[1]);
    const after=await workflow.getState();
    expect(after.events.find(event=>event.id===created.eventId)?.status).toBe('superseded');
    expect(after.digest).toHaveLength(1);
    expect(after.digest[0].eventId).toBe(first.eventIds[1]);
    expect((await db.task.findUniqueOrThrow({where:{id:task.id}})).needsReview).toBe(true);
  });

  it('updates an exact-address cancellation in place, retaining both sources and the reviewed task',async()=>{
    const point=await workflow.saveLocation({...demoLocations[1],actor});
    const source=fixture('water-bakery');
    const created=await workflow.addMessage(message(source.text));
    await workflow.analyzeEvent(created.eventId,actor);
    const task=await workflow.createTask({eventId:created.eventId,locationId:point.id,owner:'Тест',dueAt:'2026-11-15T12:00:00+03:00',comment:'Проверить запас воды',actor});
    await workflow.updateTask(task.id,{status:'done',decision:'Решение по первоначальному отключению сохранено',actor});
    const text='Отменено плановое отключение воды: Москва, Пекарский проезд, дом 7, корпус 2, 16 ноября 2026, 08:00–12:00 (Europe/Moscow).';
    const cancelled:Extraction={...source.extraction,title:'Отключение воды отменено',summary:text,status:'cancelled',evidence:['category','status','city','address','startsAt','endsAt'].map(field=>({field,quote:text}))};
    const update=await workflow.addMessage(message(text));
    const analyzed=await workflow.analyzeEvent(update.eventId,actor,options(cancelled));
    expect(analyzed.eventId).toBe(created.eventId);
    expect(await db.event.count()).toBe(1);
    expect(await db.sourceMessage.count()).toBe(2);
    const savedTask=await db.task.findUniqueOrThrow({where:{id:task.id}});
    expect(savedTask).toMatchObject({status:'done',needsReview:true});
    expect(savedTask.decision).toContain('первоначальному');
    const state=await workflow.getState();
    expect(state.events[0].assessments[0].status).toBe('inactive');
    expect(state.digest).toHaveLength(1);
    expect(state.digest[0]).toMatchObject({kind:'update',status:'inactive'});
  });

  it('keeps the other event current when a split event receives an explicit update',async()=>{
    await workflow.saveLocation({...demoLocations[0],actor});
    const concert=fixture('concert-arena'),road=fixture('road-delivery');
    const created=await workflow.addMessage(message(`${concert.text}\n${road.text}`));
    const analyzed=await workflow.analyzeEvent(created.eventId,actor,options({events:[concert.extraction,road.extraction]}));
    const roadId=analyzed.eventIds[1];
    const text=`Отменено ранее объявленное ограничение. ${road.text}`;
    await workflow.addMessage(message(text,roadId));
    await workflow.analyzeEvent(roadId,actor,options({...road.extraction,status:'cancelled',evidence:road.extraction.evidence.map(item=>item.field==='status'?{field:'status',quote:'Отменено ранее объявленное ограничение.'}:item)}));
    const state=await workflow.getState();
    expect(state.events.find(event=>event.id===created.eventId)).toMatchObject({status:'scheduled',version:1});
    expect(state.events.find(event=>event.id===created.eventId)?.assessments[0].status).toBe('relevant');
    expect(state.events.find(event=>event.id===roadId)?.messages).toHaveLength(2);
    expect(state.events.find(event=>event.id===roadId)?.assessments[0].status).toBe('inactive');
  });

  it.each([false,true])('links an identifier cancellation without retiring other events (target is source owner: %s)',async identifiedFirst=>{
    await workflow.saveLocation({...demoLocations[0],actor});
    const concert=fixture('concert-arena'),road=fixture('road-delivery');
    const identified:Extraction={...road.extraction,identity:'ROAD-2026-01',evidence:[...road.extraction.evidence,{field:'identity',quote:'ROAD-2026-01'}]};
    const created=await workflow.addMessage(message(`${concert.text}\n${road.text}\nИдентификатор ограничения: ROAD-2026-01.`));
    const analyzed=await workflow.analyzeEvent(created.eventId,actor,options({events:identifiedFirst ? [identified,concert.extraction] : [concert.extraction,identified]}));
    const identifiedId=analyzed.eventIds[identifiedFirst ? 0 : 1];
    const concertId=analyzed.eventIds[identifiedFirst ? 1 : 0];
    const text=`Ограничение ROAD-2026-01 отменено. ${road.text}`;
    const update=await workflow.addMessage(message(text));
    const cancelled={...identified,status:'cancelled',evidence:identified.evidence.map(item=>item.field==='status'?{field:'status',quote:'Ограничение ROAD-2026-01 отменено.'}:item)};
    const result=await workflow.analyzeEvent(update.eventId,actor,options(cancelled));
    expect(result.eventId).toBe(identifiedId);
    expect(await db.event.count()).toBe(2);
    await workflow.analyzeEvent(result.eventId,actor,options(cancelled));
    const state=await workflow.getState();
    expect(state.events.find(event=>event.id===concertId)).toMatchObject({status:'scheduled',version:1});
    expect(state.events.find(event=>event.id===concertId)?.assessments[0].status).toBe('relevant');
    expect(state.events.find(event=>event.id===result.eventId)?.messages).toHaveLength(2);
    expect(state.events.find(event=>event.id===result.eventId)?.assessments[0].status).toBe('inactive');
  });

  it('does not merge a topic-only cancellation with a known outage',async()=>{
    const source=fixture('water-bakery');
    const original=await workflow.addMessage(message(source.text));
    await workflow.analyzeEvent(original.eventId,actor);
    const text='Отменено плановое отключение воды. Адрес и время не указаны.';
    const incoming:Extraction={...source.extraction,status:'cancelled',summary:text,address:null,city:null,startsAt:null,endsAt:null,timezone:null,evidence:[{field:'category',quote:text},{field:'status',quote:text}]};
    const update=await workflow.addMessage(message(text));
    await workflow.analyzeEvent(update.eventId,actor,options(incoming));
    expect(await db.event.count()).toBe(2);
    expect((await db.event.findUniqueOrThrow({where:{id:original.eventId}})).status).toBe('scheduled');
  });

  it('distinguishes utilities at the same address and time and cancels only the matching resource',async()=>{
    const water=fixture('water-bakery');
    const powerText='Плановое отключение электричества: Москва, Пекарский проезд, дом 7, корпус 2, 16 ноября 2026, 08:00–12:00 (Europe/Moscow).';
    const waterExtraction:Extraction={...water.extraction,category:'utilities',affectedResources:['water'],evidence:[...water.extraction.evidence,{field:'affectedResources',quote:water.text}]};
    const powerExtraction:Extraction={...water.extraction,category:'utilities',title:'Отключение электричества',summary:powerText,affectedResources:['electricity'],evidence:['category','status','city','address','startsAt','endsAt','affectedResources'].map(field=>({field,quote:powerText}))};
    const created=await workflow.addMessage(message(`${water.text}\n${powerText}`));
    const parsed=await workflow.analyzeEvent(created.eventId,actor,options({events:[waterExtraction,powerExtraction]}));
    expect(parsed.eventIds).toHaveLength(2);
    const cancellation=`Отменено отключение электричества. ${powerText}`;
    const update=await workflow.addMessage(message(cancellation));
    const result=await workflow.analyzeEvent(update.eventId,actor,options({...powerExtraction,status:'cancelled',evidence:powerExtraction.evidence.map(item=>item.field==='status'?{field:'status',quote:'Отменено отключение электричества.'}:item)}));
    expect(result.eventId).toBe(parsed.eventIds[1]);
    expect((await db.event.findUniqueOrThrow({where:{id:created.eventId}})).status).toBe('scheduled');
    expect(await db.event.count()).toBe(2);
  });

  it('deduplicates the same publication imported through another origin',async()=>{
    const input=message(fixture('concert-arena').text);
    const first=await workflow.addMessage(input);
    expect(await workflow.addMessage({...input,origin:'json'})).toEqual({eventId:first.eventId,duplicate:true});
    expect(await db.event.count()).toBe(1);
    expect(await db.messageVersion.count()).toBe(1);
  });

  it('keeps a manual import of demo text separate and preserves it through demo reset',async()=>{
    await workflow.seedDemo(actor);
    const source=fixture('water-bakery');
    const demo=await db.event.findUniqueOrThrow({where:{demoKey:source.key}});
    const imported=await workflow.addMessage({text:source.text,publisher:source.publisher,url:source.url,publishedAt:source.publishedAt,timezone:source.timezone,origin:'manual',actor});
    expect(imported.duplicate).toBe(false);
    expect(imported.eventId).not.toBe(demo.id);
    await workflow.resetDemo({confirmation:'СБРОСИТЬ ДЕМО',actor});
    const saved=await db.event.findUniqueOrThrow({where:{id:imported.eventId},include:{messages:{include:{versions:true}}}});
    expect(saved.isDemo).toBe(false);
    expect(saved.messages[0].isDemo).toBe(false);
    expect(saved.messages[0].versions[0].text).toBe(source.text);
    expect(await db.event.findUnique({where:{id:demo.id}})).toBeNull();
  },30_000);

  it('retains an invalid model publication with an honest error and no digest alert',async()=>{
    await workflow.saveLocation({...demoLocations[0],actor});
    const created=await workflow.addMessage(message('Получено тестовое сообщение о новом событии.'));
    await expect(workflow.analyzeEvent(created.eventId,actor,options('{invalid',true))).rejects.toThrow();
    const event=await db.event.findUniqueOrThrow({where:{id:created.eventId},include:{messages:true,analyses:true}});
    expect(event).toMatchObject({status:'pending',extracted:null});
    expect(event.messages).toHaveLength(1);
    expect(event.analyses[0].outcome).toBe('error');
    expect((await workflow.getState()).digest).toEqual([]);
  });
});
