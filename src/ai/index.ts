import { z } from 'zod';
import { timezoneSchema } from '../domain/schemas';
import { getAIStatus, readAiMode } from './config';
import { AiError, type AiOptions, type AnalysisInput, type AnalysisResult, type BusinessAnalysisResult } from './types';

export { getAIStatus, AiError };
export type { AiOptions, AnalysisInput, AnalysisResult, BusinessAnalysisResult };

const inputSchema = z.object({
  text: z.string().min(10).max(16_000),
  publisher: z.string().min(1).max(200),
  publishedAt: z.iso.datetime({ offset: true }).nullable(),
  timezone: timezoneSchema.nullable(),
});

export async function analyzeMessage(input: AnalysisInput, options: AiOptions = {}): Promise<AnalysisResult> {
  const started = Date.now();
  let mode: 'DEMO' | 'LIVE' | null = null;
  try {
    mode = readAiMode(options.env);
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) throw new AiError('AI_INPUT_INVALID', 'Для разбора нужны текст от 10 до 16000 символов, издатель и корректные дата/часовой пояс либо null.', 400);
    if (mode === 'DEMO') {
      const { analyzeDemo } = await import('./demo');
      return { extraction: analyzeDemo(parsed.data), mode, model: null, durationMs: Date.now() - started };
    }
    const { analyzeLive } = await import('./live');
    const result = await analyzeLive(parsed.data, options);
    return { ...result, mode, durationMs: Date.now() - started };
  } catch (cause) {
    const error = cause instanceof AiError ? cause : new AiError('AI_VALIDATION_ERROR', 'Не удалось проверить результат AI. Сведения не приняты.');
    error.mode = mode;
    error.model = mode === 'LIVE' ? (options.env ?? process.env).AI_MODEL?.trim() || null : null;
    error.durationMs = Date.now() - started;
    throw error;
  }
}

/** Parse user context once when edited; news text is never an input to this operation. */
export async function analyzeBusinessDescription(description: string, options: AiOptions = {}): Promise<BusinessAnalysisResult> {
  const started = Date.now();
  let mode: 'DEMO' | 'LIVE' | null = null;
  try {
    mode = readAiMode(options.env);
    const parsed = z.string().trim().min(1).max(8000).safeParse(description);
    if (!parsed.success) throw new AiError('AI_INPUT_INVALID', 'Описание бизнеса должно содержать от 1 до 8000 символов.', 400);
    if (mode === 'DEMO') throw new AiError('AI_PROFILE_DEMO_ONLY', 'Описание сохранено. Для разбора новых бизнес-процессов нужен настроенный режим LIVE; DEMO не угадывает зависимости.', 422);
    const { analyzeBusinessLive } = await import('./live');
    const result = await analyzeBusinessLive(parsed.data, options);
    return { ...result, mode, durationMs: Date.now() - started };
  } catch (cause) {
    const error = cause instanceof AiError ? cause : new AiError('AI_VALIDATION_ERROR', 'Не удалось проверить бизнес-процессы. Описание сохранено без предположений.');
    error.mode = mode;
    error.model = mode === 'LIVE' ? (options.env ?? process.env).AI_MODEL?.trim() || null : null;
    error.durationMs = Date.now() - started;
    throw error;
  }
}

export async function checkAIConnection(options: AiOptions = {}) {
  const mode = readAiMode(options.env);
  if (mode === 'DEMO') return {
    ok: true, mode, model: null, checkedAt: new Date().toISOString(), durationMs: 0,
    message: 'DEMO доступен локально. Соединение с моделью не проверялось.',
  };
  const result = await analyzeMessage({
    text: 'Тест подключения. Учебное сообщение: выставка книг состоится. Место и время неизвестны.',
    publisher: 'Локальная проверка соединения', publishedAt: null, timezone: null,
  }, options);
  return {
    ok: true, mode, model: result.model, durationMs: result.durationMs, checkedAt: new Date().toISOString(),
    message: 'LIVE API вернул ответ, прошедший проверку схемы и цитат. Это проверка подключения, не оценка качества модели.',
  };
}
