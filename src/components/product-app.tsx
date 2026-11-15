'use client';

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUpRight, Bell, CalendarDays, Check, CheckCheck, ChevronDown, CircleHelp, Eye, EyeOff, LoaderCircle, MapPin, Music2, Radio, Route, ThumbsDown, ThumbsUp, UserRound, Waves, X } from 'lucide-react';
import type { ProductEvent, ProductNotification, ProductProfile, ProductRecommendation, ProductState } from '@/lib/product-types';
import { ProductProfilePanel } from './product-profile';

const ProductMap = dynamic(() => import('./product-map').then((module) => module.ProductMap), { ssr: false, loading: () => <div className="pr-map-loading"><LoaderCircle className="pr-spin" size={24} /><span>Открываем карту…</span></div> });
type ProductView = 'feed' | 'map' | 'notifications' | 'profile' | 'news' | 'source' | 'register' | 'login';
type Feedback = { text: string; error: boolean } | null;
type Act = (path: string, body: unknown, options?: { method?: string; success?: string }) => Promise<boolean>;
export type AppContext = { state: ProductState; busy: boolean; act: Act };
class ProductRequestError extends Error {
  constructor(message: string, public uncertain = false) { super(message); this.name = 'ProductRequestError'; }
}
const categories: Record<string, { label: string; icon: typeof Music2; mark: string }> = {
  mass_event: { label: 'В городе', icon: Music2, mark: 'Aa' },
  road_closure: { label: 'На дорогах', icon: Route, mark: '↗' },
  water_outage: { label: 'Городские работы', icon: Waves, mark: '≈' },
  movement_access: { label: 'На дорогах', icon: Route, mark: '↗' },
  utilities: { label: 'Городские работы', icon: Waves, mark: '≈' },
  weather: { label: 'Погода', icon: Radio, mark: '≈' },
  incident: { label: 'Происшествия', icon: Radio, mark: '!' },
  neighborhood: { label: 'Рядом', icon: MapPin, mark: '＋' },
  competition: { label: 'Конкуренты', icon: Radio, mark: '↗' },
  supplier_product: { label: 'Поставщики', icon: Route, mark: '↗' },
  commercial: { label: 'Для бизнеса', icon: Radio, mark: '＋' },
  regulation: { label: 'Правила и требования', icon: Radio, mark: '＋' },
  procurement: { label: 'Закупки', icon: Radio, mark: '＋' },
  digital_platform: { label: 'Сервисы и платформы', icon: Radio, mark: '＋' },
  labor: { label: 'Команда', icon: Radio, mark: '＋' },
  reputation: { label: 'Репутация', icon: Radio, mark: '＋' },
  unsupported: { label: 'Другое', icon: Radio, mark: '＋' },
};
function category(event: ProductEvent) { return categories[event.category] || categories.unsupported; }
function formatDate(value: string | null, withTime = true) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Дата уточняется';
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}), timeZone: 'Europe/Moscow' }).format(new Date(value));
}
function safeUrl(value: string | null) {
  if (!value) return undefined;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}
function analysisDescription(health: ProductState['analysisHealth']) {
  const descriptions = {
    ready: 'Анализ полученных сообщений завершён.',
    pending: 'Новые сообщения ожидают анализа.',
    error: 'Анализ пока недоступен. Новости сохранены.',
    missing_config: 'Анализ пока недоступен. Новости сохранены.',
    sign_in: 'Войдите, чтобы получать персональные рекомендации.',
  };
  const message = health.message.trim();
  return message && message.length <= 300 && !/groq|api[_ -]?key|token|secret|exception|prisma|https?:|[a-z]+_[a-z_]+/i.test(message) ? message : descriptions[health.status];
}
async function api<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  let response;
  try {
    response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(90_000) });
  } catch { throw new ProductRequestError('Нет ответа от сервера. Обновите состояние перед повтором: изменение могло сохраниться.', true); }
  let result;
  try { result = await response.json(); } catch { throw new ProductRequestError(`Не удалось прочитать ответ сервера (${response.status}).`, true); }
  if (!response.ok) throw new ProductRequestError(result?.error?.message || `Не удалось выполнить действие (${response.status}).`, response.status >= 500);
  return result as T;
}
function Avatar({ user, large = false }: { user: ProductProfile | null; large?: boolean }) {
  return <span className={`pr-avatar ${large ? 'pr-avatar-large' : ''}`}>{user?.photo ? <Image unoptimized src={user.photo} alt="Фото профиля" width={large ? 112 : 38} height={large ? 112 : 38} /> : user ? user.name.split(' ').map((part) => part[0]).slice(0, 2).join('').toUpperCase() : <UserRound size={large ? 38 : 19} />}</span>;
}
function SpinnerButton({ busy, children }: { busy: boolean; children: ReactNode }) { return <>{busy ? <LoaderCircle size={17} className="pr-spin" /> : null}{children}</>; }

export function ProductApp({ view, id, returnTo = '/', reason }: { view: ProductView; id?: string; returnTo?: string; reason?: string }) {
  const router = useRouter();
  const [state, setState] = useState<ProductState | null>(null);
  const [busy, setBusy] = useState(true);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [uncertain, setUncertain] = useState(false);
  const lock = useRef(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [impactId, setImpactId] = useState<string | null>(null);
  const [pollError, setPollError] = useState(false);
  useEffect(() => {
    let active = true;
    lock.current = true;
    api<ProductState>('/api/product').then((result) => { if (active) setState(result); })
      .catch((error: unknown) => { if (active) setFeedback({ text: error instanceof Error ? error.message : 'Не удалось загрузить новости.', error: true }); })
      .finally(() => { if (active) { lock.current = false; setBusy(false); } });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (view !== 'feed') return;
    let active = true;
    async function poll() {
      if (document.hidden || lock.current || uncertain) return;
      lock.current = true;
      try {
        const result = await api<ProductState>('/api/product');
        if (active) { setState(result); setPollError(false); }
      } catch { if (active) setPollError(true); }
      finally { lock.current = false; }
    }
    const interval = window.setInterval(() => void poll(), 60_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [view, uncertain]);
  async function refresh() {
    if (lock.current) return; lock.current = true; setBusy(true);
    try { setState(await api<ProductState>('/api/product')); setFeedback(null); setUncertain(false); setPollError(false); }
    catch (error) { setFeedback({ text: error instanceof Error ? error.message : 'Не удалось обновить новости.', error: true }); }
    finally { lock.current = false; setBusy(false); }
  }
  const act: Act = async (path, body, options) => {
    if (lock.current || uncertain) return false;
    lock.current = true; setBusy(true); setFeedback(null);
    try {
      setState(await api<ProductState>(`/api/product${path}`, body, options?.method));
      if (options?.success) setFeedback({ text: options.success, error: false });
      return true;
    } catch (error) {
      if (error instanceof ProductRequestError && error.uncertain) setUncertain(true);
      setFeedback({ text: error instanceof Error ? error.message : 'Не удалось сохранить изменение.', error: true });
      return false;
    } finally { lock.current = false; setBusy(false); }
  };
  const context: AppContext = { state: state!, busy: busy || uncertain, act };
  const event = state?.events.find((event) => event.id === id);
  const selectedEvent = state?.events.find((event) => event.id === selectedId) || state?.events.find((event) => event.latitude !== null && event.longitude !== null);
  const impactEvent = state?.events.find((event) => event.id === impactId);
  function like(event: ProductEvent, value: 1 | -1) {
    if (!state?.user) { router.push(`/register?reason=feedback&next=${encodeURIComponent(view === 'news' ? `/news/${event.id}` : '/')}`); return; }
    void act(`/feedback/${encodeURIComponent(event.id)}`, { value: event.feedback === value ? null : value }, { method: 'PUT' });
  }
  async function openNotification(eventId: string) {
    if (state?.user && !await act('/notifications/read', { eventId })) return;
    router.push(`/news/${encodeURIComponent(eventId)}`);
  }
  return <div className="product-shell"><a className="pr-skip" href="#product-main">К содержимому</a>
    <header className="pr-header"><Link href="/" className="pr-logo" aria-label="Радар — главная"><span className="pr-logo-symbol"><Radio size={23} strokeWidth={2} /></span><span>радар<span className="pr-logo-dot">.</span></span></Link>
      <nav className="pr-nav" aria-label="Основное меню"><Link href="/" aria-current={view === 'feed' ? 'page' : undefined}>Лента</Link><Link href="/map" aria-current={view === 'map' ? 'page' : undefined}>Карта</Link><Link href="/notifications" aria-current={view === 'notifications' ? 'page' : undefined}>Уведомления</Link></nav>
      <div className="pr-header-right">{state && <details className="pr-mode"><summary><span />{state.mode === 'DEMO' ? 'Учебные данные' : 'Новости канала'}<ChevronDown size={11} /></summary><div className="pr-mode-popover"><strong>{state.mode === 'DEMO' ? 'Подготовленная демонстрация' : 'Источник @newsssss09'}</strong><p>{state.mode === 'DEMO' ? 'Учебные события и заранее подготовленный разбор. Нейросеть в этом режиме не вызывается.' : analysisDescription(state.analysisHealth)}</p><p>Часы: {formatDate(state.now)} МСК.</p></div></details>}{state?.user ? <Link href="/profile" className="pr-user-link" aria-label={`Профиль: ${state.user.name}`}><Avatar user={state.user} /><span>{state.user.name.split(' ')[0]}</span></Link> : <Link href="/register" className="pr-register-link">Регистрация<ArrowUpRight size={15} /></Link>}</div>
    </header>
    <main id="product-main" tabIndex={-1} className={`pr-main pr-view-${view}`}>
      {feedback && <div className={`pr-feedback ${feedback.error ? 'pr-feedback-error' : ''}`} role={feedback.error ? 'alert' : 'status'}><span>{feedback.error ? <CircleHelp size={19} /> : <Check size={19} />}{feedback.text}</span>{feedback.error && <button className="pr-text-button" disabled={busy} onClick={refresh}>Обновить<ArrowRight size={14} /></button>}</div>}
      {!state && busy && <div className="pr-loading" role="status"><div className="pr-loading-mark"><Radio size={32} /></div><p>Собираем картину города<LoaderCircle className="pr-spin" size={18} /></p></div>}
      {!state && !busy && <div className="pr-empty"><span className="pr-big-symbol">…</span><h1>Связь прервалась</h1><p>Новости не загрузились. Попробуем ещё раз?</p><button className="pr-button" onClick={refresh}>Повторить<ArrowRight size={17} /></button></div>}
      {state && <>
        {view === 'feed' && <><section className="pr-hero"><div className="pr-eyebrow"><span className="pr-live-dot" />Москва · {formatDate(state.now, false)}</div><h1>Город меняется.<br /><span>Вы в курсе.</span></h1><div className="pr-hero-bottom"><p>Всё, что происходит<br />рядом с вашим делом.</p><a href="#recommendations" className="pr-scroll-link" aria-label="Перейти к рекомендациям"><ArrowDown size={23} /></a><span className="pr-edition">ГОРОДСКОЙ<br />ОБЗОР / NMH</span></div></section>
          <HomeRecommendations state={state} pollError={pollError} busy={busy} onRefresh={refresh} />
        </>}
        {view === 'map' && <><PageTitle eyebrow="Держите город в поле зрения" title={<>Рядом.<br /><span>На карте.</span></>} /><div className="pr-map-board"><ProductMap events={state.events} locations={state.locations} selectedId={selectedEvent?.id} onPreview={setSelectedId} onSelect={setSelectedId} /><aside className="pr-map-aside">{selectedEvent ? <><span className="pr-eyebrow">Выбрано на карте</span><div className="pr-map-category"><CategoryIcon event={selectedEvent} size={34} /><span>{category(selectedEvent).label}</span></div><h2>{selectedEvent.title}</h2><p className="pr-map-place"><MapPin size={15} />{selectedEvent.place || 'Место уточняется'}</p><p className="pr-map-date">{formatDate(selectedEvent.startsAt)}</p><p className="pr-map-summary">{selectedEvent.summary}</p><div className="pr-map-context"><SourceLink event={selectedEvent} /><ImpactBadge event={selectedEvent} onExplain={(item) => setImpactId(item.id)} /></div><Link href={`/news/${selectedEvent.id}`} className="pr-button">Читать новость<ArrowUpRight size={17} /></Link></> : <div className="pr-empty-small"><MapPin size={30} /><h2>Нет событий с координатами</h2><Link href="/">К ленте →</Link></div>}</aside></div>{state.events.some((item) => item.latitude === null || item.longitude === null) && <details className="pr-map-unlocated"><summary>Без точной отметки · {state.events.filter((item) => item.latitude === null || item.longitude === null).length}</summary><ul>{state.events.filter((item) => item.latitude === null || item.longitude === null).map((item) => <li key={item.id}><Link href={`/news/${item.id}`}><span>{item.title}</span><ArrowUpRight size={16} /></Link><p>{item.place || 'Место уточняется'}</p></li>)}</ul></details>}</>}
        {view === 'profile' && <ProductProfilePanel context={context} />}
        {view === 'notifications' && <NotificationsPage context={context} onOpen={openNotification} onExplain={(item) => setImpactId(item.id)} onLike={like} />}
        {view === 'news' && (event ? <NewsDetail event={event} context={context} onLike={like} onExplain={(item) => setImpactId(item.id)} /> : <div className="pr-empty"><span className="pr-big-symbol">404</span><h1>Новость не найдена</h1><Link href="/" className="pr-button">Вернуться к ленте<ArrowRight size={17} /></Link></div>)}
        {view === 'source' && (event ? <SourceView event={event} /> : <div className="pr-empty"><h1>Источник не найден</h1><Link href="/" className="pr-button">К ленте<ArrowRight size={17} /></Link></div>)}
        {(view === 'register' || view === 'login') && <Auth view={view} context={context} returnTo={returnTo} reason={reason} />}
      </>}
      {impactEvent && <ImpactPanel event={impactEvent} onClose={() => setImpactId(null)} />}
    </main><footer className="pr-footer"><Link href="/" className="pr-footer-brand">радар.</Link><span>События вокруг ваших точек</span><span>Продуктовая концепция NMH</span></footer>
  </div>;
}

function PageTitle({ title, eyebrow, trailing }: { title: ReactNode; eyebrow: string; trailing?: ReactNode }) { return <div className="pr-page-title"><div><p className="pr-eyebrow">{eyebrow}</p><h1>{title}</h1></div>{trailing}</div>; }
function HomeRecommendations({ state, pollError, busy, onRefresh }: { state: ProductState; pollError: boolean; busy: boolean; onRefresh: () => Promise<void> }) {
  const { recommendations, sourceHealth, analysisHealth } = state;
  const sourceFailed = sourceHealth.status === 'error';
  const analysisFailed = analysisHealth.status === 'error' || analysisHealth.status === 'missing_config';
  const pending = sourceHealth.status === 'pending' || analysisHealth.status === 'pending';
  return <section id="recommendations" className="pr-feed pr-recommendations" aria-label="Рекомендации для бизнеса">
    {pollError && <div className="pr-feedback pr-feedback-error" role="alert"><span><CircleHelp size={19} />Не удалось обновить рекомендации. Показаны сохранённые результаты.</span><button className="pr-text-button" disabled={busy} onClick={onRefresh}>Повторить<ArrowRight size={14} /></button></div>}
    {sourceFailed && <p className="pr-recommendation-status" role="alert"><CircleHelp size={18} />Источник временно недоступен. Сохранённые рекомендации остаются на месте.</p>}
    {analysisFailed && <p className="pr-recommendation-status" role="alert"><CircleHelp size={18} />{analysisDescription(analysisHealth)}</p>}
    {pending && <p className="pr-recommendation-status" role="status"><LoaderCircle size={18} className="pr-spin" />{sourceHealth.status === 'pending' ? 'Получаем сообщения источника…' : 'Анализируем новые сообщения…'}</p>}
    {analysisHealth.status === 'sign_in' && <div className="pr-empty pr-empty-small"><h2>Важное для вашего дела.</h2><p>Войдите и добавьте точки бизнеса, чтобы получать персональные рекомендации.</p><Link className="pr-text-button" href={state.user ? '/profile' : '/register'}>{state.user ? 'Добавить точку' : 'Создать профиль'}<ArrowRight size={16} /></Link></div>}
    {recommendations.map((item, index) => <RecommendationCard key={item.id} item={item} index={index} />)}
    {!recommendations.length && !sourceFailed && !analysisFailed && !pending && analysisHealth.status === 'ready' && <div className="pr-empty pr-empty-small" data-recommendations-empty><span className="pr-big-symbol">✓</span><h2>Пока без рекомендаций.</h2><p>В полученных сообщениях нет обоснованных возможностей или угроз для вашего бизнеса.</p></div>}
  </section>;
}
function RecommendationCard({ item, index }: { item: ProductRecommendation; index: number }) {
  const internalSource = item.sourceUrl === '/sources/' + encodeURIComponent(item.eventId);
  const sourceUrl = internalSource ? item.sourceUrl : safeUrl(item.sourceUrl);
  const period = item.startsAt ? formatDate(item.startsAt) + (item.endsAt ? ' — ' + formatDate(item.endsAt) : '') + ' · МСК' : item.endsAt ? 'До ' + formatDate(item.endsAt) + ' · МСК' : 'Период не указан в источнике';
  return <article className="pr-news-card pr-recommendation-card" data-recommendation-id={item.id} data-recommendation-event-id={item.eventId}>
    <div className="pr-news-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</div>
    <div className="pr-news-content">
      <div className="pr-news-meta"><span className={'pr-impact-label pr-impact-label-' + (item.type === 'opportunity' ? 'opportunity' : 'risk')}>{item.type === 'opportunity' ? 'Возможность' : 'Угроза'}</span></div>
      <Link href={'/news/' + encodeURIComponent(item.eventId)} className="pr-news-title"><h2>{item.title}</h2><ArrowUpRight size={25} /></Link>
      <p className="pr-recommendation-action">{item.action}</p>
      <p className="pr-recommendation-reason">{item.reason}</p>
      <div className="pr-recommendation-facts">
        <p><MapPin size={16} /><span>{item.locationNames.length ? item.locationNames.join(', ') : 'Точная точка не определена'}</span></p>
        {item.processes.length > 0 && <p><Route size={16} /><span>{item.processes.join(', ')}</span></p>}
        <p><CalendarDays size={16} /><span>{period}</span></p>
      </div>
      <div className="pr-news-bottom">{sourceUrl ? internalSource ? <Link className="pr-event-source-link" href={sourceUrl}>Исходный пост<ArrowUpRight size={14} /></Link> : <a className="pr-event-source-link" href={sourceUrl} target="_blank" rel="noopener noreferrer">Исходный пост<ArrowUpRight size={14} /></a> : <span className="pr-source-note">Ссылка на исходный пост недоступна</span>}<Link className="pr-read-link" href={'/news/' + encodeURIComponent(item.eventId)}>Подробнее<ArrowRight size={16} /></Link></div>
    </div>
  </article>;
}
function NotificationsPage({ context, onOpen, onExplain, onLike }: { context: AppContext; onOpen: (eventId: string) => Promise<void>; onExplain: (event: ProductEvent) => void; onLike: (event: ProductEvent, value: 1 | -1) => void }) {
  const { state, busy, act } = context;
  return <section className="pr-notifications">
    <PageTitle eyebrow={`За последние ${state.notificationWindowDays} дней`} title={<>Уведомления<span>.</span></>} trailing={state.user && state.unreadCount > 0 ? <button className="pr-text-button" disabled={busy} onClick={() => act('/notifications/read', {}, { success: 'Все уведомления прочитаны.' })}><CheckCheck size={17} />Прочитать всё</button> : undefined} />
    <div className="pr-notifications-count"><span>Новостей: {state.notifications.length}</span>{state.user && <span role="status">{state.unreadCount ? `Непрочитанных: ${state.unreadCount}` : 'Всё прочитано'}</span>}</div>
    {state.notifications.length ? <div className="pr-notification-inbox">{state.notifications.map(notification => {
      const event = state.events.find(item => item.id === notification.eventId);
      return event ? <NotificationCard key={notification.id} context={context} event={event} notification={notification} onOpen={onOpen} onExplain={onExplain} onLike={onLike} /> : null;
    })}</div> : <div className="pr-empty pr-empty-small"><Bell size={30} /><h2>Пока нет свежих новостей</h2><Link href="/" className="pr-text-button">Открыть ленту<ArrowRight size={16} /></Link></div>}
  </section>;
}
function NotificationCard({ context, event, notification, highlight = false, onOpen, onExplain, onLike }: { context: AppContext; event: ProductEvent; notification: ProductNotification; highlight?: boolean; onOpen: (eventId: string) => Promise<void>; onExplain: (event: ProductEvent) => void; onLike?: (event: ProductEvent, value: 1 | -1) => void }) {
  const unread = Boolean(context.state.user && !notification.readAt);
  return <article className={`pr-inline-notification ${unread ? 'pr-inline-notification-unread' : ''} ${highlight ? 'pr-highlight-notification' : ''}`} data-advice-event-id={highlight ? event.id : undefined} data-notification-event-id={highlight ? undefined : event.id}>
    <div className="pr-notification-topline"><ImpactBadge event={event} onExplain={onExplain} /><time dateTime={notification.createdAt}>{formatDate(notification.createdAt)}</time>{unread && <span className="pr-unread-label">Новое</span>}</div>
    <button className="pr-inline-notification-open" disabled={context.busy} aria-label={`Открыть новость: ${notification.title}`} onClick={() => onOpen(notification.eventId)}><div><h3>{notification.title}</h3>{!highlight && <p>{event.summary}</p>}</div><ArrowUpRight size={18} /></button>
    {event.recommendedAction && <p className="pr-notification-advice"><strong>Что можно сделать</strong>{event.recommendedAction}</p>}
    <div className="pr-card-context"><SourceLink event={event} /></div>
    {onLike && <FeedbackButtons event={event} busy={context.busy} onLike={onLike} />}
  </article>;
}
function SourceLink({ event }: { event: ProductEvent }) {
  const href = event.sourceHref?.startsWith('/sources/') ? event.sourceHref : safeUrl(event.sourceHref) || `/sources/${encodeURIComponent(event.id)}`;
  const content = <><span>Источник: {event.sourceName || 'сохранённое сообщение'}</span><ArrowUpRight size={14} /></>;
  return href.startsWith('/') ? <Link className="pr-event-source-link" href={href}>{content}</Link> : <a className="pr-event-source-link" href={href} target="_blank" rel="noopener noreferrer">{content}</a>;
}
function ImpactBadge({ event, onExplain }: { event: ProductEvent; onExplain: (event: ProductEvent) => void }) {
  if (event.impactKind === 'neutral') return null;
  return <button className={`pr-impact-badge pr-impact-badge-${event.impactKind}`} type="button" aria-haspopup="dialog" aria-controls="impact-dialog" onClick={() => onExplain(event)}>{event.impactKind === 'opportunity' ? 'Возможность' : 'Риск'}<CircleHelp size={14} aria-hidden="true" /></button>;
}
function ImpactPanel({ event, onClose }: { event: ProductEvent; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element?.showModal();
    return () => { if (element?.open) element.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return <dialog className="pr-impact-dialog" id="impact-dialog" ref={dialog} aria-labelledby="impact-heading" aria-describedby="impact-explanation" onClose={onClose} onClick={(click) => {
    if (click.target !== click.currentTarget) return;
    const bounds = click.currentTarget.getBoundingClientRect();
    if (click.clientX < bounds.left || click.clientX > bounds.right || click.clientY < bounds.top || click.clientY > bounds.bottom) click.currentTarget.close();
  }}><div className="pr-impact-panel-heading"><span className={`pr-impact-label pr-impact-label-${event.impactKind}`}>{event.impactKind === 'opportunity' ? 'Возможность' : 'Риск'}</span><button autoFocus className="pr-icon-button" aria-label="Закрыть объяснение" onClick={() => dialog.current?.close()}><X size={21} /></button></div><h2 id="impact-heading">{event.title}</h2><p className="pr-impact-explanation" id="impact-explanation">{event.impactExplanation}</p><h3>Какие точки затронуты</h3>{event.affectedLocationNames.length ? <ul>{event.affectedLocationNames.map((name) => <li key={name}><MapPin size={15} />{name}</li>)}</ul> : <p>Точное совпадение с вашими точками не подтверждено.</p>}<p className="pr-impact-caveat">Это возможное влияние по известным условиям. Решение остаётся за вами.</p><SourceLink event={event} /></dialog>;
}
function SourceView({ event }: { event: ProductEvent }) {
  const versions = event.sourceVersions || [];
  const current = versions[0];
  return <article className="pr-article pr-saved-source"><Link href={`/news/${event.id}`} className="pr-back"><ArrowLeft size={16} />К новости</Link><div className="pr-article-meta"><span>Сохранённый источник</span>{event.isDemo && <span>Учебный источник</span>}</div><h1>{event.sourceName || 'Исходное сообщение'}</h1><p className="pr-source-date">Публикация: {formatDate(event.sourcePublishedAt)} · Получено: {formatDate(event.sourceReceivedAt)}</p><section className="pr-source"><h2 className="pr-small-heading">{current ? `Версия ${current.version}` : 'Сохранённый текст'}</h2><p className="pr-source-text">{event.sourceText}</p></section>{versions.length > 1 && <section className="pr-source-history"><h2 className="pr-small-heading">Предыдущие версии</h2>{versions.slice(1).map((version) => <details key={`${version.version}-${version.savedAt}`}><summary>Версия {version.version} · {version.publisher}</summary><p className="pr-source-date">Публикация: {formatDate(version.publishedAt)} · Сохранено: {formatDate(version.savedAt)}</p><p className="pr-source-text">{version.text}</p></details>)}</section>}<p className="pr-source-note">{event.isDemo ? 'Это сохранённый учебный текст, а не публикация реального издателя.' : 'Здесь показана сохранённая копия сообщения. Она не заменяет проверку достоверности.'}</p></article>;
}
function CategoryIcon({ event, size = 23 }: { event: ProductEvent; size?: number }) { const Icon = category(event).icon; return <Icon size={size} strokeWidth={1.5} />; }
function FeedbackButtons({ event, busy, onLike }: { event: ProductEvent; busy: boolean; onLike: (event: ProductEvent, value: 1 | -1) => void }) {
  return <div className="pr-reactions" role="group" aria-label="Оценка новости"><button disabled={busy} aria-label={`Полезно: ${event.title}`} aria-pressed={event.feedback === 1} onClick={() => onLike(event, 1)}><ThumbsUp size={17} />Полезно</button><button disabled={busy} aria-label={`Не для меня: ${event.title}`} aria-pressed={event.feedback === -1} onClick={() => onLike(event, -1)}><ThumbsDown size={17} />Не для меня</button></div>;
}
function NewsDetail({ event, context, onLike, onExplain }: { event: ProductEvent; context: AppContext; onLike: (event: ProductEvent, value: 1 | -1) => void; onExplain: (event: ProductEvent) => void }) {
  const sourceUrl = safeUrl(event.sourceUrl);
  const impactText = event.impactKind === 'neutral' && event.impactStatus === 'needs_clarification' ? event.impactExplanation
    : event.impactKind === 'neutral' && event.impactStatus === 'error' ? 'Анализ этой новости пока недоступен. Проверьте исходное сообщение.' : event.impact;
  return <article className="pr-article">
    <Link className="pr-back" href="/notifications"><ArrowLeft size={16} />К уведомлениям</Link>
    <div className="pr-article-meta"><span><CategoryIcon event={event} size={18} />{category(event).label}</span><span>Версия {event.version}</span>{event.status === 'cancelled' && <span className="pr-cancelled">Отменено</span>}{event.status === 'rescheduled' && <span>Перенесено</span>}</div>
    <h1>{event.title}</h1>
    <div className="pr-detail-context"><SourceLink event={event} /><ImpactBadge event={event} onExplain={onExplain} /></div>
    <div className="pr-article-facts"><p><CalendarDays size={18} />{formatDate(event.startsAt)}{event.endsAt && <> — {formatDate(event.endsAt)}</>}</p><p><MapPin size={18} />{event.place || 'Место уточняется'}</p></div>
    <section className="pr-user-summary" aria-labelledby="news-summary-heading"><h2 id="news-summary-heading" className="pr-small-heading">Сводка для вас</h2><p>{event.summary}</p></section>
    <div className="pr-article-impact"><span className="pr-eyebrow">Для вашего бизнеса</span><h2>{event.relevance || 'Проверьте, касается ли событие ваших точек.'}</h2><p>{impactText || 'Недостаточно данных для оценки влияния.'}</p>{event.recommendedAction && <p className="pr-notification-advice"><strong>Что можно сделать</strong>{event.recommendedAction}</p>}</div>
    <section className="pr-source"><div className="pr-source-heading"><h2 className="pr-small-heading">{event.sourceName || 'Исходное сообщение'}</h2>{sourceUrl && <a href={sourceUrl} target="_blank" rel="noopener noreferrer">Источник<ArrowUpRight size={15} /></a>}</div><p className="pr-source-date">Опубликовано: {formatDate(event.sourcePublishedAt)} · МСК</p><details><summary>Полный текст источника</summary><p className="pr-source-text">{event.sourceText || 'Текст источника недоступен.'}</p></details></section>
    <div className="pr-article-bottom"><span>Такие новости вам полезны?</span><FeedbackButtons event={event} busy={context.busy} onLike={onLike} /></div>
  </article>;
}

function Field({ label, id, children, wide }: { label: string; id: string; children: ReactNode; wide?: boolean }) { return <div className={`pr-field ${wide ? 'pr-field-wide' : ''}`}><label htmlFor={id}>{label}</label>{children}</div>; }
function Auth({ view, context, returnTo, reason }: { view: 'register' | 'login'; context: AppContext; returnTo: string; reason?: string }) {
  const register = view === 'register';
  const [showPassword, setShowPassword] = useState(false);
  const router = useRouter();
  const next = typeof returnTo === 'string' && returnTo.startsWith('/') && !returnTo.startsWith('//') &&
    !Array.from(returnTo).some(char => char === '\\' || char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) ? returnTo : '/';
  if (context.state.user) return <div className="pr-empty"><Avatar user={context.state.user} large /><h1>Вы уже с нами,<br />{context.state.user.name.split(' ')[0]}.</h1><Link className="pr-button" href="/profile">В профиль<ArrowRight size={17} /></Link></div>;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const payload = { email: form.get('email'), password: form.get('password'), ...(register ? { name: form.get('name'), businessName: form.get('businessName') || '' } : {}) };
    if (await context.act(register ? '/auth/register' : '/auth/login', payload)) router.push(register && next === '/' ? '/profile' : next);
  }
  return <section className="pr-auth"><div className="pr-auth-art" aria-hidden="true"><span className="pr-auth-asterisk">✳</span><span className="pr-auth-art-word">Своё<br />место.<br /><em>В городе.</em></span><span className="pr-auth-art-caption">РАДАР / ЛИЧНОЕ ПРОСТРАНСТВО</span></div><div className="pr-auth-form-wrap"><span className="pr-eyebrow">{register ? 'Давайте знакомиться' : 'С возвращением'}</span><h1>{register ? <>Ближе<br />к важному.</> : <>Вы снова<br />в курсе.</>}</h1>{reason === 'feedback' ? <p className="pr-auth-intro">Профиль нужен, чтобы сохранять вашу оценку новостей.</p> : <p className="pr-auth-intro">{register ? 'Ваш бизнес, ваши точки, ваш городской обзор.' : 'Войдите, чтобы продолжить.'}</p>}<form onSubmit={submit} className="pr-auth-form">{register && <Field label="Как вас зовут" id="auth-name"><input id="auth-name" name="name" autoComplete="name" required maxLength={120} placeholder="Имя и фамилия" /></Field>}<Field label="Электронная почта" id="auth-email"><input id="auth-email" name="email" type="email" required autoComplete="email" placeholder="you@company.ru" /></Field><Field label="Пароль" id="auth-password"><div className="pr-password"><input id="auth-password" name="password" type={showPassword ? 'text' : 'password'} required minLength={register ? 10 : 1} maxLength={128} autoComplete={register ? 'new-password' : 'current-password'} placeholder={register ? 'Не менее 10 символов' : 'Ваш пароль'} /><button type="button" aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></Field>{register && <Field label="Название вашего бизнеса" id="auth-business"><input id="auth-business" name="businessName" autoComplete="organization" placeholder="Необязательно" /></Field>}<button className="pr-button pr-auth-submit" type="submit" disabled={context.busy}><SpinnerButton busy={context.busy}>{register ? 'Создать профиль' : 'Войти'}</SpinnerButton><ArrowUpRight size={18} /></button></form><p className="pr-auth-switch">{register ? 'Уже есть профиль?' : 'Ещё не знакомы?'} <Link href={`${register ? '/login' : '/register'}?next=${encodeURIComponent(next)}`}>{register ? 'Войти' : 'Зарегистрироваться'}<ArrowRight size={14} /></Link></p></div></section>;
}
