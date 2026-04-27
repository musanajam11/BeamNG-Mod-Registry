import { Accordion, Stack, Text, TextInput, Textarea } from '@mantine/core'
import type { FormState, Updater } from './formState'

export function AdvancedSection({ f, update }: { f: FormState; update: Updater }) {
  return (
    <Accordion.Item value="advanced">
      <Accordion.Control><Text fw={600}>Advanced</Text></Accordion.Control>
      <Accordion.Panel>
        <Stack>
          <TextInput label="$kref (auto-tracking source)" value={f.kref}
            onChange={(e) => update('kref', e.currentTarget.value)}
            description="Optional: #/github/{owner}/{repo} or #/beamng/{id}"
            placeholder="#/github/your_user/your_repo" />
          <Textarea label="Internal comment (max 4 KiB)" autosize minRows={2} maxRows={8}
            value={f.comment} onChange={(e) => update('comment', e.currentTarget.value)}
            description="Note for maintainers — not displayed to end users" />
        </Stack>
      </Accordion.Panel>
    </Accordion.Item>
  )
}
