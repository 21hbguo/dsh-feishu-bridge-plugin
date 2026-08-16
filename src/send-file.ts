/**
 * P2 出站文件工具：模型经工具把本地文件回传到当前飞书 chat（上传 im/v1/files
 * / im/v1/images + 发 file/image 消息，SDK channel.send 封装）。
 *
 * 借鉴自 amlyczz/dsh-lark-link (MIT) — src/index.ts 的 lark_send_local_file
 * （工具语义/工作区白名单/大小上限/光栅图按 image 发送其余按 file 发送）与
 * src/host/lark-client.ts uploadFile（file_type 映射）。
 *
 * 工具名与 lark-link 保持一致（lark_send_local_file，老板指示「以查到的
 * lark-link 命名为准」）；本机 feishu_setup 为配置类工具，命名风格不强制统一。
 *
 * 与 lark-link 的差异：① 参数只有 path（lark-link 额外要求 kind + caption；
 * 本机按扩展名自动分流 图片/文件，模型少传一个必填参数）；② 大小上限 20MB
 * （lark-link 25MB，本任务规格）；③ 新增扩展名白名单（图片/文档/压缩包常见
 * 格式，常量可配置）；④ 白名单目录 = chat 绑定工作区 + 插件数据目录
 * （lark-link 仅 workspaceRoot；拿不到工作区时按本任务规格退化为仅插件数据
 * 目录）；⑤ 会话反查走本机 chatIdForSession（chat→agent 映射反查，含 /resume
 * 的 web 会话覆盖项），不依赖 session id 前缀解析。
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { LarkChannel } from '@larksuiteoapi/node-sdk'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'

/** 单文件大小上限：20MB（本任务规格）。 */
export const MAX_FILE_BYTES = 20 * 1024 * 1024

/** 扩展名白名单（图片/文档/压缩包常见格式；常量可配置 —— 传入覆盖即换）。 */
export const ALLOWED_FILE_EXTENSIONS = [
  // 图片
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg',
  // 文档 / 文本
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'txt', 'md', 'json', 'csv', 'log', 'yaml', 'yml', 'xml',
  // 压缩包
  'zip', 'tar', 'gz', 'tgz', '7z', 'rar',
] as const

/** 光栅图片扩展名：仅这些走 im/v1/images（image 消息）；svg/bmp 等按 file 发送。 */
const RASTER_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])

/** One-line error text from any thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 出站文件工具的依赖（由 index.ts createRuntime 组装）。 */
export interface SendFileToolDeps {
  /** 宿主 tools 服务（可选）；未装配时返回 undefined（只告警不阻塞）。 */
  tools: { register(tool: ToolDefinition): () => void } | undefined
  channel: LarkChannel
  /** DSH session id → 飞书 chat id 反查（本机 chat→agent 映射的反向表）。 */
  chatIdForSession(sessionId: string): string | undefined
  /** chat 绑定工作区路径；undefined = 未绑定（此时白名单退化为仅数据目录）。 */
  workspacePathFor(chatId: string): string | undefined
  /** 插件数据目录（~/.dsh/dsh-feishu-bridge，与 state/outbox/wal 同根）。 */
  dataDir: string
  /** 扩展名白名单覆盖（缺省 ALLOWED_FILE_EXTENSIONS）。 */
  allowedExtensions?: readonly string[]
  log(...args: unknown[]): void
}

/**
 * 注册 lark_send_local_file 工具；返回注销函数。tools 服务未装配或注册失败
 * 返回 undefined（只告警，不阻塞桥本身 —— 与 feishu_setup 注册策略一致）。
 */
export function registerSendFileTool(deps: SendFileToolDeps): (() => void) | undefined {
  if (deps.tools?.register === undefined) {
    deps.log('lark_send_local_file tool registration skipped: tools service unavailable')
    return undefined
  }
  const allowedExtensions = deps.allowedExtensions ?? ALLOWED_FILE_EXTENSIONS
  try {
    return deps.tools.register(defineTool({
      name: 'lark_send_local_file',
      description: '发送本地文件到当前飞书会话（仅限当前工作区或插件数据目录内的文件，≤20MB，支持图片/文档/压缩包等常见格式）',
      parameters: {
        path: {
          type: 'string',
          required: true,
          description: '本地文件路径（绝对路径，或相对当前工作区的路径）',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value: string) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        // 1. 会话定位：工具调用上下文携带调用方 agent（exec.agent），其 id 即
        //    DSH session id；经 chat→agent 映射反查当前飞书 chat。
        const sessionId = exec.agent?.id
        const chatId = sessionId !== undefined ? deps.chatIdForSession(sessionId) : undefined
        if (chatId === undefined) {
          return '❌ 无法定位当前飞书会话（工具调用未关联到任何 bridge 会话）'
        }

        // 2. 路径解析：绝对路径直接用；相对路径基于 chat 绑定工作区解析。
        const workspacePath = deps.workspacePathFor(chatId)
        const raw = args.path.trim()
        if (raw === '') return '❌ 参数 path 不能为空'
        const abs = isAbsolute(raw)
          ? resolve(raw)
          : workspacePath !== undefined
            ? resolve(join(workspacePath, raw))
            : null
        if (abs === null) {
          return '❌ 相对路径需要工作区绑定（当前 chat 未绑定工作区），请改用绝对路径'
        }

        // 3. 白名单目录约束：仅允许 chat 工作区目录与插件数据目录内的文件
        //    （realpath 跟随符号链接，/tmp/../etc/passwd 一类穿越被折叠）。
        let realFile: string
        try {
          realFile = realpathSync(abs)
        } catch (error) {
          return `❌ 文件不存在：${abs}（${errorMessage(error)}）`
        }
        const allowedDirs = [workspacePath, deps.dataDir]
          .filter((d): d is string => d !== undefined && d !== '')
          .map((d) => {
            try { return realpathSync(d) } catch { return resolve(d) }
          })
        if (!allowedDirs.some((d) => realFile === d || realFile.startsWith(d + sep))) {
          return '❌ 拒绝：路径不在允许目录内（仅允许当前工作区与插件数据目录）'
        }

        // 4. 存在性/类型/大小校验。
        let st
        try {
          st = statSync(realFile)
        } catch (error) {
          return `❌ 无法读取文件：${realFile}（${errorMessage(error)}）`
        }
        if (!st.isFile()) return '❌ 拒绝：不是普通文件（目录/特殊文件不可发送）'
        if (st.size > MAX_FILE_BYTES) {
          return `❌ 拒绝：文件超过 ${MAX_FILE_BYTES / 1024 / 1024}MB 上限`
        }

        // 5. 扩展名白名单。
        const fileName = basename(realFile)
        const ext = (fileName.split('.').pop() ?? '').toLowerCase()
        if (!allowedExtensions.includes(ext as (typeof ALLOWED_FILE_EXTENSIONS)[number])) {
          return `❌ 拒绝：扩展名「${ext || '(无)'}」不在白名单（支持：${allowedExtensions.join('/')}）`
        }

        // 6. 读取 + 发送：光栅图片走 image 消息，其余走 file 消息（上传与发送
        //    由 SDK channel.send 封装：im/v1/images 或 im/v1/files + 发消息）。
        if (exec.signal.aborted) return '❌ 已取消'
        let buf: Buffer
        try {
          buf = readFileSync(realFile)
        } catch (error) {
          return `❌ 读取文件失败：${errorMessage(error)}`
        }
        try {
          const result = RASTER_IMAGE_EXTENSIONS.has(ext)
            ? await deps.channel.send(chatId, { image: { source: buf } })
            : await deps.channel.send(chatId, { file: { source: buf, fileName } })
          return `✅ 已发送到飞书（消息 id：${result.messageId}）`
        } catch (error) {
          return `❌ 发送失败：${errorMessage(error)}`
        }
      },
    }))
  } catch (error) {
    deps.log('lark_send_local_file tool registration failed:', errorMessage(error))
    return undefined
  }
}
