/**
 * Вход по коду (OAuth 2.0 Device Authorization Grant, RFC 8628) для MCP-сервера с OAuth.
 * Сохраняет offline refresh-токен в файл, его читает OAuthTokenProvider.
 *
 *   pnpm tsx src/cli/mcp-login.mts --mcp https://mcp.bannie.app/mcp --client connected-app \
 *     --scope "bannie:read bannie:write" --out secrets/bannie.rt
 *
 * Авторизационный сервер находится по метаданным ресурса (RFC 9728).
 */
import fs from 'node:fs'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    client: { default: 'connected-app', type: 'string' },
    mcp: { type: 'string' },
    out: { type: 'string' },
    scope: { default: 'bannie:read', type: 'string' }
  }
})

if (!values.mcp || !values.out) {
  console.error('usage: mcp-login --mcp <MCP URL> --out <file> [--client connected-app] [--scope "bannie:read"]')
  process.exit(2)
}

async function json<T> (url: string, init?: RequestInit): Promise<{ body: T, status: number }> {
  const response = await fetch(url, init)
  return { body: await response.json() as T, status: response.status }
}

const mcpUrl = new URL(values.mcp)
const { body: resourceMeta } = await json<{ authorization_servers: string[], resource: string }>(
  `${mcpUrl.origin}/.well-known/oauth-protected-resource${mcpUrl.pathname}`)
const issuer = resourceMeta.authorization_servers[0]
const { body: oidc } = await json<{ device_authorization_endpoint: string, token_endpoint: string }>(
  `${issuer}/.well-known/openid-configuration`)

const scope = `openid offline_access ${values.scope}`
const { body: device, status } = await json<{
  device_code: string, error?: string, error_description?: string, expires_in: number, interval?: number,
  user_code: string, verification_uri: string, verification_uri_complete?: string
}>(oidc.device_authorization_endpoint, {
  body: new URLSearchParams({ client_id: values.client, resource: resourceMeta.resource, scope }),
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  method: 'POST'
})
if (status !== 200) {
  console.error('Device authorization failed:', device.error, device.error_description)
  process.exit(1)
}

console.log(`\nОткройте ${device.verification_uri_complete ?? device.verification_uri}`)
console.log(`и введите код: ${device.user_code}\n`)

let interval = (device.interval ?? 5) * 1000
const deadline = Date.now() + device.expires_in * 1000
while (Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, interval))
  const { body: token } = await json<{ error?: string, refresh_token?: string, scope?: string }>(oidc.token_endpoint, {
    body: new URLSearchParams({
      client_id: values.client,
      device_code: device.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      resource: resourceMeta.resource
    }),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    method: 'POST'
  })
  if (token.error === 'authorization_pending') {
    continue
  }
  if (token.error === 'slow_down') {
    interval += 5000
    continue
  }
  if (token.error || !token.refresh_token) {
    console.error('Login failed:', token.error ?? 'no refresh token')
    process.exit(1)
  }
  fs.writeFileSync(values.out, token.refresh_token, { mode: 0o600 })
  console.log(`Готово: права «${token.scope}», refresh-токен в ${values.out}`)
  console.log(`token endpoint для конфига: ${oidc.token_endpoint}`)
  process.exit(0)
}
console.error('Код истёк, запустите ещё раз')
process.exit(1)
