declare global {
  type HermesThreadSummary = {
    id: string;
    name: string | null;
    preview: string;
    modelProvider: string;
    status: string;
    updatedAt: number;
    createdAt: number;
    cwd: string;
  };

  type HermesChatMessage = {
    id: string;
    role: "user" | "assistant";
    text: string;
    turnId: string | null;
    phase?: string | null;
    meta?: string;
    reasoning?: string | null;
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
      registeredSkills: Array<{ name: string; description: string; path: string }>;
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
      reasoning?: string;
    } | null;
    busy: boolean;
    skills: Array<{ name: string; description: string; path: string }>;
    lastGeneratedFiles?: string[] | null;
  };

  interface Window {
    hermesDesktop: {
      getState: () => Promise<HermesAppState>;
      newThread: () => Promise<HermesAppState>;
      selectThread: (threadId: string) => Promise<HermesAppState>;
      sendMessage: (payload: { text: string }) => Promise<HermesAppState>;
      switchSessionModel: (model: string) => Promise<HermesAppState>;
      archiveThread: (threadId: string) => Promise<HermesAppState>;
      updateSettings: (settings: Partial<HermesAppState["settings"]>) => Promise<HermesAppState>;
      repairRuntime: () => Promise<HermesAppState>;
      uninstallRuntime: () => Promise<HermesAppState>;
      openExternal: (url: string) => Promise<void>;
      onState: (handler: (state: HermesAppState) => void) => () => void;
      registerSkillFile: () => Promise<HermesAppState>;
      unregisterSkill: (path: string) => Promise<HermesAppState>;
    };
  }
}

export {};
