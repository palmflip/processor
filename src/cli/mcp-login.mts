/**
 * Вход в MCP-сервер с OAuth. Сохраняет offline refresh-токен в файл, его читает OAuthTokenProvider.
 *
 * Два способа:
 *  - CIMD + вход в браузере (Authorization Code + PKCE) — как у Claude и Codex. client_id — URL
 *    документа метаданных клиента (Client ID Metadata Document). Нужен, если сервер выдаёт токен
 *    с audience ресурса только MCP-клиентам:
 *      pnpm tsx src/cli/mcp-login.mts --mcp https://mcp.bannie.app/mcp \
 *        --cimd https://raw.githubusercontent.com/<user>/processor/bannie/cimd/speaker.json \
 *        --scope "bannie:read" --out secrets/bannie.rt
 *  - Вход по коду (Device Authorization Grant, RFC 8628) — для клиента без браузера:
 *      pnpm tsx src/cli/mcp-login.mts --mcp <URL> --client connected-app --out <file>
 *
 * Авторизационный сервер находится по метаданным ресурса (RFC 9728).
 */
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    cimd: { type: 'string' },
    client: { default: 'connected-app', type: 'string' },
    mcp: { type: 'string' },
    out: { type: 'string' },
    port: { default: '8976', type: 'string' },
    scope: { default: 'bannie:read', type: 'string' }
  }
})

if (!values.mcp || !values.out) {
  console.error('usage: mcp-login --mcp <MCP URL> --out <file> [--cimd <metadata URL> | --client <id>] [--scope "..."]')
  process.exit(2)
}

interface TokenResponse { error?: string, error_description?: string, refresh_token?: string, scope?: string }

async function json<T> (url: string, init?: RequestInit): Promise<{ body: T, status: number }> {
  const response = await fetch(url, init)
  return { body: await response.json() as T, status: response.status }
}

function form (data: Record<string, string>): RequestInit {
  return {
    body: new URLSearchParams(data),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    method: 'POST'
  }
}

function save (token: TokenResponse, tokenEndpoint: string, clientId: string): never {
  if (token.error || !token.refresh_token) {
    console.error('Login failed:', token.error ?? 'no refresh token', token.error_description ?? '')
    process.exit(1)
  }
  fs.writeFileSync(values.out!, token.refresh_token, { mode: 0o600 })
  console.log(`\nГотово: права «${token.scope}», refresh-токен в ${values.out}`)
  console.log(`Для конфига MCP: tokenEndpoint=${tokenEndpoint} clientId=${clientId}`)
  process.exit(0)
}

const mcpUrl = new URL(values.mcp)
const { body: resourceMeta } = await json<{ authorization_servers: string[], resource: string }>(
  `${mcpUrl.origin}/.well-known/oauth-protected-resource${mcpUrl.pathname}`)
const issuer = resourceMeta.authorization_servers[0]
const { body: oidc } = await json<{
  authorization_endpoint: string, device_authorization_endpoint: string, token_endpoint: string
}>(`${issuer}/.well-known/openid-configuration`)
const scope = `openid offline_access ${values.scope}`

if (values.cimd) {
  // Authorization Code + PKCE, client_id = URL документа метаданных
  const clientId = values.cimd
  const redirectUri = `http://127.0.0.1:${values.port}/callback`
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomBytes(16).toString('base64url')
  const authorize = new URL(oidc.authorization_endpoint)
  for (const [key, value] of Object.entries({
    client_id: clientId, code_challenge: challenge, code_challenge_method: 'S256', redirect_uri: redirectUri,
    resource: resourceMeta.resource, response_type: 'code', scope, state
  })) {
    authorize.searchParams.set(key, value)
  }

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', redirectUri)
      if (url.pathname !== '/callback') {
        response.writeHead(404).end()
        return
      }
      const error = url.searchParams.get('error')
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(error ? `Ошибка входа: ${error}` : 'Вход выполнен, окно можно закрыть.')
      server.close()
      if (error) {
        reject(new Error(`${error}: ${url.searchParams.get('error_description') ?? ''}`))
      } else if (url.searchParams.get('state') === state) {
        resolve(url.searchParams.get('code') ?? '')
      } else {
        reject(new Error('state mismatch'))
      }
    })
    server.listen(Number(values.port), '127.0.0.1', () => {
      console.log(`\nОткройте в браузере:\n${authorize.toString()}\n`)
    })
  })

  const { body: token } = await json<TokenResponse>(oidc.token_endpoint, form({
    client_id: clientId, code, code_verifier: verifier, grant_type: 'authorization_code',
    redirect_uri: redirectUri, resource: resourceMeta.resource
  }))
  save(token, oidc.token_endpoint, clientId)
}

// Вход по коду (RFC 8628)
const { body: device, status } = await json<{
  device_code: string, error?: string, error_description?: string, expires_in: number, interval?: number,
  user_code: string, verification_uri: string, verification_uri_complete?: string
}>(oidc.device_authorization_endpoint, form({ client_id: values.client, resource: resourceMeta.resource, scope }))
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
  const { body: token } = await json<TokenResponse>(oidc.token_endpoint, form({
    client_id: values.client, device_code: device.device_code,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code', resource: resourceMeta.resource
  }))
  if (token.error === 'authorization_pending') {
    continue
  }
  if (token.error === 'slow_down') {
    interval += 5000
    continue
  }
  save(token, oidc.token_endpoint, values.client)
}
console.error('Код истёк, запустите ещё раз')
process.exit(1)
