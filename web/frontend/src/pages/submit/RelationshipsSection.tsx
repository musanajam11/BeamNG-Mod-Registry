import { Accordion, ActionIcon, Button, Group, SimpleGrid, Stack, TagsInput, Text, TextInput, Tooltip } from '@mantine/core'
import type { FormState, Relationship, Updater } from './formState'

function RelEditor(props: {
  label: string
  help: string
  value: Relationship[]
  onChange: (next: Relationship[]) => void
}) {
  const add = () => props.onChange([...props.value, { identifier: '' }])
  const remove = (i: number) => props.onChange(props.value.filter((_, idx) => idx !== i))
  const set = (i: number, patch: Partial<Relationship>) =>
    props.onChange(props.value.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))

  return (
    <Stack gap={4}>
      <Group justify="space-between">
        <Text fw={500} size="sm">{props.label}</Text>
        <Tooltip label={props.help}>
          <Button size="xs" variant="light" onClick={add}>+ Add</Button>
        </Tooltip>
      </Group>
      <Text size="xs" c="dimmed">{props.help}</Text>
      {props.value.map((r, i) => (
        <SimpleGrid key={i} cols={{ base: 1, sm: 4 }} spacing="xs">
          <TextInput placeholder="identifier" value={r.identifier}
            onChange={(e) => set(i, { identifier: e.currentTarget.value })} />
          <TextInput placeholder="min version" value={r.min_version ?? ''}
            onChange={(e) => set(i, { min_version: e.currentTarget.value })} />
          <TextInput placeholder="max version" value={r.max_version ?? ''}
            onChange={(e) => set(i, { max_version: e.currentTarget.value })} />
          <Group justify="flex-end">
            <ActionIcon color="red" variant="subtle" onClick={() => remove(i)} aria-label="remove">✕</ActionIcon>
          </Group>
        </SimpleGrid>
      ))}
    </Stack>
  )
}

export function RelationshipsSection({ f, update }: { f: FormState; update: Updater }) {
  return (
    <Accordion.Item value="rel">
      <Accordion.Control><Text fw={600}>Relationships</Text></Accordion.Control>
      <Accordion.Panel>
        <Stack>
          <RelEditor label="Depends" help="Hard dependencies — must be installed."
            value={f.depends} onChange={(v) => update('depends', v)} />
          <RelEditor label="Recommends" help="Installed by default; user can decline."
            value={f.recommends} onChange={(v) => update('recommends', v)} />
          <RelEditor label="Suggests" help="Not installed by default; user can opt in."
            value={f.suggests} onChange={(v) => update('suggests', v)} />
          <RelEditor label="Supports" help="Mods this enhances when present (informational)."
            value={f.supports} onChange={(v) => update('supports', v)} />
          <RelEditor label="Conflicts" help="Cannot coexist with these mods."
            value={f.conflicts} onChange={(v) => update('conflicts', v)} />
          <TagsInput label="Provides" value={f.provides}
            onChange={(v) => update('provides', v)} clearable
            description="Virtual package names this mod satisfies" />
        </Stack>
      </Accordion.Panel>
    </Accordion.Item>
  )
}
