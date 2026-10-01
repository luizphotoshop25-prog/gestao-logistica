const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gestaoPopup", {
  onState: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("popup:state", listener);
    return () => ipcRenderer.removeListener("popup:state", listener);
  },
  act: (action) => ipcRenderer.send("popup:action", action),
});
