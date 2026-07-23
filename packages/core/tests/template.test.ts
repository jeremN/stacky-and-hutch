import { describe, expect, it } from 'vitest'
import { renderTemplate } from '../src/template.js'

describe('renderTemplate', () => {
  it('interpolates a single-line param', () => {
    expect(renderTemplate('port=<%= it.port %>', { port: '5173' })).toBe('port=5173')
  })

  it('preserves the newline after an end-of-line tag (autoTrim off)', () => {
    const out = renderTemplate('EXPOSE <%= it.port %>\nCMD ["run"]', { port: '5173' })
    expect(out).toBe('EXPOSE 5173\nCMD ["run"]')
  })

  it('preserves indentation and newline after a tag on a YAML-ish line', () => {
    const out = renderTemplate('image: <%= it.img %>\n    ports:\n', { img: 'node' })
    expect(out).toBe('image: node\n    ports:\n')
  })
})
