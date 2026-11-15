import { z } from 'zod';
import { AppError } from './errors';

export type ReverseAddress = { address: string; city: string | null };
const numeric = z.union([z.number(), z.string().trim().regex(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/).transform(Number)]);
const coordinates = z.object({ latitude: numeric.pipe(z.number().min(-90).max(90)), longitude: numeric.pipe(z.number().min(-180).max(180)) }).strict();
const responseSchema = z.object({ display_name: z.string().trim().min(1).max(2000), address: z.record(z.string(), z.unknown()).optional() });
const userAgent = 'NMH-Event-Radar/1.0 (+https://github.com/Ariilleren/nmh-event-radar)';
const ttl = 24 * 60 * 60_000;
const errorMessage = 'Не удалось определить адрес. Его можно ввести вручную.';

function providerUrl(base: string) {
  let url: URL;
  try { url = new URL(base); } catch { throw new AppError(503, 'GEOCODE_CONFIG', errorMessage); }
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !local) || url.username || url.password || url.search || url.hash) throw new AppError(503, 'GEOCODE_CONFIG', errorMessage);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/reverse`;
  return url;
}

export function normalizeReverseAddress(value: unknown): ReverseAddress {
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success) throw new AppError(502, 'GEOCODE_FORMAT', errorMessage);
  const fields = parsed.data.address ?? {};
  const field = (name: string) => typeof fields[name] === 'string' ? fields[name].replace(/\s+/g, ' ').trim() : '';
  const city = field('city') || field('town') || field('village') || field('municipality') || field('hamlet') || null;
  const street = field('road') || field('pedestrian') || field('residential') || field('footway');
  const house = field('house_number');
  // Keep the provider's exact building/corpus identifier. A nearby street never supplies a guessed house number.
  const address = street && house ? [city, street, `дом ${house}`].filter(Boolean).join(', ') : parsed.data.display_name;
  return { address, city };
}

/** One server-wide queue, no background polling or autocomplete. Exported factory keeps tests isolated. */
export function createReverseGeocoder(options: { fetchImpl?: typeof fetch; baseUrl?: string; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
  const transport = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const cache = new Map<string, { result: ReverseAddress; expiresAt: number }>();
  const inFlight = new Map<string, Promise<ReverseAddress>>();
  let nextRequestAt = 0;
  let queue: Promise<unknown> = Promise.resolve();
  return function reverseGeocode(input: unknown): Promise<ReverseAddress> {
    const point = coordinates.parse(input);
    const url = providerUrl(options.baseUrl ?? process.env.GEOCODING_BASE_URL ?? 'https://nominatim.openstreetmap.org');
    const latitude = point.latitude.toFixed(6), longitude = point.longitude.toFixed(6);
    const key = `${url.href}:${latitude}:${longitude}`;
    const previous = cache.get(key);
    if (previous && previous.expiresAt > now()) { cache.delete(key); cache.set(key, previous); return Promise.resolve(previous.result); }
    if (previous) cache.delete(key);
    const existing = inFlight.get(key);
    if (existing) return existing;
    if (inFlight.size >= 8 || nextRequestAt - now() >= 10_000) return Promise.reject(new AppError(429, 'GEOCODE_BUSY', 'Сервис адресов занят. Подождите немного или введите адрес вручную.'));
    url.search = new URLSearchParams({ format: 'jsonv2', addressdetails: '1', 'accept-language': 'ru', zoom: '18', lat: latitude, lon: longitude }).toString();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new AppError(504, 'GEOCODE_TIMEOUT', errorMessage)); }, 10_000);
    });
    const job = queue.then(async () => {
      if (controller.signal.aborted) throw new AppError(504, 'GEOCODE_TIMEOUT', errorMessage);
      const wait = Math.max(0, nextRequestAt - now());
      if (wait >= 10_000) throw new AppError(429, 'GEOCODE_BUSY', 'Сервис адресов временно ограничил запросы. Адрес можно ввести вручную.');
      if (wait) await sleep(wait);
      if (controller.signal.aborted) throw new AppError(504, 'GEOCODE_TIMEOUT', errorMessage);
      nextRequestAt = now() + 1000;
      try {
        const response = await transport(url.href, { method: 'GET', redirect: 'error', signal: controller.signal,
          headers: { Accept: 'application/json', 'Accept-Language': 'ru', 'User-Agent': userAgent }, cache: 'no-store' });
        if (!response.ok) {
          if (response.status === 429) {
            const raw = response.headers.get('retry-after');
            const seconds = Number(raw);
            const delay = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : raw && Number.isFinite(Date.parse(raw)) ? Date.parse(raw) - now() : 60_000;
            nextRequestAt = now() + Math.max(60_000, Math.min(24 * 60 * 60_000, delay));
          }
          await response.body?.cancel();
          throw new AppError(response.status === 429 ? 429 : 502, 'GEOCODE_PROVIDER', errorMessage);
        }
        if (Number(response.headers.get('content-length') ?? 0) > 100_000) throw new AppError(502, 'GEOCODE_FORMAT', errorMessage);
        const reader = response.body?.getReader();
        if (!reader) throw new AppError(502, 'GEOCODE_FORMAT', errorMessage);
        const chunks: Uint8Array[] = []; let size = 0;
        try {
          while (true) {
            const part = await reader.read(); if (part.done) break;
            size += part.value.byteLength;
            if (size > 100_000) throw new AppError(502, 'GEOCODE_FORMAT', errorMessage);
            chunks.push(part.value);
          }
        } finally { await reader.cancel().catch(() => {}); }
        const result = normalizeReverseAddress(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        cache.set(key, { result, expiresAt: now() + ttl });
        while (cache.size > 1000) cache.delete(cache.keys().next().value!);
        return result;
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(controller.signal.aborted ? 504 : 502, 'GEOCODE_UNAVAILABLE', errorMessage);
      }
    });
    queue = job.catch(() => {});
    const pending = Promise.race([job, timeout]).finally(() => { clearTimeout(timer); controller.abort(); inFlight.delete(key); });
    inFlight.set(key, pending);
    return pending;
  };
}
const globalGeocode = globalThis as typeof globalThis & { radarReverseGeocode?: ReturnType<typeof createReverseGeocoder> };
export function reverseGeocode(input: unknown) {
  return (globalGeocode.radarReverseGeocode ??= createReverseGeocoder())(input);
}
