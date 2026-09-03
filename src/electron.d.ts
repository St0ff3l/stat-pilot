declare global {
  const __APP_VERSION__: string;

  type HermesThreadSummary = {
    id: string;
    name: string | null;
    preview: string;
    modelProvider: string;
    status: string;
    updatedAt: number;
    createdAt: number;
    cwd: string;
    taskStatus?: "idle" | "running" | "queued" | "completed" | "error" | "clarifying" | "approving";
  };

  type HermesChatMessage = {
    id: string;
    role: "user" | "assistant";
    text: string;
    turnId: string | null;
    phase?: string | null;
    meta?: string;
    reasoning?: string | null;
    activities?: HermesStreamActivity[];
  };

  type HermesStreamActivity = {
    id: string;
    kind: "context" | "thinking" | "narrative" | "tool" | "status" | "subagent" | "error";
    label: string;
    detail?: string;
    status: "running" | "complete" | "error" | "info";
    toolName?: string;
    durationMs?: number;
  };

  type HermesSelectedFile = {
    path: string;
    name: string;
    size?: number;
  };

  type HermesAppState = {
    status: string;
    error: string | null;
    currentRuntimeModel: string | null;
    lastUsageModel: string | null;
    reasoningTrace: string | null;
    settings: {
      hermesBin: string;
      runtimeMode: "private" | "official";
      yoloMode: boolean;
      model: string;
      cwd: string;
      defaultOutputDir?: string;
      apiProvider: "openrouter" | "deepseek" | "openai" | "custom";
      apiKey: string;
      apiBaseUrl: string;
      visionModel: string;
      visionProvider: "openai" | "openrouter" | "ollama" | "custom";
      visionApiKey: string;
      visionBaseUrl: string;
      registeredSkills: Array<{ name: string; displayName?: string; description: string; path: string }>;
      firecrawlApiKey?: string;
      exaApiKey?: string;
      falApiKey?: string;
      voiceToolsOpenaiKey?: string;
      browserbaseApiKey?: string;
      browserbaseProjectId?: string;
      logoutOfficial?: boolean;
      loginOfficial?: boolean;
    };
    runtime: {
      installed: boolean;
      uninstalling: boolean;
      rootDir: string;
      installDir: string;
      homeDir: string;
      bundledSourceDir: string;
      bundledWithApp: boolean;
    };
    official: {
      available: boolean;
      homeDir: string;
      configPath: string;
      authPath: string;
      provider: string;
      defaultModel: string;
      isLoggedIn: boolean;
      subscriptionLabel: string;
      rateLimitSource: string;
      availableModels: string[];
      freeRecommendedModels: string[];
      paidRecommendedModels: string[];
      userCode?: string | null;
    };
    threads: HermesThreadSummary[];
    activeThreadId: string | null;
    activeThread: HermesThreadSummary | null;
    messages: HermesChatMessage[];
    activeDraft: {
      id: string;
      threadId: string;
      text: string;
      pendingText?: string;
      reasoning?: string;
      segments?: Array<{ reasoning?: string; text?: string }>;
      activities?: HermesStreamActivity[];
    } | null;
    busy: boolean;
    skills: Array<{ name: string; displayName?: string; description: string; path: string }>;
    lastGeneratedFiles?: string[] | null;
    pendingApproval?: {
      sessionId: string;
      approvalId?: string | null;
      command: string;
      description: string;
      patternKey: string;
      allowPermanent?: boolean;
    } | null;
    pendingClarification?: {
      sessionId: string;
      requestId?: string | null;
      question: string;
      choices?: string[] | null;
    } | null;
  };

  interface Window {
    hermesDesktop: {
      getState: () => Promise<HermesAppState>;
      newThread: () => Promise<HermesAppState>;
      selectThread: (threadId: string) => Promise<HermesAppState>;
      sendMessage: (payload: { text: string }) => Promise<HermesAppState>;
      stopMessage: () => Promise<HermesAppState>;
      selectWorkspaceFolder: () => Promise<{ cwd: string; folderName: string; branch: string | null } | null>;
      selectFiles: () => Promise<HermesSelectedFile[]>;
      switchSessionModel: (model: string) => Promise<HermesAppState>;
      archiveThread: (threadId: string) => Promise<HermesAppState>;
      updateSettings: (settings: Partial<HermesAppState["settings"]>) => Promise<HermesAppState>;
      cancelOfficialLogin: () => Promise<HermesAppState>;
      repairRuntime: () => Promise<HermesAppState>;
      uninstallRuntime: () => Promise<HermesAppState>;
      openExternal: (url: string) => Promise<void>;
      onState: (handler: (state: HermesAppState) => void) => () => void;
      registerSkillFile: () => Promise<HermesAppState>;
      unregisterSkill: (path: string) => Promise<HermesAppState>;
      respondApproval: (choice: "once" | "session" | "always" | "deny") => Promise<HermesAppState>;
      respondClarification: (answer: string) => Promise<HermesAppState>;
      ackThreadCompleted: (threadId: string) => Promise<HermesAppState>;
    };
  }
}

export {};
