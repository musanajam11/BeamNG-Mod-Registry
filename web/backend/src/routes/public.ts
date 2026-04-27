/**
 * Public read-only routes for browsing the local registry on disk. Used by
 * the in-app Registry Browser. Requires authentication so it isn't a
 * scraping endpoint, but does not require admin.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAuth } from '../auth/plugin.js'
import { getRegistry, summarize } from '../registry/index.js'
import { getTheme } from '../settings.js'

const QuerySchema = z.object({
  q: z.string().trim().max(128).optional(),
  type: z.string().trim().max(32).optional(),
  tag: z.string().trim().max(64).optional(),
  page: z.coerce.number().int().min(1).max(1000).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
})

export async function publicRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({ ok: true }))

  // Public theme so unauthenticated pages (login/signup) can apply admin
  // customizations before the user has a session.
  app.get('/theme', async () => getTheme())

  app.get('/mods', async (request, reply) => {
    const ctx = requireAuth(request, reply)
    if (!ctx) return
    const parsed = QuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues })
    }
    const { q, type, tag } = parsed.data
    const page = parsed.data.page ?? 1
    const pageSize = parsed.data.pageSize ?? 24

    const { entries } = await getRegistry()
    let filtered = entries
    if (q) {
      const needle = q.toLowerCase()
      filtered = filtered.filter(
        (m) =>
          m.identifier.toLowerCase().includes(needle) ||
          m.name.toLowerCase().includes(needle) ||
          (m.author?.toLowerCase().includes(needle) ?? false) ||
          (m.abstract?.toLowerCase().includes(needle) ?? false) ||
          m.tags.some((t) => t.toLowerCase().includes(needle))
      )
    }
    if (type) filtered = filtered.filter((m) => m.mod_type === type)
    if (tag) filtered = filtered.filter((m) => m.tags.includes(tag))

    const total = filtered.length
    const start = (page - 1) * pageSize
    const slice = filtered.slice(start, start + pageSize)

    // Aggregate facet counts off the *unfiltered* set so users can see what
    // else is available; cheap because the index is in memory.
    const typeCounts: Record<string, number> = {}
    for (const m of entries) {
      if (m.mod_type) typeCounts[m.mod_type] = (typeCounts[m.mod_type] ?? 0) + 1
    }

    return {
      items: slice.map(summarize),
      total,
      page,
      pageSize,
      facets: { mod_types: typeCounts },
    }
  })

  app.get('/mods/:identifier', async (request, reply) => {
    const ctx = requireAuth(request, reply)
    if (!ctx) return
    const { identifier } = request.params as { identifier: string }
    const { byId } = await getRegistry()
    const found = byId.get(identifier)
    if (!found) return reply.code(404).send({ error: 'not_found' })
    return { mod: found }
  })
}
