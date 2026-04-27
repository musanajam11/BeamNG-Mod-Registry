/**
 * Tiny fastify-plugin shim. We avoid pulling in the `fastify-plugin` package
 * for one helper; this preserves encapsulation-bypass via a Symbol marker.
 */
import type { FastifyPluginAsync } from 'fastify'

const kFp = Symbol.for('skip-override')

interface PluginWithMeta {
  [kFp]: true
  default?: unknown
}

export default function fp<T extends FastifyPluginAsync>(plugin: T): T {
  ;(plugin as unknown as PluginWithMeta)[kFp] = true
  return plugin
}
