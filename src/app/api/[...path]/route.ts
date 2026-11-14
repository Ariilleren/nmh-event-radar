import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import { csvTemplate, previewCsv } from '@/server/csv';
import * as workflow from '@/server/workflow';
import { demoMessages, demoLocations } from '@/data/demo';
import { Prisma } from '@/generated/prisma/client';
export const runtime='nodejs';
export const dynamic='force-dynamic';
const actor = z.object({actor:z.string().trim().min(1).max(120)});
async function handler(request:NextRequest,context:{params:Promise<{path:string[]}>}) {
  try {
    const {path}=await context.params;
    const key=path.join('/');
    const method=request.method;
    if(method==='GET') {
      if(key==='health') {await db.$queryRaw`SELECT 1`;return NextResponse.json({ok:true});}
      if(key==='state') return NextResponse.json(await workflow.getState());
      if(key==='demo/examples') return NextResponse.json({messages:demoMessages,locations:demoLocations});
      if(key==='locations/template') return new Response(csvTemplate(),{headers:{'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="locations-template.csv"'}});
      throw new AppError(404,'NOT_FOUND','Страница API не найдена.');
    }
    const origin=request.headers.get('origin');
    const host=request.headers.get('host');
    if(origin) {
      let sameOrigin=false;
      try {const source=new URL(origin);sameOrigin=['http:','https:'].includes(source.protocol) && ['localhost','127.0.0.1','[::1]'].includes(source.hostname) && source.host===host;}
      catch { /* Invalid origins are rejected. */ }
      if(!sameOrigin) throw new AppError(403,'ORIGIN','Запросы с другого сайта не разрешены.');
    }
    if(Number(request.headers.get('content-length') ?? 0)>1_100_000) throw new AppError(413,'BODY_LIMIT','Запрос превышает 1 МБ.');
    const raw=await request.text();
    if(Buffer.byteLength(raw)>1_100_000) throw new AppError(413,'BODY_LIMIT','Запрос превышает 1 МБ.');
    let body:unknown;
    try {body=JSON.parse(raw || '{}');} catch {throw new AppError(400,'JSON','Некорректный JSON.');}
    let result:unknown;
    if(method==='POST' && key==='locations') result=await workflow.saveLocation(body);
    else if(method==='PATCH' && path[0]==='locations' && path.length===2) result=await workflow.saveLocation(body,path[1]);
    else if(method==='POST' && key==='locations/preview') result=previewCsv(z.object({csv:z.string()}).parse(body).csv);
    else if(method==='POST' && key==='locations/import') {const data=actor.extend({csv:z.string()}).parse(body);result=await workflow.importLocations(data.csv,data.actor);}
    else if(method==='POST' && key==='messages') result=await workflow.addMessage(body);
    else if(method==='POST' && key==='messages/import') {
      const data=actor.extend({messages:z.array(z.record(z.string(),z.unknown())).min(1).max(50)}).parse(body);
      const results=[];
      // Each source is an atomic import; partial outcome is explicit for resumable batches.
      for(let i=0;i<data.messages.length;i++) {
        try {results.push({row:i+1,...await workflow.addMessage({...data.messages[i],origin:'json',actor:data.actor})});}
        catch(error) {results.push({row:i+1,error:error instanceof Error?error.message:'Ошибка записи'});}
      }
      result={results,imported:results.filter(row=>!('error' in row)).length};
    }
    else if(path[0]==='events' && path[1]) {
      if(method==='POST' && path[2]==='analyze') result=await workflow.analyzeEvent(path[1],actor.parse(body).actor);
      else if(method==='POST' && path[2]==='confirm') result=await workflow.confirmEvent(path[1],actor.parse(body).actor);
      else if(method==='POST' && path[2]==='group') result=await workflow.groupEvent(path[1],body);
      else if(method==='PATCH' && path.length===2) result=await workflow.correctEvent(path[1],body);
      else throw new AppError(404,'NOT_FOUND','Операция события не найдена.');
    }
    else if(method==='POST' && key==='tasks') result=await workflow.createTask(body);
    else if(method==='PATCH' && path[0]==='tasks' && path.length===2) result=await workflow.updateTask(path[1],body);
    else if(method==='POST' && key==='demo/seed') result=await workflow.seedDemo(actor.parse(body).actor);
    else if(method==='POST' && key==='demo/reset') result=await workflow.resetDemo(body);
    else if(method==='PATCH' && key==='settings') result=await workflow.setClock(body);
    else if(method==='POST' && key==='ai/check') result=await workflow.checkConnection();
    else throw new AppError(404,'NOT_FOUND','Операция API не найдена.');
    return NextResponse.json(result);
  } catch(error) {
    if(error instanceof ZodError) return NextResponse.json({error:{code:'VALIDATION',message:error.issues.map(issue=>`${issue.path.join('.')}: ${issue.message}`).join('; ')}},{status:400});
    if(error instanceof Prisma.PrismaClientKnownRequestError) {
      const status=error.code==='P2025'?404:error.code==='P2002'?409:500;
      return NextResponse.json({error:{code:error.code,message:status===404?'Запись не найдена.':status===409?'Такая запись уже существует. Обновите страницу.':'Не удалось сохранить данные в БД.'}},{status});
    }
    const known=error as {statusCode?:number;code?:string;message?:string};
    const status=known.statusCode && known.statusCode>=400 && known.statusCode<=599 ? known.statusCode:500;
    return NextResponse.json({error:{code:known.code ?? 'SERVER_ERROR',message:status===500?'Не удалось выполнить операцию. Проверьте доступность PostgreSQL и конфигурацию сервера.':known.message ?? 'Ошибка операции.'}},{status});
  }
}
export {handler as GET,handler as POST,handler as PATCH};
