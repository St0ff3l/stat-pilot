import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

function formatRelativeTime(value: number): string {
  const date = new Date(value * 1000);
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function withDisplayModel(appState: HermesAppState): HermesAppState["settings"] {
  return {
    defaultOutputDir: "outputs",
    ...appState.settings,
    model: appState.settings.runtimeMode === "official" ? appState.official.defaultModel : appState.settings.model,
  };
}

function MessageBody({ role, text }: { role: HermesChatMessage["role"]; text: string }) {
  if (role === "user") {
    return <pre className="message-plain">{text}</pre>;
  }

  return (
    <div className="message-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p>{children}</p>,
          ul: ({ children }) => <ul>{children}</ul>,
          ol: ({ children }) => <ol>{children}</ol>,
          li: ({ children }) => <li>{children}</li>,
          code: ({ className, children, ...props }) => {
            const isBlock = Boolean(className);
            if (!isBlock) {
              return (
                <code className="inline-code" {...props}>
                  {children}
                </code>
              );
            }

            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          pre: ({ children }) => <pre className="code-block">{children}</pre>,
          blockquote: ({ children }) => <blockquote>{children}</blockquote>,
          h1: ({ children }) => <h1>{children}</h1>,
          h2: ({ children }) => <h2>{children}</h2>,
          h3: ({ children }) => <h3>{children}</h3>,
          hr: () => <hr />,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="table-wrap">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function TraceBlock({ text, open = false }: { text: string; open?: boolean }) {
  return (
    <details className="trace-block" open={open}>
      <summary>思考过程</summary>
      <div className="message-markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {text}
        </ReactMarkdown>
      </div>
    </details>
  );
}

function BusyOverlay({ title, detail, elapsedSeconds }: { title: string; detail: string; elapsedSeconds: number }) {
  return (
    <div className="busy-overlay" role="status" aria-live="polite" aria-busy="true">
      <div className="busy-box">
        <div className="spinner" aria-hidden="true" />
        <h3>{title}</h3>
        <p>{detail}</p>
        <span className="busy-timer">当前已等待 {elapsedSeconds}s</span>
      </div>
    </div>
  );
}

export default function App() {
  const [state, setState] = useState<HermesAppState | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeSettingsTab, setActiveSettingsTab] = useState<"runtime" | "chat" | "vision" | "tools">("runtime");
  const [draft, setDraft] = useState("");
  const [isThreadLoading, setIsThreadLoading] = useState(false);
  const [dismissedFiles, setDismissedFiles] = useState<string[] | null>(null);
  const [dismissedError, setDismissedError] = useState<string | null>(null);

  const isTokenError = (err?: string | null) => {
    if (!err) return false;
    return /invalid refresh token|refresh_token|token expired|agent init failed/i.test(err);
  };

  const showTokenErrorModal = Boolean(
    state?.error &&
      isTokenError(state.error) &&
      dismissedError !== state.error
  );

  const [recentFolders, setRecentFolders] = useState<Array<{ path: string; name: string }>>(() => {
    try {
      const saved = localStorage.getItem("hermes_recent_folders");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [isFolderMenuOpen, setIsFolderMenuOpen] = useState(false);
  const [activeBranch, setActiveBranch] = useState<string | null>(null);
  const [activeMainTab, setActiveMainTab] = useState<"chat" | "skills">("chat");
  const [skillsSearchQuery, setSkillsSearchQuery] = useState("");
  const [selectedSkillTag, setSelectedSkillTag] = useState<string | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const editorTextRef = useRef<HTMLSpanElement>(null);
  const editorInputSyncRef = useRef(false);

  function focusEditor() {
    window.setTimeout(() => {
      editorRef.current?.focus();
      const selection = window.getSelection();
      if (selection && editorRef.current) {
        selection.selectAllChildren(editorRef.current);
        selection.collapseToEnd();
      }
    }, 0);
  }

  function readComposerText(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (!(node instanceof HTMLElement)) return "";
    if (node.dataset.skill) return `@${node.dataset.skill}`;
    return Array.from(node.childNodes).map(readComposerText).join("");
  }

  function syncEditorDraft() {
    if (!editorRef.current) return;
    const serialized = readComposerText(editorRef.current).replace(/\u00a0/g, " ");
    const skillToken = selectedSkillTag ? `@${selectedSkillTag}` : "";
    editorInputSyncRef.current = true;
    setDraft(skillToken && serialized.includes(skillToken)
      ? serialized.replace(skillToken, "").replace(/^\s+/, "")
      : serialized);
  }

  useEffect(() => {
    if (editorRef.current) {
      const wasEditorInput = editorInputSyncRef.current;
      editorInputSyncRef.current = false;
      if (!wasEditorInput && editorTextRef.current && editorTextRef.current.textContent !== draft) {
        editorTextRef.current.textContent = draft;
      }
      editorRef.current.style.height = "auto";
      const scrollH = editorRef.current.scrollHeight;
      const targetH = Math.min(Math.max(scrollH, 64), 220);
      editorRef.current.style.height = `${targetH}px`;
    }
  }, [draft]);

  // Convert typed @SkillName into selectedSkillTag pill automatically
  useEffect(() => {
    if (draft && !selectedSkillTag && state?.skills) {
      const match = draft.match(/^@([^\s]+)\s*/);
      if (match) {
        const matchedName = match[1];
        const found = state.skills.find((s) => s.name.toLowerCase() === matchedName.toLowerCase());
        if (found) {
          setSelectedSkillTag(found.name);
          setDraft((prev) => prev.replace(/^@[^\s]+\s*/, ""));
          setTimeout(() => {
            focusEditor();
          }, 60);
        }
      }
    }
  }, [draft, selectedSkillTag, state?.skills]);

  function handleUseSkillInChat(skillName: string) {
    setActiveMainTab("chat");
    setSelectedSkillTag(skillName);
    setTimeout(() => {
      focusEditor();
    }, 60);
  }

  async function handleStopMessage() {
    if (!window.hermesDesktop) return;
    const nextState = await window.hermesDesktop.stopMessage();
    setState(nextState);
  }

  async function handleSelectWorkspaceFolder() {
    if (!window.hermesDesktop) return;
    setIsFolderMenuOpen(false);
    const result = await window.hermesDesktop.selectWorkspaceFolder();
    if (result) {
      setActiveBranch(result.branch);
      const newEntry = { path: result.cwd, name: result.folderName };
      setRecentFolders((prev) => {
        const filtered = prev.filter((item) => item.path !== result.cwd);
        const updated = [newEntry, ...filtered].slice(0, 5);
        localStorage.setItem("hermes_recent_folders", JSON.stringify(updated));
        return updated;
      });
      const nextState = await window.hermesDesktop.getState();
      setState(nextState);
    }
  }

  async function handleSwitchWorkspaceFolder(folderPath: string) {
    if (!window.hermesDesktop) return;
    setIsFolderMenuOpen(false);
    const nextState = await window.hermesDesktop.updateSettings({ cwd: folderPath });
    setState(nextState);
  }

  const [rightSidebarOpen, setRightSidebarOpen] = useState(false);
  const [threadFiles, setThreadFiles] = useState<string[]>([]);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem("hermes_sidebar_width");
    if (saved) {
      const parsed = parseInt(saved, 10);
      if (!isNaN(parsed) && parsed >= 260 && parsed <= 500) {
        return parsed;
      }
    }
    return 270;
  });

  const isResizingRef = useRef(false);

  const startResizing = (mouseDownEvent: React.MouseEvent) => {
    mouseDownEvent.preventDefault();
    isResizingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    
    const handleMouseMove = (mouseMoveEvent: MouseEvent) => {
      if (!isResizingRef.current) return;
      const newWidth = mouseMoveEvent.clientX;
      if (newWidth >= 260 && newWidth <= 500) {
        setSidebarWidth(newWidth);
        localStorage.setItem("hermes_sidebar_width", String(newWidth));
      }
    };

    const handleMouseUp = () => {
      isResizingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  };

  const [headerModelSelection, setHeaderModelSelection] = useState("");
  const [busyElapsedSeconds, setBusyElapsedSeconds] = useState(0);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [settingsBusyText, setSettingsBusyText] = useState<string | null>(null);
  const headerModelDirtyRef = useRef(false);
  const [draftSettings, setDraftSettings] = useState<HermesAppState["settings"]>({
    hermesBin: "hermes",
    runtimeMode: "private",
    model: "deepseek-chat",
    cwd: "",
    defaultOutputDir: "outputs",
    apiProvider: "deepseek",
    apiKey: "",
    apiBaseUrl: "",
    visionModel: "",
    visionProvider: "openai",
    visionApiKey: "",
    visionBaseUrl: "",
    registeredSkills: [],
    firecrawlApiKey: "",
    exaApiKey: "",
    falApiKey: "",
    voiceToolsOpenaiKey: "",
    browserbaseApiKey: "",
    browserbaseProjectId: "",
  });
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;

    async function bootstrap() {
      if (!window.hermesDesktop) {
        return;
      }

      const initial = await window.hermesDesktop.getState();
      setState(initial);
      setHeaderModelSelection(initial.official.defaultModel);
      headerModelDirtyRef.current = false;
      setDraftSettings(withDisplayModel(initial));

      unsubscribe = window.hermesDesktop.onState((nextState) => {
        setState(nextState);
        if (!headerModelDirtyRef.current) {
          setHeaderModelSelection(nextState.official.defaultModel);
        }
        setDraftSettings(withDisplayModel(nextState));
      });
    }

    void bootstrap();

    return () => unsubscribe?.();
  }, []);

  // Load files when active thread changes
  useEffect(() => {
    if (state?.activeThreadId) {
      const key = `hermes_files_${state.activeThreadId}`;
      const existingStr = localStorage.getItem(key);
      if (existingStr) {
        try {
          const files = JSON.parse(existingStr);
          if (Array.isArray(files)) {
            setThreadFiles(files);
            return;
          }
        } catch (e) {
          // ignore
        }
      }
    }
    setThreadFiles([]);
  }, [state?.activeThreadId]);

  // Append files when new ones are generated
  useEffect(() => {
    if (state?.activeThreadId && state?.lastGeneratedFiles && state.lastGeneratedFiles.length > 0) {
      const key = `hermes_files_${state.activeThreadId}`;
      setThreadFiles((prev) => {
        const merged = Array.from(new Set([...prev, ...state.lastGeneratedFiles!]));
        localStorage.setItem(key, JSON.stringify(merged));
        return merged;
      });
      setRightSidebarOpen(true);
    }
  }, [state?.activeThreadId, state?.lastGeneratedFiles]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [state?.messages.length, state?.activeDraft?.text]);

  useEffect(() => {
    const isModelSwitching = !!state?.busy && !!state?.status && state.status.includes("切换模型");
    if (!isModelSwitching) {
      setBusyElapsedSeconds(0);
      return;
    }

    setBusyElapsedSeconds(0);
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setBusyElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    }, 250);

    return () => window.clearInterval(timer);
  }, [state?.busy, state?.status]);

  // Reset draft settings to current actual saved settings whenever settings modal is opened
  useEffect(() => {
    if (settingsOpen && state) {
      setDraftSettings(withDisplayModel(state));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen]);

  async function createNewChat() {
    if (!window.hermesDesktop) {
      return;
    }

    setActiveMainTab("chat");
    setSelectedSkillTag(null);
    setIsThreadLoading(true);
    try {
      const nextState = await window.hermesDesktop.newThread();
      setState(nextState);
      setDraft("");
    } finally {
      setIsThreadLoading(false);
    }
  }

  async function selectThread(threadId: string) {
    if (!window.hermesDesktop) {
      return;
    }

    setActiveMainTab("chat");
    setSelectedSkillTag(null);
    setIsThreadLoading(true);
    try {
      const nextState = await window.hermesDesktop.selectThread(threadId);
      setState(nextState);
      setDraft("");
    } finally {
      setIsThreadLoading(false);
    }
  }

  async function deleteThread(threadId: string, threadName?: string | null) {
    if (!window.hermesDesktop) {
      return;
    }

    const confirmed = window.confirm(`确认删除这条历史对话吗？${threadName ? `\n\n${threadName}` : ""}`);
    if (!confirmed) {
      return;
    }

    setIsThreadLoading(true);
    try {
      const nextState = await window.hermesDesktop.archiveThread(threadId);
      setState(nextState);
      localStorage.removeItem(`hermes_files_${threadId}`);
    } finally {
      setIsThreadLoading(false);
    }
  }

  async function sendMessage() {
    const rawText = draft.trim();
    if ((!rawText && !selectedSkillTag) || !window.hermesDesktop) {
      return;
    }

    const text = (editorRef.current
      ? readComposerText(editorRef.current)
      : (selectedSkillTag ? `@${selectedSkillTag} ${rawText}` : rawText)).trim();

    setDraft("");
    setSelectedSkillTag(null);
    if (editorRef.current) editorRef.current.innerHTML = "";
    const nextState = await window.hermesDesktop.sendMessage({ text });
    setState(nextState);
  }

  async function saveSettings() {
    if (!window.hermesDesktop) {
      return;
    }

    setSettingsBusyText("正在保存配置并应用...");
    try {
      const nextState = await window.hermesDesktop.updateSettings(draftSettings);
      setState(nextState);
      setSettingsOpen(false);
    } catch (e) {
      console.error("Failed to save settings:", e);
    } finally {
      setSettingsBusyText(null);
    }
  }

  async function closeSettingsModal() {
    if (!window.hermesDesktop) {
      setSettingsOpen(false);
      return;
    }

    setSettingsBusyText(isLoggingIn ? "正在取消官方登录..." : "正在关闭...");
    try {
      if (isLoggingIn) {
        const nextState = await window.hermesDesktop.cancelOfficialLogin();
        setState(nextState);
        if (!headerModelDirtyRef.current) {
          setHeaderModelSelection(nextState.official.defaultModel);
        }
        setIsLoggingIn(false);
      }
      setSettingsOpen(false);
    } catch (e) {
      console.error("Failed to close settings:", e);
    } finally {
      setSettingsBusyText(null);
    }
  }

  async function refreshOfficialConfig() {
    if (!window.hermesDesktop || !state) {
      return;
    }
    const nextState = await window.hermesDesktop.updateSettings({});
    setState(nextState);
    if (!headerModelDirtyRef.current) {
      setHeaderModelSelection(nextState.official.defaultModel);
    }
  }

  async function logoutOfficialConfig() {
    if (!window.hermesDesktop || !state) {
      return;
    }
    const nextState = await window.hermesDesktop.updateSettings({ logoutOfficial: true });
    setState(nextState);
    if (!headerModelDirtyRef.current) {
      setHeaderModelSelection(nextState.official.defaultModel);
    }
  }

  async function loginOfficialConfig() {
    if (!window.hermesDesktop || !state) {
      return;
    }
    setIsLoggingIn(true);
    try {
      const nextState = await window.hermesDesktop.updateSettings({ loginOfficial: true });
      setState(nextState);
      if (!headerModelDirtyRef.current) {
        setHeaderModelSelection(nextState.official.defaultModel);
      }
    } catch (e) {
      console.error("Login failed:", e);
    } finally {
      setIsLoggingIn(false);
    }
  }

  async function applyModelChange(selectedModel: string) {
    if (!window.hermesDesktop) {
      return;
    }
    setHeaderModelSelection(selectedModel);
    const nextState = await window.hermesDesktop.switchSessionModel(selectedModel);
    setState(nextState);
  }

  async function registerNewSkill() {
    if (!window.hermesDesktop) {
      return;
    }
    const nextState = await window.hermesDesktop.registerSkillFile();
    setState(nextState);
  }

  async function unregisterSkill(path: string) {
    if (!window.hermesDesktop) {
      return;
    }
    const nextState = await window.hermesDesktop.unregisterSkill(path);
    setState(nextState);
  }

  async function repairRuntime() {
    if (!window.hermesDesktop) {
      return;
    }
    const nextState = await window.hermesDesktop.repairRuntime();
    setState(nextState);
  }

  async function uninstallRuntime() {
    if (!window.hermesDesktop) {
      return;
    }

    const confirmed = window.confirm(
      "这会停止当前 Hermes 后台，并删除这个 Electron 应用私有目录里的 Hermes 运行时与会话数据。API 配置会保留。继续吗？"
    );
    if (!confirmed) {
      return;
    }

    const nextState = await window.hermesDesktop.uninstallRuntime();
    setState(nextState);
  }

  const currentCwd = state?.settings.cwd || "";
  const currentFolderName = currentCwd ? currentCwd.split(/[/\\]/).filter(Boolean).pop() || currentCwd : "选择项目";

  const orderedThreads = [...(state?.threads ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
  const groupedThreads = useMemo(() => {
    const groups: Array<{ folderName: string; threads: HermesThreadSummary[] }> = [];
    const map = new Map<string, HermesThreadSummary[]>();

    for (const thread of orderedThreads) {
      const rawCwd = (thread.cwd || "").trim();
      let folderName = "默认";
      if (rawCwd) {
        const parts = rawCwd.split(/[/\\]/).filter(Boolean);
        const name = parts.length > 0 ? parts[parts.length - 1] : "";
        if (name && name !== "sz-gov-scope") {
          folderName = name;
        }
      }
      if (!map.has(folderName)) {
        map.set(folderName, []);
      }
      map.get(folderName)!.push(thread);
    }

    if (map.has("默认")) {
      groups.push({ folderName: "默认", threads: map.get("默认")! });
      map.delete("默认");
    }

    for (const [folderName, threads] of map.entries()) {
      groups.push({ folderName, threads });
    }

    return groups;
  }, [orderedThreads]);
  const activeThread = state?.activeThread ?? null;
  const activeName = activeThread?.name || activeThread?.preview || "新对话";
  const activeMessages = state?.messages ?? [];
  const isOfficialMode = state?.settings.runtimeMode === "official";
  const resolvedUsageModel = state?.lastUsageModel?.trim() || state?.currentRuntimeModel?.trim() || null;
  const displayModel = resolvedUsageModel || (isOfficialMode ? state?.official.defaultModel : state?.settings.model) || "未设置";
  const needsProviderSetup = isOfficialMode ? !state?.official.isLoggedIn : !state?.settings.apiKey.trim();
  const runtimeInstalled = !!state?.runtime.installed;
  const officialModelDirty = !!state && draftSettings.runtimeMode === "official" && draftSettings.model !== state.official.defaultModel;
  const quickModelOptions = isOfficialMode
    ? ((state?.official.availableModels.length ?? 0) > 0 ? (state?.official.availableModels ?? []) : [state?.official.defaultModel ?? draftSettings.model])
    : [state?.settings.model ?? draftSettings.model];
  const quickModelDirty = isOfficialMode && !!state && headerModelSelection !== state.official.defaultModel;
  const isModelSwitching = !!state?.busy && !!state?.status && state.status.includes("切换模型");
  const isHermesMissing = !state?.runtime.installed || (!!state?.error && (
    state.error.includes("ENOENT") || 
    state.error.includes("找不到 Hermes") || 
    state.error.includes("No module named") ||
    state.error.includes("Hermes backend exited") ||
    state.error.includes("Could not connect to Hermes gateway") ||
    state.error.includes("did not become ready") ||
    state.error.includes("Bundled Hermes runtime source not found")
  ));
  const canSend = !needsProviderSetup && !isHermesMissing && !state?.busy;
  const isInitializing = !!state && !state.error && (
    state.status.startsWith("Starting") || 
    state.status.startsWith("Installing")
  );

  const statusDotClass = isHermesMissing
    ? "error"
    : needsProviderSetup
      ? "warning"
      : state?.error
        ? "error"
        : "";

  const statusLabel = isHermesMissing
    ? "运行时未就绪"
    : needsProviderSetup
      ? (isOfficialMode ? "官方账号未登录" : "未配置 API 密钥")
      : state?.error
        ? "运行异常"
        : (state?.status || "Ready.");

  if (!state) {
    return (
      <div
        className="shell"
        style={{
          gridTemplateColumns: `${sidebarWidth}px 1fr`,
        }}
      >
        <aside className="sidebar">
          <div className="sidebar-resizer" onMouseDown={startResizing} />
          <div className="brand">
            <div className="brand-title">
              <p className="eyebrow">深圳市统计局</p>
              <h1>深统政务 Scope</h1>
            </div>
          </div>
          <div className="empty-state">
            <strong>正在启动</strong>
            <p>正在连接并启动本地深统政务 Scope 后台...</p>
          </div>
        </aside>
        <main className="chat">
          <div className="welcome-card">
            <p className="eyebrow">Loading</p>
            <h3>准备智能工作台控制台</h3>
            <p>如果你是首次启动应用，连接本地进程需要几秒钟，请稍候。</p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div
      className={`shell ${rightSidebarOpen ? "with-right-sidebar" : ""}`}
      style={{
        gridTemplateColumns: `${sidebarWidth}px 1fr${rightSidebarOpen ? " 300px" : ""}`,
      }}
    >
      <aside className="sidebar">
        <div className="sidebar-resizer" onMouseDown={startResizing} />
        <div className="brand">
          <div className="brand-title">
            <p className="eyebrow">深圳市统计局</p>
            <h1>深统政务 Scope</h1>
          </div>
          <button
            className="ghost-button-icon"
            onClick={() => { setSettingsOpen(true); setActiveSettingsTab("runtime"); }}
            aria-label="设置"
            title="设置"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.1a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        </div>

        <div className="sidebar-action-list">
          <button
            type="button"
            className={`sidebar-action-item ${activeMainTab === "chat" ? "!bg-blue-50/80 !text-blue-600 font-bold" : ""}`}
            onClick={() => { setActiveMainTab("chat"); void createNewChat(); }}
            disabled={isHermesMissing}
            title="新建任务"
          >
            <svg className="w-4.5 h-4.5 text-current shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              <line x1="12" y1="8" x2="12" y2="14" />
              <line x1="9" y1="11" x2="15" y2="11" />
            </svg>
            <span>新建任务</span>
          </button>

          <button
            type="button"
            className={`sidebar-action-item ${activeMainTab === "skills" ? "!bg-blue-50/80 !text-blue-600 font-bold" : ""}`}
            onClick={() => setActiveMainTab("skills")}
            title="查看与管理我的技能"
          >
            <svg className="w-4.5 h-4.5 text-current shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7" rx="1.5" />
              <rect x="14" y="3" width="7" height="7" rx="1.5" />
              <rect x="14" y="14" width="7" height="7" rx="1.5" />
              <path d="M6.5 14v6m-3-3h6" />
            </svg>
            <span>我的技能</span>
          </button>
        </div>

        <div className="sidebar-section">
          <div className="section-head">
            <span>任务列表</span>
            <span>{isInitializing ? "..." : orderedThreads.length}</span>
          </div>

          <div className="thread-list">
            {isInitializing ? (
              <div className="flex flex-col gap-2 overflow-hidden p-1">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="w-full h-7 border border-slate-200 rounded-lg animate-pulse bg-slate-100" />
                ))}
              </div>
            ) : orderedThreads.length === 0 ? (
              <div className="history-empty-state">
                <svg className="history-empty-state-icon w-5 h-5" style={{ opacity: 0.4 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                <h4>暂无任务对话</h4>
                <p>新建一个对话即可开启开发与情报任务。</p>
              </div>
            ) : (
              groupedThreads.map(({ folderName, threads }) => (
                <div key={folderName} className="thread-folder-group">
                  <div className="thread-folder-header">
                    <svg className="w-3.5 h-3.5 text-slate-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
                    </svg>
                    <span className="truncate">{folderName}</span>
                  </div>
                  <div className="thread-folder-items">
                    {threads.map((thread) => {
                      const title = thread.name || thread.preview || "未命名对话";
                      const isActive = thread.id === state.activeThreadId;
                      return (
                        <div
                          key={thread.id}
                          className={`thread-item-slim group ${isActive ? "active" : ""}`}
                          onClick={() => void selectThread(thread.id)}
                          title={`${title} • ${formatRelativeTime(thread.updatedAt)}`}
                        >
                          <span className="thread-item-slim-title">{title}</span>
                          <button
                            type="button"
                            className="thread-item-slim-delete"
                            onClick={(event) => {
                              event.stopPropagation();
                              void deleteThread(thread.id, title);
                            }}
                            title="删除对话"
                          >
                            ×
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="sidebar-footer">
          <span className={`status-dot ${statusDotClass}`} />
          <span className="status-text">{statusLabel}</span>
        </div>
      </aside>

      {activeMainTab === "skills" ? (
        <SkillsPageView
          skills={state.skills ?? []}
          searchQuery={skillsSearchQuery}
          setSearchQuery={setSkillsSearchQuery}
          onImportSkill={() => void registerNewSkill()}
          onUnregisterSkill={(path) => void unregisterSkill(path)}
          onUseSkill={(skillName) => handleUseSkillInChat(skillName)}
        />
      ) : (
        <main className="chat">
          <header className="chat-header">
            <div className="chat-header-title">
              <p className="eyebrow">Intel Agent Console</p>
              <h2 title={activeName}>{activeName}</h2>
            </div>
            <div className="header-actions">
              {isOfficialMode ? (
                <div className={`model-header-pill ${quickModelDirty ? "dirty" : ""}`}>
                  <span className="pill-label" style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <svg className="w-3.5 h-3.5 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="4" y="4" width="16" height="16" rx="2" />
                      <rect x="9" y="9" width="6" height="6" rx="1" />
                      <path d="M9 1v3" />
                      <path d="M15 1v3" />
                      <path d="M9 20v3" />
                      <path d="M15 20v3" />
                      <path d="M20 9h3" />
                      <path d="M20 15h3" />
                      <path d="M1 9h3" />
                      <path d="M1 15h3" />
                    </svg>
                    <span>运行模型</span>
                  </span>
                  <select
                    value={headerModelSelection}
                    onChange={(event) => {
                      headerModelDirtyRef.current = true;
                      setHeaderModelSelection(event.target.value);
                    }}
                    className="header-model-select"
                    disabled={state.busy}
                    title={
                      quickModelDirty
                        ? `当前：${state.official.defaultModel}，切换到：${headerModelSelection}。点击“应用切换”后在当前对话内立即生效。`
                        : "直接在这里选目标模型，然后点击“应用切换”。"
                    }
                  >
                    {quickModelOptions.map((modelId) => (
                      <option key={modelId} value={modelId}>
                        {modelId}
                      </option>
                    ))}
                  </select>
                  {quickModelDirty && (
                    <button
                      className="header-apply-button"
                      onClick={() => void applyModelChange(headerModelSelection)}
                      disabled={state.busy}
                      title={`当前：${state.official.defaultModel}，切换到：${headerModelSelection}。点击“应用切换”后在当前对话内立即生效。`}
                    >
                      应用切换
                    </button>
                  )}
                </div>
              ) : (
                <div className="model-header-pill">
                  <span className="pill-label" style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <svg className="w-3.5 h-3.5 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="4" y="4" width="16" height="16" rx="2" />
                      <rect x="9" y="9" width="6" height="6" rx="1" />
                      <path d="M9 1v3" />
                      <path d="M15 1v3" />
                      <path d="M9 20v3" />
                      <path d="M15 20v3" />
                      <path d="M20 9h3" />
                      <path d="M20 15h3" />
                      <path d="M1 9h3" />
                      <path d="M1 15h3" />
                    </svg>
                    <span>运行模型</span>
                  </span>
                  <span className="pill-value">{displayModel}</span>
                </div>
              )}
              <button
                className={`header-toggle-sidebar-button ${rightSidebarOpen ? "active" : ""}`}
                onClick={() => setRightSidebarOpen(!rightSidebarOpen)}
                title={rightSidebarOpen ? "隐藏生成文件" : "显示生成文件"}
              >
                <span className="pill-label" style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
                  </svg>
                  <span>生成文件</span>
                </span>
                {threadFiles.length > 0 && (
                  <span className="sidebar-count-badge">{threadFiles.length}</span>
                )}
              </button>
            </div>
          </header>

          <section className="message-scroller">
            {isThreadLoading ? (
              <div className="flex flex-col gap-6 w-full p-4 overflow-hidden">
                <div className="w-full max-w-[500px] bg-card-bg border border-border-main rounded-[18px] rounded-bl-sm p-4 flex flex-col gap-3 shadow-sm self-start animate-pulse">
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full bg-blue-500/15" />
                    <div className="h-3 bg-slate-500/20 rounded w-16" />
                  </div>
                  <div className="flex flex-col gap-2">
                    <div className="h-3 bg-slate-500/10 rounded w-11/12" />
                    <div className="h-3 bg-slate-500/10 rounded w-4/5" />
                    <div className="h-3 bg-slate-500/10 rounded w-2/3" />
                  </div>
                </div>

                <div className="w-full max-w-[420px] bg-blue-500/5 border border-blue-500/20 border-dashed rounded-[18px] rounded-br-sm p-4 flex flex-col gap-3 self-end animate-pulse">
                  <div className="flex items-center justify-end gap-2">
                    <div className="h-3 bg-blue-500/25 rounded w-12" />
                    <div className="w-6 h-6 rounded-full bg-blue-500/20" />
                  </div>
                  <div className="flex flex-col gap-2 items-end">
                    <div className="h-3 bg-blue-500/15 rounded w-11/12" />
                    <div className="h-3 bg-blue-500/15 rounded w-3/4" />
                  </div>
                </div>

                <div className="w-full max-w-[580px] bg-card-bg border border-border-main rounded-[18px] rounded-bl-sm p-4 flex flex-col gap-3 shadow-sm self-start animate-pulse">
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full bg-blue-500/15" />
                    <div className="h-3 bg-slate-500/20 rounded w-16" />
                  </div>
                  <div className="flex flex-col gap-2">
                    <div className="h-3 bg-slate-500/10 rounded w-10/12" />
                    <div className="h-3 bg-slate-500/10 rounded w-11/12" />
                    <div className="h-3 bg-slate-500/10 rounded w-1/2" />
                  </div>
                </div>
              </div>
            ) : (
              <>
                {isHermesMissing ? (
                  <div className="onboarding-card">
                    <div className="onboarding-title">
                      <h3>Hermes 运行时未就绪</h3>
                    </div>
                    <p>桌面客户端目前无法启动内置 Hermes 运行时。现在这套集成已经改成“应用私有运行时”，不会再依赖你手工指定外部 `hermes` 可执行文件。</p>
                    <div className="guide-steps">
                      <div className="step-item">
                        <strong>第一步：一键修复内置运行时</strong>
                        <p>点击下方按钮，应用会把 Hermes runtime 安装/恢复到自己的私有目录，再重新尝试启动本地后台。</p>
                      </div>
                      <div className="step-item">
                        <strong>第二步：如果连种子运行时都不存在</strong>
                        <p>开发环境下如果项目根目录还没有 `.runtime`，先在终端执行 <code>npm run hermes:bootstrap</code>，之后再点修复按钮即可。</p>
                      </div>
                    </div>
                    {state.error ? (
                      <div className="step-item">
                        <strong>当前错误详情</strong>
                        <p><code>{state.error}</code></p>
                      </div>
                    ) : null}
                    <div className="onboarding-footer">
                      <button className="primary-button" onClick={() => void repairRuntime()}>修复内置运行时</button>
                    </div>
                  </div>
                ) : needsProviderSetup ? (
                  <div className="onboarding-card">
                    <div className="onboarding-title">
                      <h3>{isOfficialMode ? "先连接 Hermes 官方账号" : "先配置你自己的模型 API"}</h3>
                    </div>
                    <p>
                      {isOfficialMode
                        ? "当前切到了 Hermes 官方模式。这个模式会复用你本机现有的 ~/.hermes 登录态和模型配置。"
                        : "当前切到了自定义私有模式。先在右上角「设置」里填好 provider、model 和 API key，就可以直接开始对话。"}
                    </p>
                    <div className="guide-steps">
                      {isOfficialMode ? (
                        <>
                          <div className="step-item">
                            <strong>检测结果</strong>
                            <p>官方配置目录：<code>{state.official.homeDir}</code></p>
                            <p>登录状态：<b>{state.official.isLoggedIn ? `已登录 (${state.official.subscriptionLabel})` : "未登录"}</b></p>
                          </div>
                          <div className="step-item">
                            <strong>当前官方默认模型</strong>
                            <p>Provider：<b>{state.official.provider}</b>，默认模型：<b>{state.official.defaultModel}</b></p>
                          </div>
                          {!state.official.isLoggedIn && (
                            <div className="step-item">
                              <strong>如何进行官方登录</strong>
                              <p>请在您的系统终端（Terminal）中执行命令：<code>hermes login</code>。登录成功后，打开右上角设置并点击 <b>“刷新状态”</b> 即可同步。</p>
                            </div>
                          )}
                        </>
                      ) : (
                        <>
                          <div className="step-item">
                            <strong>推荐配置</strong>
                            <p>如果你在用 DeepSeek，就把 Provider 设成 <b>deepseek</b>，模型填例如 <b>deepseek-chat</b>，再填入对应 API key。</p>
                          </div>
                          <div className="step-item">
                            <strong>自定义兼容接口</strong>
                            <p>如果你是代理服务或自建 OpenAI-compatible 接口，把 Provider 设成 <b>custom</b>，同时补上 Base URL 和 API key。</p>
                          </div>
                        </>
                      )}
                    </div>
                    {state.error ? (
                      <div className="step-item">
                        <strong>当前错误详情</strong>
                        <p><code>{state.error}</code></p>
                      </div>
                    ) : null}
                    <div className="onboarding-footer">
                      <button className="primary-button" onClick={() => { setSettingsOpen(true); setActiveSettingsTab("runtime"); }}>打开运行设置</button>
                    </div>
                  </div>
                ) : null}

                {!isHermesMissing && !needsProviderSetup && activeMessages.length === 0 && !state.activeDraft && (
                  <div className="trae-hero-container">
                    <div className="trae-hero-badge">
                      <svg className="w-4 h-4 text-blue-600 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                        <polyline points="9 11 12 14 15 11" />
                      </svg>
                      <span>深圳市统计局 · 智能工作台</span>
                    </div>

                    <h2 className="trae-hero-title">深统政务 Scope</h2>
                    <p className="trae-hero-subtitle">
                      高效检索政务统计数据、自动化分析公文报告、智能代码生成与数据洞察
                    </p>

                    <div className="trae-quick-suggestions">
                      <button
                        type="button"
                        className="trae-suggestion-card"
                        onClick={() => setDraft("帮我检索深圳市最新的 CPI 与 GDP 统计数据并生成分析趋势")}
                      >
                        <span className="icon">📊</span>
                        <div className="text-content">
                          <strong>检索统计数据</strong>
                          <p>查询最新 CPI/GDP 统计指标与发展趋势分析</p>
                        </div>
                      </button>

                      <button
                        type="button"
                        className="trae-suggestion-card"
                        onClick={() => setDraft("快速梳理当前选定项目工作区的文件结构和核心逻辑")}
                      >
                        <span className="icon">📁</span>
                        <div className="text-content">
                          <strong>分析项目工作区</strong>
                          <p>了解本地项目文件结构、依赖关系与最新代码变更</p>
                        </div>
                      </button>

                      <button
                        type="button"
                        className="trae-suggestion-card"
                        onClick={() => setDraft("帮我起草一份关于近期统计数据调度的政务公文报告草案")}
                      >
                        <span className="icon">📝</span>
                        <div className="text-content">
                          <strong>起草政务公文</strong>
                          <p>生成规范的统计分析报告与政务公文草案</p>
                        </div>
                      </button>

                      <button
                        type="button"
                        className="trae-suggestion-card"
                        onClick={() => setDraft("帮我检索政务数据公开目录并整理关键信息表")}
                      >
                        <span className="icon">🔍</span>
                        <div className="text-content">
                          <strong>政务数据检索</strong>
                          <p>检索政务公开目录与数据交换标准规范</p>
                        </div>
                      </button>
                    </div>
                  </div>
                )}

                {!isHermesMissing && activeMessages.map((message: HermesChatMessage) => (
                  <article key={message.id} className={message.role === "user" ? "bubble user" : "bubble assistant"}>
                    <div className="bubble-head">
                      <strong>{message.role === "user" ? "你" : "深统 Scope"}</strong>
                      {message.phase ? <span>{message.phase}</span> : null}
                    </div>
                    {message.role === "assistant" && message.reasoning?.trim() ? (
                      <TraceBlock text={message.reasoning} open={false} />
                    ) : null}
                    <MessageBody role={message.role} text={message.text} />
                  </article>
                ))}

                {!isHermesMissing && state.activeDraft ? (
                  <article className="bubble assistant streaming">
                    <div className="bubble-head">
                      <strong>深统 Scope</strong>
                      <span>处理中</span>
                    </div>
                    {state.activeDraft.reasoning?.trim() ? <TraceBlock text={state.activeDraft.reasoning} open={true} /> : null}
                    <MessageBody role="assistant" text={state.activeDraft.text || "…"} />
                  </article>
                ) : null}
              </>
            )}

            <div ref={messagesEndRef} />
          </section>

          <footer className="composer">
            {state?.error ? (
              <div className="composer-error-banner">
                <span>⚠️ 错误提示: <code>{state.error}</code></span>
                {isTokenError(state.error) ? (
                  <button
                    type="button"
                    className="composer-error-banner-link"
                    onClick={() => {
                      setSettingsOpen(true);
                      setActiveSettingsTab("chat");
                      void refreshOfficialConfig();
                    }}
                  >
                    🔑 前往账号设置重新登录 →
                  </button>
                ) : null}
              </div>
            ) : null}

            <div className="trae-composer-card">
              <div
                ref={editorRef}
                className="trae-composer-textarea"
                contentEditable={!isHermesMissing && !needsProviderSetup}
                suppressContentEditableWarning
                role="textbox"
                aria-multiline="true"
                onInput={syncEditorDraft}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    if (state?.busy) {
                      void handleStopMessage();
                    } else {
                      void sendMessage();
                    }
                  }
                }}
                data-placeholder={
                  isHermesMissing
                    ? "运行时未就绪，消息框已禁用"
                    : needsProviderSetup
                      ? isOfficialMode
                        ? "请先让本机 Hermes 官方配置完成登录，消息框暂不可用"
                        : "请先在设置中填写 API key，消息框暂不可用"
                      : "继续输入任务需求..."
                }
                data-empty={!draft && !selectedSkillTag}
              >
                {selectedSkillTag && (
                  <span className="trae-skill-tag-pill" contentEditable={false} data-skill={selectedSkillTag}>
                    <svg className="w-3.5 h-3.5 shrink-0" style={{ color: "#734b26" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                    </svg>
                    <span className="trae-skill-tag-name">{selectedSkillTag}</span>
                    <button
                      type="button"
                      className="trae-skill-tag-remove"
                      tabIndex={-1}
                      onClick={() => {
                        setSelectedSkillTag(null);
                        if (editorRef.current) editorRef.current.innerHTML = draft;
                        focusEditor();
                      }}
                      title="移除技能"
                    >
                      ×
                    </button>
                  </span>
                )}
                <span ref={editorTextRef} className="trae-editor-draft-text" />
              </div>

              <div className="trae-composer-actions-bar">
                <div className="relative">
                  <button
                    type="button"
                    className="trae-selector-pill"
                    onClick={() => setIsFolderMenuOpen((prev) => !prev)}
                    title={state?.settings.cwd || "选择项目工作区（可选）"}
                  >
                    <svg className="w-3.5 h-3.5 text-slate-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
                    </svg>
                    <span className="truncate" style={{ maxWidth: "220px" }}>
                      {state?.settings.cwd ? currentFolderName : "选择文件夹（可选）"}
                    </span>
                    {activeBranch && (
                      <span style={{ opacity: 0.75, fontStyle: "italic", fontSize: "11px", flexShrink: 0 }}>
                        ⎇ {activeBranch}
                      </span>
                    )}
                    <svg className="w-3 h-3 text-slate-400 shrink-0 ml-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>

                  {isFolderMenuOpen && (
                    <div className="trae-popover-menu">
                      <div className="trae-popover-header">
                        <span>当前项目工作区</span>
                        <button
                          type="button"
                          style={{ border: "none", background: "transparent", cursor: "pointer", color: "#94a3b8" }}
                          onClick={() => setIsFolderMenuOpen(false)}
                        >
                          ×
                        </button>
                      </div>
                      <div style={{ padding: "6px 8px", fontSize: "11px", color: "#475569", wordBreak: "break-all", background: "#f8fafc", borderRadius: "8px", marginBottom: "4px" }}>
                        {state?.settings.cwd || "未选择项目工作区"}
                      </div>

                      {recentFolders.length > 0 && (
                        <>
                          <div className="trae-popover-header" style={{ marginTop: "4px" }}>最近使用项目历史</div>
                          {recentFolders.map((folder) => (
                            <button
                              key={folder.path}
                              type="button"
                              className={`trae-popover-item ${folder.path === state?.settings.cwd ? "active" : ""}`}
                              onClick={() => void handleSwitchWorkspaceFolder(folder.path)}
                            >
                              <span className="truncate flex items-center gap-1.5">
                                <svg className="w-3.5 h-3.5 text-slate-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
                                </svg>
                                {folder.name}
                              </span>
                              {folder.path === state?.settings.cwd && <span style={{ color: "#2563eb" }}>✓</span>}
                            </button>
                          ))}
                        </>
                      )}

                      <div style={{ borderTop: "1px solid #e2e8f0", marginTop: "4px", paddingTop: "4px", display: "flex", flexDirection: "column", gap: "2px" }}>
                        <button
                          type="button"
                          className="trae-popover-item"
                          onClick={() => void handleSelectWorkspaceFolder()}
                          style={{ color: "#2563eb", fontWeight: 600 }}
                        >
                          <span>+ 选择本地项目文件夹...</span>
                        </button>

                        {!!state?.settings.cwd && (
                          <button
                            type="button"
                            className="trae-popover-item"
                            onClick={() => void handleSwitchWorkspaceFolder("")}
                            style={{ color: "#64748b" }}
                          >
                            <span>✕ 取消选择 (设为默认)</span>
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>

              {/* Right Side: Send or Stop Button */}
              {state?.busy ? (
                <button
                  type="button"
                  className="trae-stop-icon-btn"
                  onClick={() => void handleStopMessage()}
                  title="终止当前智能体处理"
                  aria-label="终止当前智能体处理"
                >
                  <svg className="w-3.5 h-3.5 fill-white" viewBox="0 0 24 24">
                    <rect x="5" y="5" width="14" height="14" rx="2" />
                  </svg>
                </button>
              ) : (
                <button
                  type="button"
                  className="primary-button-icon"
                  onClick={() => void sendMessage()}
                  disabled={(!draft.trim() && !selectedSkillTag) || !canSend}
                  title="发送消息 (Enter)"
                  aria-label="发送消息"
                >
                  <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="19" x2="12" y2="5" />
                    <polyline points="5 12 12 5 19 12" />
                  </svg>
                </button>
              )}
            </div>
          </div>

          <div className="flex items-center justify-end px-2 pt-1 text-[11px] text-slate-400 select-none">
            <span>Shift + Enter 换行</span>
          </div>
        </footer>
      </main>
    )}

      {rightSidebarOpen && (
        <aside className="right-sidebar">
          <div className="right-sidebar-header">
            <h3>生成的文件</h3>
            <button
              className="right-sidebar-close"
              onClick={() => setRightSidebarOpen(false)}
              aria-label="关闭侧边栏"
              title="关闭侧边栏"
            >
              ×
            </button>
          </div>
          <div className="right-sidebar-body">
            {threadFiles.length === 0 ? (
              <div className="right-sidebar-empty">
                <div className="right-sidebar-empty-icon">
                  <svg className="w-10 h-10 text-slate-400 mx-auto mb-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
                  </svg>
                </div>
                <p>当前对话下尚无生成的文件</p>
                <p style={{ fontSize: "11.5px", opacity: 0.75, lineHeight: "1.5" }}>
                  智能体执行导出或抓取任务后，生成的文件默认保存至 <b>{state?.settings.defaultOutputDir || "outputs"}/任务子目录/</b>。
                </p>
              </div>
            ) : (
              <>
                <div className="right-sidebar-section-title">本对话生成 ({threadFiles.length})</div>
                <ul className="right-sidebar-list">
                  {threadFiles.map((file) => {
                    const basename = file.split(/[/\\]/).pop();
                    return (
                      <li key={file} className="right-sidebar-item" title={file}>
                        <div className="right-sidebar-item-info">
                          <span className="right-sidebar-item-icon" style={{ display: "inline-flex", alignItems: "center" }}>
                            <svg className="w-3.5 h-3.5 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
                              <path d="M14 2v4a2 2 0 0 0 2 2h4" />
                              <path d="M10 9H8" />
                              <path d="M16 13H8" />
                              <path d="M16 17H8" />
                            </svg>
                          </span>
                          <button
                            className="right-sidebar-item-name"
                            onClick={() => void window.hermesDesktop.openExternal(`file://${file}`)}
                          >
                            {basename}
                          </button>
                        </div>
                        <div className="right-sidebar-item-actions">
                          <button
                            className="right-sidebar-action-btn"
                            onClick={() => {
                              const parts = file.split(/[/\\]/);
                              parts.pop();
                              const dirPath = parts.join("/");
                              void window.hermesDesktop.openExternal(`file://${dirPath}`);
                            }}
                            title="打开文件所在目录"
                          >
                            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2" />
                            </svg>
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </div>
          <div className="right-sidebar-footer">
            <button
              className="right-sidebar-open-dir-button"
              style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}
              onClick={() => {
                const targetCwd = state?.settings?.cwd;
                const defaultOutputDir = state?.settings?.defaultOutputDir || "outputs";
                if (targetCwd) {
                  const isAbsolute = defaultOutputDir.startsWith("/") || defaultOutputDir.includes(":");
                  const resolvedPath = isAbsolute ? defaultOutputDir : `${targetCwd}/${defaultOutputDir}`;
                  void window.hermesDesktop.openExternal(`file://${resolvedPath}`);
                } else {
                  const firstFile = threadFiles[0];
                  if (firstFile) {
                    const parts = firstFile.split(/[/\\]/);
                    parts.pop();
                    const dirPath = parts.join("/");
                    void window.hermesDesktop.openExternal(`file://${dirPath}`);
                  }
                }
              }}
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2" />
              </svg>
              <span>打开输出目录</span>
            </button>
          </div>
        </aside>
      )}

      {state.lastGeneratedFiles && state.lastGeneratedFiles.length > 0 && state.lastGeneratedFiles !== dismissedFiles && (
        <div className="file-alert-toast">
          <div className="toast-header">
            <span className="toast-icon" style={{ display: "inline-flex", alignItems: "center" }}>
              <svg className="w-4 h-4 text-emerald-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
              </svg>
            </span>
            <strong>检测到新生成文件</strong>
            <button
              className="toast-close"
              onClick={() => setDismissedFiles(state.lastGeneratedFiles ?? null)}
            >
              ×
            </button>
          </div>
          <div className="toast-body">
            <p>智能体已在工作区生成了以下文件：</p>
            <ul className="toast-file-list">
              {state.lastGeneratedFiles.map((file) => {
                const basename = file.split(/[/\\]/).pop();
                return (
                  <li key={file} title={file}>
                    <button
                      className="text-button file-link"
                      onClick={() => void window.hermesDesktop.openExternal(`file://${file}`)}
                    >
                      {basename}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
          <div className="toast-footer">
            <button
              className="toast-open-dir-button"
              onClick={() => {
                const firstFile = state.lastGeneratedFiles?.[0];
                if (firstFile) {
                  const parts = firstFile.split(/[/\\]/);
                  parts.pop();
                  const dirPath = parts.join("/");
                  void window.hermesDesktop.openExternal(`file://${dirPath}`);
                }
              }}
            >
              打开输出目录
            </button>
          </div>
        </div>
      )}

      {settingsOpen ? (
        <div className="modal-backdrop" onClick={() => void closeSettingsModal()}>
          <div className="settings-modal two-column" onClick={(event) => event.stopPropagation()}>
            {/* Left Sidebar Tabs */}
            <div className="settings-sidebar">
              <div className="settings-sidebar-header">
                <p className="eyebrow">Settings</p>
                <h3>运行配置</h3>
              </div>
              <nav className="settings-tabs">
                <button
                  type="button"
                  className={`settings-tab-btn ${activeSettingsTab === "runtime" ? "active" : ""}`}
                  onClick={() => setActiveSettingsTab("runtime")}
                >
                  <span className="tab-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.1a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  </span>
                  运行与工作区
                </button>
                <button
                  type="button"
                  className={`settings-tab-btn ${activeSettingsTab === "chat" ? "active" : ""}`}
                  onClick={() => setActiveSettingsTab("chat")}
                >
                  <span className="tab-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
                    </svg>
                  </span>
                  模型与账号登录
                </button>
                <button
                  type="button"
                  className={`settings-tab-btn ${activeSettingsTab === "vision" ? "active" : ""}`}
                  onClick={() => setActiveSettingsTab("vision")}
                >
                  <span className="tab-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  </span>
                  视觉大模型
                </button>
                <button
                  type="button"
                  className={`settings-tab-btn ${activeSettingsTab === "tools" ? "active" : ""}`}
                  onClick={() => setActiveSettingsTab("tools")}
                >
                  <span className="tab-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 22v-5M9 8V2M15 8V2M18 8H6A2 2 0 0 0 4 10v2a4 4 0 0 0 4 4h8a4 4 0 0 0 4-4v-2a2 2 0 0 0-2-2z" />
                    </svg>
                  </span>
                  外部工具 & API
                </button>
              </nav>
            </div>

            {/* Right Content Panel */}
            <div className="settings-content">
              <div className="settings-content-header">
                {activeSettingsTab === "runtime" && <h3>运行状态与工作区</h3>}
                {activeSettingsTab === "chat" && <h3>对话模型配置</h3>}
                {activeSettingsTab === "vision" && <h3>视觉大模型 (Vision Backend)</h3>}
                {activeSettingsTab === "tools" && <h3>外部工具 & API 配置</h3>}
              </div>

              <div className="settings-content-body">
                {activeSettingsTab === "runtime" && (
                  <div className="settings-tab-pane">
                    <label>
                      Workspace CWD (工作区路径)
                      <input
                        value={draftSettings.cwd}
                        onChange={(event) =>
                          setDraftSettings((current: HermesAppState["settings"]) => ({
                            ...current,
                            cwd: event.target.value,
                          }))
                        }
                        placeholder="/path/to/workspace"
                      />
                    </label>

                    <label>
                      默认输出文件夹
                      <input
                        value={draftSettings.defaultOutputDir || ""}
                        onChange={(event) =>
                          setDraftSettings((current: HermesAppState["settings"]) => ({
                            ...current,
                            defaultOutputDir: event.target.value,
                          }))
                        }
                        placeholder="outputs"
                      />
                      <small className="field-hint">
                        智能体产生的文件将默认保存到该文件夹下的子目录中。支持相对路径（相对于工作区）或绝对路径。
                      </small>
                    </label>

                    <label>
                      内置 Runtime Binary
                      <input value={state?.settings.hermesBin || ""} disabled />
                    </label>

                    <div className="skills-section">
                      <div className="skills-section-header">
                        <h4>Hermes Runtime</h4>
                        <span>{runtimeInstalled ? "已安装" : "未安装"}</span>
                      </div>
                      <div className="skills-list-container">
                        <div className="skill-card">
                          <div className="skill-info">
                            <strong className="skill-card-header">应用私有运行时</strong>
                            <p className="skill-card-desc">Hermes 现在固定安装在当前 Electron 应用的私有数据目录里，不再依赖外部路径。</p>
                            <span className="skill-card-path">{state?.runtime.installDir}</span>
                            <span className="skill-card-path">{state?.runtime.homeDir}</span>
                          </div>
                        </div>
                      </div>
                      <div className="modal-actions-inline">
                        <button className="secondary-button" onClick={() => void repairRuntime()}>
                          安装 / 修复运行时
                        </button>
                        <button
                          className="secondary-button"
                          onClick={() => void uninstallRuntime()}
                          disabled={!runtimeInstalled || (state?.runtime.uninstalling ?? false)}
                        >
                          {state?.runtime.uninstalling ? "卸载中..." : "一键卸载运行时"}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {activeSettingsTab === "chat" && (
                  <div className="settings-tab-pane">
                    <label>
                      接入模式
                      <select
                        value={draftSettings.runtimeMode}
                        onChange={(event) =>
                          setDraftSettings((current: HermesAppState["settings"]) => ({
                            ...current,
                            runtimeMode: event.target.value as HermesAppState["settings"]["runtimeMode"],
                            model: event.target.value === "official" ? (state?.official.defaultModel || "") : current.model,
                          }))
                        }
                        className="settings-select"
                      >
                        <option value="private">自定义私有模式</option>
                        <option value="official">Hermes 官方模式</option>
                      </select>
                    </label>

                    <label>
                      Model (对话模型)
                      {draftSettings.runtimeMode === "official" ? (
                        <div className="settings-model-switch">
                          <div className="settings-model-row">
                            <select
                              value={draftSettings.model}
                              onChange={(event) =>
                                setDraftSettings((current: HermesAppState["settings"]) => ({
                                  ...current,
                                  model: event.target.value,
                                }))
                              }
                              className="settings-select settings-model-select"
                            >
                              {((state?.official.availableModels.length ?? 0) > 0 ? (state?.official.availableModels ?? []) : [state?.official.defaultModel ?? draftSettings.model]).map((modelId) => (
                                <option key={modelId} value={modelId}>
                                  {modelId}
                                </option>
                              ))}
                            </select>
                            <button
                              className="inline-apply-button"
                              onClick={() => {
                                if (!officialModelDirty) return;
                                void applyModelChange(draftSettings.model);
                              }}
                              disabled={!officialModelDirty}
                            >
                              应用切换
                            </button>
                          </div>
                          <small className="field-hint">
                            实际运行：<b>{displayModel}</b>
                            {officialModelDirty ? ` | 点击应用：${state?.official.defaultModel} → ${draftSettings.model}` : ""}
                          </small>
                        </div>
                      ) : (
                        <input
                          value={draftSettings.model}
                          onChange={(event) =>
                            setDraftSettings((current: HermesAppState["settings"]) => ({
                              ...current,
                              model: event.target.value,
                            }))
                          }
                          placeholder="deepseek-chat"
                        />
                      )}
                    </label>

                    {draftSettings.runtimeMode !== "official" && (
                      <>
                        <label>
                          API Provider (大模型提供商)
                          <select
                            value={draftSettings.apiProvider}
                            onChange={(event) =>
                              setDraftSettings((current: HermesAppState["settings"]) => ({
                                ...current,
                                apiProvider: event.target.value as HermesAppState["settings"]["apiProvider"],
                              }))
                            }
                            className="settings-select"
                          >
                            <option value="openai">OpenAI</option>
                            <option value="openrouter">OpenRouter</option>
                            <option value="deepseek">DeepSeek</option>
                            <option value="custom">自定义 OpenAI 兼容接口</option>
                          </select>
                        </label>

                        <label>
                          API Key (密钥)
                          <input
                            type="password"
                            value={draftSettings.apiKey}
                            onChange={(event) =>
                              setDraftSettings((current: HermesAppState["settings"]) => ({
                                ...current,
                                apiKey: event.target.value,
                              }))
                            }
                            placeholder="sk-..."
                          />
                        </label>
                      </>
                    )}

                    {draftSettings.runtimeMode !== "official" && draftSettings.apiProvider === "custom" && (
                      <label>
                        API Base URL
                        <input
                          value={draftSettings.apiBaseUrl}
                          onChange={(event) =>
                            setDraftSettings((current: HermesAppState["settings"]) => ({
                              ...current,
                              apiBaseUrl: event.target.value,
                            }))
                          }
                          placeholder="https://api.example.com/v1"
                        />
                      </label>
                    )}

                    {draftSettings.runtimeMode === "official" && state && (
                      <div className="skills-section">
                        <div className="skills-section-header">
                          <h4>Hermes 官方模式</h4>
                          <div className="official-status-group">
                            <span className="official-status-tag">
                              {state.official.isLoggedIn ? `已登录 / ${state.official.subscriptionLabel}` : "未登录"}
                            </span>
                            {state.official.isLoggedIn && (
                              <button 
                                type="button"
                                className="text-action-button danger"
                                onClick={() => void logoutOfficialConfig()}
                                title="从本机 ~/.hermes 清除官方登录态"
                              >
                                退出登录
                              </button>
                            )}
                            <button 
                              type="button"
                              className="text-action-button"
                              onClick={() => void refreshOfficialConfig()}
                              title="从 ~/.hermes 重新读取最新的配置和登录状态"
                            >
                              刷新状态
                            </button>
                          </div>
                        </div>
                        <div className="skills-list-container official-mode-container">
                          <div className="skill-card">
                            <div className="skill-info">
                              <strong className="skill-card-header">复用本机 ~/.hermes</strong>
                              <p className="skill-card-desc">这个模式会直接复用你正常安装 Hermes 后的官方配置、登录态和默认模型。</p>
                              
                              {!state.official.isLoggedIn && (
                                isLoggingIn ? (
                                  <div className="official-login-progress">
                                    <span className="hint-title">正在进行官方账号登录：</span>
                                    {state.official.userCode ? (
                                      <div className="user-code-display-box">
                                        <p className="hint-desc">请在弹出的浏览器页面中核对以下授权码：</p>
                                        <div className="user-code-value">{state.official.userCode}</div>
                                        <p className="hint-desc" style={{ fontSize: "11px", opacity: 0.7, marginTop: "6px" }}>
                                          网页端登录成功后，App 会自动重新读取状态并同步。
                                        </p>
                                      </div>
                                    ) : (
                                      <p className="hint-desc">正在请求官方授权码并唤起浏览器，请稍候...</p>
                                    )}
                                  </div>
                                ) : (
                                  <div className="official-login-hint">
                                    <span className="hint-title">如何登录官方账号：</span>
                                    <p className="hint-desc">
                                      点击下方“点击登录官方账号”按钮，即可自动唤起浏览器登录。也可以在终端手动执行以下命令：
                                    </p>
                                    <code className="hint-code">hermes auth add nous --type oauth</code>
                                    <p className="hint-desc" style={{ marginTop: "4px" }}>
                                      登录成功后，界面会自动刷新呈现已登录态。
                                    </p>
                                  </div>
                                )
                              )}
                              
                              {state.official.isLoggedIn && (
                                <div className="official-account-info">
                                  <span className="account-info-title">已同步官方账号：</span>
                                  <span className="account-info-value" title={`用户 ID: ${state.official.rateLimitSource}`}>
                                    {state.official.subscriptionLabel === "Paid" ? "★ Paid 会员账号" : "Free 免费账号"}
                                  </span>
                                </div>
                              )}

                              <span className="skill-card-path">{state.official.configPath}</span>
                              <span className="skill-card-path">{state.official.authPath}</span>
                              <span className="skill-card-path">当前配置默认模型：{state.official.defaultModel}</span>
                              {state.official.subscriptionLabel === "Free" && state.official.freeRecommendedModels.length > 0 ? (
                                <span className="skill-card-path">Free 可选：{state.official.freeRecommendedModels.join(" / ")}</span>
                              ) : null}
                              {state.official.subscriptionLabel === "Free" &&
                              state.official.freeRecommendedModels.length > 0 &&
                              !state.official.freeRecommendedModels.includes(state.official.defaultModel) ? (
                                <p className="skill-card-desc">注意：你当前 config 默认模型不在 free 推荐列表里，建议改成上面的 free 模型之一。</p>
                              ) : null}
                            </div>
                          </div>
                          
                          <div className="official-actions-row">
                            {state.official.isLoggedIn ? (
                              <button
                                type="button"
                                className="official-btn"
                                onClick={() => void window.hermesDesktop.openExternal("https://portal.nousresearch.com/")}
                                title="打开 Nous Portal 网页进行登录、退出或切换账号"
                              >
                                管理官方登录
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="official-btn primary-style"
                                onClick={() => void loginOfficialConfig()}
                                disabled={state.busy || isLoggingIn}
                                title="启动本地授权并打开浏览器完成登录"
                              >
                                {isLoggingIn ? "正在等待浏览器登录..." : "点击登录官方账号"}
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {activeSettingsTab === "vision" && (
                  <div className="settings-tab-pane">
                    <p className="tab-pane-desc">
                      配置专门的视觉后端，使纯文本基座模型在执行需要图表分析或自动网页浏览的工具（如 <code>browser_vision</code> / <code>vision_analyze</code>）时能够自动调用该模型。
                    </p>

                    <label>
                      Model (视觉大模型)
                      <input
                        value={draftSettings.visionModel}
                        onChange={(event) =>
                          setDraftSettings((current: HermesAppState["settings"]) => ({
                            ...current,
                            visionModel: event.target.value,
                          }))
                        }
                        placeholder="openai/gpt-4o-mini 或 ollama:llava"
                      />
                      <small className="field-hint">
                        例如：<code>openai/gpt-4o-mini</code> (云端高性价比) 或 <code>llava</code> / <code>qwen2.5-vl</code> (本地 Ollama 免费)
                      </small>
                    </label>

                    <label>
                      API Provider (大模型提供商)
                      <select
                        value={draftSettings.visionProvider}
                        onChange={(event) =>
                          setDraftSettings((current: HermesAppState["settings"]) => ({
                            ...current,
                            visionProvider: event.target.value as HermesAppState["settings"]["visionProvider"],
                          }))
                        }
                        className="settings-select"
                      >
                        <option value="openai">OpenAI</option>
                        <option value="openrouter">OpenRouter</option>
                        <option value="ollama">Ollama (本地私有)</option>
                        <option value="custom">自定义 OpenAI 兼容接口</option>
                      </select>
                    </label>

                    {draftSettings.visionProvider !== "ollama" && (
                      <label>
                        API Key (密钥)
                        <input
                          type="password"
                          value={draftSettings.visionApiKey}
                          onChange={(event) =>
                            setDraftSettings((current: HermesAppState["settings"]) => ({
                              ...current,
                              visionApiKey: event.target.value,
                            }))
                          }
                          placeholder="sk-..."
                        />
                      </label>
                    )}

                    {(draftSettings.visionProvider === "custom" || draftSettings.visionProvider === "ollama" || draftSettings.visionProvider === "openrouter") && (
                      <label>
                        API Base URL
                        <input
                          value={draftSettings.visionBaseUrl}
                          onChange={(event) =>
                            setDraftSettings((current: HermesAppState["settings"]) => ({
                              ...current,
                              visionBaseUrl: event.target.value,
                            }))
                          }
                          placeholder={
                            draftSettings.visionProvider === "ollama"
                              ? "http://localhost:11434/v1"
                              : "https://api.example.com/v1"
                          }
                        />
                      </label>
                    )}
                  </div>
                )}

                {activeSettingsTab === "tools" && (
                  <div className="settings-tab-pane">
                    <p className="tab-pane-desc">
                      配置外部辅助工具的 API Key。这些密钥会被自动传递给底层的 Hermes Agent 服务，用以支持网页深度检索、图像生成和语音转文字等核心增强功能。
                    </p>

                    <h4 className="settings-section-title">网络检索与抓取 (Web Search & Crawl)</h4>
                    <label>
                      Firecrawl API Key
                      <input
                        type="password"
                        value={draftSettings.firecrawlApiKey || ""}
                        onChange={(event) =>
                          setDraftSettings((current: HermesAppState["settings"]) => ({
                            ...current,
                            firecrawlApiKey: event.target.value,
                          }))
                        }
                        placeholder="fc-..."
                      />
                      <small className="field-hint">
                        用于网络深度检索、长网页内容抓取和爬虫。可以在 <a href="https://firecrawl.dev/" target="_blank" rel="noreferrer" className="text-emerald-600 hover:underline">firecrawl.dev</a> 申请。
                      </small>
                    </label>

                    <label>
                      Exa API Key
                      <input
                        type="password"
                        value={draftSettings.exaApiKey || ""}
                        onChange={(event) =>
                          setDraftSettings((current: HermesAppState["settings"]) => ({
                            ...current,
                            exaApiKey: event.target.value,
                          }))
                        }
                        placeholder="exa-..."
                      />
                      <small className="field-hint">
                        AI 原生检索和链接提取 Key。可以在 <a href="https://exa.ai/" target="_blank" rel="noreferrer" className="text-emerald-600 hover:underline">exa.ai</a> 申请。
                      </small>
                    </label>

                    <h4 className="settings-section-title" style={{ marginTop: "12px" }}>多媒体与语音 (Multimedia & Voice)</h4>
                    <label>
                      FAL.ai API Key
                      <input
                        type="password"
                        value={draftSettings.falApiKey || ""}
                        onChange={(event) =>
                          setDraftSettings((current: HermesAppState["settings"]) => ({
                            ...current,
                            falApiKey: event.target.value,
                          }))
                        }
                        placeholder="fal_key-..."
                      />
                      <small className="field-hint">
                        用于文本生成图像等工具（如 <code>image_generate</code>）。可以在 <a href="https://fal.ai/" target="_blank" rel="noreferrer" className="text-emerald-600 hover:underline">fal.ai</a> 申请。
                      </small>
                    </label>

                    <label>
                      OpenAI Voice API Key
                      <input
                        type="password"
                        value={draftSettings.voiceToolsOpenaiKey || ""}
                        onChange={(event) =>
                          setDraftSettings((current: HermesAppState["settings"]) => ({
                            ...current,
                            voiceToolsOpenaiKey: event.target.value,
                          }))
                        }
                        placeholder="sk-..."
                      />
                      <small className="field-hint">
                        专门用于语音消息识别（Whisper）与文本生成语音（TTS）。不影响主对话模型。
                      </small>
                    </label>

                    <h4 className="settings-section-title" style={{ marginTop: "12px" }}>云端自动化浏览器 (Cloud Headless Browser)</h4>
                    <label>
                      Browserbase API Key
                      <input
                        type="password"
                        value={draftSettings.browserbaseApiKey || ""}
                        onChange={(event) =>
                          setDraftSettings((current: HermesAppState["settings"]) => ({
                            ...current,
                            browserbaseApiKey: event.target.value,
                          }))
                        }
                        placeholder="bb-..."
                      />
                      <small className="field-hint">
                        云端无头浏览器执行。可以在 <a href="https://browserbase.com/" target="_blank" rel="noreferrer" className="text-emerald-600 hover:underline">browserbase.com</a> 申请。
                      </small>
                    </label>

                    <label>
                      Browserbase Project ID
                      <input
                        value={draftSettings.browserbaseProjectId || ""}
                        onChange={(event) =>
                          setDraftSettings((current: HermesAppState["settings"]) => ({
                            ...current,
                            browserbaseProjectId: event.target.value,
                          }))
                        }
                        placeholder="Project ID"
                      />
                    </label>
                  </div>
                )}
              </div>

              {/* Shared Footer Actions */}
              <div className="settings-content-footer">
                <p className="modal-copy">
                  配置完成后将自动重新启动后台 Hermes Runtime 服务。私有模式使用你自己填写的 provider/API key；官方模式复用本机 `~/.hermes` 的登录态和默认模型。卸载运行时只会删除这个应用私有目录里的 Hermes 程序与会话数据。
                </p>
                <div className="modal-actions">
                  <button className="secondary-button" onClick={() => void closeSettingsModal()}>
                    {isLoggingIn ? "取消登录并关闭" : "取消"}
                  </button>
                  <button className="primary-button" onClick={() => void saveSettings()}>
                    {officialModelDirty ? "保存并切换模型" : "保存并应用"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {isModelSwitching ? (
        <BusyOverlay
          title="正在切换模型"
          detail="模型切换约需 30-60s，在此期间请勿重复点击或继续发送消息。"
          elapsedSeconds={busyElapsedSeconds}
        />
      ) : null}

      {settingsBusyText ? (
        <BusyOverlay
          title={settingsBusyText}
          detail="正在为您载入后台运行配置，请稍候..."
          elapsedSeconds={0}
        />
      ) : null}

      {showTokenErrorModal && (
        <div className="modal-backdrop" style={{ zIndex: 600 }}>
          <div className="error-token-modal">
            <div className="error-modal-header">
              <div className="error-modal-title-group">
                <div className="error-modal-icon">⚠️</div>
                <div>
                  <h3>登录凭证失效 / Refresh Token Expired</h3>
                  <p style={{ margin: 0, fontSize: "11.5px", color: "#64748b" }}>Hermes Agent 身份验证未通过</p>
                </div>
              </div>
              <button
                className="right-sidebar-close"
                onClick={() => setDismissedError(state?.error || null)}
                aria-label="关闭"
                title="关闭弹窗"
              >
                ×
              </button>
            </div>

            <div className="error-modal-body">
              <div>
                <strong style={{ display: "block", marginBottom: "4px", color: "#991b1b" }}>报错详细信息：</strong>
                <div className="error-code-badge">
                  <code>{state?.error}</code>
                </div>
              </div>

              <p style={{ margin: 0, color: "#475569" }}>
                后台 Hermes Agent 在准备发起对话时，检测到存储在 <code>~/.hermes/auth.json</code> 中的 Refresh Token 已失效或过期，导致对话无法正常发起。
              </p>

              <div className="error-step-card">
                <div className="error-step-card-title">
                  <span>🔑 方法一：在应用界面重新登录（推荐）</span>
                </div>
                <ol className="error-step-list">
                  <li>打开应用内的 <b>设置 / 模型与账号登录</b> 界面。</li>
                  <li>点击 <b>重新登录 (Login)</b> 或 <b>退出登录后重新登录</b>。</li>
                  <li>按照提示在浏览器中完成账号授权，刷新本地凭证。</li>
                </ol>
              </div>

              <div style={{ fontSize: "11px", color: "#64748b", background: "#f8fafc", padding: "8px 12px", borderRadius: "10px", border: "1px solid #e2e8f0" }}>
                💡 <b>终端备选方案：</b> 也可以在系统 Terminal 执行 <code>hermes login</code> 命令手动完成刷新。
              </div>
            </div>

            <div className="error-modal-footer">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setDismissedError(state?.error || null)}
              >
                稍后处理
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => {
                  setDismissedError(state?.error || null);
                  setSettingsOpen(true);
                  setActiveSettingsTab("chat");
                  void refreshOfficialConfig();
                }}
                style={{ background: "linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)", borderColor: "#1d4ed8" }}
              >
                前往重新登录（设置 → 账号管理）
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SkillsPageView({
  skills,
  searchQuery,
  setSearchQuery,
  onImportSkill,
  onUnregisterSkill,
  onUseSkill,
}: {
  skills: HermesAppState["skills"];
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  onImportSkill: () => void;
  onUnregisterSkill: (path: string) => void;
  onUseSkill: (skillName: string) => void;
}) {
  const filteredSkills = useMemo(() => {
    return skills.filter((s) => {
      const q = searchQuery.toLowerCase().trim();
      return !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q);
    });
  }, [skills, searchQuery]);

  return (
    <div className="skills-page-view">
      {/* Header Bar */}
      <header className="skills-page-header">
        <div className="flex items-center gap-3">
          <h2 className="text-base font-bold text-slate-900 m-0">我的技能</h2>
          <span className="text-xs text-slate-400 font-medium">共 {skills.length} 个已安装技能</span>
        </div>

        <div className="flex items-center gap-3">
          <div className="relative">
            <svg className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              className="skills-search-input"
              placeholder="搜索技能名称或描述..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          <button
            type="button"
            className="primary-button"
            onClick={onImportSkill}
          >
            + 导入技能
          </button>
        </div>
      </header>

      {/* Body Area */}
      <div className="skills-page-body">
        {filteredSkills.length === 0 ? (
          <div className="skills-empty-state">
            <div className="w-10 h-10 rounded-2xl bg-slate-100 flex items-center justify-center text-slate-400 text-lg mb-2">
              🧩
            </div>
            <h3>暂无技能插件</h3>
            <p>尚未安装或未找到匹配的本地 Skill 插件。点击右上角“+ 导入技能”即可导入 SKILL.md 描述文件。</p>
            <button
              type="button"
              className="primary-button mt-3"
              onClick={onImportSkill}
            >
              + 导入本地技能
            </button>
          </div>
        ) : (
          <div className="skills-card-grid">
            {filteredSkills.map((skill) => (
              <div key={skill.path} className="skills-grid-card">
                <div className="skills-card-top">
                  <div className="skills-card-icon">
                    <svg className="w-4.5 h-4.5 text-slate-700 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                    </svg>
                  </div>
                  <div className="skills-card-info">
                    <h4 title={skill.name}>{skill.name}</h4>
                    <p title={skill.description}>{skill.description}</p>
                  </div>
                </div>

                <div className="skills-card-actions">
                  <button
                    type="button"
                    className="primary-button text-xs px-4"
                    onClick={() => onUseSkill(skill.name)}
                    title="在对话中使用此技能"
                  >
                    使用
                  </button>
                  <button
                    type="button"
                    className="ghost-button-icon"
                    onClick={() => onUnregisterSkill(skill.path)}
                    title="移除此技能"
                  >
                    <svg className="w-4 h-4 text-slate-400 hover:text-red-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
