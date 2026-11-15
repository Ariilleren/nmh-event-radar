'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { ArrowRight, ArrowUpRight, Check, LoaderCircle, LogOut, MapPin, Plus, Settings2, Trash2, Upload, X } from 'lucide-react';
import { BUSINESS_TYPES as industryOptions } from '@/lib/product-config';
import type { Hours } from '@/domain/schemas';
import type { ProductLocation, ProductProfile } from '@/lib/product-types';
import type { AppContext } from './product-app';

const ProductLocationPicker = dynamic(() => import('./product-location-picker').then((module) => module.ProductLocationPicker), {
  ssr: false,
  loading: () => <div className="pr-picker-loading" role="status"><LoaderCircle size={20} className="pr-spin" />Загружаем карту точки…</div>,
});
type ProfileDraft = Pick<ProductProfile, 'name' | 'photo' | 'businessName' | 'businessType' | 'city' | 'about'>;
const profileValues = (user: ProductProfile): ProfileDraft => ({ name: user.name, photo: user.photo, businessName: user.businessName, businessType: user.businessType, city: user.city, about: user.about });

export function ProductProfilePanel({ context }: { context: AppContext }) {
  const { state, act, busy } = context;
  const [editingLocation, setEditingLocation] = useState<ProductLocation | 'new' | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProfileDraft | null>(() => state.user ? profileValues(state.user) : null);
  const [dirty, setDirty] = useState(false);
  const [photoError, setPhotoError] = useState('');
  const [readingPhoto, setReadingPhoto] = useState(false);
  const dirtyRef = useRef(false);
  const draftRef = useRef(draft);
  const revision = useRef(0);
  const router = useRouter();
  const user = state.user;
  if (!user) return <div className="pr-guest-profile"><span className="pr-profile-monogram" aria-hidden="true">Вы.</span><h1>Город большой.<br />Ваш бизнес — особенный.</h1><p>Добавьте свои точки, чтобы видеть важное рядом.</p><div className="pr-actions"><Link className="pr-button" href="/register">Создать профиль<ArrowUpRight size={17} /></Link><Link className="pr-text-button" href="/login">Уже есть аккаунт</Link></div></div>;
  const values = dirty && draft ? draft : profileValues(user);
  function update<K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]) {
    if (!user) return;
    const next = { ...(dirtyRef.current && draftRef.current ? draftRef.current : profileValues(user)), [key]: value };
    draftRef.current = next;
    dirtyRef.current = true;
    revision.current += 1;
    setDraft(next);
    setDirty(true);
  }
  async function onPhoto(file?: File) {
    setPhotoError('');
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { setPhotoError('Подойдёт JPG, PNG или WebP.'); return; }
    if (file.size > 500 * 1024) { setPhotoError('Выберите фото до 500 КБ.'); return; }
    setReadingPhoto(true);
    const reader = new FileReader();
    reader.onload = () => { update('photo', typeof reader.result === 'string' ? reader.result : null); setReadingPhoto(false); };
    reader.onerror = () => { setPhotoError('Не удалось прочитать фото.'); setReadingPhoto(false); };
    reader.readAsDataURL(file);
  }
  return <section className="pr-profile">
    <div className="pr-page-title"><div><p className="pr-eyebrow">Ваше место в городе</p><h1>Личный<br /><span>профиль.</span></h1></div><button className="pr-text-button" disabled={busy} onClick={async () => { if (await act('/auth/logout', {}, { success: 'Вы вышли из аккаунта.' })) router.push('/'); }}><LogOut size={16} />Выйти</button></div>
    <form className="pr-profile-form" onSubmit={async (event) => {
      event.preventDefault();
      if (readingPhoto) return;
      const submittedRevision = revision.current;
      if (await act('/profile', values, { method: 'PATCH', success: 'Профиль сохранён.' })) {
        if (revision.current === submittedRevision) { dirtyRef.current = false; setDirty(false); }
      }
    }}>
      <div className="pr-profile-identity"><span className="pr-avatar pr-avatar-large">{values.photo ? <Image unoptimized src={values.photo} alt="Фото профиля" width={112} height={112} /> : values.name.split(' ').map((part) => part[0]).slice(0, 2).join('').toUpperCase()}</span><div><h2>{user.name}</h2><p>{user.email}</p><div className="pr-photo-actions"><label className="pr-text-button pr-file-label"><Upload size={14} />Изменить фото<input disabled={busy || readingPhoto} type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => onPhoto(event.target.files?.[0])} /></label>{values.photo && <button type="button" className="pr-text-button" disabled={busy || readingPhoto} onClick={() => update('photo', null)}>Убрать</button>}</div><span className="pr-field-help">JPG, PNG, WebP · до 500 КБ</span>{photoError && <p className="pr-field-error" role="alert">{photoError}</p>}</div></div>
      <div className="pr-profile-fields"><div className="pr-form-section-title"><span>01</span><h2>О вас и вашем деле</h2></div><div className="pr-field-grid">
        <Field label="Ваше имя" id="profile-name"><input id="profile-name" name="name" required maxLength={120} value={values.name} onChange={(event) => update('name', event.target.value)} /></Field>
        <Field label="Название бизнеса" id="profile-business"><input id="profile-business" name="businessName" value={values.businessName} onChange={(event) => update('businessName', event.target.value)} /></Field>
        <Field label="Чем занимаетесь" id="profile-type"><select id="profile-type" name="businessType" value={values.businessType} onChange={(event) => update('businessType', event.target.value as ProductProfile['businessType'])}><option value="">Выберите сферу</option>{industryOptions.map((option) => <option key={option} value={option}>{option}</option>)}</select></Field>
        <Field label="Город" id="profile-city"><input id="profile-city" name="city" value={values.city} onChange={(event) => update('city', event.target.value)} /></Field>
        <Field label="О бизнесе" id="profile-about" wide><textarea id="profile-about" name="about" rows={3} value={values.about} onChange={(event) => update('about', event.target.value)} placeholder="Что важно знать о вашем деле" /></Field>
      </div><div className="pr-actions"><button disabled={busy || readingPhoto} className="pr-button" type="submit">{busy || readingPhoto ? <LoaderCircle size={17} className="pr-spin" /> : <Check size={16} />}Сохранить изменения</button>{dirty && <span className="pr-field-help">Есть несохранённые изменения</span>}</div></div>
    </form>
    <section className="pr-locations-section"><div className="pr-form-section-title"><span>02</span><h2>Ваши точки <small>{state.locations.length}</small></h2><button className="pr-text-button" onClick={() => { if (!editingLocation) setEditingLocation('new'); else document.getElementById('location-name')?.focus(); }}><Plus size={17} />Добавить</button></div>
      {editingLocation && <LocationForm key={typeof editingLocation === 'string' ? 'new' : editingLocation.id} context={context} location={editingLocation === 'new' ? undefined : editingLocation} onClose={() => setEditingLocation(null)} />}
      {state.locations.length ? <div className="pr-location-list">{state.locations.map((location, index) => <div key={location.id} className="pr-location-row"><span className="pr-location-number">{String(index + 1).padStart(2, '0')}</span><div className="pr-location-copy"><h3>{location.name}</h3><p>{location.address}</p><span>{location.latitude == null ? 'Без отметки на карте' : 'Отметка на карте выбрана'} · {location.timezone}</span></div><div className="pr-location-actions">{deleting === location.id ? <><span>Удалить точку?</span><button className="pr-danger-button" disabled={busy} onClick={async () => { if (await act(`/locations/${location.id}`, {}, { method: 'DELETE', success: 'Точка удалена.' })) setDeleting(null); }}>Да, удалить</button><button className="pr-icon-button" aria-label="Отменить удаление" onClick={() => setDeleting(null)}><X size={17} /></button></> : <><button className="pr-icon-button" aria-label={`Редактировать ${location.name}`} onClick={() => { if (!editingLocation || editingLocation !== 'new' && editingLocation.id === location.id) setEditingLocation(location); else document.getElementById('location-name')?.focus(); }}><Settings2 size={18} /></button><button className="pr-icon-button" aria-label={`Удалить ${location.name}`} onClick={() => setDeleting(location.id)}><Trash2 size={17} /></button></>}</div></div>)}</div> : <div className="pr-location-empty"><MapPin size={30} strokeWidth={1.3} /><h3>Где начинается ваше дело?</h3><p>Добавьте первую точку — кофейню, магазин или офис.</p>{!editingLocation && <button className="pr-text-button" onClick={() => setEditingLocation('new')}>Добавить точку<Plus size={16} /></button>}</div>}
    </section>
  </section>;
}

function Field({ label, id, children, wide }: { label: string; id: string; children: ReactNode; wide?: boolean }) { return <div className={`pr-field ${wide ? 'pr-field-wide' : ''}`}><label htmlFor={id}>{label}</label>{children}</div>; }
const weekdays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
function ScheduleFields({ kind, value, onChange }: { kind: 'opening' | 'delivery'; value: Hours[]; onChange: (next: Hours[]) => void }) {
  const title = kind === 'opening' ? 'Часы работы' : 'Окна доставки';
  const short = kind === 'opening' ? 'Работа' : 'Доставка';
  const startLabel = kind === 'opening' ? 'Начало работы' : 'Начало доставки';
  const endLabel = kind === 'opening' ? 'Конец работы' : 'Конец доставки';
  return <fieldset className="pr-process-schedule"><legend>{title}</legend>{!value.length && <p className="pr-field-help">Пока не указаны</p>}
    {value.map((window, index) => <div className="pr-process-window" key={index}><div className="pr-process-days" role="group" aria-label={`${title}: дни ${index + 1}`}>{weekdays.map((day, dayIndex) => <label key={day}><input type="checkbox" aria-label={`${short}: ${day}${index ? ` · ${index + 1}` : ''}`} checked={window.days.includes(dayIndex + 1)} onChange={(event) => onChange(value.map((item, row) => row === index ? { ...item, days: event.target.checked ? [...item.days, dayIndex + 1].sort() : item.days.filter((number) => number !== dayIndex + 1) } : item))} />{day}</label>)}</div><div className="pr-field-grid"><Field label={`${startLabel}${index ? ` · ${index + 1}` : ''}`} id={`${kind}-start-${index}`}><input id={`${kind}-start-${index}`} type="time" required value={window.start} onChange={(event) => onChange(value.map((item, row) => row === index ? { ...item, start: event.target.value } : item))} /></Field><Field label={`${endLabel}${index ? ` · ${index + 1}` : ''}`} id={`${kind}-end-${index}`}><input id={`${kind}-end-${index}`} type="time" required value={window.end} onChange={(event) => onChange(value.map((item, row) => row === index ? { ...item, end: event.target.value } : item))} /></Field></div><button type="button" className="pr-text-button" onClick={() => onChange(value.filter((_, row) => row !== index))}><Trash2 size={14} />Удалить интервал {index + 1}</button></div>)}
    <button type="button" className="pr-text-button" disabled={value.length >= 21} onClick={() => onChange([...value, { days: [1, 2, 3, 4, 5, 6, 7], start: kind === 'opening' ? '08:00' : '10:00', end: kind === 'opening' ? '23:00' : '11:00' }])}><Plus size={16} />{kind === 'opening' ? 'Добавить часы работы' : 'Добавить окно доставки'}</button>
  </fieldset>;
}
function LocationForm({ context, location, onClose }: { context: AppContext; location?: ProductLocation; onClose: () => void }) {
  const { act, busy, state } = context;
  const [point, setPoint] = useState<{ latitude: number; longitude: number } | null>(() => location?.latitude != null && location.longitude != null ? { latitude: location.latitude, longitude: location.longitude } : null);
  const [address, setAddress] = useState(location?.address || '');
  const [city, setCity] = useState(location ? location.city || '' : state.user?.city || '');
  const [lookupState, setLookupState] = useState<'idle' | 'loading' | 'success' | 'error' | 'manual'>('idle');
  const cityValue = useRef(city);
  const previousAutoCity = useRef<string | null>(null);
  const addressRevision = useRef(0);
  const lookup = useRef<{ sequence: number; timer: ReturnType<typeof setTimeout> | null; controller: AbortController | null }>({ sequence: 0, timer: null, controller: null });
  const [opening, setOpening] = useState<Hours[]>(() => location?.openingHours.map((window) => ({ ...window, days: [...window.days] })) || []);
  const [delivery, setDelivery] = useState<Hours[]>(() => location?.deliveryWindows.map((window) => ({ ...window, days: [...window.days] })) || []);
  const [error, setError] = useState('');
  const revision = useRef(0);
  useEffect(() => () => {
    lookup.current.sequence += 1;
    if (lookup.current.timer) clearTimeout(lookup.current.timer);
    lookup.current.controller?.abort();
  }, []);
  function cancelLookup() {
    lookup.current.sequence += 1;
    if (lookup.current.timer) clearTimeout(lookup.current.timer);
    lookup.current.timer = null;
    lookup.current.controller?.abort();
    lookup.current.controller = null;
  }
  function findAddress(next: { latitude: number; longitude: number } | null) {
    cancelLookup();
    if (!next) { setLookupState('idle'); return; }
    const sequence = lookup.current.sequence;
    const manualRevision = addressRevision.current;
    setLookupState('loading');
    lookup.current.timer = setTimeout(async () => {
      lookup.current.timer = null;
      const controller = new AbortController();
      lookup.current.controller = controller;
      const timeout = setTimeout(() => controller.abort(), 15_000);
      try {
        const params = new URLSearchParams({ latitude: String(next.latitude), longitude: String(next.longitude) });
        const response = await fetch('/api/product/geocode/reverse?' + params, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' }, signal: controller.signal });
        const result: unknown = await response.json();
        if (!response.ok || !result || typeof result !== 'object' || !('address' in result) || typeof result.address !== 'string' || !result.address.trim()) throw new Error('Address unavailable');
        if (sequence !== lookup.current.sequence) return;
        if (addressRevision.current !== manualRevision) { setLookupState('manual'); return; }
        setAddress(result.address.trim());
        if ('city' in result && typeof result.city === 'string' && (!cityValue.current.trim() || cityValue.current === previousAutoCity.current)) {
          const nextCity = result.city.trim();
          cityValue.current = nextCity;
          previousAutoCity.current = nextCity;
          setCity(nextCity);
        }
        revision.current += 1;
        setLookupState('success');
      } catch {
        if (sequence === lookup.current.sequence) setLookupState(addressRevision.current === manualRevision ? 'error' : 'manual');
      } finally {
        clearTimeout(timeout);
        if (sequence === lookup.current.sequence) lookup.current.controller = null;
      }
    }, 500);
  }
  return <form className="pr-location-form" onChange={() => { revision.current += 1; }} onSubmit={async (event) => {
    event.preventDefault(); setError('');
    if ([...opening, ...delivery].some((window) => !window.days.length)) { setError('Выберите хотя бы один день для каждого интервала.'); return; }
    cancelLookup();
    if (lookupState === 'loading') setLookupState('manual');
    const form = new FormData(event.currentTarget);
    const submittedRevision = revision.current;
    const payload = { locationId: form.get('locationId'), name: form.get('name'), address: form.get('address'), city: form.get('city') || null, latitude: point?.latitude ?? null, longitude: point?.longitude ?? null, timezone: form.get('timezone'), responsibleName: form.get('responsibleName'), waterDependency: form.get('waterDependency'), openingHours: opening, deliveryWindows: delivery, deliveryRouteStreets: String(form.get('deliveryRouteStreets') || '').split(/[,\n]+/).map((street) => street.trim()).filter(Boolean) };
    if (await act(location ? `/locations/${location.id}` : '/locations', payload, { method: location ? 'PATCH' : 'POST', success: 'Точка сохранена.' }) && revision.current === submittedRevision) onClose();
  }}>
    <div className="pr-location-form-heading"><h3>{location ? 'Изменить точку' : 'Новая точка'}</h3><button type="button" className="pr-icon-button" onClick={onClose} aria-label="Закрыть форму точки"><X size={20} /></button></div>
    <div className="pr-field-grid"><Field label="Название" id="location-name"><input id="location-name" name="name" required defaultValue={location?.name} placeholder="Например, кофейня на углу" /></Field><Field label="Идентификатор" id="location-id"><input id="location-id" name="locationId" required defaultValue={location?.locationId} placeholder="coffee-01" /></Field><Field label="Адрес, дом и корпус" id="location-address" wide><input id="location-address" name="address" required value={address} onChange={(event) => { addressRevision.current += 1; cancelLookup(); setAddress(event.target.value); if (lookupState !== 'idle') setLookupState('manual'); }} aria-describedby="location-geocode-status" placeholder="Полный адрес точки" /><p id="location-geocode-status" className="pr-field-help" role="status" aria-live="polite">{lookupState === 'loading' ? 'Определяем адрес по отметке…' : lookupState === 'success' ? 'Адрес подставлен по отметке. Проверьте дом и корпус.' : lookupState === 'error' ? 'Не удалось определить адрес. Проверьте его вручную.' : lookupState === 'manual' ? 'Адрес изменён вручную. Проверьте соответствие отметке.' : ''}{' '}Адрес по <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>; проверьте дом и корпус.</p>{lookupState === 'error' && <button className="pr-text-button" type="button" disabled={busy || !point} onClick={() => findAddress(point)}>Повторить определение адреса<ArrowRight size={14} /></button>}</Field><Field label="Город" id="location-city"><input id="location-city" name="city" value={city} onChange={(event) => { cityValue.current = event.target.value; previousAutoCity.current = null; setCity(event.target.value); }} /></Field><Field label="Часовой пояс" id="location-zone"><input id="location-zone" name="timezone" required defaultValue={location?.timezone || 'Europe/Moscow'} /></Field><Field label="Ответственный" id="location-owner"><input id="location-owner" name="responsibleName" defaultValue={location ? location.responsibleName : state.user?.name || ''} /></Field></div>
    <input type="hidden" name="latitude" value={point?.latitude ?? ''} /><input type="hidden" name="longitude" value={point?.longitude ?? ''} />
    <ProductLocationPicker value={point} onChange={(next) => { revision.current += 1; setPoint(next); findAddress(next); }} disabled={busy} label="Место точки на карте" />
    <div className="pr-location-processes"><h4>Что важно для работы точки</h4><Field label="Зависимость от воды" id="location-water"><select id="location-water" name="waterDependency" defaultValue={location?.waterDependency || 'unknown'}><option value="unknown">Неизвестно</option><option value="essential">Вода необходима для работы</option><option value="optional">Зависимость от воды ограничена</option></select></Field>
      <ScheduleFields kind="opening" value={opening} onChange={(next) => { revision.current += 1; setOpening(next); }} /><ScheduleFields kind="delivery" value={delivery} onChange={(next) => { revision.current += 1; setDelivery(next); }} />
      <Field label="Улицы маршрута доставки" id="location-streets"><textarea id="location-streets" name="deliveryRouteStreets" rows={3} defaultValue={location?.deliveryRouteStreets.join('\n') || ''} placeholder="Через запятую или по одной улице в строке" /></Field><p className="pr-field-help">Конец интервала раньше начала означает переход через полночь.</p>
    </div>{error && <p role="alert" className="pr-field-error">{error}</p>}<div className="pr-actions"><button className="pr-button" disabled={busy || lookupState === 'loading'} type="submit">{busy && <LoaderCircle size={17} className="pr-spin" />}Сохранить точку<ArrowRight size={16} /></button><button className="pr-text-button" type="button" onClick={onClose}>Отмена</button></div>
  </form>;
}
