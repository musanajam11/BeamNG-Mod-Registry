import { Accordion, Alert, Badge, Checkbox, Group, Stack, Text, TextInput } from '@mantine/core'
import { type FormState, type Updater, parseSourceUrl } from './formState'

/**
 * "Auto-update" section — opt-in: when checked, the submission also creates
 * (or updates) a netbeammod template so the inflator picks up future
 * upstream releases automatically. The mod author submits once, every new
 * GitHub release / BeamNG.com update lands in the next index Release with
 * no further action.
 */
export function AutoUpdateSection({ f, update }: { f: FormState; update: Updater }) {
  const parsed = parseSourceUrl(f.watch_source_url)
  const showUrlError = f.watch_enabled && f.watch_source_url.trim().length > 0 && !parsed
  return (
    <Accordion.Item value="auto_update">
      <Accordion.Control>
        <Group gap="xs">
          <Text fw={600}>Auto-update from upstream releases</Text>
          {f.watch_enabled && parsed && <Badge color="green" size="sm">enabled</Badge>}
        </Group>
      </Accordion.Control>
      <Accordion.Panel>
        <Stack>
          <Checkbox
            label="Watch upstream releases for new versions"
            description="When the mod author publishes a new release on GitHub or updates a BeamNG.com resource, the inflator will automatically download it, compute the hash, and publish a fresh .beammod — no further action needed."
            checked={f.watch_enabled}
            onChange={(e) => update('watch_enabled', e.currentTarget.checked)}
          />
          {f.watch_enabled && (
            <>
              <TextInput
                label="Source URL"
                description="GitHub repo URL or BeamNG.com resource URL"
                placeholder="https://github.com/owner/repo  or  https://www.beamng.com/resources/my-mod.12345/"
                value={f.watch_source_url}
                onChange={(e) => update('watch_source_url', e.currentTarget.value)}
                error={showUrlError ? 'Could not parse — expected github.com/owner/repo or beamng.com/resources/.../id/' : undefined}
              />
              {parsed && (
                <Alert color="blue" variant="light">
                  Will be tracked as <code>{parsed}</code>
                </Alert>
              )}
              <TextInput
                label="Asset filter (optional)"
                description="Regex matched against release asset filenames. Use this when a release has multiple zips and only one is the BeamNG package. Leave blank to take the first .zip asset."
                placeholder="e.g. ^my_mod-.*\\.zip$"
                value={f.watch_filter_asset}
                onChange={(e) => update('watch_filter_asset', e.currentTarget.value)}
              />
            </>
          )}
        </Stack>
      </Accordion.Panel>
    </Accordion.Item>
  )
}
