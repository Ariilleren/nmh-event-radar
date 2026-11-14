export class RequestError extends Error {
  constructor(message: string, public status = 0) { super(message); this.name = 'RequestError'; }
}

export async function request<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method, cache: 'no-store',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch { throw new RequestError('Нет связи с локальным сервером. Результат изменения может быть неизвестен. Обновите состояние перед повтором.'); }
  let data;
  try { data = await response.json(); } catch { throw new RequestError(`Сервер вернул нечитаемый ответ (HTTP ${response.status}).`, response.status); }
  if (!response.ok) throw new RequestError(data?.error?.message || `Не удалось выполнить запрос (HTTP ${response.status}).`, response.status);
  return data as T;
}

export function displayTime(value: unknown, timezone = 'Europe/Moscow'): string {
  if (typeof value !== 'string' || !value) return 'Время не указано';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  try { return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: timezone }).format(date); }
  catch { return date.toISOString(); }
}

export function safeUrl(value: string | null): string | undefined {
  if (!value) return undefined;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}
