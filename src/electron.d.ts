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
  };

  type HermesAppState = {
    status: string;
    error: string | null;
    settings: {
      hermesBin: string;
      model: string;
      cwd: string;
      apiProvider: "openrouter" | "deepseek" | "openai" | "custom";
      apiKey: string;
      apiBaseUrl: string;
      registeredSkills: Array<{ name: string; description: string; path: string }>;
    };
    threads: HermesThreadSummary[];
    activeThreadId: string | null;
    activeThread: HermesThreadSummary | null;
    messages: HermesChatMessage[];
    activeDraft: {
      id: string;
      threadId: string;
      text: string;
    } | null;
    busy: boolean;
    skills: Array<{ name: string; description: string; path: string }>;
  };

  interface Window {
    hermesDesktop: {
      getState: () => Promise<HermesAppState>;
      newThread: () => Promise<HermesAppState>;
      selectThread: (threadId: string) => Promise<HermesAppState>;
      sendMessage: (payload: { text: string }) => Promise<HermesAppState>;
      archiveThread: (threadId: string) => Promise<HermesAppState>;
      updateSettings: (settings: Partial<HermesAppState["settings"]>) => Promise<HermesAppState>;
      openExternal: (url: string) => Promise<void>;
      onState: (handler: (state: HermesAppState) => void) => () => void;
      registerSkillFile: () => Promise<HermesAppState>;
      unregisterSkill: (path: string) => Promise<HermesAppState>;
    };
  }
}

export {};
