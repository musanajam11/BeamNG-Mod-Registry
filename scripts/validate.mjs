#!/usr/bin/env node
/**
 * validate.mjs — Validates all .beammod files against the JSON schema.
 * Usage: node scripts/validate.mjs
 */
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative, dirname } from 'path'
import { fileURLToPath } from 'url'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const SCHEMA_PATH = join(ROOT, 'schema', 'beammod.schema.json')
const MODS_DIR = join(ROOT, 'mods')

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'))
const ajv = new Ajv({ allErrors: true, strict: false })
addFormats(ajv)
const validate = ajv.compile(schema)

function findBeammodFiles(dir) {
  const results = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const s = statSync(full)
    if (s.isDirectory()) {
      results.push(...findBeammodFiles(full))
    } else if (entry.endsWith('.beammod')) {
      results.push(full)
    }
  }
  return results
}

let errors = 0
let warnings = 0
const files = findBeammodFiles(MODS_DIR)

if (files.length === 0) {
  console.log('⚠ No .beammod files found in mods/')
  process.exit(0)
}

// --- Pass 1: Parse all files & collect identifiers + virtual provides ---
const allMods = new Map()  // identifier → [parsed data objects]
const virtualProvides = new Set()  // identifiers provided via "provides"

for (const file of files) {
  const rel = relative(ROOT, file)
  let data
  try {
    data = JSON.parse(readFileSync(file, 'utf-8'))
  } catch (e) {
    console.error(`✗ ${rel}: Invalid JSON — ${e.message}`)
    errors++
    continue
  }
  if (!allMods.has(data.identifier)) allMods.set(data.identifier, [])
  allMods.get(data.identifier).push({ data, file, rel })

  // Collect virtual provides
  if (Array.isArray(data.provides)) {
    for (const v of data.provides) virtualProvides.add(v)
  }
}

/** Check if an identifier exists in the registry (real mod or virtual provide). */
function identifierExists(id) {
  return allMods.has(id) || virtualProvides.has(id)
}

/** Extract all dependency identifiers from a relationship list. */
function extractDepIds(relList) {
  if (!Array.isArray(relList)) return []
  const ids = []
  for (const entry of relList) {
    if (entry.identifier) {
      ids.push(entry.identifier)
    }
    if (Array.isArray(entry.any_of)) {
      for (const alt of entry.any_of) {
        if (alt.identifier) ids.push(alt.identifier)
      }
    }
  }
  return ids
}

// --- Pass 2: Schema validation + cross-validation ---
for (const [identifier, entries] of allMods) {
  for (const { data, file, rel } of entries) {
    // Check filename convention: {identifier}-{version}.beammod
    const basename = file.split(/[\\/]/).pop()
    const expectedName = `${data.identifier}-${data.version}.beammod`
    if (basename !== expectedName) {
      console.error(`✗ ${rel}: Filename should be "${expectedName}", got "${basename}"`)
      errors++
    }

    // Check directory convention: mods/{identifier}/
    const parentDir = file.split(/[\\/]/).slice(-2, -1)[0]
    if (parentDir !== data.identifier) {
      console.error(`✗ ${rel}: Should be in directory "mods/${data.identifier}/"`)
      errors++
    }

    // Schema validation
    const valid = validate(data)
    if (!valid) {
      console.error(`✗ ${rel}: Schema validation failed:`)
      for (const err of validate.errors) {
        console.error(`    ${err.instancePath || '/'} ${err.message}`)
      }
      errors++
    }

    // --- Dependency cross-validation ---
    const depFields = ['depends', 'recommends', 'suggests', 'supports', 'conflicts']
    for (const field of depFields) {
      const depIds = extractDepIds(data[field])
      for (const depId of depIds) {
        if (!identifierExists(depId)) {
          // depends = error (hard requirement), others = warning
          if (field === 'depends') {
            console.error(`✗ ${rel}: ${field} references unknown identifier "${depId}"`)
            errors++
          } else {
            console.warn(`⚠ ${rel}: ${field} references unknown identifier "${depId}"`)
            warnings++
          }
        }
      }
    }

    // Check replaced_by
    if (data.replaced_by?.identifier && !identifierExists(data.replaced_by.identifier)) {
      console.warn(`⚠ ${rel}: replaced_by references unknown identifier "${data.replaced_by.identifier}"`)
      warnings++
    }

    if (valid) {
      console.log(`✓ ${rel}`)
    }
  }
}

console.log(`\n${files.length} file(s) checked, ${errors} error(s), ${warnings} warning(s)`)
process.exit(errors > 0 ? 1 : 0)
