import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { db } from './db';
import { AppError } from './errors';
import { previewCsv } from './csv';
import { locationSchema, messageInputSchema, extractionSchema, validateQuotes, normalizeWhitespace } from '@/domain/schemas';
import { evaluate } from '@/domain/evaluate';
import { analyzeMessage, getAIStatus, checkAIConnection } from '@/ai';
import { demoLocations, demoMessages, demoNow } from '@/data/demo';
import { Prisma } from '@/generated/prisma/client';

type Tx = Prisma.TransactionClient;
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
const actorSchema = z.string().trim().min(1).max(100);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const lock = async (tx:Tx) => { await tx.$executeRaw`SELECT pg_advisory_xact_lock(8452026)`; };
const transaction = <T>(fn:(tx:Tx)=>Promise<T>) => db.$transaction(async tx => { await lock(tx); return fn(tx); }, {timeout:30000});
async function audit(tx:Tx,actor:string,action:string,entityId:string,details:unknown,isDemo=false) {
  await tx.audit.create({data:{actor:actorSchema.parse(actor),action,entityId,details:json(details),isDemo}});
}
async function company(tx:Tx) { return tx.company.upsert({where:{id:'demo-company'},create:{},update:{}}); }
async function now(tx:Tx) { return (await company(tx)).demoClock ? new Date(demoNow) : new Date(); }

async function reassess(tx:Tx,eventId?:string,locationId?:string) {
  const events = await tx.event.findMany({where:eventId ? {id:eventId} : {}});
  const locations = await tx.location.findMany({where:locationId ? {id:locationId} : {}});
  const clock = await now(tx);
  for (const event of events) for (const location of locations) {
    const result = event.extracted ? evaluate(locationSchema.parse(location.profile),extractionSchema.parse(event.extracted),clock)
      : {status:'needs_review',priority:'routine',conditions:[{key:'analysis',label:'Разбор источника',result:'unknown',reason:'Сообщение ещё не разобрано. Предыдущие выводы требуют повторной проверки.'}],nextAction:'Разобрать сообщение и проверить сведения',distanceMeters:undefined};
    const previous=await tx.assessment.findUnique({where:{eventId_locationId:{eventId:event.id,locationId:location.id}}});
    if(!previous || previous.eventVersion!==event.version || previous.locationRevision!==location.revision || previous.status!==result.status || previous.priority!==result.priority || !isDeepStrictEqual(previous.conditions,result.conditions)) {
      await audit(tx,'Правила применимости','Применимость пересчитана',event.id,{locationId:location.id,eventVersion:event.version,locationRevision:location.revision,before:previous?{status:previous.status,conditions:previous.conditions}:null,after:result},event.isDemo && location.isDemo);
    }
    await tx.assessment.upsert({where:{eventId_locationId:{eventId:event.id,locationId:location.id}},create:{eventId:event.id,locationId:location.id,eventVersion:event.version,locationRevision:location.revision,status:result.status,priority:result.priority,conditions:json(result.conditions),nextAction:result.nextAction,distanceMeters:result.distanceMeters ?? null},update:{eventVersion:event.version,locationRevision:location.revision,status:result.status,priority:result.priority,conditions:json(result.conditions),nextAction:result.nextAction,distanceMeters:result.distanceMeters ?? null}});
  }
}
export async function getState() {
  // Serial read: a response cannot overtake an accepted write.
  return transaction(async tx => {
    const network = await company(tx);
    await reassess(tx);
    const locations=await tx.location.findMany({orderBy:{name:'asc'}});
    const events=await tx.event.findMany({include:{messages:{include:{versions:{orderBy:{version:'desc'}}},orderBy:{receivedAt:'desc'}},assessments:true,analyses:{orderBy:{createdAt:'desc'},take:5}},orderBy:{updatedAt:'desc'}});
    const tasks=await tx.task.findMany({orderBy:{dueAt:'asc'}});
    const history=await tx.audit.findMany({orderBy:{at:'desc'},take:300});
    const last=await tx.sourceMessage.findFirst({orderBy:{receivedAt:'desc'}});
    const ai = getAIStatus();
    return {company:network,locations:locations.map(location=>({...locationSchema.parse(location.profile),id:location.id,isDemo:location.demoOrigin || location.isDemo})),events,tasks,history,settings:{aiMode:ai.mode,aiConfigured:ai.configured,aiIssues:ai.issues,sourceStatus:'Ручной ввод, JSON и учебные сообщения. Автоматический мониторинг не подключён.',lastReceivedAt:last?.receivedAt ?? null,now:await now(tx),demoClock:network.demoClock}};
  });
}
export async function saveLocation(input:unknown,id?:string,isDemo=false) {
  const {actor,...data} = z.object({actor:actorSchema}).passthrough().parse(input);
  const profile=locationSchema.parse(data);
  return transaction(async tx=>{
    const previous=id ? await tx.location.findUniqueOrThrow({where:{id}}) : await tx.location.findUnique({where:{locationId:profile.locationId}});
    const saved=await tx.location.upsert({where:{locationId:previous?.locationId ?? profile.locationId},create:{locationId:profile.locationId,name:profile.name,address:profile.address,profile:json(profile),isDemo,demoOrigin:isDemo},update:{locationId:profile.locationId,name:profile.name,address:profile.address,profile:json(profile),revision:{increment:1},...(isDemo?{}:{isDemo:false})}});
    if(previous) await tx.task.updateMany({where:{locationId:saved.id},data:{needsReview:true}});
    await reassess(tx,undefined,saved.id);
    await audit(tx,actor,previous?'Точка изменена — оценки пересчитаны':'Точка добавлена',saved.id,{before:previous?.profile,after:profile},saved.isDemo);
    return saved;
  });
}
export async function importLocations(csv:string,actor:string) {
  const preview=previewCsv(csv);
  if(preview.errors.length) throw new AppError(400,'CSV_INVALID','Исправьте ошибки предпросмотра. Импорт не выполнен.');
  return transaction(async tx=>{
    let created=0,updated=0;
    for(const row of preview.rows) {
      const previous=await tx.location.findUnique({where:{locationId:String(row.data.locationId)}});
      const profile=locationSchema.parse({...((previous?.profile as object) ?? {city:null,latitude:null,longitude:null,openingHours:[],deliveryWindows:[],deliveryRouteStreets:[],eventRadiusMeters:null,waterDependency:'unknown',responsibleName:''}),...row.data});
      const saved=await tx.location.upsert({where:{locationId:profile.locationId},create:{locationId:profile.locationId,name:profile.name,address:profile.address,profile:json(profile)},update:{name:profile.name,address:profile.address,profile:json(profile),isDemo:false,revision:{increment:1}}});
      if(previous) {updated++;await tx.task.updateMany({where:{locationId:saved.id},data:{needsReview:true}});} else created++;
    }
    await reassess(tx);await audit(tx,actor,'CSV точек импортирован','locations',{created,updated});
    return {created,updated};
  });
}
export async function addMessage(input:unknown,isDemo=false,demoKey?:string) {
  const data=messageInputSchema.parse(input);
  if(data.origin==='demo' && !isDemo) throw new AppError(400,'ORIGIN','Учебное происхождение назначается только загрузчиком демо.');
  const fingerprint=hash(JSON.stringify([data.publisher,data.url,data.publishedAt,data.timezone,data.origin,data.text]));
  return transaction(async tx=>{
    const duplicate=await tx.messageVersion.findUnique({where:{fingerprint},include:{message:true}});
    if(duplicate) return {eventId:duplicate.message.eventId,duplicate:true};
    const previous=data.eventId ? await tx.event.findUniqueOrThrow({where:{id:data.eventId}}):null;
    const event=previous ? await tx.event.update({where:{id:previous.id},data:{version:{increment:1},confirmed:false,extracted:Prisma.DbNull,status:'pending'}})
      :await tx.event.create({data:{title:data.text.slice(0,110),status:'pending',version:1,isDemo,demoKey}});
    let message=previous ? await tx.sourceMessage.findFirst({where:{eventId:event.id,publisher:data.publisher,url:data.url,origin:data.origin},orderBy:{receivedAt:'desc'}}):null;
    if(!message) message=await tx.sourceMessage.create({data:{eventId:event.id,publisher:data.publisher,url:data.url,publishedAt:data.publishedAt?new Date(data.publishedAt):null,timezone:data.timezone,origin:data.origin,isDemo,fingerprint}});
    else await tx.sourceMessage.update({where:{id:message.id},data:{publishedAt:data.publishedAt?new Date(data.publishedAt):null,timezone:data.timezone,receivedAt:new Date()}});
    const count=await tx.messageVersion.count({where:{messageId:message.id}});
    await tx.messageVersion.create({data:{messageId:message.id,version:count+1,text:data.text,contentHash:hash(data.text),fingerprint,metadata:json({publisher:data.publisher,url:data.url,publishedAt:data.publishedAt,timezone:data.timezone,origin:data.origin})}});
    if(previous) await tx.task.updateMany({where:{eventId:event.id},data:{needsReview:true}});
    await reassess(tx,event.id);await audit(tx,data.actor,previous?'Новая версия источника — нужна повторная проверка':'Сообщение получено',event.id,{messageId:message.id,version:count+1,publisher:data.publisher},isDemo);
    return {eventId:event.id,duplicate:false};
  });
}
export async function analyzeEvent(id:string,actor:string) {
  const snapshot=await db.event.findUniqueOrThrow({where:{id},include:{messages:{orderBy:{receivedAt:'desc'},include:{versions:{orderBy:{version:'desc'},take:1}},take:1}}});
  const source=snapshot.messages[0];
  if(!source) throw new AppError(400,'NO_SOURCE','У события нет исходного текста.');
  try {
    const result=await analyzeMessage({text:source.versions[0].text,publisher:source.publisher,publishedAt:source.publishedAt?.toISOString() ?? null,timezone:source.timezone});
    return transaction(async tx=>{
      const current=await tx.event.findUniqueOrThrow({where:{id}});
      if(current.version!==snapshot.version) throw new AppError(409,'STALE','Источник изменился во время разбора. Повторите разбор новой версии.');
      const extraction=result.extraction;
      const changed=!isDeepStrictEqual(current.extracted,extraction);
      const version=current.version+(current.extracted && changed?1:0);
      await tx.event.update({where:{id},data:{extracted:json(extraction),title:extraction.title,category:extraction.category,status:extraction.status,version,confirmed:changed?false:current.confirmed}});
      await tx.analysis.create({data:{eventId:id,version,mode:result.mode,model:result.model,outcome:'success',durationMs:Math.round(result.durationMs),extraction:json(extraction)}});
      if(changed) await tx.task.updateMany({where:{eventId:id},data:{needsReview:true}});
      await reassess(tx,id);await audit(tx,actor,changed?'Источник разобран; сведения требуют проверки':'Повторный разбор: условия не изменились',id,{mode:result.mode,model:result.model,version},current.isDemo);
      return {eventId:id};
    });
  } catch(error) {
    const failure=error as {message?:string;mode?:string;model?:string;durationMs?:number};
    await db.analysis.create({data:{eventId:id,version:snapshot.version,mode:failure.mode ?? getAIStatus().mode,model:failure.model ?? null,outcome:'error',durationMs:Math.round(failure.durationMs ?? 0),error:failure.message ?? 'Ошибка разбора'}});
    throw error;
  }
}
export async function correctEvent(id:string,input:unknown) {
  const data=z.object({extraction:extractionSchema,actor:actorSchema,comment:z.string().trim().min(5).max(2000)}).parse(input);
  return transaction(async tx=>{
    const event=await tx.event.findUniqueOrThrow({where:{id},include:{messages:{include:{versions:true}}}});
    const sources=event.messages.flatMap(message=>message.versions.map(version=>version.text));
    for(const evidence of data.extraction.evidence) if(!sources.some(source=>normalizeWhitespace(source).includes(normalizeWhitespace(evidence.quote)))) {
      throw new AppError(400,'QUOTE','Каждая цитата должна целиком присутствовать в одном сохранённом исходнике.');
    }
    validateQuotes(data.extraction,sources.join('\n'));
    await tx.event.update({where:{id},data:{extracted:json(data.extraction),title:data.extraction.title,category:data.extraction.category,status:data.extraction.status,version:{increment:1},confirmed:false,isDemo:false}});
    await tx.task.updateMany({where:{eventId:id},data:{needsReview:true}});await reassess(tx,id);
    await audit(tx,data.actor,'Извлечение исправлено человеком',id,{before:event.extracted,after:data.extraction,comment:data.comment});
    return {eventId:id};
  });
}
export async function confirmEvent(id:string,actor:string) {
  return transaction(async tx=>{
    const event=await tx.event.findUniqueOrThrow({where:{id}});
    if(!event.extracted) throw new AppError(409,'NO_ANALYSIS','Сначала разберите источник.');
    await tx.event.update({where:{id},data:{confirmed:true,isDemo:false}});
    await audit(tx,actor,'Сведения проверены человеком',id,{version:event.version});return {eventId:id};
  });
}
export async function groupEvent(id:string,input:unknown) {
  const data=z.object({targetEventId:z.string().nullable(),actor:actorSchema,comment:z.string().trim().min(5)}).parse(input);
  return transaction(async tx=>{
    if(data.targetEventId===id) throw new AppError(400,'GROUP_SELF','Выберите другое событие.');
    if(data.targetEventId) await tx.event.update({where:{id:data.targetEventId},data:{isDemo:false}});
    const event=await tx.event.update({where:{id},data:{relatedEventId:data.targetEventId,confirmed:false,isDemo:false}});
    await audit(tx,data.actor,data.targetEventId?'Указана возможная перепечатка; это не независимое подтверждение':'Группировка исправлена',id,data);return event;
  });
}
export async function createTask(input:unknown) {
  const data=z.object({eventId:z.string(),locationId:z.string(),owner:z.string().trim().min(1).max(100),dueAt:z.iso.datetime({offset:true}),comment:z.string().trim().min(5).max(3000),actor:actorSchema}).parse(input);
  return transaction(async tx=>{
    const event=await tx.event.findUniqueOrThrow({where:{id:data.eventId}});
    const location=await tx.location.findUniqueOrThrow({where:{id:data.locationId}});
    const existing=await tx.task.findFirst({where:{eventId:data.eventId,locationId:data.locationId,owner:data.owner,comment:data.comment,eventVersion:event.version,status:{not:'done'}}});
    if(existing) return existing;
    const task=await tx.task.create({data:{eventId:data.eventId,locationId:data.locationId,owner:data.owner,dueAt:new Date(data.dueAt),comment:data.comment,eventVersion:event.version,isDemo:false}});
    await audit(tx,data.actor,'Создана внутренняя задача',task.id,{eventId:event.id,locationId:location.id,comment:data.comment},task.isDemo);return task;
  });
}
export async function updateTask(id:string,input:unknown) {
  const data=z.object({status:z.enum(['todo','doing','done']),decision:z.string().trim().max(3000).optional(),comment:z.string().trim().max(3000).optional(),actor:actorSchema}).parse(input);
  if(data.status==='done' && (!data.decision || data.decision.length<5)) throw new AppError(400,'DECISION_REQUIRED','Для завершения запишите решение и объяснение (не менее 5 символов).');
  return transaction(async tx=>{
    const before=await tx.task.findUniqueOrThrow({where:{id},include:{event:true}});
    const task=await tx.task.update({where:{id},data:{status:data.status,decision:data.decision ?? before.decision,...(data.comment?{comment:data.comment}:{}),...(data.status==='done'?{needsReview:false,eventVersion:before.event.version}:{})}});
    await audit(tx,data.actor,data.status==='done'?'Решение сотрудника сохранено':'Статус задачи изменён',id,{before:{status:before.status,decision:before.decision},after:{status:task.status,decision:task.decision},eventId:task.eventId},task.isDemo);return task;
  });
}
export async function setClock(input:unknown) {
  const data=z.object({demoClock:z.boolean(),actor:actorSchema}).parse(input);
  return transaction(async tx=>{await company(tx);await tx.company.update({where:{id:'demo-company'},data:{demoClock:data.demoClock}});await reassess(tx);await audit(tx,data.actor,'Режим часов изменён','company',{demoClock:data.demoClock});return {demoClock:data.demoClock};});
}
export async function seedDemo(actor='Загрузчик демо',onlyEmpty=false) {
  const existing=await db.company.findUnique({where:{id:'demo-company'}});
  if(onlyEmpty && (existing?.seeded || await db.location.count() || await db.event.count())) return {skipped:true};
  for(const location of demoLocations) if(!await db.location.findUnique({where:{locationId:location.locationId}})) await saveLocation({...location,actor},undefined,true);
  const keys=new Map<string,string>();
  for(const message of demoMessages) {
    const existingEvent=await db.event.findUnique({where:{demoKey:message.key}});
    if(existingEvent) {keys.set(message.key,existingEvent.id);continue;}
    const result=await addMessage({text:message.text,publisher:message.publisher,url:message.url,publishedAt:message.publishedAt,timezone:message.timezone,origin:'demo',actor,...(message.replacesKey && keys.get(message.replacesKey)?{eventId:keys.get(message.replacesKey)}:{})},true,message.key);
    keys.set(message.key,result.eventId);
    // Seed never calls LIVE; fixtures are explicitly DEMO.
    if(!result.duplicate) await transaction(async tx=>{
      const event=await tx.event.findUniqueOrThrow({where:{id:result.eventId}});
      await tx.event.update({where:{id:event.id},data:{extracted:json(message.extraction),title:message.extraction.title,category:message.extraction.category,status:message.extraction.status}});
      await tx.analysis.create({data:{eventId:event.id,version:event.version,mode:'DEMO',outcome:'success',durationMs:0,extraction:json(message.extraction)}});
      await reassess(tx,event.id);
    });
  }
  await db.company.upsert({where:{id:'demo-company'},create:{seeded:true},update:{seeded:true}});return {loaded:true};
}
export async function resetDemo(input:unknown) {
  const data=z.object({confirmation:z.literal('СБРОСИТЬ ДЕМО'),actor:actorSchema}).parse(input);
  return transaction(async tx=>{
    await tx.task.deleteMany({where:{isDemo:true}});
    // Keep any demo entity that acquired a user's own data or task.
    await tx.event.deleteMany({where:{isDemo:true,tasks:{none:{}},messages:{every:{isDemo:true}}}});
    await tx.location.deleteMany({where:{isDemo:true,tasks:{none:{}}}});
    await tx.audit.deleteMany({where:{isDemo:true}});
    await audit(tx,data.actor,'Учебные записи сброшены; пользовательские сохранены','company',{});return {reset:true};
  });
}

export async function checkConnection() {
  try {
    const result=await checkAIConnection();
    await transaction(tx=>audit(tx,'Проверка подключения','Проверка AI завершена','ai',result));
    return result;
  } catch(error) {
    const failure=error as {code?:string;message?:string;mode?:string;model?:string;durationMs?:number};
    await transaction(tx=>audit(tx,'Проверка подключения','Ошибка подключения AI','ai',{mode:failure.mode ?? getAIStatus().mode,model:failure.model ?? null,code:failure.code ?? 'AI_ERROR',durationMs:failure.durationMs ?? 0,message:failure.message ?? 'Проверка не выполнена'}));
    throw error;
  }
}
