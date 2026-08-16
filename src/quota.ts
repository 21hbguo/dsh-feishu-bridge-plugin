/**
 * 连接配额熔断器（QuotaGovernor，纯模块，不依赖 index.ts）。
 *
 * 借鉴自 amlyczz/dsh-lark-link (MIT) src/common/quota-governor.ts：
 * 限制单位时间窗口内的连接失败次数，防止病态重连循环烧光飞书连接配额
 * （错误码 1000040350）。化用点：lark-link 的 connection-supervisor 是
 * probe+重连完整状态机，本机已有 30s 重试逻辑（src/index.ts connectChannel /
 * scheduleConnectRetry），本模块只取**熔断器本体**：窗口计数 + 跨重启落盘 +
 * 状态查询，接线时机由 index.ts 轮次决定。
 *
 * 落盘：conn-history.jsonl（每行 {at, ok}），文件权限 0600，最多保留 500 条，
 * 重启后重新加载——熔断状态跨进程/插件重载生效。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 熔断器可调参数（全部有默认值）。 */
export interface QuotaGovernorOptions {
	/** 滑动窗口长度（分钟），默认 60。 */
	windowMinutes?: number
	/** 窗口内失败次数达到该值即熔断，默认 12。 */
	limit?: number
	/** 落盘保留的最大记录条数，默认 500。 */
	maxRecords?: number
	/** 时钟注入（测试用），默认 Date.now。 */
	now?: () => number
}

/** 熔断器对外 API。 */
export interface QuotaGovernor {
	/**
	 * 记录一次连接尝试的结果；返回当前窗口内的失败次数。
	 * @param ok true=连接成功（顺带推进窗口裁剪），false=连接失败（驱动熔断）。
	 */
	recordConnect(ok: boolean): number
	/** 当前窗口内失败次数是否达到阈值——达到时桥必须停止重连尝试。 */
	tripped(): boolean
	/** 当前窗口剩余可用失败额度（0 = 已熔断）。 */
	remaining(): number
	/** 熔断解除时刻（epoch ms）；未熔断时 undefined。 */
	resetAt(): number | undefined
	/** 窗口内最近一次尝试的时间（epoch ms）；无记录时 undefined（状态展示用）。 */
	lastAttemptAt(): number | undefined
	/** 清空历史（例如用户显式 /restart 时人工解除熔断）。 */
	reset(): void
}

interface ConnRecord {
	at: number
	ok: boolean
}

const DEFAULT_OPTS: Required<Pick<QuotaGovernorOptions, 'windowMinutes' | 'limit' | 'maxRecords'>> = {
	windowMinutes: 60,
	limit: 12,
	maxRecords: 500,
}

/** 从 JSONL 文件加载历史（逐行容错：坏行跳过）。 */
function loadHistory(historyFile: string): ConnRecord[] {
	try {
		const raw = readFileSync(historyFile, 'utf8')
		const records: ConnRecord[] = []
		for (const line of raw.split('\n')) {
			if (line === '') continue
			try {
				const record = JSON.parse(line) as ConnRecord
				if (typeof record?.at === 'number' && typeof record?.ok === 'boolean') {
					records.push(record)
				}
			} catch {
				// 坏行跳过（部分写入/旧格式兼容）
			}
		}
		return records
	} catch {
		return []
	}
}

/**
 * 创建熔断器。historyFile 为 conn-history.jsonl 的绝对路径（接线轮决定，
 * 建议 ~/.dsh/dsh-feishu-bridge/conn-history.jsonl，与 state/credentials 同目录）。
 * 所有 IO 均为 best-effort：落盘失败不影响内存态计数。
 */
export function createQuotaGovernor(historyFile: string, options?: QuotaGovernorOptions): QuotaGovernor {
	const now = options?.now ?? Date.now
	const windowMs = (options?.windowMinutes ?? DEFAULT_OPTS.windowMinutes) * 60_000
	const limit = options?.limit ?? DEFAULT_OPTS.limit
	const maxRecords = options?.maxRecords ?? DEFAULT_OPTS.maxRecords

	let history = loadHistory(historyFile)

	/** 追加一条记录并落盘（保留最近 maxRecords 条）。 */
	const record = (ok: boolean): void => {
		prune()
		history.push({ at: now(), ok })
		persist()
	}

	/** 落盘：JSONL + 0600；目录不存在时尝试创建；失败静默（best-effort）。 */
	const persist = (): void => {
		try {
			const dir = join(historyFile, '..')
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
			const tail = history.slice(-maxRecords)
			writeFileSync(historyFile, tail.map((r) => JSON.stringify(r)).join('\n') + '\n', {
				mode: 0o600,
			})
			// writeFileSync 的 mode 只在创建时生效：对已存在的旧文件强制收紧权限，
			// 保证 0600 落盘在跨版本升级/残留文件场景下也成立。
			try {
				chmodSync(historyFile, 0o600)
			} catch {
				// 平台不支持 chmod 时忽略（Windows 等）
			}
		} catch {
			// best-effort：内存态计数不受落盘失败影响
		}
	}

	/** 裁剪窗口外的过期记录（跨重启后旧记录同样按 at 裁剪）。 */
	const prune = (): void => {
		const cutoff = now() - windowMs
		history = history.filter((r) => r.at >= cutoff)
	}

	/** 当前窗口内失败次数。 */
	const failuresInWindow = (): number => {
		prune()
		return history.filter((r) => !r.ok).length
	}

	return {
		recordConnect(ok) {
			record(ok)
			return failuresInWindow()
		},
		tripped() {
			return failuresInWindow() >= limit
		},
		remaining() {
			return Math.max(0, limit - failuresInWindow())
		},
		resetAt() {
			prune()
			const oldestFailure = history.find((r) => !r.ok)
			return oldestFailure !== undefined ? oldestFailure.at + windowMs : undefined
		},
		lastAttemptAt() {
			prune()
			const last = history[history.length - 1]
			return last !== undefined ? last.at : undefined
		},
		reset() {
			history = []
			persist()
		},
	}
}
