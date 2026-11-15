import type { LocationInput } from '@/domain/schemas';
import type { BusinessType } from './product-config';

export type ProductProfile = {
  id: string; name: string; email: string; photo: string | null;
  businessName: string; businessType: BusinessType; city: string; about: string;
};
export type ProductLocation = LocationInput & { id: string; isDemo: boolean };
export type ProductEvent = {
  id: string; title: string; category: string; status: string; version: number; isDemo: boolean;
  startsAt: string | null; endsAt: string | null; latitude: number | null; longitude: number | null;
  place: string; summary: string; sourceName: string; sourceUrl: string | null; sourceHref: string;
  sourcePublishedAt: string | null; sourceReceivedAt: string | null; sourceText: string; quotes: string[];
  sourceVersions: ProductSourceVersion[];
  impact: string; relevance: string; feedback: 1 | -1 | null; updatedAt: string;
  impactKind: 'opportunity' | 'risk' | 'neutral'; impactExplanation: string; affectedLocationNames: string[];
  relevantLocationIds: string[]; priority: 'urgent' | 'upcoming' | 'routine';
  recommendedAction: string | null; priorityReason: string;
  impactStatus: 'complete' | 'irrelevant' | 'needs_clarification' | 'error';
};
export type ProductSourceVersion = { version: number; text: string; savedAt: string; publisher: string; publishedAt: string | null };
export type ProductNotification = {
  id: string; eventId: string; title: string; body: string; createdAt: string; readAt: string | null;
};
export type ProductRecommendation = {
  id: string; eventId: string; type: 'opportunity' | 'threat'; title: string; action: string; reason: string;
  locationIds: string[]; locationNames: string[]; processes: string[]; startsAt: string | null; endsAt: string | null; sourceUrl: string;
};
export type ProductSourceHealth = {
  status: 'pending' | 'ok' | 'error' | 'disabled'; channel: string; message: string;
  lastAttemptAt: string | null; lastSuccessAt: string | null; fetched: number; changed: number;
};
export type ProductAnalysisHealth = {
  status: 'ready' | 'pending' | 'error' | 'missing_config' | 'sign_in'; message: string;
  pending: number; completed: number; errors: number;
};
export type ProductState = {
  user: ProductProfile | null; events: ProductEvent[]; locations: ProductLocation[];
  notifications: ProductNotification[]; unreadCount: number; mode: 'DEMO' | 'LIVE'; now: string;
  highlightEventIds: string[]; notificationWindowDays: number;
  recommendations: ProductRecommendation[]; sourceHealth: ProductSourceHealth; analysisHealth: ProductAnalysisHealth;
};

/** All successful mutations return the complete ProductState. Cookie auth is same-origin.
 * GET /api/product — anonymous demo locations or only the account's own locations.
 * POST /api/product/auth/register {name,email,password,businessName?,businessType?,city?}
 * POST /api/product/auth/login {email,password}; POST /api/product/auth/logout {}
 * PATCH /api/product/profile {name?,photo?,businessName?,businessType?,city?,about?}
 * photo: null or data:image/png|jpeg|webp;base64,..., decoded limit 500 KiB.
 * POST /api/product/locations LocationInput; PATCH /api/product/locations/:id Partial<LocationInput>
 * DELETE /api/product/locations/:id {}
 * PUT /api/product/feedback/:eventId {value:1|-1|null}
 * POST /api/product/notifications/read {eventId?}; omitted eventId marks all account notifications read.
 * Failures: {error:{message:string}} with HTTP 400/401/403/404/409/413/429/500.
 * Registration password: 10–128 characters. Locations require locationId,name,address,timezone;
 * all other LocationInput fields default to unknown/empty, never guessed from an address.
 * businessType: empty or one of BUSINESS_TYPES. Old unlisted values read as Другое.
 * eventRadiusMeters is always EVENT_RADIUS_METERS (1000), including legacy values on read.
 * sourceHref is a validated stored external HTTP(S) URL or a local /sources/:eventId saved copy.
 * sourceText is the latest saved source; sourceVersions preserves its exact saved revisions.
 * impactKind is neutral for unknown/inactive conditions; affectedLocationNames contains actual matches.
 */
