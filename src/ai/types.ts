import type { BusinessContext, Extraction } from '../domain/schemas';

export type AiMode = 'DEMO' | 'LIVE';
export interface AnalysisInput {
  text: string;
  publisher: string;
  publishedAt: string | null;
  timezone: string | null;
}
export interface AnalysisResult {
  extraction: Extraction;
  extractions?: Extraction[];
  mode: AiMode;
  model: string | null;
  durationMs: number;
}
export interface BusinessAnalysisResult {
  context: BusinessContext;
  mode: AiMode;
  model: string | null;
  durationMs: number;
}
/** Injection is only available to server code/tests, never to HTTP request bodies. */
export interface AiOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}
export class AiError extends Error {
  readonly code: string;
  readonly statusCode: number;
  mode: AiMode | null = null;
  model: string | null = null;
  durationMs = 0;
  constructor(code: string, message: string, statusCode = 502) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.statusCode = statusCode;
  }
}
