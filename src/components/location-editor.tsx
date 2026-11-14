'use client';
import { useState } from 'react';
import { Plus, Trash2, Save, X } from 'lucide-react';
import type { Location, ScheduleWindow } from '@/lib/ui-types';
import { useRadar } from './radar-context';
import { Button } from './ui/button';
import { Input, Label, Select, Textarea } from './ui/input';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';

const days = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
function ScheduleEditor({ title, value, onChange }: { title: string; value: ScheduleWindow[]; onChange: (value: ScheduleWindow[]) => void }) {
  return <fieldset className="min-w-0 rounded-xl border border-border p-4"><legend className="px-1 text-sm font-semibold">{title}</legend>
    {!value.length && <p className="mb-3 text-xs text-muted-foreground">Не указано — при оценке потребуется уточнение.</p>}
    <div className="space-y-4">{value.map((window, index) => <div className="min-w-0 space-y-2" key={index}>
      <div className="flex flex-wrap gap-1">{days.map((day, i) => <label className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1.5 text-xs" key={day}><input type="checkbox" checked={window.days.includes(i + 1)} onChange={(e) => onChange(value.map((w, n) => n === index ? { ...w, days: e.target.checked ? [...w.days, i + 1].sort() : w.days.filter((v) => v !== i + 1) } : w))} />{day}</label>)}</div>
      <div className="grid min-w-0 gap-2 sm:grid-cols-2"><label className="min-w-0 text-xs text-muted-foreground">Начало<Input aria-label={`${title}: начало интервала ${index + 1}`} type="time" className="mt-1" required value={window.start} onChange={(e) => onChange(value.map((w, n) => n === index ? { ...w, start: e.target.value } : w))} /></label><label className="min-w-0 text-xs text-muted-foreground">Конец<Input aria-label={`${title}: конец интервала ${index + 1}`} type="time" className="mt-1" required value={window.end} onChange={(e) => onChange(value.map((w, n) => n === index ? { ...w, end: e.target.value } : w))} /></label></div><Button variant="ghost" size="sm" aria-label={`Удалить интервал ${index + 1}`} onClick={() => onChange(value.filter((_, n) => n !== index))}><Trash2 size={14} />Удалить интервал</Button>
    </div>)}</div>
    <Button size="sm" variant="outline" className="mt-3" onClick={() => onChange([...value, { days: [1, 2, 3, 4, 5, 6, 7], start: '08:00', end: '20:00' }])}><Plus size={14} />Добавить интервал</Button>
    <p className="mt-2 text-xs text-muted-foreground">Конец раньше начала означает переход через полночь.</p>
  </fieldset>;
}
export function LocationEditor({ location, onClose }: { location?: Location; onClose: () => void }) {
  const { actor, mutate, busy } = useRadar();
  const [openingHours, setOpening] = useState(location?.openingHours || []);
  const [deliveryWindows, setDelivery] = useState(location?.deliveryWindows || []);
  const prefix = location?.id || 'new';
  return <Card><CardHeader className="flex items-center justify-between gap-3"><CardTitle>{location ? 'Редактирование точки' : 'Новая точка'}</CardTitle><Button variant="ghost" size="icon" aria-label="Закрыть форму точки" onClick={onClose}><X size={18} /></Button></CardHeader><CardContent>
    <form onSubmit={async (e) => {
      e.preventDefault(); const data = new FormData(e.currentTarget);
      const num = (key: string) => data.get(key) === '' ? null : Number(data.get(key));
      const body = { locationId: data.get('locationId'), name: data.get('name'), address: data.get('address'), city: data.get('city') || null, latitude: num('latitude'), longitude: num('longitude'), timezone: data.get('timezone'), openingHours, deliveryWindows, deliveryRouteStreets: String(data.get('streets') || '').split('\n').map((v) => v.trim()).filter(Boolean), eventRadiusMeters: num('radius'), waterDependency: data.get('water'), responsibleName: data.get('responsibleName'), actor };
      if (await mutate(location ? `/api/locations/${encodeURIComponent(location.id)}` : '/api/locations', body, 'Точка сохранена. Применимость событий пересчитана.', location ? 'PATCH' : 'POST')) onClose();
    }} className="space-y-5"><div className="field-grid">
      <div><Label htmlFor={`${prefix}-key`}>Идентификатор точки *</Label><Input id={`${prefix}-key`} name="locationId" required defaultValue={location?.locationId} placeholder="coffee-arena" /></div>
      <div><Label htmlFor={`${prefix}-name`}>Название *</Label><Input id={`${prefix}-name`} name="name" required defaultValue={location?.name} placeholder="У Арены" /></div>
      <div className="sm:col-span-2"><Label htmlFor={`${prefix}-address`}>Полный адрес, включая корпус *</Label><Input id={`${prefix}-address`} name="address" required defaultValue={location?.address} placeholder="Улица, дом, корпус" /></div>
      <div><Label htmlFor={`${prefix}-city`}>Город</Label><Input id={`${prefix}-city`} name="city" defaultValue={location?.city || ''} placeholder="Неизвестно" /></div>
      <div><Label htmlFor={`${prefix}-tz`}>Часовой пояс *</Label><Input id={`${prefix}-tz`} name="timezone" required defaultValue={location?.timezone || 'Europe/Moscow'} /></div>
      <div><Label htmlFor={`${prefix}-lat`}>Широта</Label><Input id={`${prefix}-lat`} name="latitude" type="number" step="any" min="-90" max="90" defaultValue={location?.latitude ?? ''} placeholder="Неизвестно" /></div>
      <div><Label htmlFor={`${prefix}-lon`}>Долгота</Label><Input id={`${prefix}-lon`} name="longitude" type="number" step="any" min="-180" max="180" defaultValue={location?.longitude ?? ''} placeholder="Неизвестно" /></div>
      <div><Label htmlFor={`${prefix}-radius`}>Радиус мероприятий, м</Label><Input id={`${prefix}-radius`} name="radius" type="number" min="0" max="100000" defaultValue={location?.eventRadiusMeters ?? ''} placeholder="Не задан" /></div>
      <div><Label htmlFor={`${prefix}-water`}>Зависимость от воды</Label><Select id={`${prefix}-water`} name="water" defaultValue={location?.waterDependency || 'unknown'}><option value="unknown">Неизвестно</option><option value="essential">Вода необходима</option><option value="optional">Есть независимый план работы</option></Select></div>
      <div><Label htmlFor={`${prefix}-owner`}>Ответственный</Label><Input id={`${prefix}-owner`} name="responsibleName" defaultValue={location?.responsibleName} /></div>
      <div><Label htmlFor={`${prefix}-streets`}>Улицы маршрута доставки</Label><Textarea id={`${prefix}-streets`} name="streets" defaultValue={location?.deliveryRouteStreets.join('\n')} placeholder="По одной улице в строке" /></div>
    </div><div className="field-grid"><ScheduleEditor title="Часы работы" value={openingHours} onChange={setOpening} /><ScheduleEditor title="Окна доставки" value={deliveryWindows} onChange={setDelivery} /></div>
    <p className="text-xs text-muted-foreground">Неизвестные координаты и условия остаются неизвестными. Координаты указывайте из подтверждённого ввода; учебные данные помечаются отдельно.</p>
    <div className="flex flex-wrap gap-3"><Button type="submit" disabled={busy}><Save size={16} />Сохранить точку</Button><Button variant="outline" onClick={onClose}>Отмена</Button></div></form>
  </CardContent></Card>;
}
