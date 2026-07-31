/**
 * The apex domain the product is served from — and so the domain the abuse
 * mailbox lives on (ADR-0010).
 *
 * One constant, imported by both `infra` (which sets `SITE_DOMAIN` on the
 * renderer) and the renderer (which falls back to it locally), so P1 changes
 * the real domain in one place rather than two that can disagree.
 */
export const DEFAULT_SITE_DOMAIN = 'ourapp.com';
