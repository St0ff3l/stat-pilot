import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./App.css";

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

function TraceBlock({ text }: { text: string }) {
  return (
    <details className="trace-block" open>
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
      <div className="busy-overlay-card">
        <div className="busy-spinner" aria-hidden="true" />
        <strong>{title}</strong>
        <p>{detail}</p>
        <span className="busy-elapsed">当前已等待 {elapsedSeconds}s</span>
      </div>
    </div>
  );
}

export default function App() {
  const [state, setState] = useState<HermesAppState | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [headerModelSelection, setHeaderModelSelection] = useState("");
  const [busyElapsedSeconds, setBusyElapsedSeconds] = useState(0);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const headerModelDirtyRef = useRef(false);
  const [draftSettings, setDraftSettings] = useState<HermesAppState["settings"]>({
    hermesBin: "hermes",
    runtimeMode: "private",
    model: "deepseek-chat",
    cwd: "",
    apiProvider: "deepseek",
    apiKey: "",
    apiBaseUrl: "",
    registeredSkills: [],
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

  async function createNewChat() {
    if (!window.hermesDesktop) {
      return;
    }

    const nextState = await window.hermesDesktop.newThread();
    setState(nextState);
    setDraft("");
  }

  async function selectThread(threadId: string) {
    if (!window.hermesDesktop) {
      return;
    }

    const nextState = await window.hermesDesktop.selectThread(threadId);
    setState(nextState);
    setDraft("");
  }

  async function deleteThread(threadId: string, threadName?: string | null) {
    if (!window.hermesDesktop) {
      return;
    }

    const confirmed = window.confirm(`确认删除这条历史对话吗？${threadName ? `\n\n${threadName}` : ""}`);
    if (!confirmed) {
      return;
    }

    const nextState = await window.hermesDesktop.archiveThread(threadId);
    setState(nextState);
  }

  async function sendMessage() {
    const text = draft.trim();
    if (!text || !window.hermesDesktop) {
      return;
    }

    setDraft("");
    const nextState = await window.hermesDesktop.sendMessage({ text });
    setState(nextState);
  }

  async function saveSettings() {
    if (!window.hermesDesktop) {
      return;
    }

    const nextState = await window.hermesDesktop.updateSettings(draftSettings);
    setState(nextState);
    setSettingsOpen(false);
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

  async function applyModelChange(model: string) {
    if (!window.hermesDesktop || !state) {
      return;
    }

    const nextState = await window.hermesDesktop.switchSessionModel(model);
    headerModelDirtyRef.current = false;
    setState(nextState);
    setHeaderModelSelection(nextState.official.defaultModel);
    setDraft("");
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

  const orderedThreads = [...(state?.threads ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
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
  const isHermesMissing = !!state?.error && (
    state.error.includes("ENOENT") || 
    state.error.includes("找不到 Hermes") || 
    state.error.includes("No module named") ||
    state.error.includes("Hermes backend exited") ||
    state.error.includes("Could not connect to Hermes gateway") ||
    state.error.includes("did not become ready") ||
    state.error.includes("Bundled Hermes runtime source not found")
  );
  const canSend = !needsProviderSetup && !isHermesMissing && !state?.busy;

  if (!state) {
    return (
      <div className="shell">
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-title">
              <p className="eyebrow">SZ Gov Scope</p>
              <h1>Hermes Desktop</h1>
            </div>
          </div>
          <div className="empty-state">
            <strong>正在启动</strong>
            <p>正在连接并启动本地 Hermes 智能体后台...</p>
          </div>
        </aside>
        <main className="chat">
          <div className="welcome-card">
            <p className="eyebrow">Loading</p>
            <h3>准备桌面控制台</h3>
            <p>如果你是首次启动应用，连接本地进程需要几秒钟，请稍候。</p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-title">
            <p className="eyebrow">SZ Gov Scope</p>
            <h1>Hermes Desktop</h1>
          </div>
          <button className="ghost-button" onClick={() => setSettingsOpen(true)} aria-label="设置">
            设置
          </button>
        </div>

        <button className="primary-button sidebar-new" onClick={createNewChat} disabled={isHermesMissing}>
          + 新建对话
        </button>

        <div className="sidebar-section">
          <div className="section-head">
            <span>对话历史</span>
            <span>{orderedThreads.length}</span>
          </div>

          <div className="thread-list">
            {orderedThreads.length === 0 ? (
              <div className="empty-state">
                <strong>暂无对话历史</strong>
                <p>新建一个会话来开始与智能体进行情报工作对接。</p>
              </div>
            ) : (
              orderedThreads.map((thread) => (
                <article
                  key={thread.id}
                  className={thread.id === state.activeThreadId ? "thread-item active" : "thread-item"}
                >
                  <button
                    className="thread-main-button"
                    onClick={() => void selectThread(thread.id)}
                  >
                    <div className="thread-row">
                      <strong>{thread.name || thread.preview || "未命名会话"}</strong>
                      <span>{formatRelativeTime(thread.updatedAt)}</span>
                    </div>
                    <p>{thread.preview || "暂无情报预览"}</p>
                    <div className="thread-meta">
                      <span className="thread-pill">{thread.modelProvider}</span>
                      <span>{thread.status}</span>
                    </div>
                  </button>
                  <button
                    className="thread-delete-button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void deleteThread(thread.id, thread.name || thread.preview);
                    }}
                    aria-label="删除历史记录"
                    title="删除历史记录"
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                </article>
              ))
            )}
          </div>
        </div>

        <div className="sidebar-footer">
          <span className={`status-dot ${state.error ? "error" : ""}`} />
          <span className="status-text">{state.error ? "运行时未就绪" : state.status}</span>
        </div>
      </aside>

      <main className="chat">
        <header className="chat-header">
          <div className="chat-header-title">
            <p className="eyebrow">Intel Agent Console</p>
            <h2>{activeName}</h2>
          </div>
          <div className="header-actions">
            {isOfficialMode ? (
              <div className={`model-header-pill ${quickModelDirty ? "dirty" : ""}`}>
                <span className="pill-label">运行模型</span>
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
                <span className="pill-label">运行模型</span>
                <span className="pill-value">{displayModel}</span>
              </div>
            )}
            <div className="workspace-header-pill">
              <span className="pill-label">工作区</span>
              <span className={`pill-value ${state.settings.cwd ? "configured" : ""}`}>
                {state.settings.cwd ? "已配置" : "默认"}
              </span>
            </div>
          </div>
        </header>

        <section className="message-scroller">
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
                <button className="primary-button" onClick={() => setSettingsOpen(true)}>打开运行设置</button>
              </div>
            </div>
          ) : activeMessages.length === 0 && !state.activeDraft ? (
            <div className="welcome-card">
              <p className="eyebrow">Ready</p>
              <h3>双向情报助手</h3>
              <p>
                当前工作区配置已生效。你可以在下方直接输入你关于深圳政务信息、情报收集或公文撰写的问题，由本地 Hermes 智能体为你提供支持。
              </p>
            </div>
          ) : null}

          {!isHermesMissing && activeMessages.map((message: HermesChatMessage) => (
            <article key={message.id} className={message.role === "user" ? "bubble user" : "bubble assistant"}>
              <div className="bubble-head">
                <strong>{message.role === "user" ? "你" : "Hermes"}</strong>
                {message.phase ? <span>{message.phase}</span> : null}
              </div>
              <MessageBody role={message.role} text={message.text} />
            </article>
          ))}

          {!isHermesMissing && state.activeDraft ? (
            <article className="bubble assistant streaming">
              <div className="bubble-head">
                <strong>Hermes</strong>
                <span>处理中</span>
              </div>
              {state.activeDraft.reasoning?.trim() ? <TraceBlock text={state.activeDraft.reasoning} /> : null}
              <MessageBody role="assistant" text={state.activeDraft.text || "…"} />
            </article>
          ) : null}

          <div ref={messagesEndRef} />
        </section>

        <footer className="composer">
          {state.settings.registeredSkills && state.settings.registeredSkills.length > 0 && (
            <div className="skills-picker">
              <span className="skills-picker-label">快捷应用技能：</span>
              {state.settings.registeredSkills.map((skill) => {
                const trigger = `@${skill.name}`;
                const isActive = draft.startsWith(trigger + " ") || draft === trigger;
                return (
                  <button
                    key={skill.path}
                    type="button"
                    className={`skill-picker-pill ${isActive ? "active" : ""}`}
                    onClick={() => {
                      setDraft((prev) => {
                        // If it already starts with this skill, toggle it off (remove it)
                        if (prev.startsWith(trigger + " ")) {
                          return prev.slice(trigger.length + 1);
                        } else if (prev === trigger) {
                          return "";
                        }
                        
                        // Otherwise, remove any other active skill prefix first
                        let cleaned = prev;
                        for (const s of state.settings.registeredSkills) {
                          const t = `@${s.name}`;
                          if (cleaned.startsWith(t + " ")) {
                            cleaned = cleaned.slice(t.length + 1);
                            break;
                          } else if (cleaned === t) {
                            cleaned = "";
                            break;
                          }
                        }
                        return trigger + " " + cleaned;
                      });
                    }}
                    title={skill.description}
                  >
                    @{skill.name}
                  </button>
                );
              })}
            </div>
          )}
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void sendMessage();
              }
            }}
            placeholder={
              isHermesMissing
                ? "运行时未就绪，消息框已禁用"
                : needsProviderSetup
                  ? isOfficialMode
                    ? "请先让本机 Hermes 官方配置完成登录，消息框暂不可用"
                    : "请先在设置中填写 API key，消息框暂不可用"
                  : "在此输入需要处理的任务，Enter 发送，Shift+Enter 换行"
            }
            rows={3}
            disabled={isHermesMissing || needsProviderSetup}
          />
          <div className="composer-actions">
            <p>
              {needsProviderSetup
                ? isOfficialMode
                  ? "请先完成 Hermes 官方登录配置"
                  : "请先完成 provider / model / API key 配置"
                : state.busy
                  ? "Hermes 正在处理中..."
                  : `当前运行模型：${displayModel}`}
            </p>
            <button className="primary-button" onClick={sendMessage} disabled={!draft.trim() || !canSend}>
              发送
            </button>
          </div>
        </footer>
      </main>

      {settingsOpen ? (
        <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}>
          <div className="settings-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <div>
                <p className="eyebrow">Settings</p>
                <h3>模型与运行配置</h3>
              </div>
              <button className="ghost-button" onClick={() => setSettingsOpen(false)}>
                关闭
              </button>
            </div>

            <label>
              接入模式
              <select
                value={draftSettings.runtimeMode}
                onChange={(event) =>
                  setDraftSettings((current: HermesAppState["settings"]) => ({
                    ...current,
                    runtimeMode: event.target.value as HermesAppState["settings"]["runtimeMode"],
                    model: event.target.value === "official" ? state.official.defaultModel : current.model,
                  }))
                }
                className="settings-select"
              >
                <option value="private">自定义私有模式</option>
                <option value="official">Hermes 官方模式</option>
              </select>
            </label>

            <label>
              内置 Runtime Binary
              <input value={state.settings.hermesBin} disabled />
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
                    <span className="skill-card-path">{state.runtime.installDir}</span>
                    <span className="skill-card-path">{state.runtime.homeDir}</span>
                  </div>
                </div>
              </div>
              <div className="modal-actions">
                <button className="secondary-button" onClick={() => void repairRuntime()}>
                  安装 / 修复运行时
                </button>
                <button
                  className="secondary-button"
                  onClick={() => void uninstallRuntime()}
                  disabled={!runtimeInstalled || state.runtime.uninstalling}
                >
                  {state.runtime.uninstalling ? "卸载中..." : "一键卸载运行时"}
                </button>
              </div>
            </div>

            <label>
              Model
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
                      {(state.official.availableModels.length > 0 ? state.official.availableModels : [state.official.defaultModel]).map((modelId) => (
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
                    {officialModelDirty ? ` | 点击应用：${state.official.defaultModel} → ${draftSettings.model}` : ""}
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
                  placeholder="gpt-5.4"
                />
              )}
            </label>

            <label>
              Workspace CWD
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
                    <option value="openrouter">OpenRouter</option>
                    <option value="deepseek">DeepSeek</option>
                    <option value="openai">OpenAI</option>
                    <option value="custom">自定义 OpenAI 兼容 API</option>
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

            {draftSettings.runtimeMode === "official" ? (
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
            ) : null}

            <div className="skills-section">
              <div className="skills-section-header">
                <h4>已注册技能 (Skills)</h4>
                <button className="add-skill-button" onClick={registerNewSkill}>
                  + 注册本地技能
                </button>
              </div>
              <div className="skills-list-container">
                {state.settings.registeredSkills.length === 0 ? (
                  <p className="no-skills-copy">暂无已注册的技能，点击上方按钮注册本地 SKILL.md 文件。</p>
                ) : (
                  state.settings.registeredSkills.map((skill) => (
                    <div key={skill.path} className="skill-card">
                      <div className="skill-info">
                        <strong className="skill-card-header">@{skill.name}</strong>
                        <p className="skill-card-desc">{skill.description}</p>
                        <span className="skill-card-path">{skill.path}</span>
                      </div>
                      <button 
                        className="skill-action-btn"
                        onClick={() => unregisterSkill(skill.path)}
                      >
                        注销
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>

            <p className="modal-copy">
              配置完成后将自动重新启动后台 Hermes Runtime 服务。私有模式使用你自己填写的 provider/API key；官方模式复用本机 `~/.hermes` 的登录态和默认模型。卸载运行时只会删除这个应用私有目录里的 Hermes 程序与会话数据，不会删除你的整个项目代码。
            </p>

            <div className="modal-actions">
              <button className="secondary-button" onClick={() => setSettingsOpen(false)}>
                取消
              </button>
              <button className="primary-button" onClick={() => void saveSettings()}>
                {officialModelDirty ? "保存并切换模型" : "保存并应用"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {isModelSwitching ? (
        <BusyOverlay
          title="正在切换模型"
          detail="Hermes 切换模型通常需要 30 到 60 秒，等待 45 秒左右也算正常。期间请不要重复点击或继续发送消息。"
          elapsedSeconds={busyElapsedSeconds}
        />
      ) : null}
    </div>
  );
}
