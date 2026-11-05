const { contextBridge, ipcRenderer: ipc } = require("electron");
contextBridge.exposeInMainWorld("api", {
  login: () => ipc.invoke("login"),
  session: () => ipc.invoke("session"),
  logout: () => ipc.invoke("logout"),
  start: (o) => ipc.invoke("start", o),
  stop: () => ipc.invoke("stop"),
  copy: (t) => ipc.invoke("copy", t),
  openSite: () => ipc.invoke("openSite"),
  getSettings: () => ipc.invoke("settings:get"),
  setSettings: (p) => ipc.invoke("settings:set", p),
  account: (op, body) => ipc.invoke("account", op, body),
  on: (ch, fn) => ipc.on(ch, (_, v) => fn(v)),
});
