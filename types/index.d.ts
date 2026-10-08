// What the keepalive keeps across a hot reload of its code.
export type KeepaliveTiming = {
  lastSend: number // when the main thread's last request started, ms; 0 before the first
  bumpedFor: number // the lastSend the latest bump answered
  bumps: number // bumps since the person's last prompt
  coldBumps: number // bumps in a row that found the cache cold
  model: string // the model the last main request named
  account: string // the account email the last main request went under; '' when unknown
  isStopped: boolean // COLD_LIMIT bumps in a row found the cache cold, or the account changed; wait for the person
  isOff: boolean // the person ran /keepalive off; no bumps until /keepalive on
}

declare module 'claude-code' {
  interface PluginState {
    'cache-keepalive': { timing: KeepaliveTiming }
  }
}
