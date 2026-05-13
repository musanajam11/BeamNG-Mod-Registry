import { Accordion, Alert, Badge, Button, Group, Select, Stack, Text, TextInput } from '@mantine/core'
import { type FormState, type Updater, MULTIPLAYER_SCOPES } from './formState'

export function MultiplayerSection({ f, update }: { f: FormState; update: Updater }) {
  const confirmed = f.multiplayer_scope_confirmed
  return (
    <Accordion.Item value="multiplayer">
      <Accordion.Control>
        <Group gap="xs">
          <Text fw={600}>Multiplayer (BeamMP)</Text>
          {confirmed
            ? <Badge size="xs" color="green" variant="light">scope confirmed</Badge>
            : <Badge size="xs" color="red" variant="filled">needs confirmation</Badge>}
        </Group>
      </Accordion.Control>
      <Accordion.Panel>
        <Stack>
          <Select
            label="Multiplayer scope"
            withAsterisk
            data={[...MULTIPLAYER_SCOPES]}
            value={f.multiplayer_scope}
            onChange={(v) => {
              const next = (v as FormState['multiplayer_scope']) ?? 'client'
              update('multiplayer_scope', next)
              // Picking a value from the dropdown counts as an explicit
              // user choice — no separate Confirm click needed.
              update('multiplayer_scope_confirmed', true)
            }}
            description="client = standard mod · server = BeamMP server plugin · both = ships both components"
          />
          {!confirmed && (
            <Alert color="yellow" variant="light" title="Please confirm the multiplayer scope">
              <Stack gap="xs">
                <Text size="sm">
                  Getting this wrong breaks BeamMP server installs. Pick the right
                  value above (or click the button below if <strong>{f.multiplayer_scope}</strong> is
                  already correct) before submitting.
                </Text>
                <Group>
                  <Button
                    size="xs"
                    color="green"
                    onClick={() => update('multiplayer_scope_confirmed', true)}
                  >
                    Confirm: this is a <strong style={{ marginLeft: 4 }}>{f.multiplayer_scope}</strong> mod
                  </Button>
                </Group>
              </Stack>
            </Alert>
          )}
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
