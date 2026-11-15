import { Client } from '@modelcontextprotocol/sdk/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp'
import { Span, startSpan } from '@sentry/node'
import z from 'zod'
import { JSONSchema } from 'zod/v4/core'

import { OAuthTokenProvider } from '../../auth/oauth-token-provider'
import { getLogger } from '../../logger'
import { McpServerConfig } from './mcp-config'
import { Functions, FunctionServer } from './types'

/** Ответ инструмента для модели: весь текст, а если текста нет — structuredContent */
function resultText (response: Awaited<ReturnType<Client['callTool']>>): string {
  const content = (response.content ?? []) as { text?: string, type: string }[]
  const texts = content.filter(item => item.type === 'text' && item.text).map(item => item.text)
  let result = texts.join('\n')
  if (!result && response.structuredContent) {
    result = JSON.stringify(response.structuredContent)
  }
  if (!result) {
    result = 'N/A'
  }
  return response.isError ? `ERROR: ${result}` : result
}

export class RemoteMCPServer implements FunctionServer {
  private readonly logger = getLogger<RemoteMCPServer>()
  private mcp: Client | null = null
  private connecting: Promise<Client> | null = null
  private readonly tokens: OAuthTokenProvider | null
  private readonly config: McpServerConfig

  /** Старый способ: PROCESSOR_MCP_SERVER_URLS=URL#name. Новый: объект из PROCESSOR_MCP_CONFIG_PATH */
  constructor (urlOrConfig: string | McpServerConfig, name?: string) {
    this.config = typeof urlOrConfig === 'string'
      ? { allowTools: [], denyTools: [], headers: {}, name: name ?? 'mcp', url: urlOrConfig }
      : urlOrConfig
    this.tokens = this.config.oauth ? new OAuthTokenProvider(this.config.oauth) : null
  }

  private get name (): string {
    return this.config.name
  }

  async callFunction (_sessionId: string, _metadata: object,
    functionName: string, arguments_: unknown, parentSpan: Span): Promise<string> {
    return startSpan({
      attributes: {
        arguments: JSON.stringify(arguments_, undefined, 2)
      },
      name: `Calling MCP function ${functionName} on ${this.getName()}`,
      op: 'call-mcp-function',
      parentSpan
    }, async span => {
      const tool = functionName.slice(this.name.length + 1)
      if (!this.allowed(tool)) {
        return `ERROR: tool ${tool} is not allowed`
      }
      this.logger.info(`Calling ${functionName}`)
      const response = await this.withClient(client => client.callTool({
        arguments: (arguments_ ?? {}) as { [k: string]: unknown },
        name: tool
      }))
      const result = resultText(response)
      span.setAttribute('result', result)
      return result
    })
  }

  async getFunctions (): Promise<Functions> {
    return {}
  }

  async getIndependentFunctions (parentSpan: Span): Promise<Functions> {
    return startSpan({
      name: `Requesting MCP functions from ${this.getName()}`,
      op: 'get-mcp-functions-server',
      parentSpan
    }, async () => {
      const tools = await this.withClient(client => client.listTools())
      const functions: Functions = {}
      for (const tool of tools.tools) {
        if (!this.allowed(tool.name)) {
          continue
        }
        functions[`${this.name}_${tool.name}`] = {
          argumentsSchema: z.fromJSONSchema(tool.inputSchema as JSONSchema._JSONSchema),
          description: tool.description ?? '???',
          hasResponse: true
        }
      }
      return functions
    })
  }

  getName (): string {
    return `mcp{${this.name}#${this.config.url}}`
  }

  async initialize (): Promise<void> {
    await this.connect()
  }

  private allowed (tool: string): boolean {
    const { allowTools, denyTools } = this.config
    if (denyTools.includes(tool)) {
      return false
    }
    return allowTools.length === 0 || allowTools.includes(tool)
  }

  private async connect (): Promise<Client> {
    this.connecting ??= (async () => {
      const client = new Client({ name: '@v3rt3p/processor', version: '1.0.0' })
      const transport = new StreamableHTTPClientTransport(new URL(this.config.url), {
        // Токен подставляем в каждый запрос: access-токен живёт минуты, соединение — дольше
        fetch: async (input, init) => {
          const headers = new Headers(init?.headers)
          for (const [key, value] of Object.entries(this.config.headers)) {
            headers.set(key, value)
          }
          if (this.tokens) {
            headers.set('Authorization', `Bearer ${await this.tokens.getAccessToken()}`)
          }
          const response = await fetch(input, { ...init, headers })
          if (response.status === 401) {
            this.tokens?.invalidate()
          }
          return response
        }
      })
      await client.connect(transport)
      this.mcp = client
      this.logger.info(`Connected to ${this.getName()}`)
      return client
    })().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  /** Вызов с одной попыткой переподключения: сервер мог перезапуститься или сбросить сессию */
  private async withClient<T> (action: (client: Client) => Promise<T>): Promise<T> {
    const client = this.mcp ?? await this.connect()
    try {
      return await action(client)
    } catch (error) {
      this.logger.warn(`MCP ${this.getName()} failed, reconnecting: ${error}`)
      this.mcp = null
      await client.close().catch(() => {})
      return action(await this.connect())
    }
  }
}
