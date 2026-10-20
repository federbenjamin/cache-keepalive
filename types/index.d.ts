// What the keepalive keeps across a hot reload of its code.
export type KeepaliveTiming = {
  lastSend: number // when the main thread's last answered request started, ms; 0 before the first
  bumpedFor: number // the lastSend the latest bump answered
  firstSend: number // when the conversation's first answered request started (a fresh one, or the first after a compaction); 0 before it
  bumps: number // bumps since the person's last prompt
  coldBumps: number // bumps in a row that found the cache cold
  model: string // the model the last answered main request named
  account: string // the account email the last answered main request went under; '' when logged out or not yet read; a read that fails or names no account keeps the one before
  isStopped: boolean // COLD_LIMIT bumps in a row found the cache cold, or the account changed; wait for the person
  isOff: boolean // the person ran /keepalive off; no bumps until /keepalive on
}

declare module 'claude-code' {
  interface PluginState {
    'cache-keepalive': { timing: KeepaliveTiming }
  }
}
