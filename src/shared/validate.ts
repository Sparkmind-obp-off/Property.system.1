/**
 * Minimal, dependency-free schema validation.
 * Traceability: PS-TECH-008 §25 (schema validation stage) | PS-MASTER-001 §28
 *
 * Every field validated here maps to a domain field — no decorative fields
 * (PS-UX-010 §63 Form ↔ Domain Contract).
 */
import { ValidationError } from './errors'

type FieldErrors = Record<string, string>

export class Validator {
  private readonly src: Record<string, unknown>
  private readonly errors: FieldErrors = {}
  private readonly out: Record<string, unknown> = {}

  constructor(source: unknown) {
    this.src = (source && typeof source === 'object' ? source : {}) as Record<string, unknown>
  }

  private present(key: string): boolean {
    const v = this.src[key]
    return v !== undefined && v !== null && v !== ''
  }

  string(key: string, opts: { required?: boolean; min?: number; max?: number; default?: string } = {}) {
    if (!this.present(key)) {
      if (opts.required) this.errors[key] = 'is required'
      else if (opts.default !== undefined) this.out[key] = opts.default
      return this
    }
    const v = String(this.src[key]).trim()
    if (opts.min !== undefined && v.length < opts.min) this.errors[key] = `must be at least ${opts.min} characters`
    else if (opts.max !== undefined && v.length > opts.max) this.errors[key] = `must be at most ${opts.max} characters`
    else this.out[key] = v
    return this
  }

  number(key: string, opts: { required?: boolean; min?: number; max?: number; default?: number } = {}) {
    if (!this.present(key)) {
      if (opts.required) this.errors[key] = 'is required'
      else if (opts.default !== undefined) this.out[key] = opts.default
      return this
    }
    const v = Number(this.src[key])
    if (!Number.isFinite(v)) this.errors[key] = 'must be a number'
    else if (opts.min !== undefined && v < opts.min) this.errors[key] = `must be >= ${opts.min}`
    else if (opts.max !== undefined && v > opts.max) this.errors[key] = `must be <= ${opts.max}`
    else this.out[key] = v
    return this
  }

  integer(key: string, opts: { required?: boolean; min?: number; max?: number; default?: number } = {}) {
    if (!this.present(key)) {
      if (opts.required) this.errors[key] = 'is required'
      else if (opts.default !== undefined) this.out[key] = opts.default
      return this
    }
    const v = Number(this.src[key])
    if (!Number.isInteger(v)) this.errors[key] = 'must be an integer'
    else if (opts.min !== undefined && v < opts.min) this.errors[key] = `must be >= ${opts.min}`
    else if (opts.max !== undefined && v > opts.max) this.errors[key] = `must be <= ${opts.max}`
    else this.out[key] = v
    return this
  }

  enum<T extends string>(key: string, values: readonly T[], opts: { required?: boolean; default?: T } = {}) {
    if (!this.present(key)) {
      if (opts.required) this.errors[key] = 'is required'
      else if (opts.default !== undefined) this.out[key] = opts.default
      return this
    }
    const v = String(this.src[key]).toUpperCase()
    if (!values.includes(v as T)) this.errors[key] = `must be one of: ${values.join(', ')}`
    else this.out[key] = v
    return this
  }

  email(key: string, opts: { required?: boolean } = {}) {
    if (!this.present(key)) {
      if (opts.required) this.errors[key] = 'is required'
      return this
    }
    const v = String(this.src[key]).trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) this.errors[key] = 'must be a valid email address'
    else this.out[key] = v
    return this
  }

  /** ISO date (YYYY-MM-DD) or full ISO datetime. */
  date(key: string, opts: { required?: boolean } = {}) {
    if (!this.present(key)) {
      if (opts.required) this.errors[key] = 'is required'
      return this
    }
    const v = String(this.src[key]).trim()
    if (Number.isNaN(Date.parse(v))) this.errors[key] = 'must be a valid date'
    else this.out[key] = v
    return this
  }

  /** Array of short strings, stored as JSON text in D1. */
  stringArray(key: string, opts: { required?: boolean; maxItems?: number } = {}) {
    const v = this.src[key]
    if (v === undefined || v === null) {
      if (opts.required) this.errors[key] = 'is required'
      else this.out[key] = []
      return this
    }
    if (!Array.isArray(v)) {
      this.errors[key] = 'must be an array'
      return this
    }
    const max = opts.maxItems ?? 30
    if (v.length > max) {
      this.errors[key] = `must have at most ${max} items`
      return this
    }
    this.out[key] = v.map((x) => String(x).trim()).filter((x) => x.length > 0).slice(0, max)
    return this
  }

  boolean(key: string, opts: { default?: boolean } = {}) {
    const v = this.src[key]
    if (v === undefined || v === null) {
      if (opts.default !== undefined) this.out[key] = opts.default
      return this
    }
    this.out[key] = v === true || v === 'true' || v === 1 || v === '1'
    return this
  }

  /** Custom cross-field rule. */
  check(condition: boolean, key: string, message: string) {
    if (!condition) this.errors[key] = message
    return this
  }

  /** Throws ValidationError when any field failed; otherwise returns typed payload. */
  result<T = Record<string, any>>(): T {
    if (Object.keys(this.errors).length > 0) {
      throw new ValidationError('Request validation failed.', this.errors)
    }
    return this.out as T
  }
}

export async function validateBody(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    throw new ValidationError('Request body must be valid JSON.')
  }
}

export function v(source: unknown) {
  return new Validator(source)
}
