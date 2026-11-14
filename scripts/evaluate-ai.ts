import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { analyzeMessage, AiError } from '../src/ai';
import { evaluate } from '../src/domain/evaluate';
import { locationSchema, timezoneSchema } from '../src/domain/schemas';

const category = z.enum(['mass_event', 'road_closure', 'water_outage', 'unsupported']);
const schema = z.object({
  label: z.string(), now: z.string(), location: locationSchema,
  cases: z.array(z.object({
    id: z.string(),
    input: z.object({ text: z.string(), publisher: z.string(), publishedAt: z.string().nullable(), timezone: timezoneSchema.nullable() }),
    expected: z.object({ candidate: z.boolean(), category,
      status: z.enum(['relevant', 'needs_review', 'excluded', 'inactive']),
      conditions: z.record(z.string(), z.enum(['match', 'mismatch', 'unknown'])),
    }),
  })),
});

function keywordCategory(text: string): z.infer<typeof category> {
  const normalized = text.toLowerCase().replaceAll('ё', 'е');
  if (/отключени[ея] воды|водоснабжен/u.test(normalized)) return 'water_outage';
  if (/перекрыти[ея]|перекрыт/u.test(normalized)) return 'road_closure';
  if (/концерт|фестиваль|ярмарка/u.test(normalized)) return 'mass_event';
  return 'unsupported';
}

const suite = schema.parse(JSON.parse(await readFile(new URL('../tests/evaluation/cases.json', import.meta.url), 'utf8')));
const useLive = process.argv.includes('--live');
const rows: Record<string, unknown>[] = [];
let candidateCorrect = 0, categoryCorrect = 0;
for (const sample of suite.cases) {
  const baseline = keywordCategory(sample.input.text);
  const candidate = baseline !== 'unsupported';
  if (candidate === sample.expected.candidate) candidateCorrect += 1;
  if (baseline === sample.expected.category) categoryCorrect += 1;
  const row: Record<string, unknown> = {
    id: sample.id,
    baseline: { candidate, category: baseline, candidateCorrect: candidate === sample.expected.candidate,
      categoryCorrect: baseline === sample.expected.category, conditions: 'NOT_ASSESSED: поиск по словам не проверяет условия' },
    live: { status: 'NOT_RUN: запустите с --live при настроенном API' },
  };
  if (useLive) {
    try {
      // Only the source input is sent. expected, location and other cases never enter the prompt.
      const result = await analyzeMessage(sample.input, { env: { ...process.env, AI_MODE: 'LIVE' } });
      const applicability = evaluate(suite.location, result.extraction, suite.now);
      row.live = {
        mode: result.mode, model: result.model, durationMs: result.durationMs,
        candidate: result.extraction.category !== 'unsupported', category: result.extraction.category,
        candidateCorrect: (result.extraction.category !== 'unsupported') === sample.expected.candidate,
        categoryCorrect: result.extraction.category === sample.expected.category,
        applicability: applicability.status, applicabilityCorrect: applicability.status === sample.expected.status,
        conditions: Object.entries(sample.expected.conditions).map(([key, expected]) => {
          const actual = applicability.conditions.find(item => item.key === key)?.result ?? 'missing';
          return { key, expected, actual, correct: actual === expected };
        }),
      };
    } catch (error) {
      row.live = { status: 'ERROR', code: error instanceof AiError ? error.code : 'EVALUATION_ERROR',
        message: error instanceof AiError ? error.message : 'Оценка завершилась ошибкой.' };
      process.exitCode = 1;
    }
  }
  rows.push(row);
}
console.log(JSON.stringify({
  label: suite.label, executedAt: new Date().toISOString(), examples: suite.cases.length,
  baseline: { candidateCorrect, categoryCorrect, conditions: 'NOT_ASSESSED' },
  liveExecuted: useLive, note: 'Малый синтетический набор; результаты не доказывают качество на реальных источниках.', rows,
}, null, 2));
