import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'
import { createSesRegistrationDelivery } from '../src/v2/sesRegistrationDelivery.ts'

const config = { region: 'us-east-1', fromEmailAddress: 'Verify@example.com' }
const token = () => randomBytes(32).toString('base64url')
const message = () => ({ email: 'person@example.org', token: token(), expiresInSeconds: 600 })
const generic = (error: unknown) => {
  assert.ok(error instanceof Error)
  assert.equal(error.message, 'Verification delivery unavailable')
  assert.equal(error.cause, undefined)
  assert.deepEqual(Object.keys(error), [])
  return true
}

test('sends exactly one text-only message with the actual one-time code and tracking disabled', async () => {
  const input = message()
  const calls: Array<{ command: SendEmailCommand; options: { abortSignal: AbortSignal } }> = []
  const transport = { async send(command: SendEmailCommand, options: { abortSignal: AbortSignal }) { calls.push({ command, options }); return { MessageId: 'opaque' } } }
  const delivery = createSesRegistrationDelivery(config, transport)
  assert.equal(await delivery.sendVerification(input), undefined)
  assert.equal(calls.length, 1)
  const { command, options } = calls[0]
  assert.ok(command instanceof SendEmailCommand)
  assert.equal(options.abortSignal.aborted, false)
  assert.deepEqual(command.input.Destination, { ToAddresses: [input.email] })
  assert.equal(command.input.FromEmailAddress, config.fromEmailAddress)
  assert.deepEqual(command.input.ConfigurationOverrides, { Tracking: { OpenTrackingEnabled: 'DISABLED', ClickTrackingEnabled: 'DISABLED' } })
  assert.deepEqual(Object.keys(command.input).sort(), ['ConfigurationOverrides', 'Content', 'Destination', 'FromEmailAddress'])
  assert.deepEqual(Object.keys(command.input.Content!.Simple!.Body!), ['Text'])
  const text = command.input.Content!.Simple!.Body!.Text!.Data!
  assert.ok(text.includes(input.token))
  assert.equal(text.split(input.token).length, 2)
  assert.match(text, /600 seconds/)
  assert.doesNotMatch(text, /https?:\/\//i)
  assert.equal(Buffer.from(input.token, 'base64url').length, 32)
})

test('production factory uses the SDK with configured region, one attempt and default credential chain', async t => {
  let calls = 0
  t.mock.method(SESv2Client.prototype, 'send', async function (this: SESv2Client, command: SendEmailCommand, options: { abortSignal: AbortSignal }) {
    calls++
    assert.ok(command instanceof SendEmailCommand)
    assert.equal(await this.config.region(), config.region)
    assert.equal(await this.config.maxAttempts(), 1)
    assert.equal(this.config.ignoreConfiguredEndpointUrls, true)
    assert.equal(typeof this.config.credentials, 'function')
    assert.equal(options.abortSignal.aborted, false)
    return { MessageId: 'mock-accepted' }
  } as any)
  // The SDK send method is replaced above; no credential provider or network is invoked.
  await createSesRegistrationDelivery(config).sendVerification(message())
  assert.equal(calls, 1)
})

test('SDK serializes tracking overrides and code using a strictly in-memory HTTP handler', async () => {
  let wire: any
  const client = new SESv2Client({ region: config.region, maxAttempts: 1,
    credentials: { accessKeyId: 'test-only', secretAccessKey: 'test-only' },
    requestHandler: { async handle(request: { body: string | Uint8Array }) {
      wire = JSON.parse(typeof request.body === 'string' ? request.body : new TextDecoder().decode(request.body))
      return { response: { statusCode: 200, headers: {}, body: Readable.from(['{"MessageId":"mock"}']) } }
    } } as any,
  })
  const input = message()
  try {
    await createSesRegistrationDelivery(config, { send: (command, options) => client.send(command, options) }).sendVerification(input)
    assert.deepEqual(wire.Destination, { ToAddresses: [input.email] })
    assert.deepEqual(wire.ConfigurationOverrides, { Tracking: { OpenTrackingEnabled: 'DISABLED', ClickTrackingEnabled: 'DISABLED' } })
    assert.ok(wire.Content.Simple.Body.Text.Data.includes(input.token))
    assert.equal(wire.Content.Simple.Body.Html, undefined)
  } finally { client.destroy() }
})

test('rejects absent or unsafe server config without invoking transport', () => {
  let calls = 0
  const transport = { async send() { calls++; return { MessageId: 'ok' } } }
  for (const bad of [undefined, null, {}, { ...config, region: '' }, { ...config, region: 'https://example.org' },
    { ...config, region: 'us-east-1\n' }, { ...config, fromEmailAddress: '' }, { ...config, fromEmailAddress: 'sender@example.org\r\nBcc: victim@example.org' },
    { ...config, fromEmailAddress: 'Sender <sender@example.org>' }, { ...config, timeoutMs: 99 }, { ...config, timeoutMs: 15001 },
    { ...config, timeoutMs: NaN }, { ...config, timeoutMs: 1.5 }] as any[]) {
    assert.throws(() => createSesRegistrationDelivery(bad, transport), generic)
  }
  assert.equal(calls, 0)
})

test('rejects malformed addresses, noncanonical tokens and invalid lifetimes before any send', async () => {
  let calls = 0
  const delivery = createSesRegistrationDelivery(config, { async send() { calls++; return { MessageId: 'ok' } } })
  const base = message()
  const invalidEmails = ['', 'a@example.com,b@example.com', 'a@example.com\r\nBcc: b@example.com', 'x@y', 'x@-example.com',
    'a..b@example.com', '.a@example.com', 'a.@example.com', `${'x'.repeat(65)}@example.com`, 'é@example.com', 'a@example..com', 'a@example.com ', 'person@example.com\u007f']
  const invalidTokens = ['', 'a'.repeat(42), 'a'.repeat(44), 'a'.repeat(42) + 'B', `${base.token}\n`, '<script>']
  const cases = [...invalidEmails.map(email => ({ ...base, email })), ...invalidTokens.map(token => ({ ...base, token })),
    ...[0, -1, 86401, 1.5, NaN, Infinity].map(expiresInSeconds => ({ ...base, expiresInSeconds })), null]
  for (const bad of cases) await assert.rejects(delivery.sendVerification(bad as any), generic)
  assert.equal(calls, 0)
})

test('redacts provider, input and timeout errors without logging or leaking causes', async () => {
  const input = message()
  const logs: unknown[][] = []
  const oldLog = console.log, oldWarn = console.warn, oldError = console.error
  console.log = (...args) => { logs.push(args) }; console.warn = (...args) => { logs.push(args) }; console.error = (...args) => { logs.push(args) }
  try {
    const delivery = createSesRegistrationDelivery(config, { async send() { throw new Error(`AWS rejected ${input.email} ${input.token} secret-key`) } })
    await assert.rejects(delivery.sendVerification(input), generic)
    const noId = createSesRegistrationDelivery(config, { async send() { return {} } })
    await assert.rejects(noId.sendVerification(input), generic)
    const badId = createSesRegistrationDelivery(config, { async send() { return { MessageId: ' ' } } })
    await assert.rejects(badId.sendVerification(input), generic)
    assert.deepEqual(logs, [])
  } finally { console.log = oldLog; console.warn = oldWarn; console.error = oldError }
})

test('aborts and rejects by deadline even if transport ignores signal and later succeeds', async () => {
  let signal: AbortSignal | undefined
  let finish!: (value: { MessageId: string }) => void
  let calls = 0
  const delivery = createSesRegistrationDelivery({ ...config, timeoutMs: 100 }, { send(_command, options) {
    calls++; signal = options.abortSignal
    return new Promise(resolve => { finish = resolve })
  } })
  const start = Date.now()
  await assert.rejects(delivery.sendVerification(message()), generic)
  assert.ok(Date.now() - start < 1500)
  assert.equal(signal?.aborted, true)
  assert.equal(calls, 1)
  finish({ MessageId: 'late' })
  await new Promise(resolve => setImmediate(resolve))
})

test('forwards abort to a compliant transport and redacts its abort failure', async () => {
  let wasAborted = false
  const delivery = createSesRegistrationDelivery({ ...config, timeoutMs: 100 }, { send(_command, { abortSignal }) {
    return new Promise((_resolve, reject) => abortSignal.addEventListener('abort', () => { wasAborted = true; reject(new Error('sensitive provider data')) }, { once: true }))
  } })
  await assert.rejects(delivery.sendVerification(message()), generic)
  assert.equal(wasAborted, true)
})
