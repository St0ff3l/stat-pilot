const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hermesDesktop", {
  getState: () => ipcRenderer.invoke("hermes:getState"),
  newThread: () => ipcRenderer.invoke("hermes:newThread"),
  selectThread: (threadId) => ipcRenderer.invoke("hermes:selectThread", threadId),
  sendMessage: (payload) => ipcRenderer.invoke("hermes:sendMessage", payload),
  stopMessage: () => ipcRenderer.invoke("hermes:stopMessage"),
  selectWorkspaceFolder: () => ipcRenderer.invoke("hermes:selectWorkspaceFolder"),
  selectFiles: () => ipcRenderer.invoke("hermes:selectFiles"),
  switchSessionModel: (model) => ipcRenderer.invoke("hermes:switchSessionModel", model),
  archiveThread: (threadId) => ipcRenderer.invoke("hermes:archiveThread", threadId),
  updateSettings: (settings) => ipcRenderer.invoke("hermes:updateSettings", settings),
  cancelOfficialLogin: () => ipcRenderer.invoke("hermes:cancelOfficialLogin"),
  repairRuntime: () => ipcRenderer.invoke("hermes:repairRuntime"),
  uninstallRuntime: () => ipcRenderer.invoke("hermes:uninstallRuntime"),
  openExternal: (url) => ipcRenderer.invoke("hermes:openExternal", url),
  registerSkillFile: () => ipcRenderer.invoke("hermes:registerSkillFile"),
  unregisterSkill: (path) => ipcRenderer.invoke("hermes:unregisterSkill", path),
  respondApproval: (choice) => ipcRenderer.invoke("hermes:respondApproval", choice),
  respondClarification: (answer) => ipcRenderer.invoke("hermes:respondClarification", answer),
  ackThreadCompleted: (threadId) => ipcRenderer.invoke("hermes:ackThreadCompleted", threadId),
  onState: (handler) => {
    const listener = (_event, nextState) => handler(nextState);
    ipcRenderer.on("hermes:state", listener);
    return () => ipcRenderer.removeListener("hermes:state", listener);
  },
});
