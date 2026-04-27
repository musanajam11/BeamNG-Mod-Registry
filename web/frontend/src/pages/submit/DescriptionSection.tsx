import { Accordion, Stack, TagsInput, Text, Textarea } from '@mantine/core'
import type { FormState, Updater } from './formState'

export function DescriptionSection({ f, update }: { f: FormState; update: Updater }) {
  return (
    <Accordion.Item value="description">
      <Accordion.Control><Text fw={600}>Description & Tags</Text></Accordion.Control>
      <Accordion.Panel>
        <Stack>
          <TagsInput label="Tags" value={f.tags} onChange={(v) => update('tags', v)} clearable
            description="Categorization tags (unique)" />
          <Textarea label="Long description (Markdown, max 16 KiB)"
            autosize minRows={4} maxRows={20}
            value={f.description}
            onChange={(e) => update('description', e.currentTarget.value)} />
        </Stack>
      </Accordion.Panel>
    </Accordion.Item>
  )
}
