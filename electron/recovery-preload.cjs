const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gestaoRecovery", {
  state: () => ipcRenderer.invoke("recovery:state"),
  check: () => ipcRenderer.invoke("recovery:check"),
  download: () => ipcRenderer.invoke("recovery:download"),
  install: () => ipcRenderer.invoke("recovery:install"),
  onState: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("recovery:state", listener);
    return () => ipcRenderer.removeListener("recovery:state", listener);
  },
});
