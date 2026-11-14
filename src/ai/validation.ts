import { extractionSchema, validateQuotes, type Extraction } from '../domain/schemas';
import { AiError, type AnalysisInput } from './types';

function localDate(instant: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant));
  return ['year', 'month', 'day'].map((type) => parts.find((part) => part.type === type)?.value).join('-');
}

export function validateLiveResult(value: unknown, input: AnalysisInput): Extraction {
  const parsed = extractionSchema.safeParse(value);
  if (!parsed.success) throw new AiError('AI_INVALID_SCHEMA', 'AI вернул данные, не соответствующие схеме события. Сведения не сохранены как результат разбора.');
  const extraction = parsed.data;
  try { validateQuotes(extraction, input.text); }
  catch { throw new AiError('AI_INVALID_EVIDENCE', 'AI указал цитату, которой нет в исходном сообщении, либо не приложил доказательство к условию.'); }

  for (const field of ['latitude', 'longitude'] as const) {
    const coordinate = extraction[field];
    if (coordinate === null) continue;
    const quotes = extraction.evidence.filter((item) => item.field === field).map((item) => item.quote).join(' ');
    const numbers = [...quotes.matchAll(/[-+]?\d+(?:[.,]\d+)?/g)].map((match) => Number(match[0].replace(',', '.')));
    if (!numbers.some((number) => Math.abs(number - coordinate) < 1e-8)) {
      throw new AiError('AI_UNGROUNDED_COORDINATES', 'Координаты AI отсутствуют в цитате. Введите подтверждённые координаты вручную; геокодирование не выполнялось.');
    }
  }

  // A relative publication day is only resolvable with both publication instant and zone.
  const startQuote = extraction.evidence.filter((item) => item.field === 'startsAt').map((item) => item.quote).join(' ').toLowerCase();
  const relative = /послезавтра|завтра|сегодня|вчера/u.exec(startQuote)?.[0];
  if (relative && extraction.startsAt) {
    if (!input.publishedAt || !input.timezone) {
      extraction.startsAt = null;
      extraction.endsAt = null;
    } else {
      const day = localDate(input.publishedAt, input.timezone);
      const offset = ({ послезавтра: 2, завтра: 1, сегодня: 0, вчера: -1 } as Record<string, number>)[relative];
      const expected = new Date(Date.parse(`${day}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
      if (localDate(extraction.startsAt, input.timezone) !== expected) {
        throw new AiError('AI_INVALID_RELATIVE_DATE', 'AI неверно разрешил относительную дату по времени публикации. Требуется исправление разбора.');
      }
    }
  }
  return extraction;
}
