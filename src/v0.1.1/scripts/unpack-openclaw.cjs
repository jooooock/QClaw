#!/usr/bin/env node

/**
 * Windows 安装后 OpenClaw tar 解压脚本
 *
 * 由 NSIS installer.nsh 的 customInstall 宏调用，
 * 通过 QClaw.exe (ELECTRON_RUN_AS_NODE=1 模式) 执行。
 *
 * 用法: QClaw.exe <本脚本路径> <安装目录>
 *
 * 效果:
 *   输入: $INSTDIR/resources/openclaw.tar
 *   输出: $INSTDIR/resources/openclaw/ (还原为散文件目录)
 *   tar 文件解压后自动删除
 *
 * 依赖: 从 app.asar 内加载 tar npm 包 (Electron 内置 ASAR 透明读取支持)
 */

const fs = require('fs')
const path = require('path')

// ============================================================
// 参数解析
// ============================================================

const instDir = process.argv[2]

if (!instDir) {
  console.error('[unpack-openclaw] 错误: 缺少安装目录参数')
  console.error('[unpack-openclaw] 用法: QClaw.exe unpack-openclaw.cjs <安装目录>')
  process.exit(1)
}

const resourcesDir = path.join(instDir, 'resources')
const tarFile = path.join(resourcesDir, 'openclaw.tar')
const appAsar = path.join(resourcesDir, 'app.asar')

// ============================================================
// 前置检查
// ============================================================

if (!fs.existsSync(tarFile)) {
  console.error(`[unpack-openclaw] 错误: tar 文件不存在: ${tarFile}`)
  process.exit(1)
}

// ============================================================
// 加载 tar 模块
// ============================================================

/**
 * 从多个可能的路径加载 tar 模块
 * 优先级:
 *   1. ASAR 内的 node_modules (Electron 内置 ASAR 读取支持)
 *   2. 全局 require (如果 tar 碰巧在 NODE_PATH 中)
 */
function loadTarModule() {
  // 策略 1: 从 app.asar 内加载
  const asarTarPath = path.join(appAsar, 'node_modules', 'tar')
  try {
    return require(asarTarPath)
  } catch {
    // ASAR 加载失败，继续尝试
  }

  // 策略 2: 直接 require (可能在 NODE_PATH 或其他路径中)
  try {
    return require('tar')
  } catch {
    // 也失败
  }

  console.error('[unpack-openclaw] 错误: 无法加载 tar 模块')
  console.error(`[unpack-openclaw] 尝试路径: ${asarTarPath}`)
  process.exit(1)
}

// ============================================================
// 执行解压
// ============================================================

try {
  console.log(`[unpack-openclaw] 开始解压: ${tarFile}`)
  console.log(`[unpack-openclaw] 目标目录: ${resourcesDir}`)

  const tar = loadTarModule()
  const startTime = Date.now()

  // 同步解压到 resources/ 目录
  // tar 内的路径结构是 openclaw/... ，解压后会自动创建 resources/openclaw/
  tar.extract({
    file: tarFile,
    cwd: resourcesDir,
    sync: true,
  })

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`[unpack-openclaw] 解压完成 (${elapsed}s)`)

  // 删除 tar 文件
  fs.unlinkSync(tarFile)
  console.log('[unpack-openclaw] 已删除 tar 归档')

  // 验证解压结果
  const openclawDir = path.join(resourcesDir, 'openclaw')
  if (!fs.existsSync(openclawDir)) {
    console.error(`[unpack-openclaw] 错误: 解压后目录不存在: ${openclawDir}`)
    process.exit(1)
  }

  console.log('[unpack-openclaw] 完成 ✓')
  process.exit(0)
} catch (err) {
  console.error(`[unpack-openclaw] 解压失败: ${err.message}`)
  process.exit(1)
}
