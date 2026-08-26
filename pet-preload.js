"use strict";
/** 桌面宠物窗口的预加载脚本：只开五个单向通道，页面拿不到 node 能力。 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("wbPet", {
  onState: (cb) => ipcRenderer.on("pet:state", (_e, s) => { try { cb(s); } catch {} }),
  dragStart: () => ipcRenderer.send("pet:drag-start"),
  dragEnd: () => ipcRenderer.send("pet:drag-end"),
  menu: () => ipcRenderer.send("pet:menu"),
  // 光标压没压在宠物实体上：主进程据此开关点击穿透，别让透明方框挡住底下的应用
  hit: (on) => ipcRenderer.send("pet:hit", !!on),
});
