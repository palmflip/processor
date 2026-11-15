import fs from 'node:fs'
import { z } from 'zod'

/**
 * Файл PROCESSOR_MCP_CONFIG_PATH: список MCP-серверов с заголовками, OAuth и фильтром инструментов.
 *
 * [{
 *   "name": "bannie",
 *   "url": "https://mcp.bannie.app/mcp",
 *   "oauth": { "tokenEndpoint": "...", "clientId": "connected-app", "refreshTokenFile": "/secrets/bannie.rt",
 *              "resource": "https://mcp.bannie.app/mcp" },
 *   "allowTools": ["get_schedule", "find_free_time"],
 *   "headers": { "X-Something": "value" }
 * }]
 */
const mcpServerConfig = z.object({
  /** Только эти инструменты (по имени MCP, без префикса); пусто — все */
  allowTools: z.array(z.string()).default([]),
  /** Эти инструменты скрыть */
  denyTools: z.array(z.string()).default([]),
  headers: z.record(z.string(), z.string()).default({}),
  name: z.string().regex(/^\w+$/),
  oauth: z.object({
    clientId: z.string(),
    refreshTokenFile: z.string(),
    resource: z.string().optional(),
    tokenEndpoint: z.url()
  }).optional(),
  url: z.url()
})

export type McpServerConfig = z.infer<typeof mcpServerConfig>

export function loadMcpConfig (path: string): McpServerConfig[] {
  if (!path) {
    return []
  }
  return z.array(mcpServerConfig).parse(JSON.parse(fs.readFileSync(path, 'utf8')))
}
