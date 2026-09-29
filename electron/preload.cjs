const { contextBridge, ipcRenderer } = require("electron");

const api = {
  getState: () => ipcRenderer.invoke("dsh:getState"),
  newThread: () => ipcRenderer.invoke("dsh:newThread"),
  selectThread: (threadId) => ipcRenderer.invoke("dsh:selectThread", threadId),
  sendMessage: (payload) => ipcRenderer.invoke("dsh:sendMessage", payload),
  stopMessage: () => ipcRenderer.invoke("dsh:stopMessage"),
  selectWorkspaceFolder: () => ipcRenderer.invoke("dsh:selectWorkspaceFolder"),
  selectFiles: () => ipcRenderer.invoke("dsh:selectFiles"),
  switchSessionModel: (model) => ipcRenderer.invoke("dsh:switchSessionModel", model),
  archiveThread: (threadId) => ipcRenderer.invoke("dsh:archiveThread", threadId),
  unarchiveThread: (threadId) => ipcRenderer.invoke("dsh:unarchiveThread", threadId),
  deleteArchivedThread: (threadId) => ipcRenderer.invoke("dsh:deleteArchivedThread", threadId),
  getSpeechCatalog: () => ipcRenderer.invoke("dsh:getSpeechCatalog"),
  prepareSpeechProvider: (providerId) => ipcRenderer.invoke("dsh:prepareSpeechProvider", providerId),
  cancelSpeechPreparation: (providerId) => ipcRenderer.invoke("dsh:cancelSpeechPreparation", providerId),
  transcribeSpeech: (request) => ipcRenderer.invoke("dsh:transcribeSpeech", request),
  updateSettings: (settings) => ipcRenderer.invoke("dsh:updateSettings", settings),
  clearProviderApiKey: (provider) => ipcRenderer.invoke("dsh:clearProviderApiKey", provider),
  startAccountSignIn: () => ipcRenderer.invoke("dsh:startAccountSignIn"),
  cancelAccountSignIn: () => ipcRenderer.invoke("dsh:cancelAccountSignIn"),
  signOutAccount: () => ipcRenderer.invoke("dsh:signOutAccount"),
  repairRuntime: () => ipcRenderer.invoke("dsh:repairRuntime"),
  openExternal: (url) => ipcRenderer.invoke("dsh:openExternal", url),
  registerSkillFile: () => ipcRenderer.invoke("dsh:registerSkillFile"),
  unregisterSkill: (path) => ipcRenderer.invoke("dsh:unregisterSkill", path),
  respondApproval: (requestId, choice) => ipcRenderer.invoke("dsh:respondApproval", { requestId, choice }),
  respondClarification: (requestId, answers) => ipcRenderer.invoke("dsh:respondClarification", { requestId, answers }),
  cancelClarification: (requestId) => ipcRenderer.invoke("dsh:cancelClarification", requestId),
  ackThreadCompleted: (threadId) => ipcRenderer.invoke("dsh:ackThreadCompleted", threadId),
  onState: (handler) => {
    const listener = (_event, nextState) => handler(nextState);
    ipcRenderer.on("dsh:state", listener);
    return () => ipcRenderer.removeListener("dsh:state", listener);
  },
};

contextBridge.exposeInMainWorld("dshDesktop", api);
