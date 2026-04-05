# BeamNG Mod Registry

A CKAN-inspired mod metadata repository for BeamNG.drive and BeamMP mods.

## How It Works

This repository contains `.beammod` metadata files — one per mod version — organized by identifier. The BeamMP Content Manager downloads a compressed index from GitHub Releases and uses it for mod browsing, installation, dependency resolution, and update checking.

**No domain or server required.** Everything runs on GitHub infrastructure:

| Component | GitHub Feature |
|-----------|---------------|
| Metadata storage | This repository |
| Compressed index | GitHub Releases |
| Validation | GitHub Actions |
| Community contributions | Pull Requests |

## Repository Structure

```
mods/
├── drift_tires_pack/
│   └── drift_tires_pack-1.0.0.beammod
├── realistic_suspension/
│   ├── realistic_suspension-2.1.0.beammod
│   └── realistic_suspension-2.2.0.beammod
└── track_day_modpack/
    └── track_day_modpack-1.0.0.beammod     (kind: metapackage)
schema/
└── beammod.schema.json
```

## The `.beammod` Format

A `.beammod` file is a JSON document (UTF-8) describing a single version of a mod. Named as `{identifier}-{version}.beammod`.

### Example

```json
{
  "spec_version": 1,
  "identifier": "drift_tires_pack",
  "name": "Drift Tires Pack",
  "abstract": "High-grip drift tires for all vehicles",
  "author": "TireMaster",
  "version": "1.0.0",
  "license": "MIT",
  "mod_type": "vehicle",
  "download": "https://example.com/drift_tires_pack-1.0.0.zip",
  "download_hash": { "sha256": "abc123..." },
  "download_size": 524288,
  "beamng_version_min": "0.31",
  "tags": ["tires", "drift", "physics"],
  "depends": [
    { "identifier": "wheel_physics_framework", "min_version": "1.0" }
  ],
  "supports": [
    { "identifier": "drift_king_vehicle" }
  ],
  "install": [
    { "find": "drift_tires", "install_to": "mods/repo" }
  ],
  "resources": {
    "homepage": "https://beamng.com/resources/drift-tires-pack.12345/",
    "repository": "https://github.com/tiremaster/drift-tires"
  }
}
```

### Required Fields

| Field | Description |
|-------|-------------|
| `spec_version` | Integer `1` (current spec) |
| `identifier` | Unique ID: ASCII letters, digits, hyphens, underscores (2–128 chars) |
| `name` | Human-readable name |
| `abstract` | One-line description (max 512 chars) |
| `author` | Author name or array of names |
| `version` | Version string, e.g. `"1.2.3"` or `"2:1.0"` (epoch prefix) |
| `license` | SPDX license identifier(s) |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `kind` | string | `"package"` (default), `"metapackage"`, or `"dlc"` |
| `download` | string / string[] | URL(s) to the mod archive. Required for `kind: "package"` |
| `download_hash` | object | `{ "sha256": "..." }` — verified on install |
| `download_size` | integer | Archive size in bytes |
| `install_size` | integer | Installed size in bytes |
| `mod_type` | string | `vehicle`, `map`, `skin`, `ui_app`, `sound`, `license_plate`, `scenario`, `automation`, `other` |
| `tags` | string[] | Categorization tags (unique) |
| `description` | string | Long-form Markdown description (max 16KB) |
| `release_status` | string | `stable`, `testing`, `development` |
| `release_date` | string | ISO date (e.g. `"2026-04-05"`) |
| `beamng_version` | string | Exact game version or `"any"` |
| `beamng_version_min` | string | Minimum game version (inclusive) |
| `beamng_version_max` | string | Maximum game version (inclusive) |
| `beammp_version_min` | string | Minimum BeamMP version required |
| `multiplayer_scope` | string | `"client"` (default), `"server"`, or `"both"` — see [Multiplayer Scope](#multiplayer-scope) |
| `server_download` | string / string[] | URL(s) to the server plugin archive (dual-component mode) |
| `server_download_hash` | object | `{ "sha256": "..." }` — verified on server plugin install |
| `comment` | string | Internal note (not displayed to users, max 4KB) |
| `localizations` | object | Localized strings — see [Localizations](#localizations) |
| `thumbnail` | string | Preview image URL |
| `resources` | object | External links (`homepage`, `repository`, `bugtracker`, `beamng_resource`, `beammp_forum`) |

### Relationships

| Field | Behavior |
|-------|----------|
| `depends` | Hard dependencies — must be installed |
| `recommends` | Installed by default, user can decline |
| `suggests` | Not installed by default, user can opt-in |
| `supports` | Mods this enhances when present (informational, reverse of `suggests`) |
| `conflicts` | Cannot coexist with these mods |
| `provides` | Virtual package names this mod satisfies |
| `replaced_by` | Pointer to successor mod |

```json
"depends": [
  { "identifier": "some_mod" },
  { "identifier": "other_mod", "min_version": "2.0", "max_version": "3.0" },
  { "any_of": [
    { "identifier": "option_a" },
    { "identifier": "option_b" }
  ], "choice_help_text": "Pick your preferred option" }
]
```

### Install Directives

Control how mod contents are extracted and placed. Each directive must specify one of `file`, `find`, or `find_regexp` along with `install_to`.

| Field | Description |
|-------|-------------|
| `file` | Exact path within the archive |
| `find` | Directory name to locate (case-insensitive) |
| `find_regexp` | Regex to locate in the archive |
| `install_to` | Target: `"mods"`, `"mods/repo"`, or a subdirectory |
| `as` | Rename the matched directory/file during install |
| `filter` | Filename(s) to exclude |
| `filter_regexp` | Regex pattern(s) to exclude |
| `include_only` | Whitelist: only install files matching these names |
| `include_only_regexp` | Whitelist: only install files matching these patterns |
| `find_matches_files` | When `true`, `find`/`find_regexp` can match files, not just directories |

```json
"install": [
  {
    "find": "vehicles",
    "install_to": "mods/repo",
    "filter": ["thumbs.db", ".gitkeep"],
    "include_only_regexp": ["\\.zip$"]
  }
]
```

### Multiplayer Scope

BeamMP multiplayer mods have separate client and server components:

- **Client mod**: Standard BeamNG `.zip` → installed to `mods/repo/`
- **Server plugin**: Lua scripts using the BeamMP server API → installed to the server's `Resources/Server/<modname>/`

| Value | Meaning |
|-------|---------|
| `"client"` (default) | Standard BeamNG client mod only |
| `"server"` | BeamMP server plugin only (installs to `Resources/Server/`) |
| `"both"` | Has both client and server components |

For `"both"`, two distribution models are supported:

**Outer-zip layout** — single download with a `Resources/` directory structure:
```
Resources/Client/my_mod.zip    → extracted to mods/repo/
Resources/Server/my_mod/       → extracted to server's Resources/Server/
```

**Dual-component** — separate `server_download` field for the server plugin:
```json
{
  "multiplayer_scope": "both",
  "download": "https://example.com/client_mod.zip",
  "download_hash": { "sha256": "..." },
  "server_download": "https://example.com/server_plugin.zip",
  "server_download_hash": { "sha256": "..." }
}
```

The Content Manager auto-detects the `Resources/` layout in the main download. If no `Resources/` layout is found and no `server_download` is set, only the client component is installed.

### Localizations

Provide translated strings keyed by locale code:

```json
"localizations": {
  "de": {
    "name": "Drift-Reifen-Paket",
    "abstract": "Hochleistungs-Drift-Reifen für alle Fahrzeuge"
  },
  "fr": {
    "name": "Pack de Pneus Drift",
    "abstract": "Pneus drift haute performance pour tous les véhicules"
  }
}
```

Each locale can override `name`, `abstract`, and/or `description`.

### Extension Fields

Fields prefixed with `x_` are allowed for third-party tooling and are ignored by the official schema validation:

```json
{
  "x_my_tool_setting": "value",
  "x_custom_tags": ["competitive", "ranked"]
}
```

## For Mod Authors

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full submission guide.

### Quick Start

1. Fork this repository
2. Create `mods/{your_mod_id}/{your_mod_id}-{version}.beammod`
3. Fill in the metadata (see example above)
4. Open a Pull Request
5. GitHub Actions will validate your metadata automatically
6. Once merged, your mod appears in the BeamMP Content Manager

### Embedding Metadata

You can also include a `.beammod` file inside your mod zip. The Content Manager will detect and use it as the authoritative metadata source.

## For Developers

### Building the Index

The GitHub Actions workflow automatically:
1. Validates all `.beammod` files against the JSON Schema
2. Builds a compressed index (`registry-index.json.gz`)
3. Uploads it as a GitHub Release

### Local Development

```bash
# Install dependencies
npm install

# Validate all metadata files
npm run validate

# Build the index locally
npm run build
```

## License

[MIT](LICENSE)
