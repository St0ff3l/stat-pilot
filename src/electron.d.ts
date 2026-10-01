declare global {
  const __APP_VERSION__: string;

  type DshThreadSummary = {
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

  type DshChatMessage = {
    id: string;
    role: "user" | "assistant";
    text: string;
    turnId: string | null;
    phase?: string | null;
    meta?: string;
    reasoning?: string | null;
    activities?: DshStreamActivity[];
  };

  type DshStreamActivity = {
    id: string;
    kind: "context" | "thinking" | "narrative" | "tool" | "status" | "subagent" | "error";
    label: string;
    detail?: string;
    output?: string;
    status: "running" | "complete" | "error" | "info";
    toolName?: string;
    streamIndex?: number;
    durationMs?: number;
  };

  type DshSelectedFile = {
    path: string;
    name: string;
    size?: number;
  };

  type DshAccountView = {
    status: "signed-out" | "credential-stored";
    links: { usageUrl: string; topUpUrl: string };
    attempt: {
      id: string;
      phase: "initializing" | "waiting-browser" | "exchanging" | "committing" | "succeeded" | "cancelled" | "expired" | "failed";
      authorizeUrl?: string;
      expiresAt?: number;
      errorCode?: "network" | "protocol" | "expired" | "storage";
    } | null;
  };

  type DshSpeechProviderView = {
    id: string;
    name: string;
    preparation?: {
      phase: string;
      completedBytes?: number;
      totalBytes?: number;
      message?: string;
    };
  };

  type DshSpeechCatalog = {
    providers: DshSpeechProviderView[];
    selection: { providerId: string; language: string };
    maxAudioBytes: number;
    maxDurationSeconds: number;
  };

  type DshQuestionOption = {
    label: string;
    description?: string;
  };

  type DshUserQuestion = {
    id: string;
    question: string;
    detail?: string;
    header?: string;
    options?: DshQuestionOption[];
    multiSelect?: boolean;
    intent?: { kind: string; approve?: string; callId?: string };
  };

  type DshQuestionAnswer = {
    id: string;
    selected: string[];
    custom?: string;
  };

  type DshQuestionDraft = {
    selected: string[];
    custom: string;
  };

  type DshAppState = {
    status: string;
    error: string | null;
    currentRuntimeModel: string | null;
    currentModelSelection: { provider: string; model: string; reasoningEffort?: string } | null;
    modelCatalog: {
      default: { provider: string; model: string; reasoningEffort?: string };
      routableProviders: string[];
      groups: Array<{
        id: string;
        name: string;
        models: Array<{
          id: string;
          name: string;
          description?: string;
          reasoning?: {
            efforts: Array<{ id: string; name: string; description?: string }>;
            defaultEffort?: string;
          };
        }>;
      }>;
      failures: Array<{ id: string; name: string; message: string }>;
    } | null;
    lastUsageModel: string | null;
    reasoningTrace: string | null;
    settings: {
      dshBin: string;
      permissionDefaultPreset: "read-only" | "workspace-write" | "danger-full-access";
      model: string;
      reasoningEffort?: string;
      authMode: "auto" | "api" | "account";
      apiModel: string;
      accountModel: string;
      cwd: string;
      defaultOutputDir?: string;
      customModels?: string[];
      customModelsByProvider?: Partial<Record<"deepseek" | "openai" | "openrouter" | "custom", string[]>>;
      apiModelsByProvider?: Partial<Record<"deepseek" | "openai" | "openrouter" | "custom", string>>;
      apiProvider: "openrouter" | "deepseek" | "openai" | "custom";
      apiKey: string;
      apiBaseUrl: string;
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
    account: DshAccountView | null;
    permissionPresets: Array<{ value: string; name: string; description?: string }>;
    permissionDefaultPreset: string;
    currentPermissionPreset: string | null;
    defaultAgentPreset: string;
    currentAgentPreset: string | null;
    providerCredentialStatus: Record<"deepseek" | "openai" | "openrouter" | "custom", { configured: boolean; writable: boolean }>;
    threads: DshThreadSummary[];
    archivedThreads: DshThreadSummary[];
    activeThreadId: string | null;
    activeThread: DshThreadSummary | null;
    messages: DshChatMessage[];
    activeDraft: {
      id: string;
      threadId: string;
      text: string;
      pendingText?: string;
      reasoning?: string;
      segments?: Array<{ reasoning?: string; text?: string }>;
      activities?: DshStreamActivity[];
    } | null;
    busy: boolean;
    skills: Array<{ name: string; displayName?: string; description: string; path: string }>;
    generatedFiles?: string[];
    lastGeneratedFiles?: string[] | null;
    pendingApproval?: {
      sessionId: string;
      requestId: string;
      agentId: string;
      command: string;
      description: string;
      patternKey: string;
      allowPermanent?: boolean;
    } | null;
    pendingClarification?: {
      sessionId: string | null;
      requestId: string;
      agentId: string;
      questions: DshUserQuestion[];
    } | null;
  };

  type DshDesktopBridge = {
      getState: () => Promise<DshAppState>;
      newThread: () => Promise<DshAppState>;
      selectThread: (threadId: string) => Promise<DshAppState>;
      sendMessage: (payload: {
        text: string;
        attachments?: Array<Pick<DshSelectedFile, "path" | "name">>;
      }) => Promise<DshAppState>;
      stopMessage: () => Promise<DshAppState>;
      selectWorkspaceFolder: () => Promise<{ cwd: string; folderName: string; branch: string | null } | null>;
      selectFiles: () => Promise<DshSelectedFile[]>;
      selectSessionModel: (selection: { provider: string; model: string; reasoningEffort?: string }) => Promise<DshAppState>;
      refreshModelCatalog: () => Promise<DshAppState>;
      setPermissionPreset: (preset: "read-only" | "workspace-write" | "danger-full-access") => Promise<DshAppState>;
      archiveThread: (threadId: string) => Promise<DshAppState>;
      unarchiveThread: (threadId: string) => Promise<DshAppState>;
      deleteArchivedThread: (threadId: string) => Promise<{ state: DshAppState; pendingDeletion: boolean }>;
      getSpeechCatalog: () => Promise<DshSpeechCatalog>;
      prepareSpeechProvider: (providerId: string) => Promise<void>;
      cancelSpeechPreparation: (providerId: string) => Promise<void>;
      transcribeSpeech: (request: { audioBase64: string; providerId?: string; language?: string }) => Promise<{ text: string; audioSeconds: number; inferenceSeconds: number }>;
      updateSettings: (settings: Partial<DshAppState["settings"]>) => Promise<DshAppState>;
      clearProviderApiKey: (provider: DshAppState["settings"]["apiProvider"]) => Promise<DshAppState>;
      startAccountSignIn: () => Promise<DshAppState>;
      cancelAccountSignIn: () => Promise<DshAppState>;
      signOutAccount: () => Promise<DshAppState>;
      repairRuntime: () => Promise<DshAppState>;
      openExternal: (url: string) => Promise<void>;
      openOutputDirectory: () => Promise<string>;
      onState: (handler: (state: DshAppState) => void) => () => void;
      registerSkillFile: () => Promise<DshAppState>;
      unregisterSkill: (path: string) => Promise<DshAppState>;
      respondApproval: (requestId: string, choice: "once" | "deny") => Promise<DshAppState>;
      respondClarification: (requestId: string, answers: DshQuestionAnswer[]) => Promise<DshAppState>;
      cancelClarification: (requestId: string) => Promise<DshAppState>;
      ackThreadCompleted: (threadId: string) => Promise<DshAppState>;
  };

  interface Window {
    dshDesktop: DshDesktopBridge;
  }
}

export {};
