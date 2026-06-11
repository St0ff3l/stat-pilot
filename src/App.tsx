import { useEffect, useRef, useState } from "react";
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

export default function App() {
  const [state, setState] = useState<HermesAppState | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftSettings, setDraftSettings] = useState<HermesAppState["settings"]>({
    hermesBin: "hermes",
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
      setDraftSettings(initial.settings);

      unsubscribe = window.hermesDesktop.onState((nextState) => {
        setState(nextState);
        setDraftSettings(nextState.settings);
      });
    }

    void bootstrap();

    return () => unsubscribe?.();
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [state?.messages.length, state?.activeDraft?.text]);

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

  const orderedThreads = [...(state?.threads ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
  const activeThread = state?.activeThread ?? null;
  const activeName = activeThread?.name || activeThread?.preview || "新对话";
  const activeMessages = state?.messages ?? [];
  const isHermesMissing = !!state?.error && (
    state.error.includes("ENOENT") || 
    state.error.includes("找不到 Hermes") || 
    state.error.includes("exited unexpectedly") ||
    state.error.includes("exited")
  );

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
                <button
                  key={thread.id}
                  className={thread.id === state.activeThreadId ? "thread-item active" : "thread-item"}
                  onClick={() => selectThread(thread.id)}
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
          <div>
            <p className="eyebrow">Intel Agent Console</p>
            <h2>{activeName}</h2>
          </div>
          <div className="header-actions">
            <div className="mini-pill">
              <span>Model / 模型</span>
              <strong>{state.settings.model ?? "未设置"}</strong>
            </div>
            <div className="mini-pill">
              <span>Workspace / 工作区</span>
              <strong>{state.settings.cwd ? "已配置" : "默认"}</strong>
            </div>
          </div>
        </header>

        <section className="message-scroller">
          {isHermesMissing ? (
            <div className="onboarding-card">
              <div className="onboarding-title">
                <h3>Hermes 运行时未就绪</h3>
              </div>
              <p>桌面客户端目前无法检测到有效的 Hermes Agent 可执行程序。这通常是因为本地开发包尚未拉取或路径未正确加载，请尝试以下步骤：</p>
              <div className="guide-steps">
                <div className="step-item">
                  <strong>第一步：在终端中安装/运行引导程序</strong>
                  <p>打开终端进入当前项目路径下，执行以下指令来拉取、解压并配置本地虚拟环境：</p>
                  <code>npm run hermes:bootstrap</code>
                </div>
                <div className="step-item">
                  <strong>第二步：在设置中校对路径</strong>
                  <p>如果你之前已经在系统上拥有已解压的 `hermes`，可以点击右上角<b>『设置』</b>，修改并保存正确的 <b>Hermes Binary</b> 文件绝对路径。</p>
                </div>
              </div>
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
              <pre>{message.text}</pre>
            </article>
          ))}

          {!isHermesMissing && state.activeDraft ? (
            <article className="bubble assistant streaming">
              <div className="bubble-head">
                <strong>Hermes</strong>
                <span>正在生成回复</span>
              </div>
              <pre>{state.activeDraft.text || "正在整理情报中..."}</pre>
            </article>
          ) : null}

          <div ref={messagesEndRef} />
        </section>

        <footer className="composer">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void sendMessage();
              }
            }}
            placeholder={isHermesMissing ? "运行时未就绪，消息框已禁用" : "在此输入需要处理的任务，Enter 发送，Shift+Enter 换行"}
            rows={3}
            disabled={isHermesMissing}
          />
          <div className="composer-actions">
            <p>
              {state.busy ? "Hermes 正在分析并调用工具..." : `当前模型：${state.settings.model ?? "未设置"}`}
            </p>
            <button className="primary-button" onClick={sendMessage} disabled={!draft.trim() || !!state.busy || isHermesMissing}>
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
              Hermes Binary
              <input
                value={draftSettings.hermesBin}
                onChange={(event) =>
                  setDraftSettings((current: HermesAppState["settings"]) => ({
                    ...current,
                    hermesBin: event.target.value,
                  }))
                }
                placeholder="hermes"
              />
            </label>

            <label>
              Model
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

            {draftSettings.apiProvider === "custom" && (
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
              配置完成后将自动重新启动后台 Hermes Runtime 服务以应用最新的 API 密钥和模型设置。
            </p>

            <div className="modal-actions">
              <button className="secondary-button" onClick={() => setSettingsOpen(false)}>
                取消
              </button>
              <button className="primary-button" onClick={() => void saveSettings()}>
                保存并应用
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
