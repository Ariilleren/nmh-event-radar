export const BUSINESS_TYPES = ['Кофейня', 'Пекарня', 'Ресторан', 'Магазин', 'Услуги', 'Другое'] as const;
export type BusinessType = '' | (typeof BUSINESS_TYPES)[number];
export const EVENT_RADIUS_METERS = 1000;

/** Old free-text values are displayed as Other, without adding invented options. */
export function normalizeBusinessType(value: string | null | undefined): BusinessType {
  if (!value?.trim()) return '';
  return BUSINESS_TYPES.find(item => item === value.trim()) ?? 'Другое';
}
