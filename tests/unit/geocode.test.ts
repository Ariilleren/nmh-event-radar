import { describe, expect, it, vi } from 'vitest';
import { createReverseGeocoder, normalizeReverseAddress } from '../../src/server/geocode';

const payload = { display_name: 'Полный адрес OpenStreetMap', address: { city: 'Москва', road: 'Тверская улица', house_number: '7 корпус 2' } };
const response = () => new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
describe('user-triggered reverse geocoding', () => {
  it('normalizes structured address preserving corpus and never invents a missing house', () => {
    expect(normalizeReverseAddress(payload)).toEqual({ address: 'Москва, Тверская улица, дом 7 корпус 2', city: 'Москва' });
    expect(normalizeReverseAddress({ display_name: 'Тверская улица, Москва', address: { city: 'Москва', road: 'Тверская улица' } }).address).toBe('Тверская улица, Москва');
    expect(normalizeReverseAddress({ display_name: 'Неизвестная территория' }).city).toBeNull();
    expect(() => normalizeReverseAddress({ error: 'No result' })).toThrow('вручную');
  });
  it('validates coordinates before making any request', () => {
    const fetchImpl = vi.fn<typeof fetch>(); const reverse = createReverseGeocoder({ fetchImpl });
    for (const input of [{ latitude: null, longitude: 0 }, { latitude: '', longitude: 0 }, { latitude: 91, longitude: 0 }, { latitude: 0, longitude: -181 }, { latitude: 'Infinity', longitude: 0 }]) expect(() => reverse(input)).toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('coalesces identical requests, caches them and globally spaces different coordinates', async () => {
    let clock = 1000; const sleeps: number[] = [], starts: number[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async () => { starts.push(clock); return response(); });
    const reverse = createReverseGeocoder({ fetchImpl, now: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms; } });
    const point = { latitude: 55.75, longitude: 37.62 };
    const [a, b] = await Promise.all([reverse(point), reverse({ latitude: '55.750000', longitude: '37.620000' })]);
    expect(a).toEqual(b); expect(fetchImpl).toHaveBeenCalledTimes(1);
    await reverse(point); expect(fetchImpl).toHaveBeenCalledTimes(1);
    await reverse({ latitude: 55.76, longitude: 37.62 });
    expect(sleeps).toEqual([1000]); expect(starts).toEqual([1000, 2000]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('https://nominatim.openstreetmap.org/reverse?format=jsonv2');
    expect(String(url)).toContain('zoom=18');
    expect(init?.headers).toMatchObject({ 'User-Agent': expect.stringContaining('github.com/Ariilleren/nmh-event-radar') });
    clock += 24 * 60 * 60_000 + 1;
    await reverse(point); expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it('respects provider rate limits without retrying or exposing upstream diagnostics', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('PRIVATE_PROVIDER_DETAIL', { status: 429, headers: { 'retry-after': '120' } }));
    const reverse = createReverseGeocoder({ fetchImpl });
    await expect(reverse({ latitude: 55.75, longitude: 37.62 })).rejects.toMatchObject({ statusCode: 429, message: expect.stringContaining('вручную') });
    await expect(reverse({ latitude: 55.76, longitude: 37.62 })).rejects.toMatchObject({ statusCode: 429 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('fails safely on network and malformed responses, with a switchable trusted server provider', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('PRIVATE_PROXY_DETAIL')).mockResolvedValueOnce(new Response('{}'));
    const reverse = createReverseGeocoder({ fetchImpl, baseUrl: 'https://geocoder.example.test/nominatim', sleep: async () => {} });
    await expect(reverse({ latitude: 55.75, longitude: 37.62 })).rejects.toMatchObject({ statusCode: 502, message: expect.not.stringContaining('PRIVATE') });
    await expect(reverse({ latitude: 55.76, longitude: 37.62 })).rejects.toMatchObject({ statusCode: 502 });
    expect(fetchImpl.mock.calls[0][0]).toContain('https://geocoder.example.test/nominatim/reverse?');
    expect(() => createReverseGeocoder({ baseUrl: 'https://user:secret@example.test' })({ latitude: 0, longitude: 0 })).toThrow();
  });
});
