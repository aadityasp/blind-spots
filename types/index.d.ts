export type SpotKind = 'question' | 'feature' | 'topic'
export type Spot = { kind: SpotKind; title: string; ask: string }
export type Assumption = { text: string; ask: string }
export type Status = 'idle' | 'thinking' | 'failed'

declare module 'claude-code' {
  interface PluginState {
    'blind-spots': {
      spots: Spot[]
      assumptions: Assumption[]
      status: Status
      isAuto: boolean
      picked: string[]
    }
  }
}
