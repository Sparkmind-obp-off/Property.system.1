/**
 * Standard API error contract.
 * Traceability: PS-DATA-009 §52 | PS-TECH-008 §27 | PS-MASTER-001 §35
 *
 * Error codes are STABLE and machine-readable. Frontend must branch on
 * `code`, never parse `message`.
 */

export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  BUSINESS_RULE_VIOLATION: 'BUSINESS_RULE_VIOLATION',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  RATE_LIMITED: 'RATE_LIMITED',
  INTEGRATION_ERROR: 'INTEGRATION_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
} as const

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode]

const STATUS_MAP: Record<ErrorCodeValue, number> = {
  VALIDATION_ERROR: 422,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  BUSINESS_RULE_VIOLATION: 409,
  INVALID_STATE_TRANSITION: 409,
  RATE_LIMITED: 429,
  INTEGRATION_ERROR: 502,
  INTERNAL_ERROR: 500
}

/** Base application error carrying a stable domain error code. */
export class AppError extends Error {
  readonly code: ErrorCodeValue
  readonly status: number
  readonly details: Record<string, unknown>
  /** Domain rule reference, e.g. "DR-008" — supports traceability (§51). */
  readonly rule?: string

  constructor(
    code: ErrorCodeValue,
    message: string,
    details: Record<string, unknown> = {},
    rule?: string
  ) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.status = STATUS_MAP[code] ?? 500
    this.details = details
    this.rule = rule
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
        ...(this.rule ? { rule: this.rule } : {})
      }
    }
  }
}

export class ValidationError extends AppError {
  constructor(message: string, fields: Record<string, string> = {}) {
    super(ErrorCode.VALIDATION_ERROR, message, { fields })
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required.') {
    super(ErrorCode.UNAUTHORIZED, message)
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action.', details = {}) {
    super(ErrorCode.FORBIDDEN, message, details)
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string, id?: string) {
    super(ErrorCode.NOT_FOUND, `${entity} not found.`, id ? { entity, id } : { entity })
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details = {}) {
    super(ErrorCode.CONFLICT, message, details)
  }
}

/** Violation of an explicit business/domain rule. `rule` carries the DR-xxx id. */
export class BusinessRuleViolation extends AppError {
  constructor(message: string, rule: string, details: Record<string, unknown> = {}) {
    super(ErrorCode.BUSINESS_RULE_VIOLATION, message, details, rule)
  }
}

/** Illegal lifecycle state transition (DR-009). */
export class InvalidStateTransition extends AppError {
  constructor(entity: string, from: string, to: string, allowed: readonly string[]) {
    super(
      ErrorCode.INVALID_STATE_TRANSITION,
      `${entity} cannot move from ${from} to ${to}.`,
      { entity, from, to, allowed: [...allowed] },
      'DR-009'
    )
  }
}
