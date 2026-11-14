'use client';
import { createContext, useContext } from 'react';
import type { RadarState } from '@/lib/ui-types';
export type RadarContextValue = { state: RadarState; actor: string; busy: boolean; mutate: (path: string, body: unknown, message: string, method?: string) => Promise<boolean> };
export const RadarContext = createContext<RadarContextValue | null>(null);
export function useRadar() { const context = useContext(RadarContext); if (!context) throw new Error('Нет контекста кабинета'); return context; }
export const categoryLabels: Record<string, string> = { mass_event: 'Мероприятие', road_closure: 'Движение', water_outage: 'Водоснабжение', unsupported: 'Вне охвата', pending: 'Ожидает разбора' };
export const statusLabels: Record<string, string> = { scheduled: 'Запланировано', cancelled: 'Отменено', rescheduled: 'Перенесено', relevant: 'Требует действия', needs_review: 'Требует уточнения', excluded: 'Не касается точки', inactive: 'Неактуально', pending: 'Нужен разбор', unprocessed: 'Нужен разбор' };
export const taskLabels = { todo: 'Новая', doing: 'В работе', done: 'Завершена' };
export const priorityLabels: Record<string, string> = { high: 'Высокий приоритет', medium: 'Средний приоритет', low: 'Планово', urgent: 'Срочно', upcoming: 'В ближайшие дни', routine: 'Планово', normal: 'Планово' };
