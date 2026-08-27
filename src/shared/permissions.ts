/**
 * RBAC permission registry + role→permission map.
 * Traceability: PS-DATA-009 §9 | PS-TECH-008 §14, §29 | PS-MASTER-001 §3
 *
 * Authorization is ALWAYS evaluated server-side. UI hiding is usability only.
 */
import type { Role } from './types'

export const PERMISSIONS = [
  // Property
  'property.read',
  'property.create',
  'property.update',
  'property.delete',
  'property.verify',
  'property.market',
  'property.analyze',
  // Market intelligence
  'market.read',
  'market.manage',
  // Tenant & segments
  'tenant.read',
  'tenant.create',
  'tenant.update',
  'segment.read',
  'segment.manage',
  'match.execute',
  // Offer & campaign
  'offer.read',
  'offer.create',
  'offer.update',
  'offer.publish',
  'campaign.read',
  'campaign.manage',
  // Lead
  'lead.read',
  'lead.create',
  'lead.update',
  'lead.qualify',
  'lead.assign',
  // Follow-up & activity
  'followup.read',
  'followup.create',
  'followup.update',
  'activity.read',
  'activity.create',
  // Visit
  'visit.read',
  'visit.create',
  'visit.update',
  'visit.complete',
  // Negotiation
  'negotiation.read',
  'negotiation.create',
  'negotiation.update',
  'negotiation.accept',
  // Rental
  'rental.read',
  'rental.create',
  'rental.update',
  'rental.activate',
  'rental.end',
  // Analytics & governance
  'analytics.read',
  'audit.read',
  'user.read',
  'user.manage'
] as const

export type Permission = (typeof PERMISSIONS)[number]

const READ_ALL: Permission[] = [
  'property.read',
  'market.read',
  'tenant.read',
  'segment.read',
  'offer.read',
  'campaign.read',
  'lead.read',
  'followup.read',
  'activity.read',
  'visit.read',
  'negotiation.read',
  'rental.read',
  'analytics.read'
]

/**
 * Role capability matrix (PS-MASTER-001 §3, PS-UX-010 §45).
 * ADMIN gets everything. OWNER is oversight + rental authority.
 */
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  ADMIN: [...PERMISSIONS],

  OWNER: [
    ...READ_ALL,
    'property.create',
    'property.update',
    'property.delete',
    'property.verify',
    'property.market',
    'property.analyze',
    'rental.create',
    'rental.activate',
    'rental.end',
    'negotiation.accept',
    'audit.read'
  ],

  OPERATOR: [
    ...READ_ALL,
    'property.create',
    'property.update',
    'property.analyze',
    'tenant.create',
    'tenant.update',
    'match.execute',
    'lead.create',
    'lead.update',
    'lead.qualify',
    'lead.assign',
    'followup.create',
    'followup.update',
    'activity.create',
    'visit.create',
    'visit.update',
    'visit.complete',
    'negotiation.create',
    'negotiation.update',
    'negotiation.accept',
    'rental.create',
    'rental.update',
    'rental.activate',
    'rental.end'
  ],

  MARKETING: [
    ...READ_ALL,
    'offer.create',
    'offer.update',
    'offer.publish',
    'campaign.manage',
    'segment.manage',
    'match.execute',
    'tenant.create',
    'tenant.update',
    'lead.create',
    'lead.update',
    'activity.create'
  ],

  ANALYST: [...READ_ALL, 'property.analyze', 'match.execute', 'market.manage']
}

/** Resolve the effective permission set for a set of role names. */
export function permissionsForRoles(roles: string[]): string[] {
  const set = new Set<string>()
  for (const r of roles) {
    const perms = ROLE_PERMISSIONS[r as Role]
    if (perms) perms.forEach((p) => set.add(p))
  }
  return [...set].sort()
}
