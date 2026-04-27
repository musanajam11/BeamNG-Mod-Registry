import { Accordion, SimpleGrid, Stack, Text, TextInput } from '@mantine/core'
import type { FormState, Updater } from './formState'

export function ResourcesSection({ f, update }: { f: FormState; update: Updater }) {
  return (
    <Accordion.Item value="resources">
      <Accordion.Control><Text fw={600}>Resources & Links</Text></Accordion.Control>
      <Accordion.Panel>
        <Stack>
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
            <TextInput label="Homepage" type="url" value={f.homepage}
              onChange={(e) => update('homepage', e.currentTarget.value)} />
            <TextInput label="Repository" type="url" value={f.repository}
              onChange={(e) => update('repository', e.currentTarget.value)} />
            <TextInput label="Bug tracker" type="url" value={f.bugtracker}
              onChange={(e) => update('bugtracker', e.currentTarget.value)} />
            <TextInput label="BeamNG resource page" type="url" value={f.beamng_resource}
              onChange={(e) => update('beamng_resource', e.currentTarget.value)} />
          </SimpleGrid>
          <TextInput label="BeamMP forum thread" type="url" value={f.beammp_forum}
            onChange={(e) => update('beammp_forum', e.currentTarget.value)} />
        </Stack>
      </Accordion.Panel>
    </Accordion.Item>
  )
}
