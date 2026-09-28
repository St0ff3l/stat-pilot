import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

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
    this.reconnectTimer = null;
    this.isDisposed = false;
    this.pendingRequests = new Map();
  }

  /**
   * Helper to execute a Typert RPC over HTTP POST.
   */
  async request(endpoint, args = {}) {
    const url = `${this.baseUrl}/api/${endpoint}`;
    const rpcId = randomUUID();

    const headers = {
      "Content-Type": "application/json",
      Host: this.host,
      Origin: this.baseUrl,
    };
    if (this.cookie) {
      headers.Cookie = this.cookie;
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
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
  }

  // --- Session Management RPCs ---

  async listSessions() {
    const data = await this.request("session/list", { _request: {} });
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

  async sendPrompt({ sessionId, text, mode = "queue", clientTimeZone } = {}) {
    return this.request("session/prompt", {
      request: {
        requestId: randomUUID(),
        sessionId,
        mode,
        content: [{ type: "text", text }],
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
    return this.request("session/modelCatalog", {});
  }

  async selectModel({ sessionId, provider, model, reasoningEffort } = {}) {
    return this.request("session/selectModel", {
      request: {
        sessionId,
        provider,
        model,
        reasoningEffort,
      },
    });
  }

  async listSkills(sessionId) {
    const data = await this.request("skill/list", {
      request: { sessionId },
    });
    return data?.skills || [];
  }

  async archiveSession(sessionId) {
    return this.request("workspace/archiveSession", {
      request: { sessionId },
    });
  }

  async unarchiveSession(sessionId) {
    return this.request("workspace/unarchiveSession", {
      request: { sessionId },
    });
  }

  async respondEventResult({ clientId, eventId, outcome }) {
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
    if (this.activeFollowSessionId === sessionId && this.wsConnected) {
      return;
    }

    this.activeFollowSessionId = sessionId;

    if (this.wsConnected) {
      // Cancel previous follow stream if any
      this.sendWsMessage({
        type: "cancel",
        streamId: "stream-follow",
      });

      this.openFollowStream(sessionId);
    }
  }

  openFollowStream(sessionId) {
    this.sendWsMessage({
      type: "open",
      streamId: "stream-follow",
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

  handleWsMessage(msg) {
    if (msg.type !== "item" || !msg.value) {
      return;
    }

    const { streamId, value } = msg;

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
    }

    // Follow session stream
    if (streamId === "stream-follow") {
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
            this.emit("reasoningDelta", { text: chunk.text });
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
    this.removeAllListeners();
  }
}
