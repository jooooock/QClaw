import { contextBridge, ipcRenderer } from "electron";
const electronAPI = {
  // 窗口控制
  window: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    maximize: () => ipcRenderer.invoke("window:maximize"),
    close: () => ipcRenderer.invoke("window:close"),
    isMaximized: () => ipcRenderer.invoke("window:isMaximized"),
    onMaximizeChange: (callback) => {
      const handler = (_event, isMaximized) => callback(isMaximized);
      ipcRenderer.on("window:maximizeChange", handler);
      return () => ipcRenderer.removeListener("window:maximizeChange", handler);
    }
  },
  // 进程管理
  process: {
    start: (options) => ipcRenderer.invoke("process:start", options),
    stop: () => ipcRenderer.invoke("process:stop"),
    restart: () => ipcRenderer.invoke("process:restart"),
    getStatus: () => ipcRenderer.invoke("process:getStatus"),
    getLogs: () => ipcRenderer.invoke("process:getLogs"),
    openControlUI: () => ipcRenderer.invoke("process:openControlUI"),
    onLog: (callback) => {
      const handler = (_event, log) => callback(log);
      ipcRenderer.on("process:log", handler);
      return () => ipcRenderer.removeListener("process:log", handler);
    },
    onStatusChange: (callback) => {
      const handler = (_event, status) => callback(status);
      ipcRenderer.on("process:status", handler);
      return () => ipcRenderer.removeListener("process:status", handler);
    }
  },
  // 配置管理
  config: {
    getField: (keyPath) => ipcRenderer.invoke("config:getField", keyPath),
    updateField: (partialConfig) => ipcRenderer.invoke("config:updateField", partialConfig)
  },
  // 应用级 API
  app: {
    getMachineId: () => ipcRenderer.invoke("app:get-machine-id"),
    getVersion: () => ipcRenderer.invoke("app:get-version"),
    getChannel: () => ipcRenderer.invoke("app:get-channel"),
    openPath: (filePath) => ipcRenderer.invoke("app:openPath", filePath),
    downloadFile: (url, fileName) => ipcRenderer.invoke("app:downloadFile", url, fileName),
    onDownloadProgress: (callback) => {
      const handler = (_event, percent) => callback(percent);
      ipcRenderer.on("app:downloadProgress", handler);
      return () => ipcRenderer.removeListener("app:downloadProgress", handler);
    },
    quitApp: () => ipcRenderer.invoke("app:quit")
  },
  // 日志 API（通过 electron-log 内置 IPC 通道转发到主进程写入文件）
  logger: {
    info: (...args) => ipcRenderer.send("__ELECTRON_LOG__", {
      data: args,
      level: "info",
      logId: "renderer"
    }),
    warn: (...args) => ipcRenderer.send("__ELECTRON_LOG__", {
      data: args,
      level: "warn",
      logId: "renderer"
    }),
    error: (...args) => ipcRenderer.send("__ELECTRON_LOG__", {
      data: args,
      level: "error",
      logId: "renderer"
    })
  },
  // RUM 事件上报（通过 IPC 转发到主进程统一上报）
  reporter: {
    report: (event) => ipcRenderer.invoke("rum:report", event)
  },
  // 实例管理
  instance: {
    getBootState: () => ipcRenderer.invoke("instance:getBootState"),
    setMode: (mode) => ipcRenderer.invoke("instance:setMode", mode),
    getMode: () => ipcRenderer.invoke("instance:getMode"),
    retryBoot: () => ipcRenderer.invoke("instance:retryBoot"),
    onBootState: (callback) => {
      const handler = (_event, state) => callback(state);
      ipcRenderer.on("instance:bootState", handler);
      return () => ipcRenderer.removeListener("instance:bootState", handler);
    },
    onModeChange: (callback) => {
      const handler = (_event, mode) => callback(mode);
      ipcRenderer.on("instance:modeChange", handler);
      return () => ipcRenderer.removeListener("instance:modeChange", handler);
    }
  },
  // 会话管理
  session: {
    trimLastExchange: (sessionKey) => ipcRenderer.invoke("session:trimLastExchange", sessionKey)
  },
  // 调试工具
  debug: {
    onTogglePanel: (callback) => {
      const handler = () => callback();
      ipcRenderer.on("debug:togglePanel", handler);
      return () => ipcRenderer.removeListener("debug:togglePanel", handler);
    },
    openLogFolder: () => ipcRenderer.invoke("debug:openLogFolder"),
    packQclaw: () => ipcRenderer.invoke("debug:packQclaw")
  },
  // 平台信息
  platform: process.platform,
  arch: process.arch
};
contextBridge.exposeInMainWorld("electronAPI", electronAPI);
