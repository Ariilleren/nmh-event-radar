'use client';
import { useEffect, useState } from 'react';
import { FileText, Upload, X } from 'lucide-react';
import { useRadar } from './radar-context';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Input, Label, Select, Textarea } from './ui/input';
import { request } from '@/lib/client';

export function SourceForm({ eventId, onClose }: { eventId?: string; onClose: () => void }) {
  const { actor, busy, mutate } = useRadar();
  const [json, setJson] = useState(false);
  const [error, setError] = useState('');
  type Example = { key: string; text: string; publisher: string; publishedAt: string | null; timezone: string | null };
  const [examples, setExamples] = useState<Example[]>([]);
  const [exampleKey, setExampleKey] = useState('');
  const example = examples.find((item) => item.key === exampleKey);
  useEffect(() => { let active = true; request<{ messages: Example[] }>('/api/demo/examples').then((data) => { if (active) setExamples(data.messages); }).catch(() => { /* Manual input remains available without example loading. */ }); return () => { active = false; }; }, []);
  return <Card><CardHeader className="flex items-start justify-between gap-3"><div><CardTitle>{eventId ? 'Обновить сведения события' : 'Добавить исходное сообщение'}</CardTitle><p className="mt-1 text-xs text-muted-foreground">Ручной ввод сохраняет исходник. Введённый URL не подтверждает достоверность.</p></div><Button size="icon" variant="ghost" onClick={onClose} aria-label="Закрыть форму сообщения"><X size={18} /></Button></CardHeader><CardContent>
    <div className="mb-5 flex gap-2"><Button variant={!json ? 'outline' : 'ghost'} size="sm" aria-pressed={!json} onClick={() => { setJson(false); setError(''); }}><FileText size={14} />Текст</Button><Button variant={json ? 'outline' : 'ghost'} size="sm" aria-pressed={json} onClick={() => { setJson(true); setError(''); }}><Upload size={14} />JSON-импорт</Button></div>
    {error && <p role="alert" className="mb-4 text-sm text-red-800">{error}</p>}
    {!json && examples.length > 0 && <div className="mb-5"><Label htmlFor="source-example">Подставить учебный текст</Label><Select id="source-example" value={exampleKey} onChange={(e) => setExampleKey(e.target.value)}><option value="">Собственное сообщение</option>{examples.map((item) => <option key={item.key} value={item.key}>{item.key} · {item.text.slice(0, 70)}…</option>)}</Select><p className="mt-1 text-xs text-muted-foreground">Учебный текст остаётся вымышленным. DEMO разбирает только известные примеры.</p></div>}
    <form key={exampleKey} className="space-y-4" onSubmit={async (e) => {
      e.preventDefault(); setError(''); const form = new FormData(e.currentTarget);
      if (json) {
        try {
          const parsed: unknown = JSON.parse(String(form.get('json')));
          const messages = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' && 'messages' in parsed ? parsed.messages : null);
          if (!Array.isArray(messages) || !messages.length) throw new Error('Ожидается непустой массив сообщений или объект {"messages":[…]}.');
          if (await mutate('/api/messages/import', { messages, actor }, 'Сообщения импортированы. Запустите разбор нужных событий.')) onClose();
        } catch (error) { setError(error instanceof Error ? error.message : 'Проверьте JSON.'); }
      } else {
        const published = String(form.get('publishedAt') || '').trim();
        if (published && !Number.isFinite(Date.parse(published))) { setError('Дата публикации должна быть ISO 8601 с часовым поясом, например 2026-11-14T09:00:00+03:00.'); return; }
        const body = { text: form.get('text'), publisher: form.get('publisher'), url: form.get('url') || null, publishedAt: published || null, timezone: form.get('timezone') || null, origin: 'manual', ...(eventId ? { eventId } : {}), actor };
        if (await mutate('/api/messages', body, 'Исходное сообщение сохранено. Запустите разбор, чтобы оценить влияние.')) onClose();
      }
    }}>
      {json ? <><Label htmlFor="message-json">Сообщения JSON</Label><Textarea id="message-json" name="json" rows={9} required className="font-mono text-xs" placeholder={'[{"text":"Текст сообщения…","publisher":"Мой источник","publishedAt":null,"timezone":null,"url":null,"origin":"json"}]'} /><p className="text-xs text-muted-foreground">Поля: text, publisher, url, publishedAt (ISO 8601 или null), timezone (IANA или null), origin: json. Для явного обновления добавьте eventId. Учебные и пользовательские тексты не являются официальным подтверждением.</p></> : <><div><Label htmlFor="source-text">Исходный текст *</Label><Textarea id="source-text" name="text" rows={5} minLength={10} maxLength={20000} required defaultValue={example?.text} placeholder="Вставьте сообщение целиком, сохранив даты, адреса и ограничения…" /></div><div className="field-grid"><div><Label htmlFor="source-publisher">Издатель или источник *</Label><Input id="source-publisher" name="publisher" required defaultValue={example?.publisher} placeholder="Название, указанное в источнике" /></div><div><Label htmlFor="source-url">URL, если известен</Label><Input id="source-url" type="url" name="url" placeholder="https://…" /></div><div><Label htmlFor="source-date">Дата публикации с часовым поясом</Label><Input id="source-date" name="publishedAt" defaultValue={example?.publishedAt || ''} placeholder="2026-11-14T09:00:00+03:00" /></div><div><Label htmlFor="source-timezone">Часовой пояс публикации</Label><Select id="source-timezone" name="timezone" defaultValue={example?.timezone || ''}><option value="">Неизвестно</option><option value="Europe/Moscow">Europe/Moscow</option><option value="UTC">UTC</option></Select></div></div><p className="text-xs text-muted-foreground">Для относительных дат («завтра») нужны дата и часовой пояс публикации. Без них результат потребует уточнения.</p></>}
      <div className="flex flex-wrap gap-3"><Button type="submit" disabled={busy}>{json ? 'Импортировать JSON' : 'Сохранить сообщение'}</Button><Button variant="outline" onClick={onClose}>Отмена</Button></div>
    </form>
  </CardContent></Card>;
}
