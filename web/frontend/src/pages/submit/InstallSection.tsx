import { Accordion, Button, Group, Paper, Select, SimpleGrid, Stack, Switch, Text, TextInput } from '@mantine/core'
import type { FormState, InstallDirective, Updater } from './formState'

export function InstallSection({ f, update }: { f: FormState; update: Updater }) {
  const add = () =>
    update('install', [
      ...f.install,
      { match_type: 'find', match_value: '', install_to: 'mods/repo' },
    ])
  const remove = (i: number) => update('install', f.install.filter((_, idx) => idx !== i))
  const set = (i: number, patch: Partial<InstallDirective>) =>
    update('install', f.install.map((d, idx) => (idx === i ? { ...d, ...patch } : d)))

  return (
    <Accordion.Item value="install">
      <Accordion.Control><Text fw={600}>Install directives</Text></Accordion.Control>
      <Accordion.Panel>
        <Stack>
          <Group justify="space-between">
            <Text size="xs" c="dimmed" style={{ flex: 1 }}>
              Each directive describes how to extract content from the archive. Most mods need none —
              omit this section if the zip already has the right layout.
            </Text>
            <Button size="xs" variant="light" onClick={add}>+ Add directive</Button>
          </Group>
          {f.install.map((d, i) => (
            <Paper key={i} withBorder p="sm" radius="sm">
              <Stack gap="xs">
                <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="xs">
                  <Select label="Match type" size="xs"
                    data={['file', 'find', 'find_regexp']}
                    value={d.match_type}
                    onChange={(v) => set(i, { match_type: (v as InstallDirective['match_type']) ?? 'find' })} />
                  <TextInput label="Match value" size="xs" value={d.match_value}
                    onChange={(e) => set(i, { match_value: e.currentTarget.value })}
                    placeholder={d.match_type === 'find' ? 'directory name' : d.match_type === 'file' ? 'path/in/zip.txt' : '^pattern.*$'} />
                  <TextInput label="Install to" size="xs" value={d.install_to}
                    onChange={(e) => set(i, { install_to: e.currentTarget.value })}
                    placeholder="mods/repo" />
                </SimpleGrid>
                <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="xs">
                  <TextInput label="Rename as" size="xs" value={d.as ?? ''}
                    onChange={(e) => set(i, { as: e.currentTarget.value })} />
                  <TextInput label="Filter (exclude)" size="xs" value={d.filter ?? ''}
                    onChange={(e) => set(i, { filter: e.currentTarget.value })} />
                  <TextInput label="Include only" size="xs" value={d.include_only ?? ''}
                    onChange={(e) => set(i, { include_only: e.currentTarget.value })} />
                </SimpleGrid>
                <Group justify="space-between">
                  <Switch size="xs"
                    label="find_matches_files (allow file matches, not just dirs)"
                    checked={!!d.find_matches_files}
                    onChange={(e) => set(i, { find_matches_files: e.currentTarget.checked })} />
                  <Button size="xs" color="red" variant="subtle" onClick={() => remove(i)}>Remove</Button>
                </Group>
              </Stack>
            </Paper>
          ))}
        </Stack>
      </Accordion.Panel>
    </Accordion.Item>
  )
}
