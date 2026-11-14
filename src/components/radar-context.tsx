'use client';
import { createContext, useContext } from 'react';
import type { RadarState } from '@/lib/ui-types';
export type RadarContextValue = { state: RadarState; actor: string; busy: boolean; mutate: (path: string, body: unknown, message: string, method?: string) => Promise<boolean> };
export const RadarContext = createContext<RadarContextValue | null>(null);
export function useRadar() { const context = useContext(RadarContext); if (!context) throw new Error('Нет контекста кабинета'); return context; }
export const categoryLabels: Record<string, string> = { mass_event: 'Мероприятие', road_closure: 'Движение', water_outage: 'Водоснабжение', movement_access: 'Движение и доступ', utilities: 'Коммунальная инфраструктура', weather: 'Погода и природные явления', incident: 'Происшествия', neighborhood: 'Изменения района', competition: 'Конкуренты и партнёры', supplier_product: 'Поставщики и товары', commercial: 'Цены и условия', regulation: 'Правила и сроки', procurement: 'Заказы и поддержка', digital_platform: 'Платформы и сервисы', labor: 'Рынок труда', reputation: 'Репутация', unsupported: 'Категория не определена', pending: 'Ожидает разбора' };
export const statusLabels: Record<string, string> = { scheduled: 'Запланировано', active: 'Действует', completed: 'Завершено', superseded: 'Заменено новым разбором', cancelled: 'Отменено', rescheduled: 'Перенесено', postponed: 'Отложено', relevant: 'Требует действия', needs_review: 'Требует уточнения', excluded: 'Не касается точки', inactive: 'Неактуально', pending: 'Нужен разбор', unprocessed: 'Нужен разбор' };
export const relevanceLabels: Record<string, string> = { direct: 'Прямая связь', potential: 'Потенциальная связь', unrelated: 'Нет связи', insufficient_data: 'Недостаточно данных' };
export const influenceLabels: Record<string, string> = { risk: 'Риск', opportunity: 'Возможность', mixed: 'Риск и возможность', information: 'Информация' };
export const taskLabels = { todo: 'Новая', doing: 'В работе', done: 'Завершена' };
export const priorityLabels: Record<string, string> = { high: 'Высокий приоритет', medium: 'Средний приоритет', low: 'Планово', urgent: 'Срочно', upcoming: 'В ближайшие дни', routine: 'Планово', normal: 'Планово' };
