# Contributing to BeamNG Mod Registry

Thank you for contributing! This guide explains how to add your mod to the registry.

There are two ways to add a mod:

- **Manual** — write a `.beammod` metadata file by hand (works for any hosting)
- **Automated (NetBeamMod)** — submit a small template with a `$kref` source reference and let the inflator auto-generate metadata from your GitHub releases

## Option A: Automated via NetBeamMod (Recommended for GitHub / BeamNG.com)

If your mod is hosted on **GitHub** (with releases) or **BeamNG.com/resources**, the inflator can automatically detect new versions, download the asset, compute its SHA256 hash and file size, and generate the `.beammod` file — no manual work per release.

### 1. Create a Template

Create `netbeammod/{identifier}.netbeammod` with a `$kref` pointing to your source:

**GitHub:**
```json
{
  "spec_version": 1,
  "identifier": "my_cool_mod",
  "$kref": "#/github/your_username/your_repo",
  "name": "My Cool Mod",
  "abstract": "A short description of the mod",
  "author": "YourName",
  "license": "MIT",
  "mod_type": "vehicle",
  "tags": ["drift", "physics"]
}
```

**BeamNG.com/resources:**
```json
{
  "spec_version": 1,
  "identifier": "my_beamng_mod",
  "$kref": "#/beamng/12345",
  "name": "My BeamNG Mod",
  "abstract": "A mod from the BeamNG portal",
  "author": "YourName",
  "license": "CC-BY-4.0",
  "mod_type": "vehicle"
}
```
The number after `#/beamng/` is the resource ID from the URL (e.g. `beamng.com/resources/my-mod.12345/` → `12345`).

### 2. Template Directives

These `$`-prefixed fields control how the inflator processes your releases:

| Field | Default | Description |
|-------|---------|-------------|
| `$kref` | *(required)* | Source: `#/github/{owner}/{repo}` or `#/beamng/{resource_id}` |
| `$filter_asset` | first `.zip` | Regex to pick the right release asset (GitHub only) |
| `$version_strip_v` | `true` | Strip leading `v` from git tags (`v1.0` → `1.0`) |
| `$version_transform` | — | Regex `{ "match": "...", "replace": "..." }` applied to version |
| `$include_prerelease` | `false` | Include GitHub pre-releases |
| `$max_releases` | `10` | Max releases to process (newest first) |

All other fields (name, abstract, tags, mod_type, install, depends, etc.) are passed through to every generated `.beammod` file as-is.

### 3. Open a Pull Request

Submit only the `.netbeammod` file. The inflator will generate `.beammod` files automatically.

### 4. How It Works

```
netbeammod/my_mod.netbeammod          ← your template (5-15 lines)
        │
        ▼  inflate.mjs (daily cron or manual trigger)
        │
        ├── Fetches releases from GitHub API
        ├── Downloads each asset, computes SHA256 + size
        ├── Merges template fields + computed fields
        └── Writes mods/my_mod/my_mod-{version}.beammod
                │
                ▼  build-index.yml (triggered by push)
                │
                └── Validates → Builds index → Publishes GitHub Release
```

### 5. Testing Locally

```bash
# Dry run — shows what would be generated without writing files
npm run inflate:dry

# Actually generate .beammod files
GITHUB_TOKEN=ghp_... npm run inflate

# Process a specific mod only
node scripts/inflate.mjs --id my_cool_mod
```

Set `GITHUB_TOKEN` to avoid the 60 requests/hour unauthenticated API limit.

---

## Option B: Manual .beammod File

### 1. Fork & Clone

```bash
git clone https://github.com/YOUR_USERNAME/BeamNG-Mod-Registry.git
cd BeamNG-Mod-Registry
```

### 2. Create Your Metadata File

Create a directory for your mod and a `.beammod` file inside it:

```
mods/
└── your_mod_id/
    └── your_mod_id-1.0.0.beammod
```

**Naming rules:**
- Directory name must match the `identifier` field
- File must be named `{identifier}-{version}.beammod`
- Identifier: ASCII letters, digits, hyphens, underscores (2–128 chars)

### 3. Fill In the Metadata

At minimum you need:

```json
{
  "spec_version": 1,
  "identifier": "your_mod_id",
  "name": "Your Mod Name",
  "abstract": "A short one-line description of what it does",
  "author": "YourName",
  "version": "1.0.0",
  "license": "MIT",
  "download": "https://direct-download-url-to-your-mod.zip",
  "download_hash": {
    "sha256": "paste-the-sha256-hash-of-your-zip-here"
  }
}
```

**Getting the SHA256 hash:**
- Windows: `certutil -hashfile your_mod.zip SHA256`
- Linux/macOS: `sha256sum your_mod.zip`

### 4. Validate Locally (Optional)

```bash
npm install
npm run validate
```

### 5. Open a Pull Request

Push your branch and open a PR against `main`. GitHub Actions will automatically:

1. **Validate** your `.beammod` file against the JSON schema
2. **Cross-validate dependencies** — checks that all `depends` identifiers exist in the registry
3. **Verify downloads** — fetches your download URL, confirms it's reachable, and verifies the SHA256 hash matches

Fix any errors it reports.

### 6. After Merge

Once merged, the CI pipeline builds a new index and publishes it as a GitHub Release. Your mod will appear in the BeamMP Content Manager within 24 hours (or immediately if users refresh).

## Updating a Mod

To publish a new version, add a new `.beammod` file alongside the old one:

```
mods/
└── your_mod_id/
    ├── your_mod_id-1.0.0.beammod
    └── your_mod_id-1.1.0.beammod
```

The Content Manager uses the newest version by default.

## Multiplayer Mods

BeamMP multiplayer mods have two distinct components that go to different places:

- **Client mod** — a standard BeamNG `.zip` mod (Lua extensions, scripts, sounds) installed to `mods/repo/`
- **Server plugin** — Lua scripts using the BeamMP server API (`MP.RegisterEvent`, `MP.TriggerClientEvent`) installed to the server's `Resources/Server/<modname>/`

### Distribution Models

**Option A — Outer-zip layout** (recommended for mods that ship both components together):

Package your mod as a `Resources/` layout zip, like BeamRadio:

```
my_mod-1.0.0.zip
└── Resources/
    ├── Client/
    │   └── my_mod.zip          ← inner zip (standard BeamNG mod format)
    └── Server/
        └── my_mod/
            └── main.lua        ← server plugin
```

The Content Manager detects the `Resources/` layout automatically and routes files correctly.

```json
{
  "multiplayer_scope": "both",
  "download": "https://example.com/my_mod-1.0.0.zip",
  "download_hash": { "sha256": "..." }
}
```

**Option B — Dual-component** (separate downloads for client and server):

```json
{
  "multiplayer_scope": "both",
  "download": "https://example.com/my_mod_client-1.0.0.zip",
  "download_hash": { "sha256": "..." },
  "server_download": "https://example.com/my_mod_server-1.0.0.zip",
  "server_download_hash": { "sha256": "..." }
}
```

**Server-only plugins** (no client component):

```json
{
  "multiplayer_scope": "server",
  "download": "https://example.com/my_server_plugin-1.0.0.zip",
  "download_hash": { "sha256": "..." }
}
```

### Scope Values

| Value | Meaning |
|-------|---------|
| `"client"` (default) | Standard BeamNG client mod → `mods/repo/` |
| `"server"` | BeamMP server plugin only → server's `Resources/Server/<id>/` |
| `"both"` | Has both client and server components |

## Metapackages (Modpacks)

To create a modpack that bundles other mods without a download of its own:

```json
{
  "spec_version": 1,
  "identifier": "my_modpack",
  "name": "My Racing Modpack",
  "abstract": "Everything you need for online racing",
  "author": "YourName",
  "version": "1.0.0",
  "license": "MIT",
  "kind": "metapackage",
  "depends": [
    { "identifier": "drift_tires" },
    { "identifier": "race_suspension" }
  ]
}
```

## Guidelines

- **One mod per directory.** Don't put multiple mods in the same folder.
- **Use valid SPDX identifiers** for the `license` field (e.g. `MIT`, `GPL-3.0-only`, `CC-BY-4.0`).
- **Host your download reliably.** GitHub Releases, Google Drive (direct link), or other permanent URLs.
- **Don't change existing versions.** If you need to fix something, publish a new version.
- **Keep `abstract` short.** Use `description` for longer explanations.
- **Test your download URL.** CI will download your file and verify the SHA256 hash before merge.
- **Dependencies must exist.** If your mod declares `depends`, all referenced identifiers must already be in the registry. Use `recommends` or `suggests` for optional dependencies that may not be registered yet.
- **Add `$kref` to your `.beammod`** if your mod is on GitHub or BeamNG.com — this enables the inflator to auto-detect future versions even without a `.netbeammod` template.

## Verification

CI automatically verifies all download URLs on pull requests:

```bash
# Run locally to check your downloads
npm run verify

# Auto-fix hashes and sizes from actual downloads
npm run verify:fix
```

## Questions?

Open an issue in this repository or ask on the BeamMP Discord.
