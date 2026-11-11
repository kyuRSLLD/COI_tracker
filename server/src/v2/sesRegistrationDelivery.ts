// Disconnected adapter. Compose only in trusted server code after the release checks.
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'

// Structural copy of RegistrationDelivery from the disconnected registration worktree.
// On integration, replace this local type with the canonical type-only import.
export type RegistrationDelivery = { sendVerification(input: { email: string; token: string; expiresInSeconds: number }): Promise<void> }

export type SesRegistrationConfig = { region: string; fromEmailAddress: string; timeoutMs?: number }
type SesTransport = { send(command: SendEmailCommand, options: { abortSignal: AbortSignal }): Promise<{ MessageId?: string }> }
const unavailable = () => new Error('Verification delivery unavailable')

// Intentionally conservative ASCII mailbox subset; no display names, lists, quoted
// local parts, CR/LF, international local parts, or header syntax are accepted.
function validMailbox(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 254 || /[^\x21-\x7e]/.test(value)) return false
  const parts = value.split('@')
  if (parts.length !== 2) return false
  const [local, domain] = parts
  if (local.length < 1 || local.length > 64 || !/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local) ||
      local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false
  const labels = domain.split('.')
  return labels.length >= 2 && labels.every(label => label.length > 0 && label.length <= 63 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)) && /^[A-Za-z]{2,63}$/.test(labels[labels.length - 1])
}

function validToken(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false
  const bytes = Buffer.from(value, 'base64url')
  return bytes.length === 32 && bytes.toString('base64url') === value
}

/** Config and optional transport must come exclusively from trusted server composition.
 * The transport seam is for tests; production uses the SDK's default credential chain.
 * This factory does not query SES to verify the sender or credentials. */
export function createSesRegistrationDelivery(config: SesRegistrationConfig, transport?: SesTransport): RegistrationDelivery {
  if (!config || typeof config.region !== 'string' || !/^[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+$/.test(config.region) ||
      !validMailbox(config.fromEmailAddress) ||
      (config.timeoutMs !== undefined && (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 100 || config.timeoutMs > 15000))) {
    throw unavailable()
  }
  const { region, fromEmailAddress, timeoutMs = 8000 } = config
  // No credentials, endpoint, or logger is accepted here. Disallow endpoint override
  // environment settings so an accidental custom URL cannot receive the one-time code.
  const client = transport ? undefined : new SESv2Client({ region, maxAttempts: 1, ignoreConfiguredEndpointUrls: true })
  const sender: SesTransport = transport ?? { send: (command, options) => client!.send(command, options) }
  return {
    async sendVerification(input) {
      try {
        if (!input || !validMailbox(input.email) || !validToken(input.token) ||
            !Number.isInteger(input.expiresInSeconds) || input.expiresInSeconds < 1 || input.expiresInSeconds > 86400) throw unavailable()
        const command = new SendEmailCommand({
          FromEmailAddress: fromEmailAddress,
          Destination: { ToAddresses: [input.email] },
          Content: { Simple: {
            Subject: { Charset: 'UTF-8', Data: 'Your account verification code' },
            Body: { Text: { Charset: 'UTF-8', Data: `Use this one-time code to verify your new account:\n\n${input.token}\n\nThis code expires ${input.expiresInSeconds} seconds after it was requested. If you did not request it, ignore this email. Do not share the code.` } },
          } },
          ConfigurationOverrides: { Tracking: { OpenTrackingEnabled: 'DISABLED', ClickTrackingEnabled: 'DISABLED' } },
        })
        const controller = new AbortController()
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const deadline = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(unavailable()) }, timeoutMs)
          })
          const result = await Promise.race([sender.send(command, { abortSignal: controller.signal }), deadline])
          // SES returns MessageId on acceptance, not proof of mailbox delivery.
          if (!result || typeof result.MessageId !== 'string' || !result.MessageId.trim()) throw unavailable()
        } finally {
          if (timer !== undefined) clearTimeout(timer)
        }
      } catch {
        // Do not propagate AWS errors, input, token, or provider metadata.
        throw unavailable()
      }
    },
  }
}
