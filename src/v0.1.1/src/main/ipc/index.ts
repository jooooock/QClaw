import { app, ipcMain, shell, BrowserWindow } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { join, basename } from 'path'
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'fs'
import { openclawLogger } from '../common/logger.js'
import pkg from 'node-machine-id'
const { machineId } = pkg
import { getProcessManager, getConfigPath } from '../openclaw/index.js'
import { ConfigManager, willTriggerRestart } from '../server/index.js'
import { readConfigFileSync } from '../common/config-file.js'
import { LOG_BUFFER_CAPACITY } from '../constants.js'
import { OPENCLAW_DEFAULT_GATEWAY_PORT, OPENCLAW_CONFIG_PATH } from '../openclaw/constants.js'
import { getDefaultConfigSourcePath } from '../openclaw/paths.js'
import { LOCALHOST_ADDRESS } from '../common/constants.js'
import { checkHealthWithRetry } from '../server/health-check.js'
import type {
  ProcessStatus,
  LogEvent,
  OpenClawConfig,
  ConfigUpdateResult,
  InstanceMode,
  InstanceBootState,
  RumEvent
} from '@guanjia-openclaw/shared'
import { getBootState, initializeWithMode, retryBootSequence } from '../openclaw/boot.js'
import { rumReport } from '../reporting/rum-reporter.js'
import { RUM_FROM_RENDERER } from '../reporting/constants.js'

/** 日志缓冲区，解决渲染进程启动晚于服务启动导致的日志丢失 */
const logBuffer: LogEvent[] = []

function pushLogBuffer(log: LogEvent): void {
  logBuffer.push(log)
  if (logBuffer.length > LOG_BUFFER_CAPACITY) {
    logBuffer.splice(0, logBuffer.length - LOG_BUFFER_CAPACITY)
  }
}

/** 为窗口注册最大化/取消最大化事件转发 */
function setupWindowMaximizeEvents(window: BrowserWindow): void {
  window.on('maximize', () => {
    if (!window.isDestroyed()) {
      window.webContents.send('window:maximizeChange', true)
    }
  })
  window.on('unmaximize', () => {
    if (!window.isDestroyed()) {
      window.webContents.send('window:maximizeChange', false)
    }
  })
}

/** 向所有已就绪窗口广播 IPC 消息 */
function broadcastToWindows(channel: string, ...args: unknown[]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, ...args)
    }
  }
}

/**
 * 设置所有 IPC 处理器
 * 纯注册层：只负责 IPC 通道绑定，业务逻辑在 server/ 模块中
 */
/**
 * 获取基于运行时 configPath 的 ConfigManager（单例）
 * ProcessManager 初始化后 runtimeConfig 才可用，因此延迟创建
 * 单例保证 writeLock 在所有调用间共享，防止并发写入丢失更新
 */
let configManagerInstance: ConfigManager | null = null

function getConfigManager(): ConfigManager {
  if (!configManagerInstance) {
    const runtimeConfig = getProcessManager().getRuntimeConfig()
    configManagerInstance = new ConfigManager({
      configPath: runtimeConfig?.configPath ?? OPENCLAW_CONFIG_PATH,
      defaultGatewayPort: OPENCLAW_DEFAULT_GATEWAY_PORT,
      templatePath: getDefaultConfigSourcePath(),
    })
  }
  return configManagerInstance
}

/** 处理下载响应流，写入文件并广播进度 */
function handleDownloadResponse(
  response: import('http').IncomingMessage,
  filePath: string,
  sender: Electron.WebContents,
  resolve: (value: string) => void,
  reject: (reason: Error) => void,
): void {
  if (response.statusCode && response.statusCode >= 400) {
    reject(new Error(`HTTP ${response.statusCode}`))
    return
  }

  const totalBytes = parseInt(response.headers['content-length'] || '0', 10)
  let receivedBytes = 0
  const fileStream = createWriteStream(filePath)

  response.on('data', (chunk: Buffer) => {
    receivedBytes += chunk.length
    if (totalBytes > 0 && !sender.isDestroyed()) {
      const percent = Math.round((receivedBytes / totalBytes) * 100)
      sender.send('app:downloadProgress', percent)
    }
  })

  response.pipe(fileStream)

  fileStream.on('finish', () => {
    fileStream.close()
    if (!sender.isDestroyed()) {
      sender.send('app:downloadProgress', 100)
    }
    resolve(filePath)
  })

  fileStream.on('error', (err: Error) => {
    fileStream.close()
    reject(err)
  })
}

export function setupIpcHandlers(): void {
  const processManager = getProcessManager()

  // ==================== 窗口控制 ====================

  ipcMain.handle('window:minimize', async (event: IpcMainInvokeEvent): Promise<void> => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })

  ipcMain.handle('window:maximize', async (event: IpcMainInvokeEvent): Promise<void> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) {
      if (win.isMaximized()) {
        win.unmaximize()
      } else {
        win.maximize()
      }
    }
  })

  ipcMain.handle('window:close', async (event: IpcMainInvokeEvent): Promise<void> => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })

  ipcMain.handle('window:isMaximized', async (event: IpcMainInvokeEvent): Promise<boolean> => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false
  })

  // 窗口最大化状态变更事件 - 监听新创建的窗口
  app.on('browser-window-created', (_event, window) => {
    setupWindowMaximizeEvents(window)
  })

  // ==================== 进程管理 ====================

  ipcMain.handle('process:start', async (
    _event: IpcMainInvokeEvent,
    options?: { verbose?: boolean }
  ): Promise<void> => {
    return processManager.start(options)
  })

  ipcMain.handle('process:stop', async (): Promise<void> => {
    return processManager.stop()
  })

  ipcMain.handle('process:restart', async (): Promise<void> => {
    return processManager.restart()
  })

  ipcMain.handle('process:getStatus', async (): Promise<ProcessStatus> => {
    return processManager.getStatus()
  })

  // 渲染进程就绪后主动拉取缓冲日志
  ipcMain.handle('process:getLogs', async (): Promise<LogEvent[]> => {
    return [...logBuffer]
  })

  // 在外部浏览器中打开 OpenClaw Control UI
  ipcMain.handle('process:openControlUI', async (): Promise<void> => {
    try {
      const configPath = getConfigPath()
      const config = readConfigFileSync<{
        gateway?: { port?: number; auth?: { token?: string } }
      }>(configPath)
      const token = config.gateway?.auth?.token ?? ''
      const port = config.gateway?.port ?? OPENCLAW_DEFAULT_GATEWAY_PORT
      await shell.openExternal(`http://${LOCALHOST_ADDRESS}:${port}#token=${token}`)
    } catch (err) {
      openclawLogger.error('Failed to open Control UI:', err)
    }
  })

  // 进程状态变更事件 - 转发到所有窗口
  processManager.onStatusChange((status: ProcessStatus) => {
    broadcastToWindows('process:status', status)
  })

  // 日志事件 - 写入缓冲并转发到所有窗口，同时写入 openclaw 日志文件
  processManager.onLog((log: LogEvent) => {
    pushLogBuffer(log)
    broadcastToWindows('process:log', log)
    // 写入 openclaw/{date}.log
    const level = log.level === 'warn' ? 'warn' : log.level === 'error' ? 'error' : 'info'
    openclawLogger[level](log.message)
  })

  // ==================== 配置管理 ====================

  ipcMain.handle('config:getField', async (
    _event: IpcMainInvokeEvent,
    keyPath: string
  ): Promise<unknown> => {
    return getConfigManager().getField(keyPath)
  })

  ipcMain.handle('config:updateField', async (
    _event: IpcMainInvokeEvent,
    partialConfig: Partial<OpenClawConfig>
  ): Promise<ConfigUpdateResult> => {
    const configManager = getConfigManager()
    const pm = getProcessManager()
    const status = pm.getStatus()

    // 判断此次配置变更是否会触发 OpenClaw gateway in-process restart
    const triggersRestart = status.status === 'running'
      && willTriggerRestart(partialConfig as Record<string, unknown>)

    if (!triggersRestart) {
      // 不触发重启，直接写入配置
      return configManager.updateField(partialConfig)
    }

    // 配置变更将触发 OpenClaw in-process restart，需要协调 Supervisor
    openclawLogger.info('[IPC] Config change will trigger OpenClaw in-process restart, pausing health checks')

    // 1. 暂停 Supervisor 健康检查，避免重启窗口期内误判为假死
    pm.pauseHealthCheck()

    try {
      // 2. 写入配置（触发 OpenClaw chokidar → in-process restart）
      const result = await configManager.updateField(partialConfig)

      if (!result.success) {
        pm.resumeHealthCheck()
        return result
      }

      // 3. 等待 OpenClaw 完成 in-process restart 并恢复健康
      const port = status.port
      const isHealthy = await checkHealthWithRetry({
        port,
        retries: 30,
        retryDelay: 1000,
        timeout: 5000,
      })

      // 4. 恢复 Supervisor 健康检查
      pm.resumeHealthCheck()

      if (isHealthy) {
        openclawLogger.info('[IPC] OpenClaw in-process restart completed, service healthy')
        return {
          ...result,
          message: '配置已更新，服务已重新加载',
          serviceRestarted: true,
        }
      } else {
        openclawLogger.warn('[IPC] OpenClaw did not become healthy after config restart')
        return {
          ...result,
          message: '配置已更新，但服务可能仍在重启中',
          serviceRestarted: true,
        }
      }
    } catch (error) {
      // 确保异常情况下健康检查也能恢复
      pm.resumeHealthCheck()
      throw error
    }
  })

  // ==================== 应用级 API ====================

  ipcMain.handle('app:get-machine-id', async (): Promise<string> => {
    return machineId()
  })

  ipcMain.handle('app:get-version', async (): Promise<string> => {
    return app.getVersion()
  })

  ipcMain.handle('app:get-channel', async (): Promise<string> => {
    try {
      const channelPath = join(process.resourcesPath, 'channel.json')
      const content = readFileSync(channelPath, 'utf-8')
      const data = JSON.parse(content) as { channel?: number }
      return String(data.channel ?? '')
    } catch {
      return ''
    }
  })

  ipcMain.handle('app:openPath', async (
    _event: IpcMainInvokeEvent,
    filePath: string
  ): Promise<string> => {
    return shell.openPath(filePath)
  })

  ipcMain.handle('app:quit', async (): Promise<void> => {
    app.quit()
  })

  ipcMain.handle('app:downloadFile', async (
    event: IpcMainInvokeEvent,
    url: string,
    fileName?: string
  ): Promise<string> => {
    const downloadsDir = app.getPath('downloads')
    if (!existsSync(downloadsDir)) {
      mkdirSync(downloadsDir, { recursive: true })
    }

    // 从 URL 中提取文件名（去掉查询参数）
    const resolvedFileName = fileName || basename(new URL(url).pathname) || 'update.dmg'
    const filePath = join(downloadsDir, resolvedFileName)
    const sender = event.sender

    return new Promise<string>((resolve, reject) => {
      const protocol = url.startsWith('https') ? require('https') : require('http')

      const request = protocol.get(url, (response: import('http').IncomingMessage) => {
        // 处理重定向
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          const redirectUrl = response.headers.location
          const redirectProtocol = redirectUrl.startsWith('https') ? require('https') : require('http')
          redirectProtocol.get(redirectUrl, (redirectResponse: import('http').IncomingMessage) => {
            handleDownloadResponse(redirectResponse, filePath, sender, resolve, reject)
          }).on('error', (err: Error) => {
            openclawLogger.error('[IPC] downloadFile redirect error:', err)
            reject(err)
          })
          return
        }
        handleDownloadResponse(response, filePath, sender, resolve, reject)
      })

      request.on('error', (err: Error) => {
        openclawLogger.error('[IPC] downloadFile request error:', err)
        reject(err)
      })
    })
  })

  // ==================== 实例管理 ====================

  ipcMain.handle('instance:getBootState', async (): Promise<InstanceBootState | null> => {
    return getBootState()
  })

  ipcMain.handle('instance:setMode', async (
    _event: IpcMainInvokeEvent,
    mode: InstanceMode
  ): Promise<void> => {
    const bootState = getBootState()
    await initializeWithMode(mode, bootState?.externalInstance, true)
    broadcastToWindows('instance:modeChange', mode)
  })

  ipcMain.handle('instance:getMode', async (): Promise<InstanceMode | null> => {
    return processManager.getMode()
  })

  ipcMain.handle('instance:retryBoot', async (): Promise<InstanceBootState> => {
    return retryBootSequence()
  })

  // ==================== RUM 事件上报 ====================

  ipcMain.handle('rum:report', async (
    _event: IpcMainInvokeEvent,
    event: RumEvent
  ): Promise<void> => {
    rumReport(event, RUM_FROM_RENDERER)
  })

  // ==================== 会话管理 ====================

  ipcMain.handle('session:trimLastExchange', async (
    _event: IpcMainInvokeEvent,
    sessionKey: string
  ): Promise<boolean> => {
    try {
      const runtimeConfig = processManager.getRuntimeConfig()
      if (!runtimeConfig?.stateDir) {
        openclawLogger.warn('[IPC] trimLastExchange: stateDir 不可用')
        return false
      }

      // session key 格式: agent:{agentId}:{...}
      const parts = sessionKey.split(':')
      const agentId = parts[1] || 'main'

      const sessionsJsonPath = join(
        runtimeConfig.stateDir,
        'agents',
        agentId,
        'sessions',
        'sessions.json'
      )

      const fs = await import('fs')

      if (!fs.existsSync(sessionsJsonPath)) {
        openclawLogger.warn(`[IPC] trimLastExchange: sessions.json 不存在: ${sessionsJsonPath}`)
        return false
      }

      const sessionsData = JSON.parse(fs.readFileSync(sessionsJsonPath, 'utf-8'))
      const sessionInfo = sessionsData[sessionKey]

      if (!sessionInfo?.sessionFile) {
        openclawLogger.warn(`[IPC] trimLastExchange: session 文件未找到: ${sessionKey}`)
        return false
      }

      // sessionFile 可能是相对路径，需要相对于 sessions.json 所在目录解析
      const { dirname, isAbsolute } = await import('path')
      const fullSessionPath = isAbsolute(sessionInfo.sessionFile)
        ? sessionInfo.sessionFile
        : join(dirname(sessionsJsonPath), sessionInfo.sessionFile)

      if (!fs.existsSync(fullSessionPath)) {
        openclawLogger.warn(`[IPC] trimLastExchange: JSONL 文件不存在: ${fullSessionPath}`)
        return false
      }

      const content = fs.readFileSync(fullSessionPath, 'utf-8')
      const lines = content.split('\n').filter((l: string) => l.trim())

      // 从末尾向前找最后一条 user 消息的位置
      let lastUserIndex = -1
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]
        if (!line) continue

        try {
          const item = JSON.parse(line)
          if (
            item.type === 'message' &&
            item.message?.role === 'user'
          ) {
            lastUserIndex = i
            break
          }
        } catch {
          // 解析失败的行跳过
        }
      }

      if (lastUserIndex === -1) {
        openclawLogger.warn(`[IPC] trimLastExchange: 未找到 user 消息`)
        return false
      }

      // 保留 lastUserIndex 之前的所有行
      const remaining = lines.slice(0, lastUserIndex)
      fs.writeFileSync(fullSessionPath, remaining.join('\n') + (remaining.length > 0 ? '\n' : ''))

      openclawLogger.info(
        `[IPC] trimLastExchange: 成功删除 session ${sessionKey} 最后 ${lines.length - lastUserIndex} 条消息`
      )
      return true
    } catch (error) {
      openclawLogger.error('[IPC] trimLastExchange 失败:', error)
      return false
    }
  })

  // ==================== 调试工具 ====================

  ipcMain.handle('debug:openLogFolder', async (): Promise<void> => {
    const logsPath = app.getPath('logs')
    await shell.openPath(logsPath)
  })

  ipcMain.handle('debug:packQclaw', async (): Promise<{ outputFile: string; size: number; sizeFormatted: string }> => {
    // 打包后 scripts/ 通过 extraResources 放到 Resources/scripts/ 下，不在 asar 内
    // 开发环境 app.getAppPath() 指向源码目录，scripts/ 与 src/ 同级
    const scriptPath = app.isPackaged
      ? join(process.resourcesPath, 'scripts', 'pack-qclaw.cjs')
      : join(app.getAppPath(), 'scripts', 'pack-qclaw.cjs')
    const { packQclaw } = require(scriptPath)
    const result = await packQclaw()
    // 打包完成后在 Finder/资源管理器中高亮显示文件
    shell.showItemInFolder(result.outputFile)
    return result
  })

}
