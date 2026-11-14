import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import { locationSchema } from '@/domain/schemas';
import { AppError } from './errors';
export const csvFields = ['locationId', 'name', 'address', 'city', 'latitude', 'longitude', 'timezone', 'eventRadiusMeters', 'waterDependency', 'responsibleName'];
export function previewCsv(csv: string) {
  if (Buffer.byteLength(csv, 'utf8') > 1_000_000) throw new AppError(413,'CSV_LIMIT','CSV должен быть не больше 1 МБ.');
  const first = csv.replace(/^\uFEFF/, '').split(/\r?\n/)[0];
  const delimiter = first.includes(';') ? ';' : ',';
  let records: Record<string,string>[];
  try { records = parse(csv, { columns: true, bom: true, delimiter, skip_empty_lines: true, trim: true, max_record_size: 20_000 }); }
  catch { throw new AppError(400,'CSV_PARSE','Не удалось прочитать CSV. Проверьте кавычки, разделитель и одинаковое число столбцов.'); }
  if (records.length > 500) throw new AppError(413,'CSV_ROWS','За один импорт допускается 500 строк.');
  const errors: {row:number;message:string}[] = [];
  const rows: {row:number;data:Record<string,unknown>}[] = [];
  records.forEach((record,index) => {
    const unsupported = Object.keys(record).filter(key => !csvFields.includes(key));
    if (unsupported.length) { errors.push({row:index+2,message:`Неизвестные столбцы: ${unsupported.join(', ')}`}); return; }
    const data: Record<string,unknown> = Object.fromEntries(Object.entries(record).filter(([,value]) => value !== ''));
    for (const key of ['latitude','longitude','eventRadiusMeters']) if (data[key] !== undefined) data[key] = Number(data[key]);
    const check = z.object(locationSchema.shape).partial().safeParse(data);
    if (!check.success || !data.locationId || !data.name || !data.address) {
      errors.push({row:index+2,message: check.success ? 'Нужны locationId, name, address.' : check.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')});
    } else rows.push({row:index+2,data});
  });
  return {rows,errors,total:records.length};
}
export function safeCsvCell(value: string) {
  const safe = /^[\s]*[=+@\-\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"','""')}"`;
}
export function csvTemplate() {
  return '\uFEFF' + csvFields.join(';') + '\r\n' + ['my-001','Моя точка','Москва, Учебная улица, д. 1','Москва','','','Europe/Moscow','1000','unknown','Менеджер'].map(safeCsvCell).join(';') + '\r\n';
}
