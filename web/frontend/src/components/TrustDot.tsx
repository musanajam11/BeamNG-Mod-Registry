import { Tooltip } from '@mantine/core'

interface Props {
  trust: 'green' | 'yellow' | 'red'
  size?: number
}

const COLOR: Record<Props['trust'], string> = {
  green: 'var(--mantine-color-green-6)',
  yellow: 'var(--mantine-color-yellow-6)',
  red: 'var(--mantine-color-red-6)',
}

const LABEL: Record<Props['trust'], string> = {
  green: 'Green tier — submissions auto-process',
  yellow: 'Yellow tier — submissions queue for review',
  red: 'Red tier — submissions are blocked',
}

export function TrustDot({ trust, size = 10 }: Props) {
  return (
    <Tooltip label={LABEL[trust]} withArrow>
      <span
        aria-label={`Trust tier: ${trust}`}
        role="status"
        style={{
          display: 'inline-block',
          width: size,
          height: size,
          borderRadius: '50%',
          backgroundColor: COLOR[trust],
          boxShadow: `0 0 0 2px color-mix(in srgb, ${COLOR[trust]} 25%, transparent)`,
        }}
      />
    </Tooltip>
  )
}
