import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const IMAGE_MEDIA_TYPES = new Map([
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

/**
 * Client for interacting with DeepSeek Harness (DSH) Web and RPC API.
 */
export class DshClient extends EventEmitter {
  constructor({ baseUrl, host, cookie }) {
    super();
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.host = host;
    this.cookie = cookie;
    this.ws = null;
    this.wsConnected = false;
    this.clientId = null;
    this.activeFollowSessionId = null;
    this.followStreamId = null;
    this.workspaceBaseline = null;
    this.pendingRemoteEvents = new Map();
    this.reconnectTimer = null;
    this.isDisposed = false;
    this.pendingRequests = new Map();
  }

  /**
   * Helper to execute a Typert RPC over HTTP POST.
   */
  async request(endpoint, args = {}, { timeoutMs = 30000 } = {}) {
    const url = `${this.baseUrl}/api/${endpoint}`;
    const rpcId = randomUUID();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const headers = {
      "Content-Type": "application/json",
      Host: this.host,
      Origin: this.baseUrl,
    };
    if (this.cookie) {
      headers.Cookie = this.cookie;
    }

    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          type: "client-request",
          rpcId,
          method: endpoint,
          payload: { args },
        }),
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        throw new Error(`DSH RPC ${endpoint} 失败 (HTTP ${res.status}): ${errorText}`);
      }

      const data = await res.json();
      if (!data.result || !data.result.ok) {
        const err = data.result?.error;
        throw new Error(err?.message || `DSH RPC ${endpoint} 执行出错: ${JSON.stringify(err || data)}`);
      }

      return data.result.value;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`DSH RPC ${endpoint} 等待超过 ${Math.round(timeoutMs / 1000)} 秒，已停止等待`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  // --- Session Management RPCs ---

  async listSessions() {
    const data = await this.request("session/list", { _request: {} }, { timeoutMs: 15000 });
    return data?.items || [];
  }

  async createSession({ cwd } = {}) {
    return this.request("session/create", {
      request: {
        cwd: cwd || process.cwd(),
      },
    });
  }

  async getProjections(sessionId) {
    return this.request("session/projections", {
      request: { sessionId },
    });
  }

  async getPage({ sessionId, throughSeq, beforeSeq, maxMessages } = {}) {
    return this.request("session/page", {
      request: {
        address: { kind: "session", sessionId },
        throughSeq,
        beforeSeq,
        maxMessages,
      },
    });
  }

  async uploadFile({ sessionId, filePath, name } = {}) {
    const url = new URL(`${this.baseUrl}/api/session/uploadFileBinary`);
    url.searchParams.set("sessionId", sessionId);
    url.searchParams.set("name", name || path.basename(filePath));

    const headers = {
      "Content-Type": "application/octet-stream",
      Host: this.host,
      Origin: this.baseUrl,
    };
    if (this.cookie) {
      headers.Cookie = this.cookie;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: createReadStream(filePath),
        duplex: "half",
      });
      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        throw new Error(`DSH 文件上传失败 (HTTP ${res.status}): ${errorText}`);
      }

      const result = await res.json();
      if (!result?.ok) {
        throw new Error(result?.error?.message || "DSH 未能接收此文件");
      }
      return result.value;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error("DSH 文件上传等待超过 120 秒，已停止等待");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async sendPrompt({ sessionId, text, attachments = [], mode = "queue", clientTimeZone } = {}) {
    const content = [];
    if (typeof text === "string" && text.trim()) {
      content.push({ type: "text", text });
    }

    for (const attachment of attachments) {
      const filePath = attachment?.path;
      if (typeof filePath !== "string" || !filePath) {
        throw new Error("附件路径无效，请重新选择文件");
      }
      const name = path.basename(attachment.name || filePath);
      const mediaType = IMAGE_MEDIA_TYPES.get(path.extname(name).toLowerCase());
      if (mediaType) {
        const data = await readFile(filePath);
        content.push({
          type: "image",
          mediaType,
          data: data.toString("base64"),
          name,
        });
      } else {
        const uploaded = await this.uploadFile({ sessionId, filePath, name });
        content.push({ type: "file", receiptId: uploaded.receiptId });
      }
    }

    if (content.length === 0) {
      throw new Error("请输入消息或选择附件");
    }

    return this.request("session/prompt", {
      request: {
        requestId: randomUUID(),
        sessionId,
        mode,
        content,
        clientTimeZone,
      },
    });
  }

  async cancelSession(sessionId) {
    return this.request("session/cancel", {
      request: { sessionId },
    });
  }

  async renameSession(sessionId, title) {
    return this.request("session/rename", {
      request: { sessionId, title },
    });
  }

  async getModelCatalog() {
    return this.request("session/modelCatalog", {}, { timeoutMs: 15000 });
  }

  async getSpeechCatalog() {
    return this.request("speech/catalog", {});
  }

  async prepareSpeechProvider(providerId) {
    return this.request("speech/prepare", { providerId });
  }

  async cancelSpeechPreparation(providerId) {
    return this.request("speech/cancelPreparation", { providerId });
  }

  async transcribeSpeech(request) {
    return this.request("speech/transcribe", { request }, { timeoutMs: 180000 });
  }

  async getAccountState() {
    return this.request("account/getState", {}, { timeoutMs: 10000 });
  }

  async startAccountSignIn({ client, callbackOrigin } = {}) {
    return this.request("account/startSignIn", {
      client,
      callbackOrigin,
      loginSource: "desktop",
    });
  }

  async cancelAccountSignIn(attemptId) {
    return this.request("account/cancelSignIn", { attemptId });
  }

  async signOutAccount(client) {
    return this.request("account/signOut", { client });
  }

  async initializeAccountDefaultModel() {
    return this.request("session/initializeDefaultModel", {});
  }

  async mutateSettings({ namespace, operations, expectedRevision } = {}) {
    return this.request("settings/mutate", {
      ns: namespace,
      ops: operations,
      expectedRevision,
    }, { timeoutMs: 15000 });
  }

  async getPermissionPresetCatalog() {
    return this.request("permissionPresets/catalog", {}, { timeoutMs: 15000 });
  }

  async getAgentPresetRoster() {
    return this.request("agentPresets/list", {}, { timeoutMs: 15000 });
  }

  async selectAgentPreset(sessionId, preset) {
    return this.request("agentPresets/select", {
      agentId: sessionId,
      agentPreset: preset,
    }, { timeoutMs: 15000 });
  }

  async executeSessionCommand(sessionId, line) {
    return this.request("commands/execute", {
      agentId: sessionId,
      line,
      submittedAttachments: [],
    }, { timeoutMs: 15000 });
  }

  async setCredential(ref, value) {
    return this.request("credentials/set", { ref, value }, { timeoutMs: 15000 });
  }

  async unsetCredential(ref) {
    return this.request("credentials/unset", { ref });
  }

  async describeCredentials(refs = []) {
    return this.request("credentials/describe", { refs }, { timeoutMs: 15000 });
  }

  async selectModel({ sessionId, provider, model, reasoningEffort } = {}) {
    return this.request("session/selectModel", {
      request: {
        sessionId,
        provider,
        model,
        reasoningEffort,
      },
    }, { timeoutMs: 15000 });
  }

  async listSkills(sessionId) {
    if (!sessionId) return [];
    try {
      const data = await this.request("skills/list", {
        request: { sessionId },
      });
      return data?.skills || [];
    } catch (err) {
      console.warn("[dsh-client] skills/list failed:", err);
      return [];
    }
  }

  async archiveSession(sessionId) {
    return this.request("workspace/archiveSession", {
      request: { sessionId, stopActivity: true },
    });
  }

  async unarchiveSession(sessionId) {
    return this.request("workspace/unarchiveSession", {
      request: { sessionId },
    });
  }

  async requestArchivePlugin(route, { method = "GET", body, allowConflict = false } = {}) {
    const url = `${this.baseUrl}/plugins/dsh-archived-chats/${route}`;
    const headers = {
      Accept: "application/json",
      Host: this.host,
      Origin: this.baseUrl,
      "x-dsh-archived-chats": "1",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.cookie) headers.Cookie = this.cookie;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let response;
    let responseText;
    try {
      response = await fetch(url, {
        method,
        headers,
        signal: controller.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      responseText = await response.text();
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`DSH 归档管理请求 ${route} 等待超过 15 秒，已停止等待`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    let value;
    try {
      value = responseText ? JSON.parse(responseText) : {};
    } catch {
      value = {};
    }
    if (!response.ok && !(allowConflict && response.status === 409)) {
      const detail = value?.message || value?.error || responseText || `HTTP ${response.status}`;
      throw new Error(`DSH 归档管理请求失败: ${detail}`);
    }
    return value;
  }

  async listArchivedSessions() {
    const result = await this.requestArchivePlugin("state");
    if (!Array.isArray(result?.sessions)) {
      throw new Error("DSH 归档管理没有返回归档会话列表");
    }
    return result.sessions;
  }

  async permanentlyDeleteArchivedSession(sessionId) {
    const result = await this.requestArchivePlugin("delete", {
      method: "POST",
      body: { sessionId, permanent: true },
      // The plugin uses 409 when a live session is durably queued for cleanup;
      // inspect the body so the app can hide it and report the deferred delete.
      allowConflict: true,
    });
    const removedIds = new Set([
      ...(Array.isArray(result?.deleted) ? result.deleted : []),
      ...(Array.isArray(result?.pending) ? result.pending : []),
    ].map(String));
    if (!removedIds.has(String(sessionId))) {
      const failure = Array.isArray(result?.failed)
        ? result.failed.find((item) => String(item?.id) === String(sessionId))
        : null;
      throw new Error(failure?.reason || "DSH 未确认对话已删除");
    }
    return result;
  }

  async respondEventResult({ clientId, eventId, outcome }) {
    if (!clientId) {
      throw new Error("DSH 交互事件通道尚未就绪");
    }
    return this.request("$events/result", {
      clientId,
      eventId,
      outcome,
    });
  }

  // --- WebSocket Streaming ---

  connectWebSocket() {
    if (this.isDisposed || this.ws) return;

    const wsUrl = `ws://${this.host}/api/remote.mux`;
    const headers = {
      Host: this.host,
      Origin: this.baseUrl,
    };
    if (this.cookie) {
      headers.Cookie = this.cookie;
    }

    try {
      this.ws = new WebSocket(wsUrl, { headers });
    } catch (err) {
      console.error("[dsh-client] WebSocket init error:", err);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      console.log("[dsh-client] Connected to remote.mux WebSocket");
      this.wsConnected = true;

      // 1. Open $events logical stream
      this.sendWsMessage({
        type: "open",
        streamId: "stream-events",
        endpoint: "$events",
        payload: { args: {} },
      });

      // Keep the Workspace archive projection in sync with DSH. session/list
      // includes archived sessions; DSH's own UI filters them using this feed.
      this.openWorkspaceStream();

      // 2. If we had an active followed session, restore follow stream
      if (this.activeFollowSessionId) {
        this.openFollowStream(this.activeFollowSessionId);
      }

      this.emit("connected");
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.handleWsMessage(msg);
      } catch (err) {
        console.warn("[dsh-client] Failed to parse WebSocket message:", err);
      }
    };

    this.ws.onerror = (err) => {
      console.warn("[dsh-client] WebSocket error:", err.message || err);
    };

    this.ws.onclose = () => {
      console.log("[dsh-client] WebSocket closed");
      this.ws = null;
      this.wsConnected = false;
      this.emit("disconnected");
      this.scheduleReconnect();
    };
  }

  sendWsMessage(message) {
    if (this.ws && this.wsConnected) {
      this.ws.send(JSON.stringify(message));
    }
  }

  scheduleReconnect() {
    if (this.isDisposed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWebSocket();
    }, 2000);
  }

  followSession(sessionId) {
    if (this.activeFollowSessionId === sessionId && this.followStreamId) {
      return;
    }

    if (this.followStreamId && this.wsConnected) {
      this.sendWsMessage({
        type: "cancel",
        streamId: this.followStreamId,
      });
    }

    this.activeFollowSessionId = sessionId;
    this.followStreamId = `stream-follow-${randomUUID()}`;

    if (this.wsConnected) {
      this.openFollowStream(sessionId, this.followStreamId);
    }
  }

  unfollowSession() {
    if (this.followStreamId && this.wsConnected) {
      this.sendWsMessage({
        type: "cancel",
        streamId: this.followStreamId,
      });
    }
    this.activeFollowSessionId = null;
    this.followStreamId = null;
  }

  openFollowStream(sessionId, streamId = this.followStreamId) {
    if (!streamId) return;
    this.sendWsMessage({
      type: "open",
      streamId,
      endpoint: "session/follow",
      payload: {
        args: {
          request: {
            address: { kind: "session", sessionId },
            assistantStream: true,
          },
        },
      },
    });
  }

  openWorkspaceStream() {
    this.sendWsMessage({
      type: "open",
      streamId: "stream-workspace",
      endpoint: "workspace/follow",
      payload: { args: {} },
    });
  }

  waitForWorkspaceBaseline(timeoutMs = 3000) {
    if (this.workspaceBaseline) {
      return Promise.resolve(this.workspaceBaseline);
    }

    return new Promise((resolve) => {
      const onBaseline = (baseline) => {
        clearTimeout(timeout);
        resolve(baseline);
      };
      const timeout = setTimeout(() => {
        this.off("workspaceBaseline", onBaseline);
        resolve(null);
      }, timeoutMs);
      this.once("workspaceBaseline", onBaseline);
    });
  }

  handleWsMessage(msg) {
    if (msg.type !== "item" || !msg.value) {
      return;
    }

    const { streamId, value } = msg;

    if (streamId === "stream-workspace") {
      if (value.type === "baseline") {
        this.workspaceBaseline = value.value;
        this.emit("workspaceBaseline", value.value);
      } else if (value.type === "archived") {
        this.emit("workspaceArchivedSessions", value.archivedSessionIds);
      }
      return;
    }

    // Global events stream
    if (streamId === "stream-events") {
      if (value.type === "ready") {
        this.clientId = value.clientId;
        console.log("[dsh-client] $events ready with clientId:", this.clientId);
        return;
      }

      if (value.type === "emit") {
        this.emit("globalEvent", { event: value.event, args: value.args });
        return;
      }

      if (value.type === "waterfall") {
        const interaction = {
          eventId: value.eventId,
          agentId: value.agentId,
          request: value.request,
        };
        this.pendingRemoteEvents.set(value.eventId, value.event);
        if (value.event === "approval/request") {
          this.emit("approvalRequested", interaction);
        } else if (value.event === "user-questions/request") {
          this.emit("userQuestionRequested", interaction);
        }
        return;
      }

      if (value.type === "cancel") {
        const event = this.pendingRemoteEvents.get(value.eventId);
        this.pendingRemoteEvents.delete(value.eventId);
        this.emit("remoteEventCancelled", { eventId: value.eventId, event });
        return;
      }
    }

    // Follow session stream
    if (streamId === this.followStreamId) {
      if (value.type === "snapshot") {
        this.emit("snapshot", value);
        return;
      }

      // Assistant stream chunks (real-time tokens)
      if (value.type === "assistant-stream" && value.frame) {
        const frame = value.frame;

        if (frame.type === "start") {
          this.emit("turnStart", { turn: frame.turn, step: frame.step });
        } else if (frame.type === "chunk" && frame.chunk) {
          const chunk = frame.chunk;
          if (chunk.type === "text-delta") {
            this.emit("textDelta", { text: chunk.text });
          } else if (chunk.type === "reasoning-delta") {
            this.emit("reasoningDelta", { text: chunk.text, index: chunk.index });
          } else if (chunk.type === "block-start") {
            this.emit("blockStart", chunk);
          } else if (chunk.type === "block-end") {
            this.emit("blockEnd", chunk);
          } else if (chunk.type === "usage") {
            this.emit("tokenUsage", chunk.usage);
          }
        } else if (frame.type === "end") {
          this.emit("assistantCommitted", frame.outcome);
        }
        return;
      }

      // Durable session events
      if (value.type === "event" && value.event) {
        const event = value.event;
        const eventType = event.type;
        const data = event.data;

        if (eventType === "turn/start") {
          this.emit("turnStart", data);
        } else if (eventType === "turn/end") {
          this.emit("turnEnd", data);
        } else if (eventType === "step/start") {
          this.emit("stepStart", data);
        } else if (eventType === "step/end") {
          this.emit("stepEnd", data);
        } else if (eventType === "tool/call") {
          this.emit("toolCall", data);
        } else if (eventType === "tool/result") {
          this.emit("toolResult", data);
        } else if (eventType === "approval/asked") {
          this.emit("approvalAsked", data);
        } else if (eventType === "approval/decided") {
          this.emit("approvalDecided", data);
        } else if (eventType === "session/title") {
          this.emit("sessionTitle", data);
        } else if (eventType === "assistant/message") {
          this.emit("assistantMessage", data);
        } else {
          this.emit("sessionEvent", event);
        }
      }
    }
  }

  dispose() {
    this.isDisposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this.pendingRemoteEvents.clear();
    this.removeAllListeners();
  }
}
