import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { ClientRequest, InitializeResponse, ServerNotification } from "../generated/index.js";
import type {
  SkillMetadata,
  SkillsListEntry,
  SkillsListResponse,
  Thread,
  ThreadItem,
  ThreadReadResponse,
  ThreadStartResponse,
  TurnStartResponse,
} from "../generated/v2/index.js";
import type { SkillSummary } from "../types.js";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

type JsonRpcError = {
  code: number;
  message: string;
};

type JsonRpcResponse = {
  id: number;
  result?: unknown;
  error?: JsonRpcError;
};

export class HermesAppServerClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private notificationListeners = new Set<(message: ServerNotification) => void>();
  private initialized = false;
  private readonly hermesPath: string;
  private readonly model: string;
  private readonly cwd: string;
  private readonly skillRoot: string;

  constructor() {
    this.hermesPath = process.env.HERMES_BIN ?? "hermes";
    this.model = process.env.CODEX_MODEL ?? "gpt-5.4";
    this.cwd = process.cwd();
    this.skillRoot = path.resolve(this.cwd, "skills");
  }

  private async start(): Promise<void> {
    if (this.proc) {
      return;
    }

    this.proc = spawn(this.hermesPath, ["app-server", "--stdio"], {
      cwd: this.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const lineReader = readline.createInterface({
      input: this.proc.stdout,
      crlfDelay: Infinity,
    });

    lineReader.on("line", (line) => {
      if (!line.trim()) {
        return;
      }

      const message = JSON.parse(line) as JsonRpcResponse | ServerNotification;

      if ("id" in message) {
        const pending = this.pending.get(message.id);
        if (!pending) {
          return;
        }

        this.pending.delete(message.id);

        if (message.error) {
          pending.reject(new Error(message.error.message));
          return;
        }

        pending.resolve(message.result);
        return;
      }

      for (const listener of this.notificationListeners) {
        listener(message);
      }

      if (message.method === "error") {
        console.error("[hermes-runtime:error]", message.params);
      }
    });

    this.proc.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) {
        console.error("[hermes-runtime:stderr]", text);
      }
    });

    this.proc.on("exit", () => {
      this.proc = null;
      this.initialized = false;
      for (const entry of this.pending.values()) {
        entry.reject(new Error("Hermes runtime exited unexpectedly."));
      }
      this.pending.clear();
    });

    await this.initialize();
  }

  private async initialize(): Promise<InitializeResponse> {
    if (this.initialized) {
      return {
        userAgent: "already-initialized",
        platformFamily: "unknown",
        platformOs: "unknown",
      };
    }

    const result = (await this.request({
      method: "initialize",
      params: {
        clientInfo: {
          name: "sz_gov_scope",
          title: "深小统",
          version: "0.1.0",
        },
      },
    })) as InitializeResponse;

    this.notify({ method: "initialized" });
    this.initialized = true;

    await this.request({
      method: "skills/extraRoots/set",
      params: {
        extraRoots: [this.skillRoot],
      },
    });

    return result;
  }

  private notify(message: { method: "initialized" }): void {
    if (!this.proc) {
      throw new Error("Hermes runtime is not running.");
    }
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async readLocalSkills(): Promise<SkillSummary[]> {
    const entries = await fs.readdir(this.skillRoot, { withFileTypes: true }).catch(() => []);
    const localSkills: SkillSummary[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (entry.name === ".DS_Store" || entry.name.startsWith("._")) {
        continue;
      }

      const skillFile = path.join(this.skillRoot, entry.name, "SKILL.md");
      const content = await fs.readFile(skillFile, "utf8").catch(() => "");
      const descriptionLine = content
        .split("\n")
        .find((line) => line.trim().startsWith("description:"));
      const displayNameLine = content
        .split("\n")
        .find((line) => line.trim().startsWith("display_name:"));

      localSkills.push({
        name: entry.name,
        ...(displayNameLine
          ? {
              displayName: displayNameLine
                .replace("display_name:", "")
                .trim()
                .replace(/^["']|["']$/g, ""),
            }
          : {}),
        description: descriptionLine
          ? descriptionLine.replace("description:", "").trim().replace(/^"|"$/g, "")
          : "Local project skill",
        path: skillFile,
      });
    }

    return localSkills;
  }

  private async request(message: Omit<ClientRequest, "id">): Promise<unknown> {
    await this.start();

    if (!this.proc) {
      throw new Error("Hermes runtime failed to start.");
    }

    const id = this.nextId++;
    const payload = { ...message, id };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc?.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  async listSkills(): Promise<SkillSummary[]> {
    const localSkills = await this.readLocalSkills();
    const result = (await this.request({
      method: "skills/list",
      params: {
        cwds: [this.cwd],
        forceReload: true,
      },
    })) as SkillsListResponse;

    const remoteSkills = result.data.flatMap((entry) =>
      (entry as SkillsListEntry).skills.map((skill: SkillMetadata) => ({
        name: skill.name,
        description: skill.description,
        path: skill.path,
      })),
    );

    const merged = new Map<string, SkillSummary>();

    for (const skill of [...localSkills, ...remoteSkills]) {
      merged.set(skill.name, skill);
    }

    return Array.from(merged.values());
  }

  async analyzeArticle(options: {
    articleTitle: string;
    articleContent: string;
    skillName: string;
    skillPath: string;
  }): Promise<string> {
    const threadStart = (await this.request({
      method: "thread/start",
      params: {
        model: this.model,
        cwd: this.cwd,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        baseInstructions:
          "You are an analyst for Shenzhen government information monitoring. Answer from the provided text only. Do not use tools, shell commands, file edits, or browser actions.",
      },
    })) as ThreadStartResponse;

    let activeTurnId: string | null = null;

    const outputPromise = new Promise<string>((resolve, reject) => {
      let buffer = "";

      const listener = (message: ServerNotification) => {
        if (
          message.method === "item/agentMessage/delta" &&
          message.params.threadId === threadStart.thread.id &&
          (activeTurnId === null || message.params.turnId === activeTurnId)
        ) {
          activeTurnId = message.params.turnId;
          buffer += message.params.delta;
        }

        if (
          message.method === "turn/completed" &&
          message.params.threadId === threadStart.thread.id &&
          (activeTurnId === null || message.params.turn.id === activeTurnId)
        ) {
          this.notificationListeners.delete(listener);
          resolve(buffer.trim());
        }

        if (message.method === "error") {
          this.notificationListeners.delete(listener);
          reject(new Error("Hermes runtime reported an error notification."));
        }
      };

      this.notificationListeners.add(listener);
    });

    const turnStart = (await this.request({
      method: "turn/start",
      params: {
        threadId: threadStart.thread.id,
        model: this.model,
        input: [
          {
            type: "skill",
            name: options.skillName,
            path: options.skillPath,
          },
          {
            type: "text",
            text: `Please analyze the following article.\n\nTitle: ${options.articleTitle}\n\nContent:\n${options.articleContent}`,
            text_elements: [],
          },
        ],
      },
    })) as TurnStartResponse;

    activeTurnId = turnStart.turn.id;

    const output = await outputPromise;

    if (output) {
      return output;
    }

    const threadRead = (await this.request({
      method: "thread/read",
      params: {
        threadId: threadStart.thread.id,
        includeTurns: true,
      },
    })) as ThreadReadResponse;

    const messageFromItems =
      (threadRead.thread as Thread).turns
        .flatMap((turn) => turn.items)
        .map((item: ThreadItem) => (item.type === "agentMessage" ? item.text : ""))
        .filter(Boolean)
        .join("\n")
        .trim() ?? "";

    if (messageFromItems) {
      return messageFromItems;
    }

    return "Analysis completed, but no agent message text was extracted from notifications or thread history.";
  }
}

export const hermesAppServerClient = new HermesAppServerClient();
