import { Accordion, Select, Stack, Text, TextInput } from '@mantine/core'
import { type FormState, type Updater, MULTIPLAYER_SCOPES } from './formState'

export function MultiplayerSection({ f, update }: { f: FormState; update: Updater }) {
  return (
    <Accordion.Item value="multiplayer">
      <Accordion.Control><Text fw={600}>Multiplayer (BeamMP)</Text></Accordion.Control>
      <Accordion.Panel>
        <Stack>
          <Select label="Multiplayer scope" data={[...MULTIPLAYER_SCOPES]}
            value={f.multiplayer_scope}
            onChange={(v) => update('multiplayer_scope', (v as FormState['multiplayer_scope']) ?? 'client')}
            description="client = standard mod · server = BeamMP server plugin · both = ships both components" />
          {(f.multiplayer_scope === 'server' || f.multiplayer_scope === 'both') && (
            <TextInput label="Server download URL" type="url" value={f.server_download}
              onChange={(e) => update('server_download', e.currentTarget.value)}
              description="Optional separate download for the server-side plugin" />
          )}
        </Stack>
      </Accordion.Panel>
    </Accordion.Item>
  )
}
