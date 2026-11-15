import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AiError, type AiOptions } from './types';

export type NewsAiProvider = 'groq' | 'gemini';
const PROVIDERS = {
  groq: { prefix: 'GROQ', label: 'Groq', model: 'openai/gpt-oss-20b', base: 'https://api.groq.com/openai/v1' },
  gemini: { prefix: 'GEMINI', label: 'Gemini', model: 'gemini-3.1-flash-lite', base: 'https://generativelanguage.googleapis.com/v1beta/openai' },
} as const;
type Environment = Record<string, string | undefined>;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ISO_OFFSET_PATTERN = z.toJSONSchema(z.iso.datetime({ offset: true })).pattern;

function resolveSettings(env: Environment) {
  const selected = env.NEWS_AI_PROVIDER?.trim() || 'groq';
  if (selected !== 'groq' && selected !== 'gemini') throw new AiError('NEWS_AI_INVALID_CONFIG', 'Выбран неизвестный провайдер анализа.', 503);
  const provider: NewsAiProvider = selected;
  const defaults = PROVIDERS[provider];
  const model = env[defaults.prefix + '_MODEL']?.trim() || defaults.model;
  let base: URL;
  try { base = new URL(env[defaults.prefix + '_BASE_URL']?.trim() || defaults.base); }
  catch { throw new AiError(defaults.prefix + '_INVALID_CONFIG', 'Адрес сервера анализа настроен неверно.', 503); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new AiError(defaults.prefix + '_INVALID_CONFIG', 'Адрес сервера анализа должен использовать HTTPS без параметров и учётных данных.', 503);
  }
  const baseUrl = base.href.replace(/\/+$/, '');
  return { provider, model, baseUrl, endpoint: baseUrl + '/chat/completions', cacheScope: hash({ provider, model, baseUrl }) };
}

/** Safe status for GET consumers: no key, endpoint or upstream diagnostics. */
export function getNewsAiStatus(env: Environment = process.env): { provider: NewsAiProvider | null; configured: boolean; model: string | null; errorCode: string | null } {
  try {
    const config = resolveSettings(env);
    const configured = Boolean(env[PROVIDERS[config.provider].prefix + '_API_KEY']?.trim());
    return { provider: config.provider, configured, model: config.model, errorCode: configured ? null : PROVIDERS[config.provider].prefix + '_NOT_CONFIGURED' };
  } catch (error) {
    return { provider: null, configured: false, model: null, errorCode: error instanceof AiError ? error.code : 'NEWS_AI_INVALID_CONFIG' };
  }
}

/** Stable before credentials exist; namespace excludes all API keys. */
export function getNewsAiCacheScope(env: Environment = process.env): string {
  try { return resolveSettings(env).cacheScope; }
  catch {
    return hash({ invalid: true, provider: env.NEWS_AI_PROVIDER ?? '', groqModel: env.GROQ_MODEL ?? '', groqBase: env.GROQ_BASE_URL ?? '', geminiModel: env.GEMINI_MODEL ?? '', geminiBase: env.GEMINI_BASE_URL ?? '' });
  }
}

/** Server-only credentials: never serialize or log this configuration. */
export function getNewsAiConfig(env: Environment = process.env) {
  const config = resolveSettings(env);
  const apiKey = env[PROVIDERS[config.provider].prefix + '_API_KEY']?.trim();
  if (!apiKey) throw new AiError(PROVIDERS[config.provider].prefix + '_NOT_CONFIGURED', 'Для анализа нужно настроить серверный ключ выбранного провайдера.', 503);
  return { ...config, apiKey };
}

function retryDelay(response: Response, provider: NewsAiProvider): number | undefined {
  const header = response.headers.get('retry-after');
  if (header !== null) {
    const seconds = Number(header);
    const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
    if (milliseconds > 0) return Math.min(milliseconds, 24 * 60 * 60 * 1000);
  }
  if (provider === 'groq' && response.status === 429) {
    const reset = response.headers.get('x-ratelimit-reset-tokens') ?? '';
    if (/^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/u.test(reset)) {
      const units: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000 };
      const delay = [...reset.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/gu)].reduce((sum, match) => sum + Number(match[1]) * units[match[2]], 0);
      if (delay > 0) return Math.min(delay, 3600000);
    }
  }
  return undefined;
}

/** Both providers receive the strict schema; full Zod validation remains local. */
export function newsJsonSchema(schema: z.ZodType, prefix = 'GROQ'): Record<string, unknown> {
  const result = z.toJSONSchema(schema) as Record<string, unknown>;
  delete result.$schema;
  function inspect(node: unknown) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(inspect); return; }
    const value = node as Record<string, unknown>;
    // Google's constrained decoder rejects the nested array bounds in the
    // profile schema. Keep the exact original limits in local Zod validation.
    if (prefix === 'GEMINI') { delete value.minItems; delete value.maxItems; }
    // date-time already describes this standard ISO constraint. Keep the original
    // Zod validator locally and preserve any nonstandard/custom pattern.
    if (value.type === 'string' && value.format === 'date-time' && value.pattern === ISO_OFFSET_PATTERN) delete value.pattern;
    if (value.type === 'object' && value.properties) {
      value.additionalProperties = false;
      const keys = Object.keys(value.properties);
      if (keys.some((key) => !(value.required as string[] | undefined)?.includes(key))) {
        throw new AiError(`${prefix}_INVALID_SCHEMA_CONFIG`, 'Внутренняя схема анализа содержит необязательные поля.', 500);
      }
    }
    Object.values(value).forEach(inspect);
  }
  inspect(result);
  return result;
}

/** One bounded request, with at most one transient retry. No fallback or response logging. */
export async function completeNewsJson<T>(schema: z.ZodType<T>, system: string, data: unknown, options: AiOptions = {}): Promise<{ value: T; model: string; durationMs: number }> {
  const started = Date.now();
  const settings = getNewsAiConfig(options.env ?? process.env);
  const { prefix, label } = PROVIDERS[settings.provider];
  const serialized = JSON.stringify(data);
  if (serialized.length > 64000) throw new AiError(`${prefix}_INPUT_TOO_LONG`, 'Слишком большой профиль или текст для одного анализа.', 400);
  const timeout = Math.max(1, Math.min(options.timeoutMs ?? (settings.provider === 'gemini' ? 60000 : 20000), 60000));
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new AiError(`${prefix}_TIMEOUT`, `${label} не ответил вовремя. Результат анализа не сохранён.`, 504)); }, timeout);
  });
  const run = async () => {
    const body = JSON.stringify({
      model: settings.model,
      ...(settings.provider === 'groq' && settings.model.startsWith('openai/gpt-oss-') ? { reasoning_effort: 'low' } : {}),
      ...(settings.provider === 'gemini' && settings.model.startsWith('gemini-3.1-flash-lite') ? { reasoning_effort: 'minimal' } : {}),
      messages: [{ role: 'system', content: system }, { role: 'user', content: serialized }],
      response_format: { type: 'json_schema', json_schema: { name: 'personal_news_analysis', strict: true, schema: newsJsonSchema(schema, prefix) } },
      ...(settings.provider === 'gemini' ? { max_tokens: 10000 } : { max_completion_tokens: 10000 }),
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      let response: Response;
      try {
        response = await (options.fetchImpl ?? fetch)(settings.endpoint, {
          method: 'POST', headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
          body, signal: controller.signal,
        });
      } catch {
        throw new AiError(controller.signal.aborted ? `${prefix}_TIMEOUT` : `${prefix}_NETWORK`, `Не удалось получить ответ ${label}. Проверьте соединение сервера.`, 503);
      }
      if (!response.ok) {
        // Never copy upstream bodies: they can contain inputs, credentials or diagnostics.
        await response.body?.cancel();
        const providerDelay = retryDelay(response, settings.provider);
        const delay = providerDelay ?? (response.status === 429 ? 60_000 : 400);
        if (attempt === 0 && [429, 503].includes(response.status)) {
          // A long provider backoff belongs to the durable queue, not an early retry.
          if (delay <= 2000 && Date.now() - started + delay < timeout) {
            await (options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(delay);
            if (controller.signal.aborted) throw new AiError(`${prefix}_TIMEOUT`, `Истекло время ожидания ${label}.`, 504);
            continue;
          }
        }
        if ([401, 403].includes(response.status)) throw new AiError(`${prefix}_AUTH`, `${label} отклонил серверный ключ. Проверьте настройки доступа.`, 503);
        if (response.status === 413) throw new AiError(`${prefix}_INPUT_TOO_LONG`, `Полный запрос превышает доступный лимит ${label}. Нужен более короткий профиль или запрос.`, 413);
        if (response.status === 400) throw new AiError(`${prefix}_INVALID_REQUEST`, `${label} отклонил структурированный запрос. Обработка приостановлена до повторной проверки.`, 503);
        if (response.status === 429) {
          const error = new AiError(`${prefix}_RATE_LIMIT`, `Достигнут лимит запросов ${label}. Анализ будет доступен позже.`, 503);
          error.retryAfterMs = providerDelay;
          throw error;
        }
        throw new AiError(`${prefix}_UPSTREAM`, `${label} сейчас не может выполнить анализ. Сохранённая новость доступна для повторной обработки.`, 502);
      }
      if (Number(response.headers.get('content-length')) > 160000) throw new AiError(`${prefix}_RESPONSE_TOO_LARGE`, `Ответ ${label} превысил допустимый размер.`);
      const reader = response.body?.getReader();
      if (!reader) throw new AiError(`${prefix}_INVALID_RESPONSE`, `${label} вернул пустой ответ.`);
      const decoder = new TextDecoder();
      let raw = '', bytes = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 160000) { await reader.cancel(); throw new AiError(`${prefix}_RESPONSE_TOO_LARGE`, `Ответ ${label} превысил допустимый размер.`); }
        raw += decoder.decode(chunk.value, { stream: true });
      }
      raw += decoder.decode();
      let value: unknown;
      try {
        const envelope = JSON.parse(raw);
        const choice = envelope.choices?.[0];
        if (choice?.finish_reason !== 'stop' || typeof choice?.message?.content !== 'string' || choice.message.refusal) throw new Error();
        value = JSON.parse(choice.message.content);
      } catch { throw new AiError(`${prefix}_INVALID_JSON`, `${label} не вернул полный структурированный результат. Рекомендации не созданы.`); }
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw new AiError(`${prefix}_INVALID_SCHEMA`, `Ответ ${label} не прошёл проверку структуры. Рекомендации не созданы.`);
      return { value: parsed.data, model: settings.model, durationMs: Date.now() - started };
    }
    throw new AiError(`${prefix}_UPSTREAM`, `Не удалось выполнить анализ ${label}.`);
  };
  try { return await Promise.race([run(), timeoutPromise]); }
  catch (error) {
    const safe = error instanceof AiError ? error : new AiError(`${prefix}_NETWORK`, `Не удалось получить полный ответ ${label}.`);
    safe.mode = 'LIVE'; safe.model = settings.model; safe.durationMs = Date.now() - started;
    throw safe;
  } finally { clearTimeout(timer); controller.abort(); }
}
