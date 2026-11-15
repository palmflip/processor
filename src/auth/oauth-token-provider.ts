import fs from 'node:fs'

import { getLogger } from '../logger'

/** Настройки OAuth для MCP-сервера: offline refresh-токен, полученный входом по коду (src/cli/mcp-login.mts) */
export interface OAuthSettings {
  /** Клиент OAuth, которым получен refresh-токен */
  clientId: string
  /** Адрес MCP-ресурса (RFC 8707): сервер принимает только токен с этой audience */
  resource?: string
  /** Файл с refresh-токеном. Сервер может выдать новый — тогда файл перезаписывается */
  refreshTokenFile: string
  /** Token endpoint авторизационного сервера */
  tokenEndpoint: string
}

interface TokenResponse {
  access_token: string
  expires_in?: number
  refresh_token?: string
}

/** Короткий access-токен по refresh-токену: держит его в памяти и обновляет за 30 с до истечения */
export class OAuthTokenProvider {
  private readonly logger = getLogger<OAuthTokenProvider>()
  private accessToken: string | null = null
  private expiresAt = 0
  private pending: Promise<string> | null = null

  constructor (private readonly settings: OAuthSettings) {}

  async getAccessToken (): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt - 30_000) {
      return this.accessToken
    }
    this.pending ??= this.refresh().finally(() => {
      this.pending = null
    })
    return this.pending
  }

  /** Сбросить токен, например после 401 */
  invalidate (): void {
    this.accessToken = null
    this.expiresAt = 0
  }

  private async refresh (): Promise<string> {
    const refreshToken = fs.readFileSync(this.settings.refreshTokenFile, 'utf8').trim()
    if (!refreshToken) {
      throw new Error(`Empty refresh token in ${this.settings.refreshTokenFile}: run mcp-login first`)
    }
    const body = new URLSearchParams({
      client_id: this.settings.clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    })
    if (this.settings.resource) {
      body.set('resource', this.settings.resource)
    }
    const response = await fetch(this.settings.tokenEndpoint, {
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      method: 'POST'
    })
    if (!response.ok) {
      throw new Error(`Token refresh failed: HTTP ${response.status} ${await response.text()}`)
    }
    const token = await response.json() as TokenResponse
    this.accessToken = token.access_token
    this.expiresAt = Date.now() + (token.expires_in ?? 300) * 1000
    if (token.refresh_token && token.refresh_token !== refreshToken) {
      fs.writeFileSync(this.settings.refreshTokenFile, token.refresh_token, { mode: 0o600 })
    }
    this.logger.info(`Access token refreshed, valid for ${token.expires_in ?? '?'} s`)
    return token.access_token
  }
}
