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
}).strict().refine((value) => (value.latitude === null) === (value.longitude === null), {
  message: 'Укажите обе координаты или оставьте обе неизвестными', path: ['latitude'],
});

const instant = z.iso.datetime({ offset: true });
export const extractionSchema = z.object({
  category: z.enum(['mass_event', 'road_closure', 'water_outage', 'unsupported']),
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(2000),
  status: z.enum(['scheduled', 'cancelled', 'rescheduled']),
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
  evidence: z.array(z.object({ field: z.string().min(1).max(80), quote: z.string().min(1).max(2000) }).strict()).min(1).max(30),
}).strict().refine((value) => !value.startsAt || !value.endsAt || Date.parse(value.endsAt) > Date.parse(value.startsAt), {
  message: 'Конец события должен быть позже начала', path: ['endsAt'],
}).refine((value) => (value.latitude === null) === (value.longitude === null), {
  message: 'Координаты события должны быть парой', path: ['latitude'],
});

export const messageInputSchema = z.object({
  text: z.string().trim().min(10).max(20000),
  publisher: z.string().trim().min(1).max(200),
  url: z.url().max(2048).refine((value) => ['https:', 'http:'].includes(new URL(value).protocol), 'Допускаются HTTP(S)-ссылки').nullable().default(null),
  publishedAt: instant.nullable().default(null),
  timezone: timezoneSchema.nullable().default(null),
  origin: z.enum(['manual', 'demo', 'json']).default('manual'),
  eventId: z.string().min(1).max(100).optional(),
  actor: z.string().trim().min(1).max(120).default('Менеджер демонстрационной сессии'),
}).strict();

export type LocationInput = z.infer<typeof locationSchema>;
export type Extraction = z.infer<typeof extractionSchema>;
export type MessageInput = z.infer<typeof messageInputSchema>;
export type Hours = z.infer<typeof hoursSchema>;

export function normalizeWhitespace(text: string): string { return text.normalize('NFC').replace(/\s+/gu, ' ').trim(); }

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
}
