import { LLMMessage } from '../llm/types'

interface Entry {
  savedAt: number
  turns: LLMMessage[]
}

/**
 * Память диалога между сессиями одной станции. Каждое «Алиса, …» — новая WebSocket-сессия,
 * и без этого уточнения вроде «а в воскресенье?» теряют контекст. Храним реплики пользователя,
 * ответы и результаты функций; системный промпт, состояние и список функций сессия строит заново.
 */
export class DeviceHistory {
  private readonly entries = new Map<string, Entry>()

  /** ttlMs = 0 — память выключена */
  constructor (private readonly ttlMs: number, private readonly maxMessages: number) {}

  get enabled (): boolean {
    return this.ttlMs > 0
  }

  load (deviceId: string): LLMMessage[] {
    const entry = this.entries.get(deviceId)
    if (!entry) {
      return []
    }
    if (Date.now() - entry.savedAt > this.ttlMs) {
      this.entries.delete(deviceId)
      return []
    }
    return [...entry.turns]
  }

  save (deviceId: string, turns: LLMMessage[]): void {
    if (!this.enabled) {
      return
    }
    this.entries.set(deviceId, { savedAt: Date.now(), turns: turns.slice(-this.maxMessages) })
  }

  clear (deviceId: string): void {
    this.entries.delete(deviceId)
  }
}
