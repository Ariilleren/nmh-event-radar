import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { AppError } from '@/server/errors';
import * as product from '@/server/product';
import { reverseGeocode } from '@/server/geocode';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ path?: string[] }> };

function sameOrigin(request: NextRequest) {
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  let valid = false;
  try {
    const source = new URL(origin ?? '');
    // Next may reconstruct request.url with an internal localhost hostname.
    // The browser's real destination is Host; forwarded host headers are not trusted.
    valid = Boolean(host) && ['http:', 'https:'].includes(source.protocol) && source.origin === origin &&
      source.protocol === request.nextUrl.protocol && source.host === host!.toLowerCase();
  } catch { /* reject */ }
  if (!valid || request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new AppError(403, 'ORIGIN', 'Запросы разрешены только с сайта приложения.');
  }
}
function responseHeaders() { return { 'Cache-Control': 'private, no-store', 'Vary': 'Cookie', 'X-Content-Type-Options': 'nosniff' }; }

async function handler(request: NextRequest, context: Context) {
  try {
    const path = (await context.params).path ?? [];
    const key = path.join('/');
    const token = request.cookies.get(product.sessionCookie)?.value;
    if (request.method === 'GET' && !key) {
      return NextResponse.json(await product.getProductState(await product.sessionUser(token)), { headers: responseHeaders() });
    }
    if (request.method === 'GET' && key === 'geocode/reverse') {
      await product.requireUser(token);
      return NextResponse.json(await reverseGeocode({ latitude: request.nextUrl.searchParams.get('latitude'), longitude: request.nextUrl.searchParams.get('longitude') }), { headers: responseHeaders() });
    }
    if (request.method === 'GET') throw new AppError(404, 'ROUTE', 'Страница API не найдена.');
    sameOrigin(request);
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
      throw new AppError(415, 'JSON', 'Отправьте данные в формате JSON.');
    }
    if (Number(request.headers.get('content-length') ?? 0) > 750_000) throw new AppError(413, 'BODY', 'Слишком большой запрос.');
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 750_000) throw new AppError(413, 'BODY', 'Слишком большой запрос.');
    let body: unknown;
    try { body = JSON.parse(raw || '{}'); } catch { throw new AppError(400, 'JSON', 'Некорректный JSON.'); }
    let cookie: string | null | undefined;
    if (request.method === 'POST' && (key === 'auth/register' || key === 'auth/login')) {
      const auth = key === 'auth/register' ? await product.register(body) : await product.login(body);
      cookie = auth.token;
      // A new login never preserves the previous browser's session identifier.
      if (token) await product.logout(token);
    } else if (request.method === 'POST' && key === 'auth/logout') {
      await product.logout(token);
      cookie = null;
    } else {
      const user = await product.requireUser(token);
      if (request.method === 'PATCH' && key === 'profile') await product.updateProfile(user.id, body);
      else if (request.method === 'POST' && key === 'locations') await product.savePersonalLocation(user.id, body);
      else if (path[0] === 'locations' && path.length === 2 && request.method === 'PATCH') await product.savePersonalLocation(user.id, body, path[1]);
      else if (path[0] === 'locations' && path.length === 2 && request.method === 'DELETE') await product.deletePersonalLocation(user.id, path[1]);
      else if (path[0] === 'feedback' && path.length === 2 && request.method === 'PUT') await product.setFeedback(user.id, path[1], body);
      else if (key === 'notifications/read' && request.method === 'POST') await product.markNotificationsRead(user.id, body);
      else throw new AppError(404, 'ROUTE', 'Операция API не найдена.');
    }
    const currentToken = cookie === undefined ? token : cookie ?? undefined;
    const response = NextResponse.json(await product.getProductState(await product.sessionUser(currentToken)), { headers: responseHeaders() });
    if (cookie !== undefined) response.cookies.set(product.sessionCookie, cookie ?? '', {
      httpOnly: true, sameSite: 'lax', secure: new URL(request.url).protocol === 'https:', path: '/',
      maxAge: cookie === null ? 0 : product.sessionSeconds,
    });
    return response;
  } catch (error) {
    if (error instanceof ZodError) return NextResponse.json({ error: { message: error.issues.map(issue => issue.message).join(' ') } }, { status: 400, headers: responseHeaders() });
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      const status = error.code === 'P2002' ? 409 : error.code === 'P2025' ? 404 : 500;
      return NextResponse.json({ error: { message: status === 409 ? 'Этот email или идентификатор точки уже используется.' : status === 404 ? 'Запись не найдена.' : 'Не удалось сохранить данные.' } }, { status, headers: responseHeaders() });
    }
    const known = error as { statusCode?: number; message?: string };
    const status = known.statusCode && known.statusCode >= 400 && known.statusCode <= 599 ? known.statusCode : 500;
    return NextResponse.json({ error: { message: status === 500 ? 'Не удалось выполнить операцию. Повторите попытку позже.' : known.message } }, { status, headers: responseHeaders() });
  }
}
export { handler as GET, handler as POST, handler as PATCH, handler as PUT, handler as DELETE };
