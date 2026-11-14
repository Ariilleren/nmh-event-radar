import { businessContextSchema, literalInQuote, sourceExtractionSchema, validateBusinessContext, validateQuotes, type BusinessContext, type Extraction } from '../domain/schemas';
import { AiError, type AnalysisInput } from './types';

function localDate(instant: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant));
  return ['year', 'month', 'day'].map((type) => parts.find((part) => part.type === type)?.value).join('-');
}

function addressText(value: string): string {
  return value.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[.,:;]/g, ' ')
    .replace(/(^|\s)ул(?=\s|$)/gu, '$1улица').replace(/(^|\s)д(?=\s|$)/gu, '$1дом')
    .replace(/(^|\s)(?:корп|к)(?=\s|$)/gu, '$1корпус').replace(/(^|\s)стр(?=\s|$)/gu, '$1строение')
    .replace(/(^|\s)г(?=\s|$)/gu, '$1').replace(/\s+/gu, ' ').trim();
}

function groundedAddress(address: string, quote: string): boolean {
  const value = addressText(address), source = addressText(quote);
  if (!literalInQuote(value, source)) return false;
  // A house prefix is not the complete address of a building/corpus or fractional house.
  const index = source.indexOf(value);
  const following = source.slice(index + value.length);
  return !/^(?:\s*\/\s*\d|\s+(?:корпус|строение)(?:\s|$))/u.test(following);
}

export function validateLiveResult(value: unknown, input: AnalysisInput): Extraction {
  const parsed = sourceExtractionSchema.safeParse(value);
  if (!parsed.success) throw new AiError('AI_INVALID_SCHEMA', 'AI вернул данные, не соответствующие схеме события. Сведения не сохранены как результат разбора.');
  const extraction = parsed.data;
  try { validateQuotes(extraction, input.text); }
  catch { throw new AiError('AI_INVALID_EVIDENCE', 'AI указал цитату, которой нет в исходном сообщении, либо не приложил доказательство к условию.'); }

  if (extraction.street) {
    const quotes = extraction.evidence.filter((item) => item.field === 'street').map((item) => item.quote);
    if (!quotes.some((quote) => literalInQuote(addressText(extraction.street!), addressText(quote)))) {
      throw new AiError('AI_UNGROUNDED_STREET', 'Улица AI отсутствует в подтверждающей цитате. Название и маршрут не предполагаются.');
    }
  }

  if (extraction.address) {
    const quotes = extraction.evidence.filter((item) => item.field === 'address').map((item) => item.quote);
    if (!quotes.some((quote) => groundedAddress(extraction.address!, quote)) || !groundedAddress(extraction.address, input.text)) {
      throw new AiError('AI_UNGROUNDED_ADDRESS', 'Адрес AI отсутствует в подтверждающей цитате. Дом, корпус и соседние адреса не предполагаются.');
    }
  }
  for (const address of extraction.affectedAddresses ?? []) {
    if (!groundedAddress(address, input.text)) throw new AiError('AI_UNGROUNDED_ADDRESS', 'Адрес AI сокращён относительно источника. Уточните дом и корпус.');
  }

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
  for (const field of ['startsAt', 'endsAt', 'responseDeadline'] as const) {
    const time = extraction[field];
    const timeQuote = extraction.evidence.filter((item) => item.field === field).map((item) => item.quote).join(' ').toLowerCase();
    const relative = /послезавтра|завтра|сегодня|вчера/u.exec(timeQuote)?.[0];
    if (!relative || !time) continue;
    if (!input.publishedAt || !input.timezone) {
      extraction[field] = null;
      if (field === 'startsAt') extraction.endsAt = null;
    } else {
      const day = localDate(input.publishedAt, input.timezone);
      const offset = ({ послезавтра: 2, завтра: 1, сегодня: 0, вчера: -1 } as Record<string, number>)[relative];
      const expected = new Date(Date.parse(`${day}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
      const actual = localDate(time, input.timezone);
      // An explicitly described overnight interval may end the following day.
      const following = new Date(Date.parse(`${expected}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      const range = /(\d{1,2}):(\d{2})\s*(?:–|—|-|до)\s*(\d{1,2}):(\d{2})/u.exec(timeQuote);
      const crossesMidnight = range && Number(range[3]) * 60 + Number(range[4]) <= Number(range[1]) * 60 + Number(range[2]);
      const overnight = field === 'endsAt' && (crossesMidnight || /следующ[а-я]*\s+(?:день|дня|утр[а-я]*)|через полночь|ноч[а-я]*/u.test(timeQuote));
      if (actual !== expected && !(overnight && actual === following)) {
        throw new AiError('AI_INVALID_RELATIVE_DATE', 'AI неверно разрешил относительную дату по времени публикации. Требуется исправление разбора.');
      }
    }
  }
  return extraction;
}

/** All events are validated before any member of the batch can be persisted. */
export function validateLiveResults(value: unknown, input: AnalysisInput): Extraction[] {
  if (value && typeof value === 'object' && 'events' in value) {
    const envelope = value as Record<string, unknown>;
    if (Object.keys(envelope).length !== 1 || !Array.isArray(envelope.events) || envelope.events.length < 1 || envelope.events.length > 8) {
      throw new AiError('AI_INVALID_SCHEMA', 'AI должен вернуть от одного до восьми самостоятельных событий. Результат не принят.');
    }
    return envelope.events.map((event) => validateLiveResult(event, input));
  }
  // Compatibility with the pre-existing single-event provider contract.
  return [validateLiveResult(value, input)];
}

export function validateBusinessResult(value: unknown, description: string): BusinessContext {
  const parsed = businessContextSchema.safeParse(value);
  if (!parsed.success) throw new AiError('AI_PROFILE_INVALID_SCHEMA', 'AI вернул некорректную структуру бизнес-процессов. Описание сохранено без догадок.');
  try { validateBusinessContext(parsed.data, description); }
  catch { throw new AiError('AI_PROFILE_INVALID_EVIDENCE', 'AI указал процессы, зависимости или расписание без подтверждения в описании. Описание сохранено без догадок.'); }
  return parsed.data;
}
