/**
 * AJV-backed validators that load the canonical schemas from the registry
 * repo bundled into the Docker image at /app/registry-bundled/schema.
 *
 * Falls back to ../../../schema (workspace-relative) for local dev.
 */
import Ajv, { type ValidateFunction } from 'ajv'
import addFormats from 'ajv-formats'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

function findSchemaDir(): string {
  const candidates = [
    '/app/registry-bundled/schema',
    join(__dirname, '..', '..', '..', '..', 'schema'),
    join(process.cwd(), '..', 'schema'),
    join(process.cwd(), 'schema'),
  ]
  for (const c of candidates) {
    if (existsSync(join(c, 'beammod.schema.json'))) return c
  }
  throw new Error('Cannot locate schema directory')
}

const SCHEMA_DIR = findSchemaDir()

const ajv = new Ajv({ allErrors: true, strict: false })
addFormats(ajv)

let beammodValidator: ValidateFunction | null = null
let netbeammodValidator: ValidateFunction | null = null

function getBeammodValidator(): ValidateFunction {
  if (!beammodValidator) {
    const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, 'beammod.schema.json'), 'utf-8'))
    beammodValidator = ajv.compile(schema)
  }
  return beammodValidator
}

function getNetbeammodValidator(): ValidateFunction {
  if (!netbeammodValidator) {
    const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, 'netbeammod.schema.json'), 'utf-8'))
    netbeammodValidator = ajv.compile(schema)
  }
  return netbeammodValidator
}

export interface ValidationResult {
  valid: boolean
  errors: { path: string; message: string }[]
}

function format(validator: ValidateFunction): ValidationResult {
  if (!validator.errors) return { valid: true, errors: [] }
  return {
    valid: false,
    errors: validator.errors.map((e) => ({
      path: e.instancePath || '/',
      message: `${e.message ?? 'invalid'}${
        e.params && Object.keys(e.params).length ? ' ' + JSON.stringify(e.params) : ''
      }`,
    })),
  }
}

export function validateBeammod(doc: unknown): ValidationResult {
  const v = getBeammodValidator()
  v(doc)
  return format(v)
}

export function validateNetbeammod(doc: unknown): ValidationResult {
  const v = getNetbeammodValidator()
  v(doc)
  return format(v)
}
