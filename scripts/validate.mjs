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
const files = findBeammodFiles(MODS_DIR)

if (files.length === 0) {
  console.log('⚠ No .beammod files found in mods/')
  process.exit(0)
}

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
  } else {
    console.log(`✓ ${rel}`)
  }
}

console.log(`\n${files.length} file(s) checked, ${errors} error(s)`)
process.exit(errors > 0 ? 1 : 0)
