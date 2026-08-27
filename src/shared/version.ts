/**
 * Application version — surfaced by /api/v1/health and the §9 status panel.
 * Traceability: PS-MASTER-001 §9 (admin setup dashboard shows application version)
 *
 * Kept as a plain constant because Workers cannot read package.json at runtime.
 * Bump this together with package.json when releasing.
 */
export const APP_VERSION = '1.1.0'
