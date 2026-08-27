/**
 * Dashboard — application service. The dashboard is an ACTION CENTER (§19).
 * Traceability: PS-MASTER-001 §19, §20, §55 | PS-UX-010 §12, §13 | PS-IMP-011 §20
 *
 * Design rule (§20): analytics reads DOMAIN data. No duplicated business logic,
 * no full-table loads — every KPI is an indexed aggregate query (§55).
 */
import { findMany, findOne } from '../../../shared/repository'

export interface ActionItem {
  kind: string
  label: string
  count: number
  severity: 'CRITICAL' | 'WARNING' | 'INFO'
  href: string
}

export class DashboardService {
  constructor(private db: D1Database) {}

  /**
   * ACTION REQUIRED comes before GENERAL ANALYTICS (§19).
   * Returns the operator work queue as a prioritised list.
   */
  async actionCenter(userId?: string): Promise<ActionItem[]> {
    const today = new Date().toISOString().slice(0, 10)

    const row = await findOne<Record<string, number>>(
      this.db,
      `SELECT
         (SELECT COUNT(*) FROM follow_ups
            WHERE status = 'PENDING' AND date(due_at) < date(?1))            AS overdue_follow_ups,
         (SELECT COUNT(*) FROM follow_ups
            WHERE status = 'PENDING' AND date(due_at) = date(?1))            AS due_today_follow_ups,
         (SELECT COUNT(*) FROM follow_ups
            WHERE status = 'PENDING' AND date(due_at) > date(?1))            AS upcoming_follow_ups,
         (SELECT COUNT(*) FROM leads
            WHERE status = 'NEW')                                            AS uncontacted_leads,
         (SELECT COUNT(*) FROM leads
            WHERE status IN ('CONTACTED','RESPONDED','QUALIFIED','INTERESTED')
              AND temperature = 'HOT')                                       AS hot_leads,
         (SELECT COUNT(*) FROM visits
            WHERE status IN ('SCHEDULED','CONFIRMED')
              AND date(scheduled_at) = date(?1, '+1 day'))                   AS visits_tomorrow,
         (SELECT COUNT(*) FROM visits
            WHERE status IN ('SCHEDULED','CONFIRMED')
              AND date(scheduled_at) = date(?1))                             AS visits_today,
         (SELECT COUNT(*) FROM visits
            WHERE status IN ('SCHEDULED','CONFIRMED')
              AND date(scheduled_at) < date(?1))                             AS visits_overdue,
         (SELECT COUNT(*) FROM negotiations
            WHERE status IN ('OPEN','COUNTER_OFFER'))                        AS open_negotiations,
         (SELECT COUNT(*) FROM rentals
            WHERE status = 'EXPIRING')                                       AS expiring_rentals,
         (SELECT COUNT(*) FROM rentals
            WHERE status IN ('DRAFT','PENDING','CONFIRMED'))                 AS rentals_awaiting_activation,
         (SELECT COUNT(*) FROM properties
            WHERE lifecycle_status = 'PENDING_VERIFICATION')                 AS properties_pending_verification,
         (SELECT COUNT(*) FROM offers
            WHERE status = 'READY')                                          AS offers_ready_to_publish`,
      [today]
    )

    const v = (k: string) => Number(row?.[k] ?? 0)

    const items: ActionItem[] = [
      {
        kind: 'FOLLOW_UP_OVERDUE',
        label: 'Follow-up overdue',
        count: v('overdue_follow_ups'),
        severity: 'CRITICAL',
        href: '/activities?bucket=OVERDUE'
      },
      {
        kind: 'VISIT_OVERDUE',
        label: 'Visit lewat jadwal belum diselesaikan',
        count: v('visits_overdue'),
        severity: 'CRITICAL',
        href: '/visits?bucket=OVERDUE'
      },
      {
        kind: 'FOLLOW_UP_DUE_TODAY',
        label: 'Follow-up jatuh tempo hari ini',
        count: v('due_today_follow_ups'),
        severity: 'WARNING',
        href: '/activities?bucket=DUE_TODAY'
      },
      {
        kind: 'LEAD_UNCONTACTED',
        label: 'Lead belum dihubungi',
        count: v('uncontacted_leads'),
        severity: 'WARNING',
        href: '/leads?status=NEW'
      },
      {
        kind: 'NEGOTIATION_OPEN',
        label: 'Negosiasi menunggu respons',
        count: v('open_negotiations'),
        severity: 'WARNING',
        href: '/negotiations?status=OPEN'
      },
      {
        kind: 'VISIT_TODAY',
        label: 'Visit hari ini',
        count: v('visits_today'),
        severity: 'WARNING',
        href: '/visits?bucket=TODAY'
      },
      {
        kind: 'RENTAL_EXPIRING',
        label: 'Rental menuju berakhir',
        count: v('expiring_rentals'),
        severity: 'WARNING',
        href: '/rentals?status=EXPIRING'
      },
      {
        kind: 'RENTAL_AWAITING_ACTIVATION',
        label: 'Rental menunggu aktivasi',
        count: v('rentals_awaiting_activation'),
        severity: 'INFO',
        href: '/rentals?status=PENDING'
      },
      {
        kind: 'VISIT_TOMORROW',
        label: 'Visit besok',
        count: v('visits_tomorrow'),
        severity: 'INFO',
        href: '/visits?bucket=UPCOMING'
      },
      {
        kind: 'OFFER_READY',
        label: 'Offer siap dipublikasikan',
        count: v('offers_ready_to_publish'),
        severity: 'INFO',
        href: '/offers?status=READY'
      },
      {
        kind: 'PROPERTY_PENDING_VERIFICATION',
        label: 'Properti menunggu verifikasi',
        count: v('properties_pending_verification'),
        severity: 'INFO',
        href: '/properties?lifecycle_status=PENDING_VERIFICATION'
      }
    ]

    const rank = { CRITICAL: 0, WARNING: 1, INFO: 2 } as const
    return items
      .filter((i) => i.count > 0)
      .sort((a, b) => rank[a.severity] - rank[b.severity] || b.count - a.count)
  }

  /** Headline KPI counters (§19). Single round-trip of indexed aggregates. */
  async kpis() {
    const row = await findOne<Record<string, number>>(
      this.db,
      `SELECT
         (SELECT COUNT(*) FROM properties WHERE lifecycle_status != 'INACTIVE')     AS total_properties,
         (SELECT COUNT(*) FROM properties WHERE availability_status = 'AVAILABLE')  AS available_properties,
         (SELECT COUNT(*) FROM properties WHERE availability_status = 'RENTED')     AS rented_properties,
         (SELECT COUNT(*) FROM properties WHERE lifecycle_status = 'MARKETED')      AS marketed_properties,
         (SELECT COUNT(*) FROM tenants)                                             AS total_tenants,
         (SELECT COUNT(*) FROM leads)                                               AS total_leads,
         (SELECT COUNT(*) FROM leads WHERE status NOT IN ('WON','LOST'))            AS open_leads,
         (SELECT COUNT(*) FROM leads WHERE temperature = 'HOT'
            AND status NOT IN ('WON','LOST'))                                       AS hot_leads,
         (SELECT COUNT(*) FROM leads WHERE status = 'NEW')                          AS new_leads,
         (SELECT COUNT(*) FROM leads WHERE status = 'WON')                          AS won_leads,
         (SELECT COUNT(*) FROM follow_ups WHERE status = 'PENDING')                 AS pending_follow_ups,
         (SELECT COUNT(*) FROM visits WHERE status IN ('SCHEDULED','CONFIRMED'))    AS scheduled_visits,
         (SELECT COUNT(*) FROM visits WHERE status = 'COMPLETED')                   AS completed_visits,
         (SELECT COUNT(*) FROM negotiations WHERE status IN ('OPEN','COUNTER_OFFER')) AS open_negotiations,
         (SELECT COUNT(*) FROM rentals WHERE status IN ('ACTIVE','EXPIRING'))       AS active_rentals,
         (SELECT COALESCE(SUM(price), 0) FROM rentals
            WHERE status IN ('ACTIVE','EXPIRING') AND payment_period = 'MONTH')     AS monthly_recurring_revenue,
         (SELECT COALESCE(SUM(price) / 12.0, 0) FROM rentals
            WHERE status IN ('ACTIVE','EXPIRING') AND payment_period = 'YEAR')      AS annual_normalised_revenue,
         (SELECT COUNT(*) FROM offers WHERE status = 'ACTIVE')                      AS active_offers,
         (SELECT COUNT(*) FROM campaigns WHERE status = 'RUNNING')                  AS active_campaigns`,
      []
    )

    const n = (k: string) => Number(row?.[k] ?? 0)
    const totalProps = n('total_properties')
    const occupied = n('rented_properties')

    return {
      properties: {
        total: totalProps,
        available: n('available_properties'),
        rented: occupied,
        marketed: n('marketed_properties'),
        occupancy_rate: totalProps > 0 ? Math.round((occupied / totalProps) * 1000) / 10 : 0
      },
      tenants: { total: n('total_tenants') },
      leads: {
        total: n('total_leads'),
        open: n('open_leads'),
        new: n('new_leads'),
        hot: n('hot_leads'),
        won: n('won_leads')
      },
      operations: {
        pending_follow_ups: n('pending_follow_ups'),
        scheduled_visits: n('scheduled_visits'),
        completed_visits: n('completed_visits'),
        open_negotiations: n('open_negotiations')
      },
      rentals: {
        active: n('active_rentals'),
        monthly_revenue: Math.round((n('monthly_recurring_revenue') + n('annual_normalised_revenue')) * 100) / 100
      },
      marketing: { active_offers: n('active_offers'), active_campaigns: n('active_campaigns') }
    }
  }

  /** Recent operational activity — the shared operational memory feed (§13). */
  async recentActivity(limit = 12) {
    return findMany(
      this.db,
      `SELECT a.id, a.activity_type, a.subject, a.description, a.occurred_at,
              a.lead_id, l.status AS lead_status,
              p.name AS property_name, t.name AS tenant_name,
              u.name AS actor_name
         FROM activities a
         LEFT JOIN leads l      ON l.id = a.lead_id
         LEFT JOIN properties p ON p.id = l.property_id
         LEFT JOIN tenants t    ON t.id = l.tenant_id
         LEFT JOIN users u      ON u.id = a.user_id
        ORDER BY a.occurred_at DESC
        LIMIT ?`,
      [limit]
    )
  }
}
