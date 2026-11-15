'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { LeafletMouseEvent, Map as LeafletMap, Marker, TileLayer } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './product-location-picker.css';

export type ProductLocationPoint = { latitude: number; longitude: number };

export type ProductLocationPickerProps = {
  value: ProductLocationPoint | null;
  onChange: (value: ProductLocationPoint | null) => void;
  disabled?: boolean;
  label?: string;
};

type Leaflet = typeof import('leaflet');
type TileStatus = 'loading' | 'ready' | 'unavailable';
type PickerEngine = {
  leaflet: Leaflet;
  map: LeafletMap;
  tiles: TileLayer;
  marker: Marker | null;
  selectionCentered: boolean;
};

const MOSCOW_CENTER: [number, number] = [55.7558, 37.6176];
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

function validPoint(value: ProductLocationPoint | null): value is ProductLocationPoint {
  return value !== null && Number.isFinite(value.latitude) && Number.isFinite(value.longitude)
    && value.latitude >= -90 && value.latitude <= 90
    && value.longitude >= -180 && value.longitude <= 180;
}

function markerElement(): HTMLSpanElement {
  const pin = document.createElement('span');
  pin.className = 'plp-marker-shape';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const value of ['M3 9l2-6h14l2 6', 'M3 9v3a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0V9Z', 'M5 15v6h14v-6', 'M10 21v-5h4v5']) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', value);
    svg.append(path);
  }
  pin.append(svg);
  return pin;
}

export function ProductLocationPicker({
  value, onChange, disabled = false, label = 'Место на карте',
}: ProductLocationPickerProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const centerButtonRef = useRef<HTMLButtonElement>(null);
  const engineRef = useRef<PickerEngine | null>(null);
  const latest = useRef({ value, onChange, disabled });
  const [generation, setGeneration] = useState(0);
  const [ready, setReady] = useState(false);
  const [tileStatus, setTileStatus] = useState<TileStatus>('loading');
  const [initializationFailed, setInitializationFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const id = useId();
  const selected = validPoint(value);

  useEffect(() => { latest.current = { value, onChange, disabled }; }, [value, onChange, disabled]);

  useEffect(() => {
    let cancelled = false;
    let current: PickerEngine | undefined;
    let resize: ResizeObserver | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let cycleFailed = false;
    const clearTimer = () => { if (timeout) clearTimeout(timeout); };
    const watchLoading = () => {
      clearTimer();
      timeout = setTimeout(() => { if (!cancelled) setTileStatus('unavailable'); }, 12000);
    };
    watchLoading();

    void import('leaflet').then((leaflet) => {
      if (cancelled || !canvasRef.current) return;
      const initial = latest.current.value;
      const hasInitialPoint = validPoint(initial);
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const map = leaflet.map(canvasRef.current, {
        center: hasInitialPoint ? [initial.latitude, initial.longitude] : MOSCOW_CENTER,
        zoom: hasInitialPoint ? 16 : 12,
        minZoom: 3,
        maxZoom: 19,
        zoomControl: false,
        keyboard: true,
        scrollWheelZoom: true,
        worldCopyJump: true,
        zoomAnimation: !reducedMotion,
        fadeAnimation: !reducedMotion,
        markerZoomAnimation: !reducedMotion,
      });
      leaflet.control.zoom({
        position: 'topright', zoomInTitle: 'Приблизить карту', zoomOutTitle: 'Отдалить карту',
      }).addTo(map);
      const tiles = leaflet.tileLayer(TILE_URL, {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        referrerPolicy: 'strict-origin-when-cross-origin',
      });
      current = { leaflet, map, tiles, marker: null, selectionCentered: hasInitialPoint };
      engineRef.current = current;

      map.on('click', (event: LeafletMouseEvent) => {
        if (latest.current.disabled) return;
        const point = event.latlng.wrap();
        const next = { latitude: point.lat, longitude: point.lng };
        if (!validPoint(next)) return;
        if (current) current.selectionCentered = true;
        latest.current.onChange(next);
      });
      tiles.on('loading', () => { cycleFailed = false; watchLoading(); });
      tiles.on('tileerror', () => {
        cycleFailed = true;
        if (!cancelled) setTileStatus('unavailable');
      });
      tiles.on('load', () => {
        clearTimer();
        if (!cancelled) setTileStatus(cycleFailed ? 'unavailable' : 'ready');
      });
      tiles.addTo(map);
      if (typeof ResizeObserver !== 'undefined') {
        resize = new ResizeObserver(() => map.invalidateSize({ pan: false, animate: false }));
        resize.observe(canvasRef.current);
      }
      setInitializationFailed(false);
      setReady(true);
      setGeneration((previous) => previous + 1);
    }).catch(() => {
      clearTimer();
      if (!cancelled) { setInitializationFailed(true); setTileStatus('unavailable'); setReady(false); }
    });

    return () => {
      cancelled = true;
      clearTimer();
      resize?.disconnect();
      if (current) {
        current.marker?.off();
        current.tiles.off();
        current.map.remove();
        current.map.off();
        if (engineRef.current === current) engineRef.current = null;
      }
    };
  }, [attempt]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (!validPoint(value)) {
      engine.marker?.off();
      engine.marker?.remove();
      engine.marker = null;
      return;
    }
    const position: [number, number] = [value.latitude, value.longitude];
    if (!engine.marker) {
      const marker = engine.leaflet.marker(position, {
        icon: engine.leaflet.divIcon({
          html: markerElement(), className: 'plp-marker', iconSize: [44, 50], iconAnchor: [22, 47],
        }),
        draggable: !disabled,
        keyboard: false,
        autoPanOnFocus: false,
        title: 'Выбранное место. Перетащите метку, чтобы изменить его.',
        alt: 'Выбранное место',
      }).addTo(engine.map);
      marker.getElement()?.setAttribute('role', 'img');
      marker.getElement()?.setAttribute('aria-label', 'Выбранное место');
      marker.on('dragend', () => {
        if (latest.current.disabled) {
          const previous = latest.current.value;
          if (validPoint(previous)) marker.setLatLng([previous.latitude, previous.longitude]);
          return;
        }
        const point = marker.getLatLng().wrap();
        const next = { latitude: point.lat, longitude: point.lng };
        if (validPoint(next)) latest.current.onChange(next);
      });
      engine.marker = marker;
    } else {
      const previous = engine.marker.getLatLng();
      if (previous.lat !== value.latitude || previous.lng !== value.longitude) engine.marker.setLatLng(position);
    }
    if (disabled) engine.marker.dragging?.disable();
    else engine.marker.dragging?.enable();
    if (!engine.selectionCentered) {
      engine.map.setView(position, 16, { animate: false });
      engine.selectionCentered = true;
    }
  }, [value, disabled, generation]);

  function selectCenter() {
    const engine = engineRef.current;
    if (!engine || disabled) return;
    const center = engine.map.getCenter().wrap();
    const next = { latitude: center.lat, longitude: center.lng };
    if (!validPoint(next)) return;
    engine.selectionCentered = true;
    onChange(next);
  }

  function clearSelection() {
    if (disabled) return;
    onChange(null);
    centerButtonRef.current?.focus();
  }

  function retry() {
    if (disabled || tileStatus === 'loading') return;
    setTileStatus('loading');
    if (!engineRef.current || initializationFailed) {
      setReady(false);
      setAttempt((previous) => previous + 1);
    } else engineRef.current.tiles.redraw();
  }

  return <section className="product-location-picker" aria-labelledby={`${id}-label`}>
    <div className="plp-heading">
      <span id={`${id}-label`} className="plp-label">{label}</span>
      <span className={`plp-selection${selected ? ' is-selected' : ''}`} role="status">
        <span aria-hidden="true" className="plp-selection-dot" />
        {selected ? 'Место выбрано' : 'Место не выбрано'}
      </span>
    </div>
    <p className="plp-description">Нажмите на нужное место или перетащите метку. Адрес подставится автоматически — проверьте дом и корпус.</p>
    <div className={`plp-map-frame${disabled ? ' is-disabled' : ''}`}>
      <div ref={canvasRef} className="plp-map" role="region" aria-label={label} aria-describedby={`${id}-keyboard`} />
      <span className="plp-center-target" aria-hidden="true" />
    </div>
    <div className="plp-actions">
      <button ref={centerButtonRef} type="button" className="plp-button" disabled={disabled || !ready} onClick={selectCenter}>Поставить точку в центре карты</button>
      <button type="button" className="plp-clear" disabled={disabled || !selected} onClick={clearSelection}>Убрать отметку</button>
    </div>
    <p id={`${id}-keyboard`} className="plp-help">С клавиатуры: перейдите на карту клавишей Tab, двигайте её стрелками и меняйте масштаб клавишами + и −. Затем выберите центр карты кнопкой выше.</p>
    {tileStatus === 'loading' && <p className="plp-loading" role="status">Загружаем карту…</p>}
    {tileStatus === 'unavailable' && <div className="plp-error" role="status">
      <p>{initializationFailed ? 'Карта не загрузилась. Попробуйте ещё раз.' : 'Фон карты не загрузился. Выбор места не изменился.'}</p>
      <button type="button" className="plp-retry" onClick={retry} disabled={disabled}>Повторить загрузку</button>
    </div>}
  </section>;
}
