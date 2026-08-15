/**
 * Feishu channel factory (bridge.mjs M4): WebSocket long connection with the
 * dedup / chat-queue / stale-window safety settings and the streaming-card
 * throttle knobs, wired from the plugin Config.
 */
import { createLarkChannel, LoggerLevel, type LarkChannel, type LarkChannelOptions } from '@larksuiteoapi/node-sdk'

/** Credential and streaming-card settings the channel is built from. */
export interface LarkChannelSettings {
  appId: string
  appSecret: string
  streamThrottleMs: number
  streamThrottleChars: number
}

/** Build the channel exactly as bridge.mjs did (transport websocket, source tag, safety/policy/outbound). */
export function buildChannel(settings: LarkChannelSettings): LarkChannel {
  const options: LarkChannelOptions = {
    appId: settings.appId,
    appSecret: settings.appSecret,
    transport: 'websocket',
    source: 'dsh-feishu-bridge',
    loggerLevel: LoggerLevel.warn,
    safety: {
      dedup: { ttl: 120_000, maxEntries: 2000 },
      chatQueue: { enabled: true },
      staleMessageWindowMs: 120_000,
    },
    policy: { dmMode: 'open', requireMention: false, respondToMentionAll: false },
    outbound: {
      streamInitialText: '🤔 思考中…',
      streamThrottleMs: settings.streamThrottleMs,
      streamThrottleChars: settings.streamThrottleChars,
    },
  }
  return createLarkChannel(options)
}
