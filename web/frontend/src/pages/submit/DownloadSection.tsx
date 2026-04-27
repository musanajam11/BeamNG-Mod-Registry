import { Accordion, NumberInput, SimpleGrid, Stack, Switch, Text, TextInput } from '@mantine/core'
import type { FormState, Updater } from './formState'

export function DownloadSection({
  f, update, hashServerSide, setHashServerSide,
}: { f: FormState; update: Updater; hashServerSide: boolean; setHashServerSide: (v: boolean) => void }) {
  return (
    <Accordion.Item value="download">
      <Accordion.Control><Text fw={600}>Download</Text></Accordion.Control>
      <Accordion.Panel>
        <Stack>
          <TextInput label="Download URL" type="url" required={f.kind === 'package'}
            value={f.download} onChange={(e) => update('download', e.currentTarget.value)}
            description="Direct link to the .zip. Required for kind=package." />
          <Switch label="Compute SHA256 + size on the server (recommended)"
            checked={hashServerSide} onChange={(e) => setHashServerSide(e.currentTarget.checked)} />
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
            <NumberInput label="Download size (bytes)" value={f.download_size ?? ''}
              onChange={(v) => update('download_size', typeof v === 'number' ? v : null)}
              description="Auto-filled by inspect or server-side hash"
              min={0} thousandSeparator="," />
            <NumberInput label="Installed size (bytes)" value={f.install_size ?? ''}
              onChange={(v) => update('install_size', typeof v === 'number' ? v : null)}
              description="Optional — informational only"
              min={0} thousandSeparator="," />
          </SimpleGrid>
          <TextInput label="Thumbnail URL" type="url" value={f.thumbnail}
            onChange={(e) => update('thumbnail', e.currentTarget.value)}
            description="Preview image shown in the Content Manager" />
        </Stack>
      </Accordion.Panel>
    </Accordion.Item>
  )
}
