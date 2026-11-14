import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoLocations, demoMessages } from '../../src/data/demo';
import type { AiOptions } from '../../src/ai';
import type { BusinessContext, Extraction } from '../../src/domain/schemas';

const databaseUrl=process.env.DATABASE_URL;
if(!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Impact workflow tests require a dedicated DATABASE_URL ending in _test.');
process.env.AI_MODE='DEMO';
let db:typeof import('../../src/server/db').db;
let workflow:typeof import('../../src/server/workflow');
const actor='Тест влияния на бизнес';
const sourceUrl='https://t.me/newsssss09/42';
const source=demoMessages.find(message=>message.key==='water-bakery')!;
const description='Пекарня. Выпечка ежедневно с 05:00 до 13:00, нужна вода.';
const context:BusinessContext={
  industry:'foodservice',resources:['water'],
  processes:[{name:'Выпечка',resources:['water'],schedule:[{days:[1,2,3,4,5,6,7],start:'05:00',end:'13:00'}]}],
  evidence:[{field:'industry',quote:'Пекарня.'},{field:'resources',quote:'нужна вода'},
    {field:'processes.0.name',quote:'Выпечка'},{field:'processes.0.resources',quote:'нужна вода'},
    {field:'processes.0.schedule',quote:description}],
};
const modelAnswer={
  fact:'плановое отключение воды',affectedProcess:'Выпечка',
  possibleImpact:'Из-за отключения воды процесс «Выпечка» может быть ограничен.',
  assumptions:['Резервное водоснабжение не подтверждено.'],
  evidence:[{field:'fact',quote:'плановое отключение воды'}],effect:'threat',
  title:'Возможное ограничение выпечки',recommendedAction:'Проверьте резервное водоснабжение для выпечки.',question:null,
};
function message(text:string,eventId?:string) {
  return {text,publisher:'Тестовый диспетчер',url:sourceUrl,publishedAt:'2026-11-14T08:00:00+03:00',timezone:'Europe/Moscow',origin:'manual',actor,...(eventId?{eventId}:{})};
}
function completion(value:unknown) {
  return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}),{status:200,headers:{'content-type':'application/json'}});
}
function options(extraction:unknown,impact:unknown=modelAnswer,impactHttpStatus?:number) {
  const calls:{extraction:number;impact:number;profile:number}={extraction:0,impact:0,profile:0};
  const ai:AiOptions={
    env:{AI_MODE:'LIVE',AI_BASE_URL:'https://example.test/v1',AI_MODEL:'test-impact-model',AI_API_KEY:'test-key'},
    sleep:async()=>{},
    fetchImpl:async(_url,init)=>{
      const request=JSON.parse(String(init?.body));
      const input=JSON.parse(request.messages.find((item:{role:string})=>item.role==='user').content);
      if(Array.isArray(input.allowedProcesses)) {
        calls.impact++;
        return impactHttpStatus ? new Response('UPSTREAM_BODY_MUST_STAY_PRIVATE',{status:impactHttpStatus}) : completion(impact);
      }
      if(input.businessDescription!==undefined) {calls.profile++;return completion(context);}
      calls.extraction++;
      return completion(extraction);
    },
  };
  return {ai,calls};
}
async function createPoint() {
  return workflow.saveLocation({...demoLocations[1],businessDescription:description,actor},undefined,false,options(null).ai);
}

beforeAll(async()=>{db=(await import('../../src/server/db')).db;workflow=await import('../../src/server/workflow');await db.$connect();});
beforeEach(async()=>{await db.$transaction([db.task.deleteMany(),db.assessment.deleteMany(),db.analysis.deleteMany(),db.messageVersion.deleteMany(),db.sourceMessage.deleteMany(),db.event.deleteMany(),db.location.deleteMany(),db.audit.deleteMany(),db.company.deleteMany()]);});
afterEach(()=>{vi.restoreAllMocks();});
afterAll(async()=>{if(db) await db.$disconnect();});

describe('Verified relevance, model impact and persisted signal',()=>{
  it('preserves the fact, hypothesis and source separately and targets one point and the verified period',async()=>{
    const point=await createPoint();
    const created=await workflow.addMessage(message(source.text));
    const transport=options(source.extraction);
    const analyzed=await workflow.analyzeEvent(created.eventId,actor,transport.ai);
    expect(transport.calls).toEqual({profile:0,extraction:1,impact:1});
    expect(analyzed.impacts).toEqual([{eventId:created.eventId,locationId:point.id,status:'complete'}]);
    const stored=await db.assessment.findUniqueOrThrow({where:{eventId_locationId:{eventId:created.eventId,locationId:point.id}}});
    expect(stored.impact).toMatchObject({
      status:'complete',sourceUrl,fact:modelAnswer.fact,affectedProcess:'Выпечка',
      possibleImpact:modelAnswer.possibleImpact,assumptions:modelAnswer.assumptions,evidence:modelAnswer.evidence,
      relevance:{status:'relevant',locationId:demoLocations[1].locationId,affectedProcesses:expect.arrayContaining(['Выпечка'])},
      signal:{type:'threat',recommendedAction:modelAnswer.recommendedAction,locationId:demoLocations[1].locationId,startsAt:source.extraction.startsAt,endsAt:source.extraction.endsAt},
      model:'test-impact-model',error:null,
    });
    const fetchSpy=vi.spyOn(globalThis,'fetch');
    const state=await workflow.getState();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(state.events[0].assessments[0].impact).toEqual(stored.impact);
    expect(state.events[0].assessments[0].impact?.relevance.reason).toBeTruthy();
    expect(state.digest[0]).toMatchObject({kind:'risk',locationId:point.id,title:modelAnswer.title,consequences:[modelAnswer.possibleImpact],actions:[modelAnswer.recommendedAction]});
    expect(state.digest[0].sources[0].url).toBe(sourceUrl);
  });

  it('keeps the extracted news after a model error and shows the error without a signal',async()=>{
    await createPoint();
    const created=await workflow.addMessage(message(source.text));
    const transport=options(source.extraction,modelAnswer,502);
    await workflow.analyzeEvent(created.eventId,actor,transport.ai);
    const state=await workflow.getState();
    const event=state.events[0],impact=event.assessments[0].impact;
    expect(event.extracted).toMatchObject({category:'water_outage',address:source.extraction.address});
    expect(impact).toMatchObject({status:'error',sourceUrl,signal:null,error:{code:'AI_HTTP_ERROR',message:expect.stringContaining('HTTP 502')}});
    expect(JSON.stringify(impact)).not.toContain('UPSTREAM_BODY_MUST_STAY_PRIVATE');
    expect(state.digest[0]).toMatchObject({kind:'information',consequences:[]});
    expect(state.digest[0].actions[0]).toContain('HTTP 502');
    expect(state.history.some(entry=>entry.action==='Ошибка модели при оценке влияния')).toBe(true);
  });

  it('asks one question when the model cannot substantiate a consequence',async()=>{
    await createPoint();
    const created=await workflow.addMessage(message(source.text));
    await workflow.analyzeEvent(created.eventId,actor,options(source.extraction,{
      ...modelAnswer,possibleImpact:null,effect:null,title:null,recommendedAction:null,
      question:'Есть ли резервное водоснабжение? Согласован ли план работы?',
    }).ai);
    const state=await workflow.getState();
    expect(state.events[0].assessments[0].impact).toMatchObject({
      status:'needs_clarification',fact:modelAnswer.fact,affectedProcess:'Выпечка',possibleImpact:null,
      signal:null,question:'Есть ли резервное водоснабжение?',sourceUrl,
    });
    expect(state.digest.every(item=>item.kind==='information')).toBe(true);
  });

  it.each(['other_city','missing_place'] as const)('does not invoke the impact model for %s',async scenario=>{
    await createPoint();
    const text=scenario==='other_city'
      ? source.text.replace('Москва','Казань')
      : 'Плановое отключение воды. Вода будет отключена 16 ноября 2026, 08:00–12:00 (Europe/Moscow). Место не указано.';
    const extraction:Extraction={...source.extraction,summary:text,
      city:scenario==='other_city'?'Казань':null,
      address:scenario==='other_city'?source.extraction.address!.replace('Москва','Казань'):null,
      evidence:['category','status','startsAt','endsAt',...(scenario==='other_city'?['city','address']:[])].map(field=>({field,quote:text})),
    };
    const created=await workflow.addMessage(message(text));
    const transport=options(extraction);
    await workflow.analyzeEvent(created.eventId,actor,transport.ai);
    expect(transport.calls).toEqual({profile:0,extraction:1,impact:0});
    const state=await workflow.getState();
    expect(state.events[0].assessments[0].impact).toMatchObject({
      status:scenario==='other_city'?'irrelevant':'needs_clarification',signal:null,
      relevance:{status:scenario==='other_city'?'irrelevant':'needs_clarification'},
    });
    expect(state.digest.every(item=>item.kind!=='risk' && item.kind!=='opportunity')).toBe(true);
  });

  it('invalidates saved impact after a profile edit and GET never calls a model',async()=>{
    const point=await createPoint();
    const created=await workflow.addMessage(message(source.text));
    await workflow.analyzeEvent(created.eventId,actor,options(source.extraction).ai);
    const saved=await workflow.saveLocation({...demoLocations[1],name:'Пекарня после изменения',actor},point.id);
    expect(saved.revision).toBe(point.revision+1);
    const fetchSpy=vi.spyOn(globalThis,'fetch');
    const state=await workflow.getState();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(state.events[0].assessments[0].impact).toMatchObject({status:'needs_clarification',signal:null});
    expect(state.digest.every(item=>item.kind==='information')).toBe(true);
    expect((await db.assessment.findFirstOrThrow()).impact).toBeNull();
  });

  it('removes a stale signal immediately when the source receives a new version',async()=>{
    await createPoint();
    const created=await workflow.addMessage(message(source.text));
    await workflow.analyzeEvent(created.eventId,actor,options(source.extraction).ai);
    await workflow.addMessage(message(`${source.text}\nУточнение: срок ограничения проверяется.`,created.eventId));
    const fetchSpy=vi.spyOn(globalThis,'fetch');
    const state=await workflow.getState();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(state.events[0]).toMatchObject({status:'pending',extracted:null});
    expect(state.events[0].assessments[0].impact).toBeNull();
    expect(state.digest).toEqual([]);
    expect((await db.assessment.findFirstOrThrow()).impact).toBeNull();
  });
});
