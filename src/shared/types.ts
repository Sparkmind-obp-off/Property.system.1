/**
 * Shared runtime bindings and request context types.
 * Traceability: PS-IMP-011 §5 (application boundary)
 */
import type { JwtPayload } from './crypto'

export interface Bindings {
  DB: D1Database
  /** Cloudflare Pages static-asset fetcher — serves the SPA shell (§22). */
  ASSETS?: Fetcher
  JWT_SECRET?: string
  JWT_TTL_SECONDS?: string
}

export interface AuthUser {
  id: string
  email: string
  name: string
  roles: string[]
  permissions: string[]
}

export interface Variables {
  user?: AuthUser
  requestId: string
}

export type Env = { Bindings: Bindings; Variables: Variables }

export function toAuthUser(p: JwtPayload): AuthUser {
  return { id: p.sub, email: p.email, name: p.name, roles: p.roles, permissions: p.permissions }
}

/* --------------------------- Domain enum literals -------------------------- */

export const ROLES = ['OWNER', 'OPERATOR', 'MARKETING', 'ANALYST', 'ADMIN'] as const
export type Role = (typeof ROLES)[number]

export const PROPERTY_TYPES = [
  'SHOPHOUSE',
  'KIOSK',
  'HOUSE',
  'BOARDING_HOUSE',
  'COMMERCIAL_SPACE',
  'WAREHOUSE',
  'LAND',
  'OTHER'
] as const

export const PRICE_PERIODS = ['MONTH', 'YEAR'] as const

export const PROPERTY_LIFECYCLE = [
  'DRAFT',
  'PENDING_VERIFICATION',
  'VERIFIED',
  'ACTIVE',
  'MARKETED',
  'RESERVED',
  'RENTED',
  'INACTIVE'
] as const

export const PROPERTY_AVAILABILITY = ['AVAILABLE', 'RESERVED', 'RENTED', 'UNAVAILABLE'] as const

export const BUSINESS_CATEGORIES = [
  'UMKM',
  'BARBER',
  'LAUNDRY',
  'FOOD_BUSINESS',
  'SERVICE_BUSINESS',
  'RETAIL',
  'WORKSHOP',
  'OTHER'
] as const

export const TENANT_TYPES = ['INDIVIDUAL', 'BUSINESS', 'ORGANIZATION'] as const
export const TENANT_STATUS = ['PROSPECT', 'ACTIVE', 'INACTIVE'] as const

export const OFFER_STATUS = ['DRAFT', 'READY', 'ACTIVE', 'PAUSED', 'EXPIRED'] as const

export const LEAD_SOURCES = ['INBOUND', 'OUTBOUND', 'REFERRAL', 'ORGANIC', 'CAMPAIGN', 'OTHER'] as const

export const LEAD_STATUS = [
  'NEW',
  'CONTACTED',
  'RESPONDED',
  'QUALIFIED',
  'INTERESTED',
  'VISIT_SCHEDULED',
  'VISITED',
  'NEGOTIATION',
  'WON',
  'LOST'
] as const

export const LEAD_TEMPERATURE = ['HOT', 'WARM', 'COOL', 'LOW'] as const

export const ACTIVITY_TYPES = [
  'CALL',
  'MESSAGE',
  'EMAIL',
  'NOTE',
  'FOLLOW_UP',
  'VISIT',
  'NEGOTIATION',
  'STATUS_CHANGE',
  'QUALIFICATION',
  'RENTAL',
  'OTHER'
] as const

export const FOLLOW_UP_ACTIONS = ['CALL', 'MESSAGE', 'EMAIL', 'VISIT_REMINDER', 'SEND_DETAILS', 'OTHER'] as const
export const FOLLOW_UP_STATUS = ['PENDING', 'COMPLETED', 'CANCELLED', 'RESCHEDULED'] as const

export const VISIT_STATUS = ['SCHEDULED', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'] as const
export const VISIT_RESULTS = ['STRONG_FIT', 'POTENTIAL', 'WEAK_FIT', 'NO_FIT'] as const

export const NEGOTIATION_STATUS = ['OPEN', 'COUNTER_OFFER', 'AGREED', 'FAILED'] as const

export const RENTAL_STATUS = [
  'DRAFT',
  'PENDING',
  'CONFIRMED',
  'ACTIVE',
  'EXPIRING',
  'ENDED',
  'CANCELLED'
] as const

export const QUALIFICATION_TIMELINES = [
  'IMMEDIATE',
  'WITHIN_30_DAYS',
  'WITHIN_90_DAYS',
  'LATER',
  'UNKNOWN'
] as const

export const QUALIFICATION_RESULTS = ['QUALIFIED', 'PARTIALLY_QUALIFIED', 'UNQUALIFIED'] as const

export const CAMPAIGN_CHANNELS = [
  'DIRECT_OUTREACH',
  'WHATSAPP',
  'INSTAGRAM',
  'FACEBOOK',
  'MARKETPLACE',
  'OFFLINE',
  'REFERRAL',
  'OTHER'
] as const
