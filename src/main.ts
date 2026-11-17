import Sentry from '@sentry/node'
import express from 'express'
import fs from 'node:fs'
import { OpenAI } from 'openai'
import { Server as WSServer } from 'ws'

import { getEnvironment } from './environment'
import { loadMcpConfig } from './llm/function/mcp-config'
import { RemoteMCPServer } from './llm/function/mcp-remote'
import { RemoteFunctionServer } from './llm/function/remote'
import { FunctionServer } from './llm/function/types'
import { HandlebarsPromptGenerator } from './llm/prompt-generator/handlebars'
import { RemoteStateServer } from './llm/state/remote'
import { SystemStateServer } from './llm/state/system'
import { StateServer } from './llm/state/types'
import { LLMMessage } from './llm/types'
import { getLogger } from './logger'
import { NlpServiceClient } from './nlp/client'
import { Processor } from './processor'
import { DeviceHistory } from './session-storage/device-history'
import { InMemorySessionStorage } from './session-storage/in-memory'

const logger = getLogger()
const environment = getEnvironment()

Sentry.init({
  defaultIntegrations: false,
  dsn: environment.SENTRY_DSN,
  tracesSampleRate: 1
})

const app = express()

const openAI = new OpenAI({
  apiKey: environment.OPENAI_API_KEY,
  baseURL: environment.OPENAI_BASE_URL,
})

const stateServers: StateServer[] = [
  new SystemStateServer()
]
for (const url of environment.PROCESSOR_STATE_SERVER_URLS) {
  stateServers.push(new RemoteStateServer(url))
}

const functionServers: FunctionServer[] = [
]
for (const url of environment.PROCESSOR_FUNCTION_SERVER_URLS) {
  functionServers.push(new RemoteFunctionServer(url))
}

for (const url of environment.PROCESSOR_MCP_SERVER_URLS) {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  functionServers.push(new RemoteMCPServer(url.split('#')[0]!, url.split('#')[1]!))
}
const mcpServers = new Map<string, RemoteMCPServer>()
for (const config of loadMcpConfig(environment.PROCESSOR_MCP_CONFIG_PATH)) {
  const server = new RemoteMCPServer(config)
  mcpServers.set(config.name, server)
  functionServers.push(server)
}

(async () => {
  for (const server of stateServers) {
    try {
      await server.initialize()
      logger.info(`State server ${server.getName()} initialized successfully`)
    } catch (error) {
      logger.error(`Failed to init ${server.getName()} server: `, error)
    }
  }
  for (const server of functionServers) {
    try {
      await server.initialize()
      logger.info(`Function server ${server.getName()} initialized successfully`)
    } catch (error) {
      logger.error(`Failed to init ${server.getName()} server: `, error)
    }
  }
// eslint-disable-next-line unicorn/prefer-top-level-await
})().catch(error => logger.error(error))

const promptGenerator = new HandlebarsPromptGenerator(
  fs.readFileSync(environment.PROMPT_TEMPLATE_PATH).toString('utf8'),
  fs.readFileSync(environment.STATE_PROMPT_TEMPLATE_PATH).toString('utf8'),
  fs.readFileSync(environment.FUNCTIONS_PROMPT_TEMPLATE_PATH).toString('utf8')
)

const sessionStorage = new InMemorySessionStorage<LLMMessage[]>()
const deviceHistory = new DeviceHistory(environment.HISTORY_TTL_SECONDS * 1000, environment.HISTORY_MAX_MESSAGES)
const nlpService = new NlpServiceClient(environment.NLP_SERVICE_URL, environment.NLP_SERVICE_TIMEOUT_MS)

const processor = new Processor({
  cacheSize: environment.CACHE_SIZE,
  deviceHistory,
  errorResponseText: environment.ERROR_RESPONSE_TEXT,
  functionServers,
  model: environment.OPENAI_MODEL,
  nlpService,
  openAI,
  promptGenerator,
  reasoningEffort: environment.OPENAI_REASONING_EFFORT,
  sessionStorage,
  stateFunctionsMessagesType: environment.STATE_FUNCTIONS_MESSAGES_TYPE,
  stateServers
})

app.use(express.json())

// Внутренняя ручка для quasar-server (режим gpt-realtime): короткий access-токен MCP-сервера.
// Refresh-токен ротируется, поэтому владелец один — processor. Порт наружу не публикуется.
app.get('/internal/mcp-token/:name', async (request, response) => {
  const server = mcpServers.get(request.params.name)
  if (!server) {
    response.status(404).json({ error: 'unknown MCP server' })
    return
  }
  try {
    // ?min_valid=150 — токен проживёт ещё минимум 150 с (его держит долгая сессия gpt-realtime)
    const minValid = Number(request.query['min_valid'] ?? 30) * 1000
    response.json({ access_token: await server.accessToken(minValid), url: server.url })
  } catch (error) {
    response.status(502).json({ error: String(error) })
  }
})

const server = app.listen(environment.PORT, error => {
  if (error) {
    logger.fatal(`Failed to start on :${environment.PORT}: `, error)
    return
  }
  logger.info(`Started on :${environment.PORT}`)
})

const wsServer = new WSServer({ noServer: true })

server.on('upgrade', (request, socket, head) => {
  if (request.url === '/process') {
    wsServer.handleUpgrade(request, socket, head, client => {
      wsServer.emit('connection', client, request)
    })
  }
})

wsServer.on('connection', (websocket, request) => {
  logger.debug('Got WebSocket connection')

  processor.openSession(websocket, {
    baggage: request.headers['baggage'] ? String(request.headers['baggage']) : undefined,
    sentryTrace: request.headers['sentry-trace'] ? String(request.headers['sentry-trace']) : undefined
  })
})
