'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { LayerGroup, Map as LeafletMap, Marker, TileLayer } from 'leaflet';
import type { ProductEvent, ProductLocation } from '@/lib/product-types';
import 'leaflet/dist/leaflet.css';
import './product-map.css';

type Leaflet = typeof import('leaflet');
type MapStatus = 'loading' | 'ready' | 'unavailable';
type Pin = {
  marker: Marker; button: HTMLButtonElement; tooltip: HTMLSpanElement; kind: string; dispose: () => void;
  previewId?: string; eventIds?: string[]; popupSignature?: string; popupDispose?: () => void;
  popupButtons?: Map<string, HTMLButtonElement>;
};
type Engine = {
  leaflet: Leaflet;
  map: LeafletMap;
  tiles: TileLayer;
  eventLayer: LayerGroup;
  locationLayer: LayerGroup;
  events: Map<string, Pin>;
  locations: Map<string, Pin>;
  fitted: boolean;
};

export type ProductMapProps = {
  events: ProductEvent[];
  locations: ProductLocation[];
  selectedId?: string;
  onSelect: (eventId: string) => void;
  onPreview?: (eventId: string) => void;
};

const MOSCOW_CENTER: [number, number] = [55.7558, 37.6176];
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const categoryNames: Record<string, string> = {
  mass_event: 'Мероприятие', road_closure: 'Ограничение движения', water_outage: 'Отключение воды',
};
const iconPaths: Record<string, string[]> = {
  mass_event: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M16 3a4 4 0 0 1 0 8', 'M22 21v-2a4 4 0 0 0-3-3.87', 'M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0'],
  road_closure: ['M4 8h16v8H4z', 'M8 8l8 8', 'M16 8l4 4', 'M4 12l4 4', 'M7 16v5', 'M17 16v5'],
  water_outage: ['M12 3c-2.5 4-7 7.8-7 12a7 7 0 0 0 14 0c0-4.2-4.5-8-7-12Z', 'M9 16a3 3 0 0 0 3 3'],
  location: ['M3 9l2-6h14l2 6', 'M3 9v3a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0V9Z', 'M5 15v6h14v-6', 'M10 21v-5h4v5'],
  other: ['M12 8v5', 'M12 17h.01', 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0'],
};

function coordinates(item: { latitude: number | null; longitude: number | null }): [number, number] | null {
  const { latitude, longitude } = item;
  if (typeof latitude !== 'number' || typeof longitude !== 'number'
    || !Number.isFinite(latitude) || !Number.isFinite(longitude)
    || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return [latitude, longitude];
}

function icon(kind: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const value of iconPaths[kind] ?? iconPaths.other) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', value);
    svg.append(path);
  }
  return svg;
}

function createPin(engine: Engine, position: [number, number], kind: string, handlers?: {
  preview: () => void; select: () => void;
}): Pin {
  const location = kind === 'location';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = location ? 'pm-location' : 'pm-marker';
  const shape = document.createElement('span');
  shape.className = location ? 'pm-location-shape' : 'pm-pin';
  const glyph = document.createElement('span');
  glyph.className = 'pm-glyph';
  glyph.append(icon(kind));
  shape.append(glyph);
  button.append(shape);
  engine.leaflet.DomEvent.disableClickPropagation(button);

  const marker = engine.leaflet.marker(position, {
    icon: engine.leaflet.divIcon({
      html: button,
      className: 'pm-leaflet-marker',
      iconSize: location ? [36, 36] : [46, 54],
      iconAnchor: location ? [18, 18] : [23, 49],
    }),
    keyboard: false,
    autoPanOnFocus: false,
    riseOnHover: true,
    zIndexOffset: location ? -100 : 0,
  });
  const tooltip = document.createElement('span');
  marker.bindTooltip(tooltip, { direction: 'top', offset: [0, location ? -15 : -40], className: 'pm-tooltip' });
  const preview = () => handlers?.preview();
  const focus = () => { marker.openTooltip(); preview(); };
  const blur = () => marker.closeTooltip();
  const select = () => {
    if (handlers) handlers.select();
    else marker.openTooltip();
  };
  button.addEventListener('pointerenter', preview);
  button.addEventListener('focus', focus);
  button.addEventListener('blur', blur);
  button.addEventListener('click', select);
  marker.addTo(location ? engine.locationLayer : engine.eventLayer);
  const pin: Pin = {
    marker, button, tooltip, kind,
    dispose: () => {
      button.removeEventListener('pointerenter', preview);
      button.removeEventListener('focus', focus);
      button.removeEventListener('blur', blur);
      button.removeEventListener('click', select);
      engine.leaflet.DomEvent.off(button);
      pin.popupDispose?.();
      marker.unbindPopup();
      marker.unbindTooltip();
      marker.off();
      (location ? engine.locationLayer : engine.eventLayer).removeLayer(marker);
    },
  };
  return pin;
}

function popupWidth(mapWidth: number): number {
  // Leave room for Leaflet's content margins, popup border and auto-pan padding.
  return Math.max(120, Math.min(310, mapWidth - 90));
}

function updateGroupPopup(pin: Pin, events: ProductEvent[], callbacks: () => {
  onSelect: ProductMapProps['onSelect']; onPreview: ProductMapProps['onPreview'];
}, mapWidth: number, mapHeight: number, selectedId?: string) {
  const signature = JSON.stringify(events.map(({ id, title, category }) => [id, title, category]));
  if (pin.popupSignature !== signature) {
    pin.popupDispose?.();
    pin.marker.unbindPopup();
    pin.popupSignature = signature;
    pin.popupButtons = new Map();
    pin.button.querySelector('.pm-marker-count')?.remove();
    pin.button.removeAttribute('aria-haspopup');
    pin.button.removeAttribute('aria-expanded');
    const cleanups: Array<() => void> = [];
    pin.popupDispose = () => cleanups.forEach((cleanup) => cleanup());
    if (events.length > 1) {
      const badge = document.createElement('span');
      badge.className = 'pm-marker-count';
      badge.setAttribute('aria-hidden', 'true');
      badge.textContent = String(events.length);
      pin.button.append(badge);
      pin.button.setAttribute('aria-haspopup', 'dialog');
      pin.button.setAttribute('aria-expanded', 'false');
      const content = document.createElement('div');
      content.className = 'pm-popup-list';
      content.setAttribute('role', 'group');
      content.setAttribute('aria-label', 'События в этой точке');
      const heading = document.createElement('strong');
      heading.textContent = `События в этой точке · ${events.length}`;
      content.append(heading);
      for (const event of events) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'pm-popup-event';
        button.dataset.eventId = event.id;
        const category = document.createElement('span');
        category.className = 'pm-popup-category';
        category.textContent = categoryNames[event.category] ?? 'Событие';
        const title = document.createElement('span');
        title.textContent = event.title;
        button.append(category, title);
        const preview = () => callbacks().onPreview?.(event.id);
        const select = () => {
          callbacks().onSelect(event.id);
          pin.marker.closePopup();
          // Restore focus without replacing the preview with another member of the group.
          pin.previewId = event.id;
          pin.button.focus({ preventScroll: true });
        };
        button.addEventListener('pointerenter', preview);
        button.addEventListener('focus', preview);
        button.addEventListener('click', select);
        cleanups.push(() => {
          button.removeEventListener('pointerenter', preview);
          button.removeEventListener('focus', preview);
          button.removeEventListener('click', select);
        });
        pin.popupButtons.set(event.id, button);
        content.append(button);
      }
      const maxWidth = popupWidth(mapWidth);
      pin.marker.bindPopup(content, {
        className: 'pm-events-popup', minWidth: Math.min(220, maxWidth), maxWidth,
        autoPanPaddingTopLeft: [20, mapHeight < 500 ? 100 : 20],
        autoPanPaddingBottomRight: [20, mapHeight < 500 ? 50 : 20],
      });
      const opened = () => {
        pin.button.setAttribute('aria-expanded', 'true');
        const popup = pin.marker.getPopup()?.getElement();
        popup?.setAttribute('role', 'dialog');
        popup?.setAttribute('aria-label', 'События в этой точке');
        popup?.querySelector('.leaflet-popup-close-button')?.setAttribute('aria-label', 'Закрыть список событий');
      };
      const closed = () => pin.button.setAttribute('aria-expanded', 'false');
      pin.marker.on('popupopen', opened);
      pin.marker.on('popupclose', closed);
      cleanups.push(() => { pin.marker.off('popupopen', opened); pin.marker.off('popupclose', closed); });
    }
  }
  for (const [id, button] of pin.popupButtons ?? []) button.setAttribute('aria-pressed', String(id === selectedId));
}

export function ProductMap({ events, locations, onSelect, onPreview, selectedId }: ProductMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onSelect, onPreview });
  const engineRef = useRef<Engine | null>(null);
  const [generation, setGeneration] = useState(0);
  const [status, setStatus] = useState<MapStatus>('loading');
  const [initializationFailed, setInitializationFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const instructionsId = useId();

  useEffect(() => { callbacks.current = { onSelect, onPreview }; }, [onSelect, onPreview]);

  useEffect(() => {
    let cancelled = false;
    let current: Engine | undefined;
    let resize: ResizeObserver | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let cycleFailed = false;
    const clearTimeoutIfNeeded = () => { if (timeout) clearTimeout(timeout); };
    const armTimeout = () => {
      clearTimeoutIfNeeded();
      timeout = setTimeout(() => { if (!cancelled) setStatus('unavailable'); }, 12000);
    };
    armTimeout();

    void import('leaflet').then((leaflet) => {
      if (cancelled || !containerRef.current) return;
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const map = leaflet.map(containerRef.current, {
        center: MOSCOW_CENTER, zoom: 12, minZoom: 3, maxZoom: 19,
        zoomControl: false, scrollWheelZoom: true, keyboard: true,
        zoomAnimation: !reducedMotion, fadeAnimation: !reducedMotion,
        markerZoomAnimation: !reducedMotion,
      });
      leaflet.control.zoom({ position: 'topright', zoomInTitle: 'Приблизить карту', zoomOutTitle: 'Отдалить карту' }).addTo(map);
      const tiles = leaflet.tileLayer(TILE_URL, {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        // Standard browser caching and Referer are preserved; no prefetch or geocoding.
        referrerPolicy: 'strict-origin-when-cross-origin',
      });
      current = {
        leaflet, map, tiles,
        eventLayer: leaflet.layerGroup().addTo(map), locationLayer: leaflet.layerGroup().addTo(map),
        events: new Map(), locations: new Map(), fitted: false,
      };
      tiles.on('loading', () => { cycleFailed = false; armTimeout(); });
      tiles.on('tileerror', () => { cycleFailed = true; if (!cancelled) setStatus('unavailable'); });
      tiles.on('load', () => {
        clearTimeoutIfNeeded();
        if (!cancelled) setStatus(cycleFailed ? 'unavailable' : 'ready');
      });
      tiles.addTo(map);
      if (typeof ResizeObserver !== 'undefined') {
        resize = new ResizeObserver(() => {
          map.invalidateSize({ pan: false, animate: false });
          for (const pin of current?.events.values() ?? []) {
            const popup = pin.marker.getPopup();
            if (popup) {
              popup.options.maxWidth = popupWidth(map.getSize().x);
              popup.options.minWidth = Math.min(220, popup.options.maxWidth);
              popup.options.autoPanPaddingTopLeft = [20, map.getSize().y < 500 ? 100 : 20];
              popup.options.autoPanPaddingBottomRight = [20, map.getSize().y < 500 ? 50 : 20];
              popup.update();
            }
          }
        });
        resize.observe(containerRef.current);
      }
      engineRef.current = current;
      setGeneration((value) => value + 1);
      setInitializationFailed(false);
    }).catch(() => {
      clearTimeoutIfNeeded();
      if (!cancelled) { setInitializationFailed(true); setStatus('unavailable'); }
    });

    return () => {
      cancelled = true;
      clearTimeoutIfNeeded();
      resize?.disconnect();
      if (current) {
        for (const pin of [...current.events.values(), ...current.locations.values()]) pin.dispose();
        current.tiles.off();
        current.map.remove();
        if (engineRef.current === current) engineRef.current = null;
      }
    };
  }, [attempt]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const visibleEvents = new Set<string>();
    const visibleLocations = new Set<string>();
    const points: [number, number][] = [];
    const groups = new Map<string, { position: [number, number]; events: ProductEvent[] }>();
    for (const event of events) {
      const position = coordinates(event);
      if (!position) continue;
      const key = JSON.stringify(position);
      const group = groups.get(key);
      if (group) group.events.push(event);
      else groups.set(key, { position, events: [event] });
    }
    for (const [key, { position, events: members }] of groups) {
      const event = members.find((member) => member.id === selectedId) ?? members[0];
      const selected = members.some((member) => member.id === selectedId);
      visibleEvents.add(key);
      points.push(position);
      const kind = Object.hasOwn(categoryNames, event.category) ? event.category : 'other';
      let pin = engine.events.get(key);
      if (!pin) {
        pin = createPin(engine, position, kind, {
          preview: () => {
            const id = engine.events.get(key)?.previewId;
            if (id) callbacks.current.onPreview?.(id);
          },
          select: () => {
            const current = engine.events.get(key);
            if (!current?.previewId) return;
            callbacks.current.onSelect(current.previewId);
            if ((current.eventIds?.length ?? 0) > 1) {
              current.marker.openPopup();
              current.popupButtons?.get(current.previewId)?.focus({ preventScroll: true });
            }
          },
        });
        engine.events.set(key, pin);
      }
      pin.eventIds = members.map((member) => member.id);
      pin.previewId = event.id;
      const label = members.length > 1
        ? `${members.length} событий в этой точке. Открыть список. ${event.place}`
        : `${categoryNames[kind] ?? 'Событие'}: ${event.title}${event.place ? `. ${event.place}` : ''}`;
      if (pin.kind !== kind) {
        pin.button.querySelector('.pm-glyph')?.replaceChildren(icon(kind));
        pin.kind = kind;
      }
      pin.button.className = `pm-marker pm-marker--${kind}${selected ? ' is-selected' : ''}`;
      pin.button.setAttribute('aria-label', label);
      pin.button.setAttribute('aria-pressed', String(selected));
      pin.button.title = label;
      pin.button.dataset.eventId = event.id;
      pin.button.dataset.eventCount = String(members.length);
      pin.tooltip.textContent = members.length > 1 ? `${members.length} событий в этой точке — нажмите для выбора` : event.title;
      updateGroupPopup(pin, members, () => callbacks.current, engine.map.getSize().x, engine.map.getSize().y, selectedId);
      pin.marker.setLatLng(position);
      pin.marker.setZIndexOffset(selected ? 1000 : 0);
    }
    for (const location of locations) {
      const position = coordinates(location);
      if (!position) continue;
      visibleLocations.add(location.id);
      points.push(position);
      let pin = engine.locations.get(location.id);
      if (!pin) {
        pin = createPin(engine, position, 'location');
        engine.locations.set(location.id, pin);
      }
      const label = `Точка бизнеса: ${location.name}. ${location.address}`;
      pin.button.setAttribute('aria-label', label);
      pin.button.title = label;
      pin.tooltip.textContent = `${location.name} · ${location.address}`;
      pin.marker.setLatLng(position);
    }
    for (const [id, pin] of engine.events) {
      if (!visibleEvents.has(id)) { pin.dispose(); engine.events.delete(id); }
    }
    for (const [id, pin] of engine.locations) {
      if (!visibleLocations.has(id)) { pin.dispose(); engine.locations.delete(id); }
    }
    // Fit once when coordinate data arrives. Hover, selection and filters preserve the user's view.
    if (!engine.fitted && points.length) {
      engine.map.fitBounds(engine.leaflet.latLngBounds(points), { padding: [58, 58], maxZoom: 14, animate: false });
      engine.fitted = true;
    }
  }, [generation, events, locations, selectedId]);

  const eventCount = events.filter((event) => coordinates(event) !== null).length;
  const locationCount = locations.filter((location) => coordinates(location) !== null).length;
  const retry = () => {
    const engine = engineRef.current;
    setStatus('loading');
    if (initializationFailed || !engine) setAttempt((value) => value + 1);
    else engine.tiles.redraw();
  };

  return <section className="product-map" aria-label="События и точки бизнеса на карте">
    <p id={instructionsId} className="pm-sr-only">Перемещайте карту стрелками, меняйте масштаб клавишами плюс и минус. Клавишей Tab выберите маркер; Enter или пробел покажет событие в списке рядом.</p>
    <div ref={containerRef} className="pm-canvas" role="region" aria-label="Интерактивная карта Москвы" aria-describedby={instructionsId} />
    <ul className="pm-legend" aria-label="Обозначения на карте">
      <li><span className="pm-key pm-key--mass" />Мероприятия</li>
      <li><span className="pm-key pm-key--road" />Дороги</li>
      <li><span className="pm-key pm-key--water" />Вода</li>
      <li><span className="pm-key pm-key--location" />Ваши точки</li>
    </ul>
    <div className="pm-map-summary">На карте: {eventCount} событий · {locationCount} точек</div>
    {status === 'loading' && <div className="pm-notice pm-notice--loading" role="status"><span className="pm-loading-dot" />Загружаем карту…</div>}
    {status === 'unavailable' && <div className="pm-notice" role="status">
      <p>{initializationFailed ? 'Карта не загрузилась. События доступны в списке рядом.' : 'Фон карты недоступен. Метки остаются на указанных координатах.'}</p>
      <button type="button" onClick={retry}>Повторить</button>
    </div>}
    {status === 'ready' && eventCount === 0 && locationCount === 0 && <div className="pm-notice" role="status"><p>Пока нет точек с координатами. События с неизвестным местом доступны в списке.</p></div>}
  </section>;
}
