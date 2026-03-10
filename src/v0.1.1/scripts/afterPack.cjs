const { readdir, rm, stat, writeFile } = require('fs/promises')
const { join } = require('path')

/**
 * electron-builder afterPack hook
 * 在打包完成后清理无用文件，最小化应用体积
 */

/**
 * @param {import('electron-builder').AfterPackContext} context
 */
// 仅保留这些语言的 .lproj，其余全部删除
// 同时保留 Electron 旧格式 (zh_CN/zh_TW) 和 macOS BCP 47 格式 (zh-Hans/zh-Hant)
const KEEP_LANGUAGES = new Set(['en', 'zh_CN', 'zh_TW', 'zh-Hans', 'zh-Hant'])

module.exports = async function afterPack(context) {
  const appDir = context.appOutDir
  const platform = context.electronPlatformName

  console.log(`\n[afterPack] 开始清理无用文件 (${platform})...`)

  let totalSaved = 0

  // 1. 清理 Electron Framework 内部多余的 .lproj 目录（electronLanguages 对 Framework 无效）
  if (platform === 'darwin') {
    const contentsDir = join(appDir, `${context.packager.appInfo.productFilename}.app`, 'Contents')
    totalSaved += await cleanFrameworkLproj(contentsDir)
  } else if (platform === 'win32') {
    // Windows 下 locale 文件在 locales/ 目录
    totalSaved += await cleanWinLocales(appDir)
  }

  // 2. 清理 Chromium LICENSES.html (约 15MB)
  if (platform === 'win32') {
    const licensesPath = join(appDir, 'LICENSES.chromium.html')
    totalSaved += await removeFileIfExists(licensesPath)
  }

  // 3. 写入 channel.json（安装渠道号，CI 通过 INSTALL_CHANNEL 环境变量注入）
  await writeChannelFile(appDir, platform, context)

  console.log(`[afterPack] 清理完成，共释放 ${formatBytes(totalSaved)}\n`)
}

/**
 * 清理 macOS Electron Framework 中多余的 .lproj 目录
 * electronLanguages 只清理 App Resources 下的 .lproj，Framework 内部的需要手动处理
 */
async function cleanFrameworkLproj(contentsDir) {
  let saved = 0
  const frameworksDir = join(contentsDir, 'Frameworks')

  // 递归查找所有 .lproj 目录
  saved += await cleanLprojInDir(frameworksDir)

  const lprojCount = saved > 0
    ? `(${formatBytes(saved)})`
    : '(无需清理)'
  console.log(`[afterPack] Electron Framework .lproj 清理完成 ${lprojCount}`)

  return saved
}

/**
 * 递归在目录中查找并清理不需要的 .lproj 目录
 */
async function cleanLprojInDir(dir) {
  let saved = 0

  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return saved
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)

    if (!entry.isDirectory()) continue

    if (entry.name.endsWith('.lproj')) {
      const lang = entry.name.replace('.lproj', '')
      if (!KEEP_LANGUAGES.has(lang)) {
        saved += await getDirSize(fullPath)
        await rm(fullPath, { recursive: true, force: true })
      }
    } else {
      // 递归进入子目录（如 Versions/A/Resources）
      saved += await cleanLprojInDir(fullPath)
    }
  }

  return saved
}

/**
 * 清理 Windows locales 目录中多余的 .pak 文件
 */
async function cleanWinLocales(appDir) {
  let saved = 0
  const localesDir = join(appDir, 'locales')

  let entries
  try {
    entries = await readdir(localesDir, { withFileTypes: true })
  } catch {
    return saved
  }

  // Windows locale 文件格式: en-US.pak, zh-CN.pak
  const keepPaks = new Set(['en-US.pak', 'zh-CN.pak', 'zh-TW.pak'])

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.pak') && !keepPaks.has(entry.name)) {
      saved += await removeFileIfExists(join(localesDir, entry.name))
    }
  }

  console.log(`[afterPack] Windows locales 清理完成 (${formatBytes(saved)})`)
  return saved
}

/**
 * 获取目录大小
 */
async function getDirSize(dirPath) {
  let size = 0
  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name)
      if (entry.isDirectory()) {
        size += await getDirSize(fullPath)
      } else {
        try {
          const s = await stat(fullPath)
          size += s.size
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
  return size
}

/**
 * 安全删除文件并返回文件大小
 */
async function removeFileIfExists(filePath) {
  try {
    const s = await stat(filePath)
    const size = s.size
    await rm(filePath, { force: true })
    return size
  } catch {
    return 0
  }
}

/**
 * 写入 channel.json 到 extraResources 目录
 *
 * CI 通过 INSTALL_CHANNEL 环境变量注入渠道号（如 5001=官网 / 5002=内测群）。
 * 运行时 Electron 主进程读取该文件来确定安装渠道。
 */
async function writeChannelFile(appDir, platform, context) {
  const channel = Number(process.env.INSTALL_CHANNEL) || 5001

  // macOS: Contents/Resources/  |  Windows: resources/
  let resourcesDir
  if (platform === 'darwin') {
    resourcesDir = join(
      appDir,
      `${context.packager.appInfo.productFilename}.app`,
      'Contents',
      'Resources',
    )
  } else {
    resourcesDir = join(appDir, 'resources')
  }

  const channelFile = join(resourcesDir, 'channel.json')
  const content = JSON.stringify({ channel }, null, 2)

  await writeFile(channelFile, content, 'utf-8')
  console.log(`[afterPack] 写入渠道标识文件: ${channelFile} (channel=${channel})`)
}

/**
 * 格式化字节数
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}
