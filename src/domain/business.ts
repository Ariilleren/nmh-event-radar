import type { Category, Industry } from './schemas';

type IndustryPreset = { label: string; processes: readonly string[]; dependencies: readonly string[]; categories: readonly Category[] };

/** Questions for analysis, never facts about a particular business. Only user input confirms a dependency. */
export const INDUSTRY_CONFIG: Record<Industry, IndustryPreset> = {
  foodservice: { label: 'Общепит', processes: ['Приготовление', 'Обслуживание гостей', 'Доставка продуктов'], dependencies: ['water', 'electricity', 'cooling', 'Поставщики', 'Поток посетителей'], categories: ['utilities', 'mass_event', 'supplier_product', 'movement_access'] },
  retail: { label: 'Розничная торговля', processes: ['Продажа', 'Пополнение запасов', 'Хранение'], dependencies: ['Поставщики', 'Товары', 'electricity', 'Доступ покупателей'], categories: ['supplier_product', 'commercial', 'neighborhood', 'movement_access'] },
  ecommerce: { label: 'Интернет-магазины и ПВЗ', processes: ['Приём заказов', 'Комплектация', 'Выдача и доставка'], dependencies: ['Платформы', 'Товарные категории', 'Склад', 'Доставка'], categories: ['commercial', 'digital_platform', 'supplier_product', 'movement_access'] },
  household_services: { label: 'Бытовые услуги и ремонт', processes: ['Запись клиентов', 'Выполнение работ', 'Закупка материалов'], dependencies: ['Материалы', 'Оборудование', 'electricity', 'Доступ клиентов'], categories: ['utilities', 'supplier_product', 'procurement'] },
  education: { label: 'Образование', processes: ['Занятия', 'Запись учащихся', 'Дистанционное обучение'], dependencies: ['Аудитория', 'Помещения', 'internet', 'Платформы'], categories: ['movement_access', 'digital_platform', 'regulation', 'labor'] },
  hospitality: { label: 'Гостиницы, туризм и мероприятия', processes: ['Бронирование', 'Размещение', 'Организация мероприятий'], dependencies: ['Платформы бронирования', 'water', 'Доступ гостей', 'Мероприятия'], categories: ['mass_event', 'movement_access', 'weather', 'digital_platform'] },
  construction: { label: 'Строительство и недвижимость', processes: ['Работы на объекте', 'Поставка материалов', 'Эксплуатация'], dependencies: ['Материалы', 'Подрядчики', 'Транспорт', 'electricity'], categories: ['supplier_product', 'weather', 'regulation', 'procurement'] },
  manufacturing: { label: 'Производство', processes: ['Производственная смена', 'Закупка сырья', 'Отгрузка'], dependencies: ['Сырьё', 'Поставщики', 'Оборудование', 'electricity'], categories: ['utilities', 'supplier_product', 'commercial', 'movement_access'] },
  agriculture: { label: 'Сельское хозяйство', processes: ['Полевые работы', 'Уход за продукцией', 'Хранение и отгрузка'], dependencies: ['Погода', 'water', 'cooling', 'Поставщики'], categories: ['weather', 'utilities', 'supplier_product', 'regulation'] },
  wholesale: { label: 'Оптовая торговля', processes: ['Закупка партий', 'Хранение', 'Отгрузка заказов'], dependencies: ['Поставщики', 'Товары', 'Склад', 'Перевозчики'], categories: ['supplier_product', 'commercial', 'movement_access', 'procurement'] },
  logistics: { label: 'Логистика и склады', processes: ['Рейс', 'Погрузка', 'Хранение'], dependencies: ['Маршруты', 'Транспорт', 'Время рейса', 'Склад'], categories: ['movement_access', 'weather', 'utilities', 'commercial'] },
  it: { label: 'IT и цифровые продукты', processes: ['Обслуживание сервиса', 'Интеграции', 'Обработка платежей'], dependencies: ['Облачные провайдеры', 'Внешние API', 'Платёжные системы', 'internet'], categories: ['digital_platform', 'commercial', 'regulation', 'reputation'] },
  professional_services: { label: 'Профессиональные услуги для компаний', processes: ['Выполнение проектов', 'Работа с клиентами', 'Участие в закупках'], dependencies: ['Клиентская отрасль', 'Платформы', 'Квалификация сотрудников'], categories: ['procurement', 'regulation', 'labor', 'digital_platform'] },
};

export const RESOURCE_LABELS: Readonly<Record<string, string>> = { water: 'вода', electricity: 'электричество', internet: 'интернет и связь', cooling: 'охлаждение' };

export function normalizeIdentity(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[«»"“”]/gu, '').replace(/\s+/gu, ' ').trim();
}

/** Explicit aliases only: a shared industry never implies use of a particular resource or provider. */
export function normalizeResource(value: string): string {
  const normalized = normalizeIdentity(value);
  const aliases: Record<string, string> = {
    'вода': 'water', 'водоснабжение': 'water', 'электричество': 'electricity', 'электроэнергия': 'electricity', 'электроснабжение': 'electricity',
    'интернет': 'internet', 'интернет и связь': 'internet', 'охлаждение': 'cooling', 'холодильное оборудование': 'cooling',
  };
  return aliases[normalized] ?? normalized;
}
