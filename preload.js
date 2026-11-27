'use strict'

const { contextBridge, ipcRenderer } = require('electron')

/**
 * 只暴露这几个方法给页面。页面拿不到 Node、fs、ipcRenderer 本体。
 */
contextBridge.exposeInMainWorld('forge', {
  /**
   * 把参考图的样式套到目标图上
   * @param {{target:object, reference:object|null, outSize:number}} payload
   */
  convert: (payload) => ipcRenderer.invoke('image:convert', payload),

  /** 导出单个文件 @param {{name:string, format:'svg'|'png', svg?:string, pngBase64?:string}} file */
  save: (file) => ipcRenderer.invoke('file:save', file),

  /** 导出全部 @param {{files:object[]}} payload */
  saveAll: (payload) => ipcRenderer.invoke('file:saveAll', payload),

  /** 启动时命令行传进来的文件 */
  onBootFiles: (callback) => {
    ipcRenderer.on('boot:files', (_event, files) => callback(files))
  },
})
