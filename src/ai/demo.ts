import { demoMessages } from '../data/demo';
import { extractionSchema, validateQuotes } from '../domain/schemas';
import { AiError, type AnalysisInput } from './types';

export function analyzeDemo(input: AnalysisInput) {
  const fixture = demoMessages.find((message) => message.text === input.text);
  if (!fixture) throw new AiError('DEMO_UNKNOWN_TEXT', 'Демонстрационный режим знает только подготовленные учебные сообщения. Выберите пример или настройте LIVE для нового текста.', 422);
  // Relative source dates cannot safely be reused with changed publication metadata.
  if (/\b(?:tomorrow|today|yesterday)\b|завтра|сегодня|вчера/iu.test(input.text) &&
    (!input.publishedAt || Date.parse(input.publishedAt) !== Date.parse(fixture.publishedAt) || input.timezone !== fixture.timezone)) {
    throw new AiError('DEMO_METADATA_CHANGED', 'Для этого учебного сообщения изменена дата публикации или часовой пояс. Подготовленный ответ неприменим; используйте LIVE.', 422);
  }
  const extraction = extractionSchema.parse(structuredClone(fixture.extraction));
  validateQuotes(extraction, input.text);
  return extraction;
}
