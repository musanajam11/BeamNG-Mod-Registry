/**
 * Shared Discord call-to-action link.
 *
 * Used on the login page, in the left sidebar (above the Content Manager
 * button), and at the bottom of the FAQ. Renders the Discord wordmark/logo
 * with a short prompt and links to the public invite.
 */
import { Button } from '@mantine/core'

export const DISCORD_INVITE_URL = 'https://discord.gg/JQGyzmkjk'

const DISCORD_BRAND = '#5865F2'

/** Inline Discord "Clyde" mark. Single path, currentColor so it tints with the button. */
export function DiscordIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 127.14 96.36"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block' }}
    >
      <path
        fill="currentColor"
        d="M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.83 97.68 97.68 0 0 0-29.11 0A72.37 72.37 0 0 0 45.64 0a105.89 105.89 0 0 0-26.25 8.09C2.79 32.65-1.71 56.6.54 80.21a105.73 105.73 0 0 0 32.17 16.15 77.7 77.7 0 0 0 6.89-11.11 68.42 68.42 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2a75.57 75.57 0 0 0 64.32 0c.87.71 1.76 1.39 2.66 2a68.68 68.68 0 0 1-10.87 5.19 77 77 0 0 0 6.89 11.1 105.25 105.25 0 0 0 32.19-16.14c2.64-27.38-4.51-51.11-18.9-72.15ZM42.45 65.69C36.18 65.69 31 60 31 53s5-12.74 11.43-12.74S54 46 53.89 53s-5.05 12.69-11.44 12.69Zm42.24 0C78.41 65.69 73.25 60 73.25 53s5-12.74 11.44-12.74S96.23 46 96.12 53s-5.04 12.69-11.43 12.69Z"
      />
    </svg>
  )
}

export interface DiscordLinkProps {
  /** Call-to-action label. */
  label?: string
  /** Mantine size prop forwarded to the underlying Button. */
  size?: 'xs' | 'sm' | 'md' | 'lg'
  fullWidth?: boolean
}

/**
 * Renders a button-styled link that opens the Discord invite in a new tab.
 * Uses Discord brand colours so it's recognisable at a glance.
 */
export function DiscordLink({ label = 'Join the Discord', size = 'sm', fullWidth }: DiscordLinkProps) {
  return (
    <Button
      component="a"
      href={DISCORD_INVITE_URL}
      target="_blank"
      rel="noopener noreferrer"
      size={size}
      fullWidth={fullWidth}
      title="Join the Discord for help and questions"
      leftSection={<DiscordIcon size={18} />}
      styles={{
        root: {
          backgroundColor: DISCORD_BRAND,
          color: 'white',
          border: 'none',
        },
      }}
    >
      {label}
    </Button>
  )
}
