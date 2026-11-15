import type { z } from 'zod';
import { completeNewsJson, newsJsonSchema } from './provider';
import type { AiOptions } from './types';

/** Compatibility adapter; personal news selects its provider in provider.ts. */
export function getGroqStatus(env: Record<string, string | undefined> = process.env) {
  return { configured: Boolean(env.GROQ_API_KEY?.trim()), model: env.GROQ_MODEL?.trim() || 'openai/gpt-oss-20b' };
}
export const groqJsonSchema = newsJsonSchema;
export function completeGroq<T>(schema: z.ZodType<T>, system: string, data: unknown, options: AiOptions = {}) {
  return completeNewsJson(schema, system, data, { ...options, env: { ...(options.env ?? process.env), NEWS_AI_PROVIDER: 'groq' } });
}
