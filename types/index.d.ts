export type Risk = 1 | 2 | 3 | 4 | 5
export type Spot = { title: string; ask: string }
export type Assumption = { text: string; ask: string; risk: Risk; ifWrong?: string }
export type Status = 'idle' | 'thinking' | 'failed'
export type Depth = 'focused' | 'thorough'

declare module 'claude-code' {
  interface PluginState {
    'blind-spots': {
      spots: Spot[]
      assumptions: Assumption[]
      status: Status
      isAuto: boolean
      picked: string[]
      sent: string[]
      notice: string
      settled: string[]
      fresh: string[]
      hasRun: boolean
      depth: Depth
      frame: number
      modelName: string
    }
  }
}
