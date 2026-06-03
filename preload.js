const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 验证授权码
  verifyCode: (code) => ipcRenderer.invoke('verify:code', code),

  // 开始安装
  startInstall: (config) => ipcRenderer.invoke('install:start', config),

  // 启动终端
  startTerminal: (command) => ipcRenderer.invoke('terminal:start', command),

  // 监听安装日志
  onInstallLog: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('install:log', handler);
    return () => ipcRenderer.removeListener('install:log', handler);
  },

  // 监听安装进度
  onInstallProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('install:progress', handler);
    return () => ipcRenderer.removeListener('install:progress', handler);
  },

  // 监听安装完成
  onInstallComplete: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('install:complete', handler);
    return () => ipcRenderer.removeListener('install:complete', handler);
  },

  // 监听安装错误
  onInstallError: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('install:error', handler);
    return () => ipcRenderer.removeListener('install:error', handler);
  },

  // 监听 API 测试结果
  onInstallApiTestResult: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('install:apiTestResult', handler);
    return () => ipcRenderer.removeListener('install:apiTestResult', handler);
  },

  // 打开外部链接
  openExternal: (url) => ipcRenderer.invoke('open:external', url),

  // 获取软件信息
  getAppInfo: () => ipcRenderer.invoke('get:appInfo'),

  // 重启安装
  restartInstall: () => ipcRenderer.invoke('install:restart'),

  // 关闭应用
  quitApp: () => ipcRenderer.invoke('app:quit'),

  // 检测已安装的工具
  checkTools: () => ipcRenderer.invoke('install:checkTools'),

  // 卸载工具
  uninstallTool: (tool) => ipcRenderer.invoke('install:uninstallTool', tool),

  // 检查本地授权
  checkLicense: () => ipcRenderer.invoke('auth:checkLicense'),

  // 打开使用指南（.doc 文件）
  openGuide: (name) => ipcRenderer.invoke('guide:open', name),

  // 检查 relay 状态
  relayStatus: () => ipcRenderer.invoke('relay:status'),

  // 启动 relay
  relayStart: () => ipcRenderer.invoke('relay:start'),
});
