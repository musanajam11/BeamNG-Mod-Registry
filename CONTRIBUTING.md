# Contributing to BeamNG Mod Registry

Thank you for contributing! This guide explains how to add your mod to the registry.

## Adding a Mod

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

Push your branch and open a PR against `main`. GitHub Actions will automatically validate your `.beammod` file against the schema. Fix any errors it reports.

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
- **Test your download URL.** The Content Manager will verify the SHA256 hash on install.

## Questions?

Open an issue in this repository or ask on the BeamMP Discord.
