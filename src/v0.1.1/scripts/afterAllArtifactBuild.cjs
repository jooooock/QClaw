const { stat } = require('fs/promises')
const { basename, dirname } = require('path')

/**
 * electron-builder afterAllArtifactBuild hook
 * 在所有构建产物生成后输出构建总结
 */

/**
 * @param {import('electron-builder').BuildResult} buildResult
 */
module.exports = async function afterAllArtifactBuild(buildResult) {
  const artifacts = buildResult.artifactPaths

  if (!artifacts || artifacts.length === 0) {
    console.log('\n[afterAllArtifactBuild] 未检测到构建产物')
    return
  }

  // 收集文件信息
  const fileInfos = []
  let totalSize = 0

  for (const filePath of artifacts) {
    try {
      const s = await stat(filePath)
      const size = s.size
      totalSize += size
      fileInfos.push({
        path: filePath,
        name: basename(filePath),
        size: size,
      })
    } catch {
      // 忽略无法访问的文件
    }
  }

  // 按文件大小降序排序
  fileInfos.sort((a, b) => b.size - a.size)

  // 确定输出目录（取第一个文件的父目录作为基准）
  const outputDir = fileInfos.length > 0 ? dirname(fileInfos[0]?.path || '') : ''

  // 输出构建总结
  printBuildSummary(fileInfos, totalSize, outputDir)

}

/**
 * 输出构建总结
 */
function printBuildSummary(fileInfos, totalSize, outputDir) {
  const border = '═'.repeat(60)
  const sideBorder = '║'

  console.log('')
  console.log(`╔${border}╗`)
  console.log(`${sideBorder}${centerText('📦 构建完成', 60)}${sideBorder}`)
  console.log(`╠${border}╣`)

  // 输出目录
  const dirText = `  输出目录: ${outputDir}`
  console.log(`${sideBorder}${padRight(dirText, 60)}${sideBorder}`)
  console.log(`╠${border}╣`)

  // 文件列表标题
  console.log(`${sideBorder}${padRight('  文件列表:', 60)}${sideBorder}`)

  // 文件列表
  for (let i = 0; i < fileInfos.length; i++) {
    const info = fileInfos[i]
    const prefix = i === fileInfos.length - 1 ? '  └── ' : '  ├── '
    const sizeText = formatBytes(info.size).padStart(12)
    const nameWithPrefix = prefix + info.name
    const line = nameWithPrefix + ' '.repeat(Math.max(0, 60 - nameWithPrefix.length - sizeText.length - 2)) + sizeText + '  '
    console.log(`${sideBorder}${padRight(line, 60)}${sideBorder}`)
  }

  console.log(`╠${border}╣`)

  // 总大小
  const totalText = `  总大小: ${formatBytes(totalSize)}`
  console.log(`${sideBorder}${padRight(totalText, 60)}${sideBorder}`)
  console.log(`╚${border}╝`)
  console.log('')
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

/**
 * 居中文本
 */
function centerText(text, width) {
  const textWidth = getTextWidth(text)
  const padding = Math.max(0, width - textWidth)
  const leftPad = Math.floor(padding / 2)
  const rightPad = padding - leftPad
  return ' '.repeat(leftPad) + text + ' '.repeat(rightPad)
}

/**
 * 右侧填充空格
 */
function padRight(text, width) {
  const textWidth = getTextWidth(text)
  const padding = Math.max(0, width - textWidth)
  return text + ' '.repeat(padding)
}

/**
 * 计算文本显示宽度（中文字符算2个宽度）
 */
function getTextWidth(text) {
  let width = 0
  for (const char of text) {
    // 中文字符范围
    if (/[\u4e00-\u9fa5]/.test(char)) {
      width += 2
    } else {
      width += 1
    }
  }
  return width
}
