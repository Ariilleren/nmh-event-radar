import { z } from 'zod';

export const timezoneSchema = z.string().min(1).max(80).refine((value) => {
  try { new Intl.DateTimeFormat('ru-RU', { timeZone: value }).format(); return true; }
  catch { return false; }
}, 'Укажите действительный часовой пояс, например Europe/Moscow');
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Время должно иметь формат ЧЧ:ММ');
export const hoursSchema = z.object({
  days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  start: clock,
  end: clock,
}).strict();

export const industrySchema = z.enum(['foodservice', 'retail', 'ecommerce', 'household_services', 'education', 'hospitality', 'construction', 'manufacturing', 'agriculture', 'wholesale', 'logistics', 'it', 'professional_services']);
export const categorySchema = z.enum(['mass_event', 'movement_access', 'utilities', 'weather', 'incident', 'neighborhood', 'competition', 'supplier_product', 'commercial', 'regulation', 'procurement', 'digital_platform', 'labor', 'reputation', 'road_closure', 'water_outage', 'unsupported']);
const names = z.array(z.string().trim().min(1).max(200)).max(40);
export const evidenceSchema = z.array(z.object({ field: z.string().min(1).max(120), quote: z.string().min(1).max(2000) }).strict()).max(100);

/** Derived exclusively from the user's description; never from a publication. */
export const businessContextSchema = z.object({
  industry: industrySchema.optional(),
  products: names.optional(),
  services: names.optional(),
  suppliers: names.optional(),
  brands: names.optional(),
  platforms: names.optional(),
  resources: names.optional(),
  audiences: names.optional(),
  processes: z.array(z.object({
    name: z.string().trim().min(1).max(200),
    resources: names.optional(),
    platforms: names.optional(),
    suppliers: names.optional(),
    products: names.optional(),
    routes: names.optional(),
    schedule: z.array(hoursSchema).max(21).optional(),
  }).strict()).max(30).optional(),
  productionHours: z.array(hoursSchema).max(21).optional(),
  evidence: evidenceSchema,
}).strict();

export const locationSchema = z.object({
  locationId: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(160),
  address: z.string().trim().min(1).max(400),
  city: z.string().trim().min(1).max(120).nullable().default(null),
  latitude: z.number().min(-90).max(90).nullable().default(null),
  longitude: z.number().min(-180).max(180).nullable().default(null),
  timezone: timezoneSchema,
  openingHours: z.array(hoursSchema).max(21).default([]),
  deliveryWindows: z.array(hoursSchema).max(21).default([]),
  deliveryRouteStreets: z.array(z.string().trim().min(1).max(160)).max(50).default([]),
  eventRadiusMeters: z.number().int().min(0).max(100000).nullable().default(null),
  waterDependency: z.enum(['essential', 'optional', 'unknown']).default('unknown'),
  responsibleName: z.string().trim().max(120).default(''),
  businessDescription: z.string().trim().max(8000).optional(),
  businessContext: businessContextSchema.optional(),
  businessContextError: z.string().max(1000).nullable().optional(),
}).strict().refine((value) => (value.latitude === null) === (value.longitude === null), {
  message: 'Укажите обе координаты или оставьте обе неизвестными', path: ['latitude'],
});

const instant = z.iso.datetime({ offset: true });
export const sourceExtractionSchema = z.object({
  category: categorySchema,
  categories: z.array(categorySchema).min(1).max(14).optional(),
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(2000),
  status: z.enum(['scheduled', 'cancelled', 'rescheduled', 'active', 'postponed', 'completed']),
  startsAt: instant.nullable(),
  endsAt: instant.nullable(),
  timezone: timezoneSchema.nullable(),
  city: z.string().trim().min(1).max(120).nullable(),
  street: z.string().trim().min(1).max(200).nullable(),
  address: z.string().trim().min(1).max(400).nullable(),
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  vehicleRestriction: z.boolean().nullable(),
  impactHypothesis: z.string().trim().min(1).max(2000),
  recommendedAction: z.string().trim().min(1).max(1000),
  entities: z.object({
    suppliers: names.optional(), platforms: names.optional(), brands: names.optional(), products: names.optional(), services: names.optional(),
    industries: names.optional(), audiences: names.optional(),
  }).strict().optional(),
  affectedResources: names.optional(),
  affectedAddresses: names.optional(),
  factStatus: z.enum(['announced', 'occurred', 'forecast', 'proposed', 'enacted', 'unknown']).optional(),
  influence: z.enum(['risk', 'opportunity', 'mixed', 'information']).optional(),
  responseDeadline: instant.nullable().optional(),
  identity: z.string().trim().min(1).max(300).nullable().optional(),
  evidence: evidenceSchema.min(1),
}).strict().refine((value) => !value.startsAt || !value.endsAt || Date.parse(value.endsAt) > Date.parse(value.startsAt), {
  message: 'Конец события должен быть позже начала', path: ['endsAt'],
}).refine((value) => !value.categories || value.categories.includes(value.category), {
  message: 'Основная категория должна входить в список категорий', path: ['categories'],
}).refine((value) => (value.latitude === null) === (value.longitude === null), {
  message: 'Координаты события должны быть парой', path: ['latitude'],
});

/** Server-owned provenance is persisted for event siblings, never accepted from AI. */
export const extractionSchema = sourceExtractionSchema.safeExtend({
  provenance: z.object({
    sourceEventId: z.string().min(1).max(100), sourceMessageId: z.string().min(1).max(100),
    sourceVersion: z.number().int().positive(), sourceExtractionKey: z.string().min(1).max(300),
    previousSourceMessageIds: z.array(z.string().min(1).max(100)).max(50).optional(),
  }).strict().optional(),
});
export const extractionBatchSchema = z.object({ events: z.array(sourceExtractionSchema).min(1).max(8) }).strict();

export const messageInputSchema = z.object({
  text: z.string().trim().min(10).max(20000),
  publisher: z.string().trim().min(1).max(200),
  url: z.url().max(2048).refine((value) => ['https:', 'http:'].includes(new URL(value).protocol), 'Допускаются HTTP(S)-ссылки').nullable().default(null),
  publishedAt: instant.nullable().default(null),
  timezone: timezoneSchema.nullable().default(null),
  origin: z.enum(['manual', 'demo', 'json', 'telegram']).default('manual'),
  eventId: z.string().min(1).max(100).optional(),
  actor: z.string().trim().min(1).max(120).default('Менеджер демонстрационной сессии'),
}).strict();

export type LocationInput = z.infer<typeof locationSchema>;
export type Extraction = z.infer<typeof extractionSchema>;
export type MessageInput = z.infer<typeof messageInputSchema>;
export type Hours = z.infer<typeof hoursSchema>;
export type Industry = z.infer<typeof industrySchema>;
export type Category = z.infer<typeof categorySchema>;
export type BusinessContext = z.infer<typeof businessContextSchema>;

export function normalizeWhitespace(text: string): string { return text.normalize('NFC').replace(/\s+/gu, ' ').trim(); }

const normalizedName = (text: string) => normalizeWhitespace(text).toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
export function literalInQuote(value: string, quote: string): boolean {
  const needle = normalizedName(value);
  const haystack = normalizedName(quote);
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    const before = haystack[index - 1], after = haystack[index + needle.length];
    if ((!before || !/[\p{L}\p{N}]/u.test(before)) && (!after || !/[\p{L}\p{N}]/u.test(after))) return true;
    index = haystack.indexOf(needle, index + 1);
  }
  return false;
}

const resourceTerms: Record<string, RegExp> = {
  water: /\bwater\b|(?<![а-я])(?:вода|воды|воде|воду|водой|водоснабжени[а-я]*)(?![а-я])/iu,
  electricity: /\belectricity\b|электричеств[а-я]*|электроэнерги[а-я]*|электроснабжени[а-я]*/iu,
  internet: /\binternet\b|интернет[а-я]*|(?:мобильн[а-я]*|телефонн[а-я]*)\s+связ[а-я]*/iu,
  cooling: /\bcooling\b|охлаждени[а-я]*|холодильн[а-я]*/iu,
};
export function resourceInQuote(value: string, quote: string): boolean {
  return resourceTerms[normalizedName(value)]?.test(quote) ?? literalInQuote(value, quote);
}

function cited(evidence: Extraction['evidence'], field: string): string {
  return evidence.filter((item) => item.field === field || item.field.startsWith(`${field}.`)).map((item) => item.quote).join('\n');
}

function validateNames(values: string[] | undefined, field: string, evidence: Extraction['evidence'], resources = false) {
  if (!values?.length) return;
  const quote = cited(evidence, field);
  if (!quote || values.some((value) => !(resources ? resourceInQuote(value, quote) : literalInQuote(value, quote)))) {
    throw new Error(`Нет точного основания для значения поля «${field}»`);
  }
}

/** Validates provenance, not the semantic truth of the extracted claim. */
export function validateQuotes(extraction: Extraction, text: string): void {
  const normalized = normalizeWhitespace(text);
  for (const item of extraction.evidence) {
    if (!normalizeWhitespace(item.quote) || !normalized.includes(normalizeWhitespace(item.quote))) {
      throw new Error(`Цитата поля «${item.field}» отсутствует в исходном тексте`);
    }
  }
  const evidenceFields = new Set(extraction.evidence.map((item) => item.field));
  for (const field of ['category', 'status', 'startsAt', 'endsAt', 'city', 'street', 'address', 'latitude', 'longitude', 'vehicleRestriction'] as const) {
    if (extraction[field] !== null && !evidenceFields.has(field)) {
      throw new Error(`Нет цитаты для поля «${field}»`);
    }
  }
  for (const field of ['categories', 'factStatus', 'responseDeadline', 'identity'] as const) {
    const value = extraction[field];
    if (value !== null && value !== undefined && (!Array.isArray(value) || value.length) && !cited(extraction.evidence, field)) {
      throw new Error(`Нет цитаты для поля «${field}»`);
    }
  }
  if (extraction.identity && !literalInQuote(extraction.identity, cited(extraction.evidence, 'identity'))) {
    throw new Error('Идентификатор события должен присутствовать в источнике');
  }
  validateNames(extraction.affectedAddresses, 'affectedAddresses', extraction.evidence);
  validateNames(extraction.affectedResources, 'affectedResources', extraction.evidence, true);
  for (const [field, values] of Object.entries(extraction.entities ?? {})) {
    validateNames(values, `entities.${field}`, extraction.evidence);
  }
}

function quoteHasClock(quote: string, time: string): boolean {
  const [hour, minute] = time.split(':').map(Number);
  if (new RegExp(`(?<!\\d)0?${hour}:${String(minute).padStart(2, '0')}(?!\\d)`).test(quote)) return true;
  if (minute !== 0) return false;
  if (new RegExp(`(?<!\\d)${hour}\\s*(?:час|утра|вечера|ночи|дня)`, 'iu').test(quote)) return true;
  const clockRange = /(?:с\s*)?(\d{1,2})\s*(?:–|—|-|до)\s*(\d{1,2})(?![\d:])/gu;
  return [...quote.matchAll(clockRange)].some((match) => Number(match[1]) === hour || Number(match[2]) === hour);
}

function quoteDays(quote: string): Set<number> {
  const normalized = normalizedName(quote);
  if (/ежедневно|каждый день|все дни|всю неделю|без выходных/u.test(normalized)) return new Set([1, 2, 3, 4, 5, 6, 7]);
  const found = new Set<number>();
  if (/будн[а-я]*|рабочи[а-я]* дни/u.test(normalized)) [1, 2, 3, 4, 5].forEach((day) => found.add(day));
  if (/выходн[а-я]*/u.test(normalized)) [6, 7].forEach((day) => found.add(day));
  const names = ['понедельник[а-я]*|пн', 'вторник[а-я]*|вт', 'сред[а-я]*|ср', 'четверг[а-я]*|чт', 'пятниц[а-я]*|пт', 'суббот[а-я]*|сб', 'воскресень[а-я]*|вс'];
  const matches = [...normalized.matchAll(new RegExp(`(?<![а-я])(${names.map((name) => `(?:${name})`).join('|')})(?![а-я])`, 'gu'))];
  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    const day = names.findIndex((name) => new RegExp(`^(?:${name})$`, 'u').test(current[0])) + 1;
    found.add(day);
    const next = matches[i + 1];
    if (next && /^\s*(?:–|—|-|по|до)\s*$/u.test(normalized.slice(current.index + current[0].length, next.index))) {
      const last = names.findIndex((name) => new RegExp(`^(?:${name})$`, 'u').test(next[0])) + 1;
      for (let cursor = day; cursor !== last; cursor = cursor % 7 + 1) found.add(cursor);
      found.add(last);
    }
  }
  return found;
}

function validateSchedule(hours: Hours[] | undefined, field: string, evidence: BusinessContext['evidence']) {
  if (!hours?.length) return;
  const quote = cited(evidence, field);
  const days = quoteDays(quote);
  if (!quote || hours.some((slot) => !quoteHasClock(quote, slot.start) || !quoteHasClock(quote, slot.end) || slot.days.some((day) => !days.has(day)))) {
    throw new Error(`Расписание «${field}» не подтверждено описанием: нужны дни, начало и конец`);
  }
}

/** Checks provenance and concrete names/times; does not claim to prove all natural-language semantics. */
export function validateBusinessContext(context: BusinessContext, description: string): void {
  const source = normalizeWhitespace(description);
  for (const item of context.evidence) {
    if (!source.includes(normalizeWhitespace(item.quote))) throw new Error('Цитата профиля отсутствует в описании пользователя');
  }
  if (context.industry && !cited(context.evidence, 'industry')) throw new Error('Отрасль не подкреплена описанием');
  for (const field of ['products', 'services', 'suppliers', 'brands', 'platforms', 'resources', 'audiences'] as const) {
    validateNames(context[field], field, context.evidence, field === 'resources');
  }
  validateSchedule(context.productionHours, 'productionHours', context.evidence);
  for (const [index, process] of (context.processes ?? []).entries()) {
    const prefix = `processes.${index}`;
    validateNames([process.name], `${prefix}.name`, context.evidence);
    for (const field of ['resources', 'platforms', 'suppliers', 'products', 'routes'] as const) {
      validateNames(process[field], `${prefix}.${field}`, context.evidence, field === 'resources');
    }
    validateSchedule(process.schedule, `${prefix}.schedule`, context.evidence);
  }
}
