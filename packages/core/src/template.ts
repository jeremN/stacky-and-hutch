import { Eta } from 'eta'
import type { ParamBag } from './types.js'

const eta = new Eta({ autoEscape: false })

/** Renders `.eta` sources. Params are exposed as `it`, e.g. `<%= it.port %>`. */
export function renderTemplate(source: string, params: ParamBag): string {
  return eta.renderString(source, params)
}
