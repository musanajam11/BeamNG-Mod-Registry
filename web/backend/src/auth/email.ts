/**
 * Outgoing email via SMTP. If SMTP is not configured, every send is a no-op
 * and admins can use the admin UI to verify users manually.
 */
import nodemailer, { type Transporter } from 'nodemailer'
import { config, isSmtpConfigured } from '../config.js'

let cachedTransport: Transporter | null = null

function getTransport(): Transporter | null {
  if (!isSmtpConfigured()) return null
  if (cachedTransport) return cachedTransport
  cachedTransport = nodemailer.createTransport({
    host: config.email.smtpHost,
    port: config.email.smtpPort,
    secure: config.email.smtpSecure,
    auth:
      config.email.smtpUser && config.email.smtpPass
        ? { user: config.email.smtpUser, pass: config.email.smtpPass }
        : undefined,
  })
  return cachedTransport
}

export async function sendVerificationEmail(
  to: string,
  displayName: string,
  token: string
): Promise<void> {
  const transport = getTransport()
  if (!transport) return
  const link = `${config.publicOrigin.replace(/\/$/, '')}/verify-email?token=${encodeURIComponent(token)}`
  const text = [
    `Hi ${displayName},`,
    '',
    'Confirm your email address to finish setting up your BeamNG Mod Registry account:',
    link,
    '',
    'This link expires in 24 hours. If you did not sign up, you can ignore this email.',
  ].join('\n')
  const html = `
    <p>Hi ${escapeHtml(displayName)},</p>
    <p>Confirm your email address to finish setting up your BeamNG Mod Registry account:</p>
    <p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>
    <p style="color:#666;font-size:12px">This link expires in 24 hours. If you did not sign up, you can ignore this email.</p>
  `
  await transport.sendMail({
    from: config.email.from,
    to,
    subject: 'Confirm your email — BeamNG Mod Registry',
    text,
    html,
  })
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
