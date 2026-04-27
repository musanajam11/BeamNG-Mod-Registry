import { Accordion, Select, SimpleGrid, Stack, Text, TextInput } from '@mantine/core'
import { type FormState, type Updater, RELEASE_STATUSES } from './formState'

export function CompatSection({ f, update }: { f: FormState; update: Updater }) {
  return (
    <Accordion.Item value="compat">
      <Accordion.Control><Text fw={600}>Compatibility & Release</Text></Accordion.Control>
      <Accordion.Panel>
        <Stack>
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
            <Select label="Release status" data={[...RELEASE_STATUSES]}
              value={f.release_status}
              onChange={(v) => update('release_status', (v as FormState['release_status']) ?? 'stable')} />
            <TextInput label="Release date" type="date" value={f.release_date}
              onChange={(e) => update('release_date', e.currentTarget.value)} />
          </SimpleGrid>
          <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md">
            <TextInput label="BeamNG version (exact)" value={f.beamng_version}
              onChange={(e) => update('beamng_version', e.currentTarget.value)}
              description="Or 'any'" />
            <TextInput label="BeamNG min" value={f.beamng_version_min}
              onChange={(e) => update('beamng_version_min', e.currentTarget.value)} />
            <TextInput label="BeamNG max" value={f.beamng_version_max}
              onChange={(e) => update('beamng_version_max', e.currentTarget.value)} />
          </SimpleGrid>
          <TextInput label="BeamMP min version" value={f.beammp_version_min}
            onChange={(e) => update('beammp_version_min', e.currentTarget.value)} />
        </Stack>
      </Accordion.Panel>
    </Accordion.Item>
  )
}
