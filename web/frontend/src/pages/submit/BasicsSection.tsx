import { Accordion, Badge, Group, Select, SimpleGrid, Stack, Text, TextInput } from '@mantine/core'
import { type FormState, type Updater, KINDS, MOD_TYPES } from './formState'

export function BasicsSection({ f, update }: { f: FormState; update: Updater }) {
  return (
    <Accordion.Item value="basics">
      <Accordion.Control>
        <Group gap="xs"><Text fw={600}>Basics</Text><Badge size="xs" color="red">required</Badge></Group>
      </Accordion.Control>
      <Accordion.Panel>
        <Stack>
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
            <TextInput label="Identifier" required value={f.identifier}
              onChange={(e) => update('identifier', e.currentTarget.value)}
              description="ASCII letters, digits, _ or -" />
            <TextInput label="Version" required value={f.version}
              onChange={(e) => update('version', e.currentTarget.value)}
              description="e.g. 1.2.3 or 2:1.0 (with epoch)" />
          </SimpleGrid>
          <TextInput label="Name" required value={f.name}
            onChange={(e) => update('name', e.currentTarget.value)} />
          <TextInput label="Abstract" required maxLength={512} value={f.abstract}
            onChange={(e) => update('abstract', e.currentTarget.value)}
            description="One-line description shown in listings (max 512 chars)" />
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
            <TextInput label="Author" required value={f.author}
              onChange={(e) => update('author', e.currentTarget.value)}
              description="Single author or comma-separated names" />
            <TextInput label="License" required value={f.license}
              onChange={(e) => update('license', e.currentTarget.value)}
              description="SPDX identifier, e.g. MIT, GPL-3.0-or-later" />
          </SimpleGrid>
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
            <Select label="Kind" data={[...KINDS]} value={f.kind}
              onChange={(v) => update('kind', (v as FormState['kind']) ?? 'package')}
              description="package = downloadable · metapackage = bundle · dlc = paid" />
            <Select label="Mod type" data={[...MOD_TYPES]} value={f.mod_type}
              onChange={(v) => update('mod_type', v)} clearable
              description="High-level category" />
          </SimpleGrid>
        </Stack>
      </Accordion.Panel>
    </Accordion.Item>
  )
}
