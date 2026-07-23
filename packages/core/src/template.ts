import { Eta } from 'eta'
import type { ParamBag } from './types.js'

// autoTrim: false — Eta's default silently eats the newline right after an
// interpolation tag (e.g. `EXPOSE <%= it.port %>\n` renders with no newline
// at all). Brick sources are config files, not HTML; whitespace outside the
// tags must survive rendering byte-for-byte.
const eta = new Eta({ autoEscape: false, autoTrim: false })

/** Renders `.eta` sources. Params are exposed as `it`, e.g. `<%= it.port %>`. */
export function renderTemplate(source: string, params: ParamBag): string {
  return eta.renderString(source, params)
}
