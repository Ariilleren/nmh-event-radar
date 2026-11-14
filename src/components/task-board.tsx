'use client';
import { useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, CalendarClock, Check, MessageSquare, Plus, X } from 'lucide-react';
import type { Task } from '@/lib/ui-types';
import { displayTime } from '@/lib/client';
import { taskLabels, useRadar } from './radar-context';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Input, Label, Select, Textarea } from './ui/input';
import { Badge } from './ui/badge';

export function TaskCreateForm({ eventId, locationId, onClose }: { eventId: string; locationId?: string; onClose: () => void }) {
  const { state, actor, busy, mutate } = useRadar();
  const event = state.events.find((item) => item.id === eventId);
  const location = state.locations.find((item) => item.id === locationId);
  return <Card className="border-primary/30"><CardHeader className="flex items-start justify-between gap-3"><div><CardTitle>Новая внутренняя задача</CardTitle><p className="mt-1 text-sm text-muted-foreground">{event?.title}</p></div><Button variant="ghost" size="icon" onClick={onClose} aria-label="Закрыть форму задачи"><X size={18} /></Button></CardHeader><CardContent><form className="space-y-4" onSubmit={async (e) => {
    e.preventDefault(); const form = new FormData(e.currentTarget); const due = new Date(String(form.get('dueAt')));
    if (!Number.isFinite(due.getTime())) return;
    const body = { eventId, locationId: form.get('locationId'), owner: form.get('owner'), dueAt: due.toISOString(), comment: form.get('comment'), actor };
    if (await mutate('/api/tasks', body, 'Внутренняя задача создана. Внешние уведомления не отправлялись.')) onClose();
  }}><div className="field-grid"><div><Label htmlFor="task-location">Точка *</Label><Select id="task-location" name="locationId" defaultValue={locationId || ''} required><option value="" disabled>Выберите точку</option>{state.locations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></div><div><Label htmlFor="task-owner">Ответственный *</Label><Input id="task-owner" name="owner" required defaultValue={location?.responsibleName || ''} /></div><div className="sm:col-span-2"><Label htmlFor="task-due">Срок *</Label><Input id="task-due" name="dueAt" type="datetime-local" required /><p className="mt-1 text-xs text-muted-foreground">Время в часовом поясе вашего браузера: {Intl.DateTimeFormat().resolvedOptions().timeZone}.</p></div></div><div><Label htmlFor="task-comment">Что нужно сделать *</Label><Textarea id="task-comment" name="comment" required defaultValue={event?.extracted?.recommendedAction || ''} /></div><p className="text-xs text-muted-foreground">Задача не подтверждает факт события. Изменение существенных условий потребует пересмотреть решение.</p><div className="flex flex-wrap gap-2"><Button type="submit" disabled={busy}><Plus size={16} />Создать задачу</Button><Button variant="outline" onClick={onClose}>Отмена</Button></div></form></CardContent></Card>;
}

function TaskRow({ task }: { task: Task }) {
  const { state, actor, busy, mutate } = useRadar();
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState(task.status);
  const event = state.events.find((item) => item.id === task.eventId);
  const location = state.locations.find((item) => item.id === task.locationId);
  const overdue = task.status !== 'done' && Date.parse(task.dueAt) < Date.parse(state.settings.now);
  return <Card data-task-id={task.id} className="overflow-hidden"><CardContent>
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 basis-full sm:basis-auto sm:flex-1"><div className="mb-2 flex flex-wrap gap-2"><Badge tone={task.status === 'done' ? 'success' : 'neutral'}>{task.status === 'done' && <Check size={12} />}{taskLabels[task.status]}</Badge>{task.needsReview && <Badge tone="warning">Событие изменилось — проверить решение</Badge>}{overdue && <Badge tone="danger">Срок прошёл</Badge>}</div><Link className="break-safe inline-flex items-center gap-1 text-base font-semibold hover:text-primary" href={`/events/${task.eventId}`}>{event?.title || 'Связанное событие'}<ArrowUpRight size={15} className="shrink-0" /></Link><p className="mt-1 text-sm text-muted-foreground">{location?.name || 'Точка недоступна'} · {task.owner}</p></div><Button variant="outline" size="sm" onClick={() => { setStatus(task.status); setEditing(!editing); }}>{editing ? 'Свернуть' : task.needsReview ? 'Пересмотреть решение' : 'Изменить статус'}</Button></div>
    <p className="break-safe mt-3 whitespace-pre-wrap text-sm">{task.comment}</p><div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground"><CalendarClock size={14} /><time dateTime={task.dueAt}>Срок: {displayTime(task.dueAt)} МСК</time></div>
    {task.decision && <div className="mt-4 rounded-xl bg-muted p-3"><p className="mb-1 text-xs font-semibold text-muted-foreground">Сохранённое решение</p><p className="break-safe whitespace-pre-wrap text-sm">{task.decision}</p></div>}
    {editing && <form className="mt-5 space-y-3 border-t border-border pt-4" onSubmit={async (e) => { e.preventDefault(); const data = new FormData(e.currentTarget); if (await mutate(`/api/tasks/${task.id}`, { status, decision: data.get('decision') || '', comment: data.get('comment') || task.comment, actor }, 'Статус и решение сохранены в журнале.', 'PATCH')) setEditing(false); }}>
      <div><Label htmlFor={`${task.id}-status`}>Статус</Label><Select id={`${task.id}-status`} value={status} onChange={(e) => setStatus(e.target.value as Task['status'])}>{Object.entries(taskLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select></div>
      <div><Label htmlFor={`${task.id}-decision`}>{status === 'done' ? 'Решение и объяснение *' : 'Решение или результат уточнения'}</Label><Textarea id={`${task.id}-decision`} name="decision" required={status === 'done'} minLength={status === 'done' ? 5 : undefined} defaultValue={task.decision || ''} placeholder="Что решено и на каком основании?" /></div>
      <div><Label htmlFor={`${task.id}-comment`}>Задача / комментарий</Label><Textarea id={`${task.id}-comment`} name="comment" defaultValue={task.comment} /></div><Button type="submit" disabled={busy}><MessageSquare size={15} />Сохранить решение</Button>
    </form>}
  </CardContent></Card>;
}
export function TaskBoard({ eventId }: { eventId?: string }) {
  const { state } = useRadar();
  const [filter, setFilter] = useState('all');
  const tasks = state.tasks.filter((task) => (!eventId || task.eventId === eventId) && (filter === 'all' || (filter === 'review' ? task.needsReview : task.status === filter)));
  return <div className="space-y-4"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">{eventId ? 'Задачи по событию' : `Задачи · ${state.tasks.length}`}</h2><Select aria-label="Фильтр задач" className="w-full sm:w-auto" value={filter} onChange={(e) => setFilter(e.target.value)}><option value="all">Все задачи</option><option value="todo">Новые</option><option value="doing">В работе</option><option value="done">Завершённые</option><option value="review">Проверить решение</option></Select></div>{tasks.length ? tasks.map((task) => <TaskRow key={task.id} task={task} />) : <Card><CardContent><p className="font-medium">{state.tasks.length ? 'По этому фильтру задач нет' : 'Пока нет задач'}</p><p className="mt-2 text-sm text-muted-foreground">Откройте событие, проверьте основания для конкретной точки и назначьте внутреннее действие.</p><Link className="mt-4 inline-block text-sm font-semibold text-primary" href="/events">Перейти к событиям →</Link></CardContent></Card>}</div>;
}
