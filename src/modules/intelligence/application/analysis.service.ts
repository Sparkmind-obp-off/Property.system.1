/**
 * Property Intelligence — application service.
 * Traceability: PS-IMP-011 §9 | PS-MASTER-001 §6 | PS-DATA-009 §13, §42
 *
 * BOUNDARY: Property Intelligence READS Property and GENERATES Analysis.
 * It MUST NOT mutate the property lifecycle (PS-IMP-011 §9).
 */
import { AnalyticsEvent, analyticsStmt, auditStmt } from '../../../shared/audit'
import { ID } from '../../../shared/id'
import { findMany, findOneOrFail, parseJson, transaction } from '../../../shared/repository'

export interface AnalysisInput {
  access_score: number
  visibility_score: number
  location_score: number
  space_score: number
  strengths: string[]
  weaknesses: string[]
  opportunities: string[]
  risks: string[]
  recommended_uses: string[]
}

/**
 * Overall score = mean of the four component scores, scaled to 0..100.
 * Explainability is mandatory: a score without reasons is not acceptable
 * (PS-MASTER-001 §6).
 */
export function computeOverallScore(i: {
  access_score: number
  visibility_score: number
  location_score: number
  space_score: number
}): number {
  const sum = i.access_score + i.visibility_score + i.location_score + i.space_score
  return Math.round((sum / 40) * 100)
}

/** Derive automatic observations so no score is ever unexplained. */
export function deriveObservations(input: AnalysisInput): { strengths: string[]; risks: string[] } {
  const strengths = [...input.strengths]
  const risks = [...input.risks]
  if (input.access_score >= 8 && !strengths.some((s) => /access/i.test(s))) {
    strengths.push('Strong road access')
  }
  if (input.visibility_score <= 5 && !risks.some((r) => /visib|signage/i.test(r))) {
    risks.push('Low visibility — signage strategy required')
  }
  if (input.space_score <= 5 && !risks.some((r) => /space|size/i.test(r))) {
    risks.push('Limited usable space may restrict tenant categories')
  }
  return { strengths, risks }
}

export class AnalysisService {
  constructor(private readonly db: D1Database) {}

  /** UC: AnalyzeProperty — appends a new analysis record (1..N history). */
  async analyze(propertyId: string, input: AnalysisInput, actorId: string, requestId: string) {
    await findOneOrFail(
      this.db,
      `SELECT id FROM properties WHERE id = ?`,
      [propertyId],
      'Property',
      propertyId
    )

    const overall = computeOverallScore(input)
    const { strengths, risks } = deriveObservations(input)
    const id = ID.analysis()

    await transaction(this.db, [
      this.db
        .prepare(
          `INSERT INTO property_analyses
             (id, property_id, access_score, visibility_score, location_score, space_score, overall_score,
              strengths, weaknesses, opportunities, risks, recommended_uses, analysis_status, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?)`
        )
        .bind(
          id,
          propertyId,
          input.access_score,
          input.visibility_score,
          input.location_score,
          input.space_score,
          overall,
          JSON.stringify(strengths),
          JSON.stringify(input.weaknesses),
          JSON.stringify(input.opportunities),
          JSON.stringify(risks),
          JSON.stringify(input.recommended_uses),
          actorId
        ),
      auditStmt(this.db, {
        userId: actorId,
        entityType: 'PROPERTY_ANALYSIS',
        entityId: id,
        action: 'PROPERTY_ANALYZED',
        newValue: { property_id: propertyId, overall_score: overall },
        requestId
      }),
      analyticsStmt(this.db, {
        eventType: AnalyticsEvent.PROPERTY_ANALYZED,
        entityType: 'PROPERTY_ANALYSIS',
        entityId: id,
        propertyId,
        value: overall
      })
    ])

    return this.latest(propertyId)
  }

  async latest(propertyId: string) {
    const rows = await this.history(propertyId, 1)
    return rows[0] ?? null
  }

  async history(propertyId: string, limit = 10) {
    const rows = await findMany<any>(
      this.db,
      `SELECT a.*, u.name AS created_by_name
         FROM property_analyses a
         LEFT JOIN users u ON u.id = a.created_by
        WHERE a.property_id = ?
        ORDER BY a.created_at DESC
        LIMIT ?`,
      [propertyId, limit]
    )
    return rows.map((a) => ({
      ...a,
      strengths: parseJson<string[]>(a.strengths, []),
      weaknesses: parseJson<string[]>(a.weaknesses, []),
      opportunities: parseJson<string[]>(a.opportunities, []),
      risks: parseJson<string[]>(a.risks, []),
      recommended_uses: parseJson<string[]>(a.recommended_uses, [])
    }))
  }
}
