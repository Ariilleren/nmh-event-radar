import type { Extraction, Hours, LocationInput } from '@/domain/schemas';
import type { ImpactResult } from '@/ai/impact';
export type { Extraction };
export type ScheduleWindow = Hours;
export type Location = LocationInput & { id: string; isDemo: boolean };
export type Condition = { key: string; label: string; result: 'match' | 'mismatch' | 'unknown'; reason: string; quote?: string | null };
export type Assessment = { id: string; locationId: string; status: 'relevant' | 'needs_review' | 'excluded' | 'inactive'; priority: string; conditions: Condition[]; nextAction: string; distanceMeters?: number | null; relevance?: string; influence?: string; reason?: string; consequences?: string[]; actions?: string[]; missingData?: string[]; responseDeadline?: string | null; priorityReason?: string; impact?: ImpactResult | null };
export type SourceMessage = { id: string; publisher: string; url: string | null; publishedAt: string | null; receivedAt: string; timezone: string | null; origin: string; versions: { version: number; text: string; createdAt: string; metadata?: { publisher: string; url: string | null; publishedAt: string | null; timezone: string | null; origin: string } | null }[] };
export type RadarEvent = { id: string; title: string; category: string; status: string; extracted: Extraction | null; confirmed: boolean; version: number; isDemo: boolean; relatedEventId?: string | null; updatedAt: string; messages: SourceMessage[]; assessments: Assessment[] };
export type Task = { id: string; eventId: string; locationId: string; owner: string; dueAt: string; status: 'todo' | 'doing' | 'done'; comment: string; decision: string | null; needsReview: boolean };
export type HistoryEntry = { id: string; at: string; actor: string; action: string; entityId: string; details: unknown };
export type DigestItem = { id: string; eventId: string; locationId: string; kind: 'risk' | 'opportunity' | 'update' | 'information'; title: string; locationName: string; reason: string; influence?: string; priority: string; priorityReason?: string; consequences?: string[]; actions: string[]; missingData: string[]; startsAt: string | null; endsAt: string | null; responseDeadline?: string | null; sources: { id: string; publisher: string; url: string | null; publishedAt: string | null }[]; status: string };
export type RadarState = {
  company: { name: string; demoClock: boolean };
  locations: Location[]; events: RadarEvent[]; tasks: Task[]; history: HistoryEntry[];
  digest?: DigestItem[];
  settings: { aiMode: 'DEMO' | 'LIVE'; aiConfigured: boolean; sourceStatus: unknown; lastReceivedAt: string | null; now: string; demoClock: boolean };
};
