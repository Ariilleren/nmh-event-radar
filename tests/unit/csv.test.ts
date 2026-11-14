import { describe, expect, it } from 'vitest';
import { csvTemplate, previewCsv, safeCsvCell } from '../../src/server/csv';

describe('CSV preview and safe export', () => {
  it('accepts BOM and semicolons while preserving leading zero identifiers', () => {
    const preview = previewCsv('\uFEFFlocationId;name;address;timezone;latitude;longitude\r\n000012;Кофейня;Москва, Учебная улица, д. 1;Europe/Moscow;55.75;37.62\r\n');
    expect(preview.errors).toEqual([]);
    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0].data.locationId).toBe('000012');
    expect(preview.rows[0].data.latitude).toBe(55.75);
  });
  it('parses commas and quoted address delimiters', () => {
    const preview = previewCsv('locationId,name,address,timezone\n0002,"Кофе, хлеб","Москва, Учебная улица, д. 2",Europe/Moscow');
    expect(preview.errors).toEqual([]);
    expect(preview.rows[0].data.name).toBe('Кофе, хлеб');
    expect(preview.rows[0].data.address).toBe('Москва, Учебная улица, д. 2');
  });
  it('reports invalid lines with their row numbers and preserves valid preview rows', () => {
    const preview = previewCsv('locationId;name;address;timezone;eventRadiusMeters\n001;Точка;Адрес;Europe/Moscow;1000\n002;;Адрес;Europe/Moscow;1000\n003;Точка;Адрес;Wrong/Zone;50\n004;Точка;Адрес;Europe/Moscow;wat');
    expect(preview.total).toBe(4);
    expect(preview.rows).toHaveLength(1);
    expect(preview.errors.map((error) => error.row)).toEqual([3, 4, 5]);
  });
  it('does not put empty columns into the update payload', () => {
    const preview = previewCsv('locationId;name;address;city;latitude;longitude;responsibleName\n001;Точка;Адрес;;;;');
    expect(preview.errors).toEqual([]);
    expect(preview.rows[0].data).toEqual({ locationId: '001', name: 'Точка', address: 'Адрес' });
  });
  it('preserves repeated identifiers for transactional upsert instead of minting ids', () => {
    const preview = previewCsv('locationId;name;address;timezone\n0001;Первая версия;Адрес;Europe/Moscow\n0001;Вторая версия;Адрес;Europe/Moscow');
    expect(preview.errors).toEqual([]);
    expect(preview.rows.map((row) => row.data.locationId)).toEqual(['0001', '0001']);
  });
  it('rejects unsupported schedule columns rather than silently dropping them', () => {
    const preview = previewCsv('locationId;name;address;openingHours\n001;Точка;Адрес;08:00');
    expect(preview.errors[0].message).toContain('openingHours');
  });
  it('enforces file and row limits and rejects broken quoted records', () => {
    expect(() => previewCsv('я'.repeat(500_001))).toThrow(/1 МБ/);
    expect(() => previewCsv('locationId;name;address\n' + '1;Точка;Адрес\n'.repeat(501))).toThrow(/500 строк/);
    expect(() => previewCsv('locationId;name;address\n1;"Не закрытая кавычка;Адрес')).toThrow(/CSV/);
  });
  it.each(['=1+1', '+cmd', '-12', '@SUM(A1)', '   =1', '\tcommand', '\rcommand'])('neutralizes formula-like input %j', (text) => {
    expect(safeCsvCell(text)).toBe(`"'${text}"`);
  });
  it('escapes quotes and leaves plain identifiers unchanged', () => {
    expect(safeCsvCell('Кофейня "Первая"')).toBe('"Кофейня ""Первая"""');
    expect(safeCsvCell('000001')).toBe('"000001"');
  });
  it('downloadable template can be previewed and explicitly selects a timezone', () => {
    const preview = previewCsv(csvTemplate());
    expect(preview.errors).toEqual([]);
    expect(preview.rows[0].data.timezone).toBe('Europe/Moscow');
  });
});
