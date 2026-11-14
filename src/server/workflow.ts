import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { db } from './db';
import { AppError } from './errors';
import { previewCsv } from './csv';
import { locationSchema, messageInputSchema, extractionSchema, validateQuotes, normalizeWhitespace, type Extraction } from '@/domain/schemas';
import { evaluate, compareAddress, type Evaluation } from '@/domain/evaluate';
import { analyzeMessage, analyzeBusinessDescription, getAIStatus, checkAIConnection, type AiOptions } from '@/ai';
import { analyzeImpact, demoImpact, pendingImpact, impactResultSchema, type ImpactInput, type ImpactResult } from '@/ai/impact';
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

const factKey = (event: Extraction) => {
  const normalize=(value:string|null|undefined)=>value ? normalizeWhitespace(value).toLocaleLowerCase('ru-RU') : null;
  if(event.identity) return hash(JSON.stringify([event.category,normalize(event.identity)]));
  const entities=Object.entries(event.entities ?? {}).sort(([a],[b])=>a.localeCompare(b)).map(([field,values])=>[field,values.map(normalize).sort()]);
  const anchored=Boolean(event.startsAt && (event.address || event.street || event.latitude!==null && event.longitude!==null || entities.length));
  return hash(JSON.stringify([event.category,normalize(event.city),normalize(event.address),normalize(event.street),event.latitude,event.longitude,event.startsAt,entities,event.affectedResources?.map(normalize).sort() ?? [],event.affectedAddresses?.map(normalize).sort() ?? [],anchored ? null : normalize(event.title)]));
};
const parseExtraction = (value: unknown) => extractionSchema.safeParse(value);
function isSameKnownEvent(previous:Extraction,incoming:Extraction) {
  if(previous.category!==incoming.category) return false;
  if(previous.identity && incoming.identity && previous.identity===incoming.identity
    && /\d|[#№]|[a-zа-я]{2,}[-_/][a-zа-я0-9]{2,}/iu.test(incoming.identity)
    && incoming.identity.length>=4
    && [previous,incoming].every(event=>event.evidence.some(item=>item.field==='identity' && item.quote.includes(event.identity!)))) return true;
  if(!['cancelled','rescheduled','postponed'].includes(incoming.status)) return false;
  if(incoming.category!=='water_outage' && !(incoming.category==='utilities' && previous.affectedResources?.length && incoming.affectedResources?.length && isDeepStrictEqual([...previous.affectedResources].sort(),[...incoming.affectedResources].sort()))) return false;
  return Boolean(previous.startsAt && incoming.startsAt && Date.parse(previous.startsAt)===Date.parse(incoming.startsAt)
    && previous.address && incoming.address && previous.city && incoming.city
    && previous.city.toLocaleLowerCase('ru-RU')===incoming.city.toLocaleLowerCase('ru-RU')
    && compareAddress(previous.address,incoming.address,previous.city)==='match'
    && ['address','startsAt','status'].every(field=>incoming.evidence.some(item=>item.field===field)));
}
const sourceOwner = (event: {id:string;extracted:unknown}) => {
  const parsed = parseExtraction(event.extracted);
  return parsed.success ? parsed.data.provenance?.sourceEventId ?? event.id : event.id;
};
async function family(tx: Tx, eventId: string) {
  const events = await tx.event.findMany();
  return events.filter(event => event.id === eventId || sourceOwner(event) === eventId);
}
function pendingEvaluation(reason = 'Сообщение ещё не разобрано. Предыдущие выводы требуют повторной проверки.') {
  return {status:'needs_review' as const,priority:'routine' as const,conditions:[{key:'analysis',label:'Разбор источника',result:'unknown' as const,reason}],nextAction:'Разобрать сообщение и проверить сведения',distanceMeters:undefined};
}
async function evaluateStored(tx:Tx,event:{id:string;extracted:unknown;status:string},profile:unknown,clock:Date):Promise<Evaluation> {
  if(event.status === 'superseded') return {status:'inactive' as const,priority:'routine' as const,conditions:[{key:'analysis',label:'Уточнение состава событий',result:'mismatch' as const,reason:'Это выделенное событие отсутствует в последнем разборе источника. Прежнее предупреждение снято; исходник и решения сохранены.'}],nextAction:'Проверьте новый разбор и ранее принятые решения.',distanceMeters:undefined};
  if(!event.extracted) return pendingEvaluation();
  const extraction=extractionSchema.parse(event.extracted);
  if(extraction.provenance && extraction.provenance.sourceEventId !== event.id) {
    const source=await tx.sourceMessage.findUnique({where:{id:extraction.provenance.sourceMessageId},include:{versions:{orderBy:{version:'desc'},take:1}}});
    if(source?.eventId!==extraction.provenance.sourceEventId || source?.versions[0]?.version!==extraction.provenance.sourceVersion) return pendingEvaluation('Исходная публикация обновлена. Это выделенное событие требует повторного разбора.');
  }
  return evaluate(locationSchema.parse(profile),extraction,clock);
}

async function reassess(tx:Tx,eventId?:string,locationId?:string) {
  const events = await tx.event.findMany({where:eventId ? {id:eventId} : {}});
  const locations = await tx.location.findMany({where:locationId ? {id:locationId} : {}});
  const clock = await now(tx);
  for (const event of events) for (const location of locations) {
    const result = await evaluateStored(tx,event,location.profile,clock);
    const previous=await tx.assessment.findUnique({where:{eventId_locationId:{eventId:event.id,locationId:location.id}}});
    const impactChanged=!previous || previous.eventVersion!==event.version || previous.locationRevision!==location.revision || previous.status!==result.status || !isDeepStrictEqual(previous.conditions,result.conditions);
    if(!previous || previous.eventVersion!==event.version || previous.locationRevision!==location.revision || previous.status!==result.status || previous.priority!==result.priority || !isDeepStrictEqual(previous.conditions,result.conditions)) {
      await audit(tx,'Правила применимости','Применимость пересчитана',event.id,{locationId:location.id,eventVersion:event.version,locationRevision:location.revision,before:previous?{status:previous.status,conditions:previous.conditions}:null,after:result},event.isDemo && location.isDemo);
    }
    await tx.assessment.upsert({where:{eventId_locationId:{eventId:event.id,locationId:location.id}},create:{eventId:event.id,locationId:location.id,eventVersion:event.version,locationRevision:location.revision,status:result.status,priority:result.priority,conditions:json(result.conditions),nextAction:result.nextAction,distanceMeters:result.distanceMeters ?? null},update:{eventVersion:event.version,locationRevision:location.revision,status:result.status,priority:result.priority,conditions:json(result.conditions),nextAction:result.nextAction,distanceMeters:result.distanceMeters ?? null,...(impactChanged ? {impact:Prisma.DbNull} : {})}});
  }
}
export async function getState() {
  // Serial read: a response cannot overtake an accepted write.
  return transaction(async tx => {
    const network = await company(tx);
    await reassess(tx);
    const locations=await tx.location.findMany({orderBy:{name:'asc'}});
    const storedEvents=await tx.event.findMany({include:{messages:{include:{versions:{orderBy:{version:'desc'}}},orderBy:{receivedAt:'desc'}},assessments:true,analyses:{orderBy:{createdAt:'desc'},take:5}},orderBy:{updatedAt:'desc'}});
    const tasks=await tx.task.findMany({orderBy:{dueAt:'asc'}});
    const history=await tx.audit.findMany({orderBy:{at:'desc'},take:300});
    const last=await tx.sourceMessage.findFirst({orderBy:{receivedAt:'desc'}});
    const ai = getAIStatus();
    const clock=await now(tx);
    const allMessages=storedEvents.flatMap(event=>event.messages);
    const enrichEvent=async (event:typeof storedEvents[number])=>{
      const owner=storedEvents.find(candidate=>candidate.id===sourceOwner(event));
      const parsed=parseExtraction(event.extracted);
      const historicalIds=parsed.success ? parsed.data.provenance?.previousSourceMessageIds ?? [] : [];
      const inherited=event.messages.length ? event.messages : parsed.success && parsed.data.provenance ? allMessages.filter(message=>message.id===parsed.data.provenance!.sourceMessageId) : owner?.messages ?? [];
      const messages=[...new Map([...inherited,...allMessages.filter(message=>historicalIds.includes(message.id))].map(message=>[message.id,message])).values()].sort((a,b)=>b.receivedAt.getTime()-a.receivedAt.getTime());
      const assessments:Array<Omit<typeof event.assessments[number],keyof Evaluation|'impact'> & Evaluation & {impact:ImpactResult|null}>=[];
      for(const assessment of event.assessments) {
        const location=locations.find(candidate=>candidate.id===assessment.locationId)!;
        const evaluation=await evaluateStored(tx,event,location.profile,clock);
        const storedImpact=impactResultSchema.safeParse(assessment.impact);
        const source=messages.find(message=>message.id===(parsed.success ? parsed.data.provenance?.sourceMessageId : undefined)) ?? messages[0];
        const input=parsed.success && source ? {source:{text:source.versions[0].text,publisher:source.publisher,publishedAt:source.publishedAt?.toISOString() ?? null,timezone:source.timezone,sourceUrl:source.url},extraction:parsed.data,location:locationSchema.parse(location.profile),evaluation} : null;
        const impact=storedImpact.success ? storedImpact.data : input ? (event.isDemo ? demoImpact(input) : pendingImpact(input)) : null;
        assessments.push({...assessment,...evaluation,impact,distanceMeters:evaluation.distanceMeters});
      }
      return {...event,messages,assessments};
    };
    const events:Array<Awaited<ReturnType<typeof enrichEvent>>>=[];
    for(const event of storedEvents) events.push(await enrichEvent(event));
    const digest=events.flatMap(event=>event.assessments.flatMap(assessment=>{
      const extracted=parseExtraction(event.extracted);
      if(!extracted.success || event.status==='superseded' || assessment.status==='excluded' || assessment.conditions.some(condition=>condition.key==='analysis' && condition.result==='unknown')) return [];
      const location=locations.find(candidate=>candidate.id===assessment.locationId)!;
      const changed=['cancelled','rescheduled','postponed','completed'].includes(event.status);
      const wasRelevant=history.some(entry=>{
        const details=(entry.details ?? {}) as {locationId?:string;before?:{status?:string}};
        return entry.entityId===event.id && details.locationId===location.id && details.before?.status==='relevant';
      });
      if(assessment.status==='inactive' && !(changed && (wasRelevant || tasks.some(task=>task.eventId===event.id && task.locationId===location.id)))) return [];
      const signal=assessment.impact?.signal;
      const influence=signal?.type==='threat' ? 'risk' : signal?.type==='opportunity' ? 'opportunity' : 'information';
      const kind=changed ? 'update' as const : signal?.type==='threat' ? 'risk' as const : signal?.type==='opportunity' ? 'opportunity' as const : 'information' as const;
      return [{id:`${event.id}:${location.id}:${event.version}:${location.revision}`,eventId:event.id,locationId:location.id,kind,title:signal?.title ?? event.title,locationName:location.name,status:assessment.status,relevance:assessment.relevance,influence,priority:signal ? assessment.priority : 'routine',priorityReason:assessment.priorityReason ?? '',reason:assessment.reason ?? assessment.conditions.find(condition=>condition.key!=='category')?.reason ?? '',consequences:assessment.impact?.possibleImpact ? [assessment.impact.possibleImpact] : [],actions:signal ? [signal.recommendedAction] : [assessment.impact?.error?.message ?? assessment.impact?.question ?? assessment.nextAction],missingData:assessment.missingData ?? [],startsAt:extracted.data.startsAt,endsAt:extracted.data.endsAt,responseDeadline:assessment.responseDeadline ?? null,sources:event.messages.map(message=>({id:message.id,publisher:message.publisher,url:message.url,publishedAt:message.publishedAt}))}];
    }));
    const digestRank=(item:typeof digest[number])=>item.kind==='risk' && item.priority==='urgent' ? 0 : item.kind==='opportunity' ? 1 : item.kind==='update' ? 2 : item.kind==='risk' ? 3 : 4;
    digest.sort((a,b)=>digestRank(a)-digestRank(b) || (Date.parse(a.responseDeadline ?? a.startsAt ?? '') || Infinity)-(Date.parse(b.responseDeadline ?? b.startsAt ?? '') || Infinity) || a.id.localeCompare(b.id));
    return {company:network,locations:locations.map(location=>({...locationSchema.parse(location.profile),id:location.id,isDemo:location.demoOrigin || location.isDemo})),events,tasks,history,digest,settings:{aiMode:ai.mode,aiConfigured:ai.configured,aiIssues:ai.issues,sourceStatus:'Telegram: t.me/newsssss09 — импорт последних публикаций по кнопке. Также доступны ручной ввод и JSON.',lastReceivedAt:last?.receivedAt ?? null,now:clock,demoClock:network.demoClock}};
  });
}
export async function saveLocation(input:unknown,id?:string,isDemo=false,options:AiOptions={}) {
  const {actor,...data} = z.object({actor:actorSchema}).passthrough().parse(input);
  const previous=id ? await db.location.findUniqueOrThrow({where:{id}}) : typeof data.locationId === 'string' ? await db.location.findUnique({where:{locationId:data.locationId}}) : null;
  const previousProfile=previous ? locationSchema.parse(previous.profile) : null;
  // Older clients omit the new optional business fields. Keep them across ordinary location edits.
  const merged={...previousProfile,...data,businessContext:previousProfile?.businessContext,businessContextError:previousProfile?.businessContextError};
  let profile=locationSchema.parse(merged);
  const descriptionChanged=Object.hasOwn(data,'businessDescription') && profile.businessDescription !== previousProfile?.businessDescription;
  const needsDescriptionParse=Object.hasOwn(data,'businessDescription') && Boolean(profile.businessDescription?.trim()) && (!previousProfile?.businessContext || Boolean(previousProfile.businessContextError));
  if(descriptionChanged || needsDescriptionParse) {
    profile={...profile,businessContext:undefined,businessContextError:null};
    if(profile.businessDescription?.trim()) {
      try { profile.businessContext=(await analyzeBusinessDescription(profile.businessDescription,options)).context; }
      catch(error) { profile.businessContextError=error instanceof Error ? error.message : 'Описание бизнеса сохранено, но его процессы пока не разобраны.'; }
    }
  }
  return transaction(async tx=>{
    const current=previous ? await tx.location.findUniqueOrThrow({where:{id:previous.id}}) : null;
    if(previous && current?.revision!==previous.revision) throw new AppError(409,'STALE','Профиль изменился во время разбора. Обновите страницу и сохраните изменения повторно.');
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
    const sameText=await tx.messageVersion.findMany({where:{contentHash:hash(data.text),message:{publisher:data.publisher,url:data.url}},include:{message:true}});
    const repeated=sameText.find(version=>{
      if(version.message.isDemo!==isDemo) return false;
      const meta=version.metadata as {publishedAt?:string|null;timezone?:string|null};
      return (meta.publishedAt ? new Date(meta.publishedAt).toISOString() : null)===(data.publishedAt ? new Date(data.publishedAt).toISOString() : null) && (meta.timezone ?? null)===data.timezone;
    });
    if(repeated) return {eventId:repeated.message.eventId,duplicate:true};
    const requested=data.eventId ? await tx.event.findUniqueOrThrow({where:{id:data.eventId}}):null;
    // An explicit update to a split event gets its own source; other events in the publication stay current.
    const previous=requested;
    const existingFamily=previous ? await family(tx,previous.id) : [];
    const event=previous ? await tx.event.update({where:{id:previous.id},data:{version:{increment:1},confirmed:false,extracted:Prisma.DbNull,status:'pending'}})
      :await tx.event.create({data:{title:data.text.slice(0,110),status:'pending',version:1,isDemo,demoKey}});
    let message=previous ? await tx.sourceMessage.findFirst({where:{eventId:event.id,publisher:data.publisher,url:data.url,origin:data.origin},orderBy:{receivedAt:'desc'}}):null;
    if(!message) message=await tx.sourceMessage.create({data:{eventId:event.id,publisher:data.publisher,url:data.url,publishedAt:data.publishedAt?new Date(data.publishedAt):null,timezone:data.timezone,origin:data.origin,isDemo,fingerprint}});
    else await tx.sourceMessage.update({where:{id:message.id},data:{publishedAt:data.publishedAt?new Date(data.publishedAt):null,timezone:data.timezone,receivedAt:new Date()}});
    const count=await tx.messageVersion.count({where:{messageId:message.id}});
    await tx.messageVersion.create({data:{messageId:message.id,version:count+1,text:data.text,contentHash:hash(data.text),fingerprint,metadata:json({publisher:data.publisher,url:data.url,publishedAt:data.publishedAt,timezone:data.timezone,origin:data.origin})}});
    const affectedFamily=existingFamily.filter(member=>member.id===event.id || (parseExtraction(member.extracted).success && extractionSchema.parse(member.extracted).provenance?.sourceMessageId===message.id));
    if(previous) await tx.task.updateMany({where:{eventId:{in:affectedFamily.map(member=>member.id)}},data:{needsReview:true}});
    for(const member of affectedFamily.filter(member=>member.id!==event.id)) await reassess(tx,member.id);
    await reassess(tx,event.id);await audit(tx,data.actor,previous?'Новая версия источника — нужна повторная проверка':'Сообщение получено',event.id,{messageId:message.id,version:count+1,publisher:data.publisher},isDemo);
    return {eventId:event.id,duplicate:false};
  });
}
/** Model requests run outside database transactions; results belong to exact event/profile versions. */
async function analyzeEventImpacts(eventIds:string[],actor:string,options:AiOptions) {
  const outcomes:Array<{eventId:string;locationId:string;status:ImpactResult['status']}>=[];
  for(const eventId of eventIds) {
    const inputs=await transaction(async tx=>{
      const event=await tx.event.findUniqueOrThrow({where:{id:eventId}});
      const parsed=parseExtraction(event.extracted);
      if(!parsed.success) return [];
      const extraction=parsed.data;
      const source=extraction.provenance
        ? await tx.sourceMessage.findUnique({where:{id:extraction.provenance.sourceMessageId},include:{versions:{orderBy:{version:'desc'},take:1}}})
        : await tx.sourceMessage.findFirst({where:{eventId},orderBy:{receivedAt:'desc'},include:{versions:{orderBy:{version:'desc'},take:1}}});
      if(!source?.versions[0]) return [];
      const clock=await now(tx);
      const locations=await tx.location.findMany();
      const inputs:Array<{eventVersion:number;locationId:string;locationRevision:number;input:ImpactInput}>=[];
      for(const location of locations) inputs.push({eventVersion:event.version,locationId:location.id,locationRevision:location.revision,input:{source:{text:source.versions[0].text,publisher:source.publisher,publishedAt:source.publishedAt?.toISOString() ?? null,timezone:source.timezone,sourceUrl:source.url},extraction,location:locationSchema.parse(location.profile),evaluation:await evaluateStored(tx,event,location.profile,clock)}});
      return inputs;
    });
    for(const snapshot of inputs) {
      const impact=await analyzeImpact(snapshot.input,options);
      await transaction(async tx=>{
        const event=await tx.event.findUnique({where:{id:eventId}});
        const location=await tx.location.findUnique({where:{id:snapshot.locationId}});
        if(!event || !location || event.version!==snapshot.eventVersion || location.revision!==snapshot.locationRevision) return;
        const current=await evaluateStored(tx,event,location.profile,await now(tx));
        if(current.status!==snapshot.input.evaluation.status || !isDeepStrictEqual(current.conditions,snapshot.input.evaluation.conditions)) return;
        await tx.assessment.update({where:{eventId_locationId:{eventId,locationId:location.id}},data:{impact:json(impact)}});
        await audit(tx,actor,impact.status==='error' ? 'Ошибка модели при оценке влияния' : 'Влияние на бизнес оценено',eventId,{locationId:location.id,eventVersion:event.version,locationRevision:location.revision,impact},event.isDemo);
        outcomes.push({eventId,locationId:location.id,status:impact.status});
      });
    }
  }
  return outcomes;
}

export async function analyzeEvent(id:string,actor:string,options:AiOptions={}) {
  const requested=await db.event.findUniqueOrThrow({where:{id}});
  const ownerId=sourceOwner(requested);
  const snapshot=await db.event.findUniqueOrThrow({where:{id:ownerId},include:{messages:{orderBy:{receivedAt:'desc'},include:{versions:{orderBy:{version:'desc'},take:1}},take:1},analyses:{where:{outcome:'success'},orderBy:{createdAt:'desc'},take:1}}});
  const source=snapshot.messages[0];
  if(!source) throw new AppError(400,'NO_SOURCE','У события нет исходного текста.');
  try {
    const result=await analyzeMessage({text:source.versions[0].text,publisher:source.publisher,publishedAt:source.publishedAt?.toISOString() ?? null,timezone:source.timezone},options);
    const extractions=result.extractions ?? [result.extraction];
    if(new Set(extractions.map(factKey)).size!==extractions.length) throw new AppError(422,'AI_AMBIGUOUS_EVENTS','Разбор содержит неразличимые события. Уточните исходник и повторите разбор.');
    const saved=await transaction(async tx=>{
      let current=await tx.event.findUniqueOrThrow({where:{id:ownerId}});
      if(current.version!==snapshot.version) throw new AppError(409,'STALE','Источник изменился во время разбора. Повторите разбор новой версии.');
      let merged=false;
      if(extractions.length===1 && !current.extracted && current.version===1 && !current.relatedEventId
        && await tx.task.count({where:{eventId:current.id}})===0 && await tx.event.count({where:{relatedEventId:current.id}})===0) {
        const candidates=await tx.event.findMany({where:{id:{not:current.id}},include:{messages:{select:{publisher:true}}}});
        const matches=candidates.filter(candidate=>{
          const previous=parseExtraction(candidate.extracted);
          const owner=candidates.find(event=>event.id===sourceOwner(candidate));
          const publishers=candidate.messages.length ? candidate.messages : owner?.messages ?? [];
          return candidate.status!=='superseded' && previous.success && publishers.some(message=>message.publisher===source.publisher) && isSameKnownEvent(previous.data,extractions[0]);
        });
        if(matches.length===1) {
          const target=matches[0];
          await tx.sourceMessage.updateMany({where:{eventId:current.id},data:{eventId:target.id}});
          await tx.analysis.updateMany({where:{eventId:current.id},data:{eventId:target.id}});
          await tx.audit.updateMany({where:{entityId:current.id},data:{entityId:target.id}});
          await tx.event.delete({where:{id:current.id}});
          await audit(tx,actor,'Уточнение связано с известным событием',target.id,{sourceEventId:current.id,sourceMessageId:source.id,identity:extractions[0].identity ?? null,reason:'Совпали явный идентификатор либо точные адрес и исходное время.'});
          current=await tx.event.update({where:{id:target.id},data:{version:{increment:1},confirmed:false}});
          merged=true;
        }
      }
      const members=(await family(tx,current.id)).filter(member=>member.id===current.id || (parseExtraction(member.extracted).success && extractionSchema.parse(member.extracted).provenance?.sourceMessageId===source.id));
      const previousRoot=parseExtraction(current.extracted ?? snapshot.analyses[0]?.extraction);
      const previousProvenance=previousRoot.success ? previousRoot.data.provenance : undefined;
      const previousSourceMessageIds=[...new Set([...(previousProvenance?.previousSourceMessageIds ?? []),...(previousProvenance && previousProvenance.sourceEventId!==current.id ? [previousProvenance.sourceMessageId] : [])])];
      const previousRootKey=previousRoot.success ? factKey(previousRoot.data) : null;
      const rootExtraction=extractions.find(item=>factKey(item)===previousRootKey)
        ?? extractions.find(item=>!members.some(member=>member.id!==current.id && parseExtraction(member.extracted).success && factKey(extractionSchema.parse(member.extracted))===factKey(item)))
        ?? (members.length===1 ? extractions[0] : undefined);
      const ordered=rootExtraction ? [rootExtraction,...extractions.filter(item=>item!==rootExtraction)] : extractions;
      const assigned=new Set<string>();
      const eventIds:string[]=[];
      for(const item of ordered) {
        const key=factKey(item);
        const existing=item===rootExtraction ? current : members.find(member=>member.id!==current.id && !assigned.has(member.id) && parseExtraction(member.extracted).success && factKey(extractionSchema.parse(member.extracted))===key);
        const extraction:Extraction=ordered.length>1 || members.length>1 || previousProvenance ? {...item,provenance:{sourceEventId:current.id,sourceMessageId:source.id,sourceVersion:source.versions[0].version,sourceExtractionKey:key,...(previousSourceMessageIds.length ? {previousSourceMessageIds} : {})}} : item;
        const changed=!existing || !isDeepStrictEqual(existing.extracted,extraction) || existing.status==='superseded';
        const version=existing ? existing.version+(existing.extracted && changed && !(merged && existing.id===current.id)?1:0) : 1;
        const saved=existing ? await tx.event.update({where:{id:existing.id},data:{extracted:json(extraction),title:extraction.title,category:extraction.category,status:extraction.status,version,confirmed:changed?false:existing.confirmed}})
          : await tx.event.create({data:{extracted:json(extraction),title:extraction.title,category:extraction.category,status:extraction.status,version,isDemo:current.isDemo}});
        assigned.add(saved.id);eventIds.push(saved.id);
        await tx.analysis.create({data:{eventId:saved.id,version,mode:result.mode,model:result.model,outcome:'success',durationMs:Math.round(result.durationMs),extraction:json(extraction)}});
        if(changed || merged) await tx.task.updateMany({where:{eventId:saved.id},data:{needsReview:true}});
        await audit(tx,actor,changed?'Источник разобран; сведения требуют проверки':'Повторный разбор: условия не изменились',saved.id,{mode:result.mode,model:result.model,version,sourceMessageId:source.id},saved.isDemo);
      }
      for(const member of members.filter(member=>!assigned.has(member.id))) {
        if(member.status!=='superseded') {
          await tx.event.update({where:{id:member.id},data:{status:'superseded',version:{increment:1},confirmed:false}});
          await tx.task.updateMany({where:{eventId:member.id},data:{needsReview:true}});
          await audit(tx,actor,'Выделенное событие отсутствует в новом разборе',member.id,{sourceMessageId:source.id});
        }
        await reassess(tx,member.id);
      }
      for(const eventId of eventIds) await reassess(tx,eventId);
      return {eventId:eventIds[0],eventIds};
    });
    const impacts=await analyzeEventImpacts(saved.eventIds,actor,options);
    return {...saved,impacts};
  } catch(error) {
    const failure=error as {message?:string;mode?:string;model?:string;durationMs?:number};
    await db.analysis.create({data:{eventId:ownerId,version:snapshot.version,mode:failure.mode ?? getAIStatus().mode,model:failure.model ?? null,outcome:'error',durationMs:Math.round(failure.durationMs ?? 0),error:failure.message ?? 'Ошибка разбора'}});
    throw error;
  }
}
export async function correctEvent(id:string,input:unknown) {
  const data=z.object({extraction:extractionSchema,actor:actorSchema,comment:z.string().trim().min(5).max(2000)}).parse(input);
  return transaction(async tx=>{
    const event=await tx.event.findUniqueOrThrow({where:{id},include:{messages:{include:{versions:true}}}});
    const ownerId=sourceOwner(event);
    const owner=ownerId===id ? event : await tx.event.findUniqueOrThrow({where:{id:ownerId},include:{messages:{include:{versions:true}}}});
    const original=parseExtraction(event.extracted);
    const historical=original.success && original.data.provenance?.previousSourceMessageIds?.length
      ? await tx.sourceMessage.findMany({where:{id:{in:original.data.provenance.previousSourceMessageIds}},include:{versions:true}}) : [];
    const sources=[...owner.messages,...historical].flatMap(message=>message.versions.map(version=>version.text));
    // Source ownership is server metadata, never editable source content.
    data.extraction={...data.extraction,provenance:original.success ? original.data.provenance : undefined};
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
