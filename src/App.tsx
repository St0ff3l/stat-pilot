import React, { Component, useEffect, useMemo, useRef, useState, type ReactNode, type ErrorInfo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import szLogo from "./assets/sz-logo.png";

const VOICE_PROVIDER_ID = "sensevoice-local";
const VOICE_SAMPLE_RATE = 16_000;
const MAX_VOICE_SECONDS = 120;

function readMigratedLocalValue(key: string, previousKey: string): string | null {
  let current: string | null;
  try {
    current = localStorage.getItem(key);
  } catch {
    return null;
  }

  if (current !== null) {
    try { localStorage.removeItem(previousKey); } catch { /* keep the current value usable */ }
    return current;
  }

  let previous: string | null;
  try {
    previous = localStorage.getItem(previousKey);
  } catch {
    return null;
  }
  if (previous === null) return null;

  try {
    localStorage.setItem(key, previous);
    localStorage.removeItem(previousKey);
  } catch {
    // Return the legacy value even when quota or storage policy blocks migration.
  }
  return previous;
}

async function encodeSpeechWavBase64(recording: Blob): Promise<string> {
  const audioContext = new AudioContext();
  try {
    const decoded = await audioContext.decodeAudioData(await recording.arrayBuffer());
    const frameCount = Math.max(1, Math.floor(Math.min(decoded.duration, MAX_VOICE_SECONDS) * VOICE_SAMPLE_RATE));
    const offlineContext = new OfflineAudioContext(1, frameCount, VOICE_SAMPLE_RATE);
    const source = offlineContext.createBufferSource();
    source.buffer = decoded;
    source.connect(offlineContext.destination);
    source.start(0);
    const resampled = await offlineContext.startRendering();
    const samples = resampled.getChannelData(0);
    const wav = new Uint8Array(44 + samples.length * 2);
    const header = new DataView(wav.buffer);
    const writeAscii = (offset: number, value: string) => {
      for (let index = 0; index < value.length; index += 1) wav[offset + index] = value.charCodeAt(index);
    };

    writeAscii(0, "RIFF");
    header.setUint32(4, wav.length - 8, true);
    writeAscii(8, "WAVE");
    writeAscii(12, "fmt ");
    header.setUint32(16, 16, true);
    header.setUint16(20, 1, true);
    header.setUint16(22, 1, true);
    header.setUint32(24, VOICE_SAMPLE_RATE, true);
    header.setUint32(28, VOICE_SAMPLE_RATE * 2, true);
    header.setUint16(32, 2, true);
    header.setUint16(34, 16, true);
    writeAscii(36, "data");
    header.setUint32(40, samples.length * 2, true);

    for (let index = 0; index < samples.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, samples[index]));
      header.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }

    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < wav.length; offset += chunkSize) {
      binary += String.fromCharCode(...wav.subarray(offset, Math.min(offset + chunkSize, wav.length)));
    }
    return btoa(binary);
  } finally {
    await audioContext.close().catch(() => {});
  }
}

function formatRelativeTime(value: number): string {
  const date = new Date(value * 1000);
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function withDisplayModel(appState: DshAppState): DshAppState["settings"] {
  return {
    defaultOutputDir: "output",
    customModels: [],
    ...appState.settings,
    model: appState.settings.model,
  };
}

const EMPTY_MESSAGES: DshChatMessage[] = [];

const PROVIDER_PRESET_MODELS: Record<string, Array<{ id: string; label: string; desc: string }>> = {
  deepseek: [
    { id: "deepseek-flash", label: "deepseek-flash", desc: "DeepSeek-V4.1 Flash 最新版，原生视觉理解" },
    { id: "deepseek-v4-pro", label: "deepseek-v4-pro", desc: "官方兼容 ID，当前路由到 V4.1 Flash" },
  ],
  openai: [
    { id: "gpt-5.5", label: "gpt-5.5", desc: "GPT-5.5 最新旗舰" },
    { id: "gpt-5.4", label: "gpt-5.4", desc: "GPT-5.4 专业工作" },
    { id: "gpt-5.4-mini", label: "gpt-5.4-mini", desc: "GPT-5.4 Mini 高性价比" },
    { id: "gpt-5.4-nano", label: "gpt-5.4-nano", desc: "GPT-5.4 Nano 快速低成本" },
  ],
  openrouter: [
    { id: "deepseek/deepseek-v4-flash", label: "deepseek-v4-flash", desc: "DeepSeek V4 Flash 快速" },
    { id: "deepseek/deepseek-v4-pro", label: "deepseek-v4-pro", desc: "DeepSeek V4 Pro 旗舰" },
    { id: "openai/gpt-5.5", label: "gpt-5.5", desc: "GPT-5.5 最新旗舰" },
    { id: "anthropic/claude-sonnet-4.6", label: "claude-sonnet-4.6", desc: "Claude Sonnet 4.6" },
    { id: "google/gemini-3.1-pro-preview", label: "gemini-3.1-pro", desc: "Gemini 3.1 Pro Preview" },
  ],
  custom: [
    { id: "gpt-5.5", label: "gpt-5.5", desc: "GPT-5.5 (兼容接口)" },
    { id: "gpt-5.4", label: "gpt-5.4", desc: "GPT-5.4 (兼容接口)" },
    { id: "deepseek-v4-flash", label: "deepseek-v4-flash", desc: "DeepSeek V4 Flash (兼容接口)" },
    { id: "deepseek-v4-pro", label: "deepseek-v4-pro", desc: "DeepSeek V4 Pro (兼容接口)" },
  ],
};

function MessageBody({ role, text }: { role: DshChatMessage["role"]; text: string }) {
  const safeText = text ?? "";
  if (role === "user") {
    return <pre className="message-plain">{safeText}</pre>;
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
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => {
                if (href && window.dshDesktop?.openExternal) {
                  e.preventDefault();
                  void window.dshDesktop.openExternal(href);
                }
              }}
            >
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
        {safeText}
      </ReactMarkdown>
    </div>
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

export interface DigestItem {
  id: string;
  title: string;
  organization?: string;
  publish_time?: string;
  summary?: string;
  link?: string;
  category?: string;
}

type ReportStyleOption = {
  id: string;
  label: string;
  description: string;
  tone: string;
};

const BUILTIN_SKILL_DISPLAY_NAMES: Record<string, string> = {
  "info-digest-html": "动态信息汇总 HTML 报表",
  "weekly-report": "统计信息化动态采集与周报",
  "price-index-gdp-impact": "价格指数对 GDP 各项影响分析",
  "source-verification": "官方来源与转载核验",
  "gov-official-document-drafting": "政务公文起草",
  info_digest_html: "动态信息汇总 HTML 报表",
  weekly_report: "统计信息化动态采集与周报",
  price_index_gdp_impact: "价格指数对 GDP 各项影响分析",
  source_verification: "官方来源与转载核验",
  gov_official_document_drafting: "政务公文起草",
};

const BUILTIN_SKILL_ICONS: Record<string, string> = {
  "info-digest-html": "📰",
  "weekly-report": "📊",
  "price-index-gdp-impact": "📈",
  "source-verification": "🔎",
  "gov-official-document-drafting": "📝",
  info_digest_html: "📰",
  weekly_report: "📊",
  price_index_gdp_impact: "📈",
  source_verification: "🔎",
  gov_official_document_drafting: "📝",
};

function formatCleanTaskTitle(title: string): string {
  if (!title) return "";
  const skillMatch = title.match(/^@([a-zA-Z0-9_\-]+)(?:\s+|$)/);
  if (skillMatch) {
    const skillName = skillMatch[1];
    const displayName = BUILTIN_SKILL_DISPLAY_NAMES[skillName] || skillName;
    const rest = title.replace(/^@[a-zA-Z0-9_\-]+\s*/, "").trim();
    return rest ? `[${displayName}] ${rest}` : `[${displayName}]`;
  }
  return title;
}

const REPORT_STYLE_OPTIONS: ReportStyleOption[] = [
  {
    id: "geek",
    label: "极客卡片",
    description: "信息密度高，适合日常追踪与周报参阅。",
    tone: "blue",
  },
  {
    id: "classic",
    label: "政务经典",
    description: "庄重朱红，适合正式汇报和打印阅读。",
    tone: "red",
  },
  {
    id: "slate",
    label: "现代板岩",
    description: "克制清爽，适合数字政府看板式呈现。",
    tone: "slate",
  },
  {
    id: "dark",
    label: "暗黑海洋",
    description: "深色大屏，适合会议室展示和夜间浏览。",
    tone: "navy",
  },
  {
    id: "swiss",
    label: "瑞士编辑",
    description: "极简网格，适合专题材料和编辑式阅读。",
    tone: "yellow",
  },
];

const REPORT_SKILL_NAMES = new Set([
  "info-digest-html",
  "weekly-report",
  "price-index-gdp-impact",
  "source-verification",
  "gov-official-document-drafting",
  "info_digest_html",
  "weekly_report",
  "price_index_gdp_impact",
  "source_verification",
  "gov_official_document_drafting",
]);

const BUILTIN_SKILL_START_PROMPTS: Record<string, string> = {
  "weekly-report":
    "请采集最近 7 天国家统计局、广东省统计局、深圳市统计局等官方来源的统计信息化动态，筛选信息化、数字化、人工智能、大数据等主题，生成周报；每条内容都必须标明发布单位或网站全称、完整标题、发布日期和具体原文链接。",
  "price-index-gdp-impact":
    "请默认以深圳市为分析对象，分析 CPI、PPI、GDP 平减指数等价格指数对 GDP 各项（消费、投资、净出口及名义/实际 GDP）的影响；优先使用深圳市统计局及深圳市政府官方统计数据，国家和广东省数据只作口径或对照，区分相关性与因果性，并为每个事实附发布单位或网站全称、完整标题和具体原文链接。",
  "source-verification":
    "请核验我接下来提交的文件或链接：确认是否为官方来源、发布日期、发布机构、具体原文链接是否有效，并识别重复、转载和二次改写关系；输出逐项证据和发布单位或网站全称、完整标题、具体原文链接。",
  "gov-official-document-drafting":
    "请按深圳市统计局官方网站公开页面的政务文风起草公文：先根据我的任务判断合适的文种，保留文号、落款、联系人等待补字段，不虚构正式发布信息，并为事实、政策依据和数据附发布单位或网站全称、完整标题和具体原文链接。",
  weekly_report:
    "请采集最近 7 天国家统计局、广东省统计局、深圳市统计局等官方来源的统计信息化动态，筛选信息化、数字化、人工智能、大数据等主题，生成周报；每条内容都必须标明发布单位或网站全称、完整标题、发布日期和具体原文链接。",
  price_index_gdp_impact:
    "请默认以深圳市为分析对象，分析 CPI、PPI、GDP 平减指数等价格指数对 GDP 各项（消费、投资、净出口及名义/实际 GDP）的影响；优先使用深圳市统计局及深圳市政府官方统计数据，国家和广东省数据只作口径或对照，区分相关性与因果性，并为每个事实附发布单位或网站全称、完整标题和具体原文链接。",
  source_verification:
    "请核验我接下来提交的文件或链接：确认是否为官方来源、发布日期、发布机构、具体原文链接是否有效，并识别重复、转载和二次改写关系；输出逐项证据和发布单位或网站全称、完整标题、具体原文链接。",
  gov_official_document_drafting:
    "请按深圳市统计局官方网站公开页面的政务文风起草公文：先根据我的任务判断合适的文种，保留文号、落款、联系人等待补字段，不虚构正式发布信息，并为事实、政策依据和数据附发布单位或网站全称、完整标题和具体原文链接。",
};

function extractDigestItems(text: string): DigestItem[] {
  if (!text) return [];

  // 1. Try JSON block parsing
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (jsonMatch) {
    try {
      const jsonStr = jsonMatch[1] || jsonMatch[0];
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].title) {
        return parsed.map((item: any, idx: number) => ({
          id: item.link || item.url || `${item.title}_${idx}`,
          title: item.title || item.name || "未命名动态",
          organization: item.organization || item.unit || item.source || item.site || "统计局",
          publish_time: item.publish_time || item.date || item.time || "",
          summary: item.summary || item.desc || item.content || "",
          link: item.link || item.url || "",
          category: item.category || item.type || item.relevance || "工作动态",
        }));
      }
    } catch {
      // ignore parse error
    }
  }

  // 2. Try parsing Markdown articles with book titles 《...》
  const items: DigestItem[] = [];
  const bookTitleRegex = /《([^》]+)》\s*(?:[（(]([^）)]+)[）)])?/g;
  let match: RegExpExecArray | null;

  while ((match = bookTitleRegex.exec(text)) !== null) {
    const rawTitle = match[1].trim();
    if (rawTitle.includes("info_digest_html") || rawTitle.includes("weekly_report")) {
      continue;
    }
    const pubTime = match[2]?.trim() || "";

    const restText = text.slice(match.index + match[0].length);
    const nextMatch = restText.search(/《[^》]+》|###|\n---\n/);
    const block = nextMatch !== -1 ? restText.slice(0, nextMatch) : restText;

    let summary = "";
    const summaryMatch = block.match(/(?:核心内容|主要内容|摘要|简介|内容)[:：]\s*([^\n]+)/);
    if (summaryMatch) {
      summary = summaryMatch[1].trim();
    } else {
      const firstLine = block.split("\n").map(l => l.trim()).find(l => l.length > 5 && !l.startsWith("关联度") && !l.startsWith("来源") && !l.startsWith("附注"));
      summary = firstLine || "";
    }

    const linkMatch = block.match(/(https?:\/\/[^\s)\\]]+)/);
    const link = linkMatch ? linkMatch[1] : "";

    const orgMatch = block.match(/(?:来源|单位|发布方)[:：]\s*([^\n]+)/);
    const organization = orgMatch ? orgMatch[1].trim() : "国家统计局";

    items.push({
      id: link || `${rawTitle}_${items.length}`,
      title: rawTitle,
      organization,
      publish_time: pubTime,
      summary,
      link,
      category: "工作动态",
    });
  }

  // 3. Try parsing text structured with "标题[:：]"
  const titleRegex = /(?:标题|Title)[:：]\s*([^\n]+)/g;
  let tMatch: RegExpExecArray | null;

  while ((tMatch = titleRegex.exec(text)) !== null) {
    const rawTitle = tMatch[1].trim().replace(/^["'《]|["'》]$/g, "");
    if (!rawTitle || rawTitle.includes("info_digest_html") || rawTitle.includes("weekly_report")) {
      continue;
    }

    const restText = text.slice(tMatch.index + tMatch[0].length);
    const nextMatch = restText.search(/(?:标题|Title)[:：]|###|\n---\n/);
    const block = nextMatch !== -1 ? restText.slice(0, nextMatch) : restText;

    let time = "";
    const timeMatch = block.match(/(?:时间|发布时间|日期)[:：]\s*([^\n]+)/);
    if (timeMatch) time = timeMatch[1].trim();

    let summary = "";
    const summaryMatch = block.match(/(?:核心内容|主要内容|摘要|简介|内容|关键词)[:：]\s*([^\n]+)/);
    if (summaryMatch) {
      summary = summaryMatch[1].trim();
    } else {
      const firstLine = block.split("\n").map(l => l.trim()).find(l => l.length > 5 && !l.startsWith("链接") && !l.startsWith("来源"));
      summary = firstLine || "";
    }

    let link = "";
    const linkMatch = block.match(/(https?:\/\/[^\s)\\]]+)/);
    if (linkMatch) link = linkMatch[1];

    let organization = "国家统计局";
    const orgMatch = block.match(/(?:来源|单位|发布方)[:：]\s*([^\n]+)/);
    if (orgMatch) organization = orgMatch[1].trim();

    items.push({
      id: link || `${rawTitle}_${items.length}`,
      title: rawTitle,
      organization,
      publish_time: time,
      summary,
      link,
      category: "工作动态",
    });
  }

  if (items.length > 0) {
    return items;
  }

  return [];
}

function CheckableItemSection({
  items,
  selectedMap,
  onToggleItem,
  onToggleAll,
}: {
  items: DigestItem[];
  selectedMap: Record<string, DigestItem>;
  onToggleItem: (item: DigestItem) => void;
  onToggleAll: (items: DigestItem[]) => void;
}) {
  if (!items || items.length === 0) return null;
  const allSelected = items.every((it) => Boolean(selectedMap[it.id]));

  return (
    <div className="digest-items-container">
      <div className="digest-items-header">
        <h4>
          <span>📌</span> 检索提取条目 ({items.length} 条动态可选)
        </h4>
        <button
          type="button"
          className="digest-items-select-all"
          onClick={() => onToggleAll(items)}
        >
          {allSelected ? "取消全选" : "全选本组"}
        </button>
      </div>

      <div className="digest-items-grid">
        {items.map((item) => {
          const isChecked = Boolean(selectedMap[item.id]);
          return (
            <div
              key={item.id}
              className={`digest-item-row ${isChecked ? "selected" : ""}`}
              onClick={() => onToggleItem(item)}
            >
              <input
                type="checkbox"
                className="digest-checkbox"
                checked={isChecked}
                onChange={() => {}}
              />
              <div className="digest-item-content">
                <div className="digest-item-title-row">
                  <span className="digest-item-title">{item.title}</span>
                  {item.organization && (
                    <span className="digest-item-org-badge">{item.organization}</span>
                  )}
                </div>
                {item.summary && <p className="digest-item-summary">{item.summary}</p>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatFileSize(size?: number): string {
  if (typeof size !== "number" || !Number.isFinite(size)) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function StreamActivityGlyph({ activity }: { activity: DshStreamActivity }) {
  const isBash = activity.label === "Bash";
  const isRead = activity.label === "Read";
  const isBrowse = activity.label === "Browse";
  const isSkillView = activity.label === "Skill View" || activity.label === "技能视图";
  const isPlan = activity.label === "Plan" || activity.label === "计划";
  const isThink = activity.kind === "thinking" || activity.label === "Think";

  return (
    <span className="stream-activity-glyph" aria-hidden="true">
      <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        {isThink ? (
          <>
            <path d="M6.1 8.3a3.2 3.2 0 1 1 5.8 0c-.6.7-.9 1.4-1 2.5H7.1c-.1-1.1-.4-1.8-1-2.5Z" />
            <path d="M7.3 12.2h3.4M7.7 14.2h2.6" />
          </>
        ) : isSkillView ? (
          <>
            <path d="m10.8 2.4.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" />
            <path d="m5.2 8.6.55 1.45 1.45.55-1.45.55-.55 1.45-.55-1.45-1.45-.55 1.45-.55.55-1.45Z" />
            <path d="m8.5 13 2.6-2.6" />
          </>
        ) : isPlan ? (
          <>
            <rect x="4" y="3.5" width="10" height="12" rx="1.5" />
            <path d="M7 3.5v-1h4v1" />
            <path d="m6.2 7.5.9.9 1.5-1.7M10 7.5h2.2" />
            <path d="m6.2 11 .9.9 1.5-1.7M10 11h2.2" />
          </>
        ) : activity.kind === "narrative" ? (
          <>
            <rect x="3" y="3" width="12" height="12" rx="2" />
            <path d="M5.5 6.5h7M5.5 9h7M5.5 11.5h4.5" />
          </>
        ) : activity.kind === "context" ? (
          <>
            <rect x="3" y="3" width="12" height="12" rx="1.5" />
            <path d="M5.5 6.2h7M5.5 9h7M5.5 11.8h4.5" />
          </>
        ) : activity.kind === "error" ? (
          <>
            <circle cx="9" cy="9" r="6.4" />
            <path d="M9 5.6v4.2M9 12.6v.1" />
          </>
        ) : isBash ? (
          <>
            <path d="m4.5 4.4 4.3 4.6-4.3 4.6M10.8 13.6h2.8" />
          </>
        ) : isRead ? (
          <>
            <rect x="3" y="3" width="12" height="12" rx="1.2" />
            <path d="m4.2 7.2 6.6 6.6M4.2 4.5l9.3 9.3M7.4 3.8l6.8 6.8" />
          </>
        ) : isBrowse ? (
          <>
            <circle cx="9" cy="9" r="6.4" />
            <circle cx="9" cy="9" r="2" />
            <path d="M9 1.7v2M9 14.3v2M1.7 9h2M14.3 9h2" />
          </>
        ) : activity.kind === "subagent" ? (
          <>
            <circle cx="5" cy="9" r="1.7" />
            <circle cx="13" cy="5" r="1.7" />
            <circle cx="13" cy="13" r="1.7" />
            <path d="m6.5 8.2 4.8-2.4M6.5 9.8l4.8 2.4" />
          </>
        ) : (
          <rect x="3" y="3" width="12" height="12" rx="1.5" />
        )}
      </svg>
    </span>
  );
}

function ThinkingActivityRow({ activity, detail }: { activity: DshStreamActivity; detail: string }) {
  const isComplete = activity.status === "complete";
  const [expanded, setExpanded] = useState(() => !isComplete);
  const canToggle = isComplete && Boolean(detail.trim());

  return (
    <div className={`stream-activity-row ${activity.status} thinking${expanded ? " expanded" : " collapsed"}`}>
      <button
        type="button"
        className="stream-activity-thinking-toggle"
        disabled={!canToggle}
        aria-expanded={canToggle ? expanded : undefined}
        aria-label={`${activity.label} · ${detail}`}
        onClick={() => {
          if (canToggle) {
            setExpanded((current) => !current);
          }
        }}
      >
        <StreamActivityGlyph activity={activity} />
        <span className="stream-activity-label">{activity.label}</span>
        <span className="stream-activity-separator" aria-hidden="true">·</span>
        {!isComplete ? (
          <span className="stream-activity-thinking-detail">{detail}</span>
        ) : (
          expanded ? null : <span className="stream-activity-thinking-collapsed">已完成</span>
        )}
        {activity.status === "running" ? (
          <span className="stream-activity-state" aria-label="进行中">
            <span className="stream-activity-spinner" aria-hidden="true" />
          </span>
        ) : canToggle ? (
          <span className="stream-activity-thinking-chevron" aria-hidden="true">
            <svg viewBox="0 0 16 16" focusable="false">
              <path d={expanded ? "m3.5 9.5 4.5-4 4.5 4" : "m3.5 6.5 4.5 4 4.5-4"} />
            </svg>
          </span>
        ) : null}
      </button>
      {isComplete && expanded ? (
        <div className="stream-activity-thinking-body">{detail}</div>
      ) : null}
    </div>
  );
}

function StreamActivityTimeline({
  activities,
  live = false,
}: {
  activities: DshStreamActivity[];
  live?: boolean;
}) {
  const visibleActivities = activities.slice(-80);
  if (visibleActivities.length === 0) return null;

  return (
    <div className={`stream-activity-feed ${live ? "live" : ""}`} role="list" aria-label="智能体活动流" aria-live={live ? "polite" : undefined}>
      {visibleActivities.map((activity) => {
        const detail = activity.detail || (
          activity.status === "running"
            ? "处理中…"
            : activity.status === "error"
              ? "执行失败"
              : "已完成"
        );
        const duration = typeof activity.durationMs === "number"
          ? ` · ${(activity.durationMs / 1000).toFixed(activity.durationMs < 10_000 ? 1 : 0)}s`
          : "";
        const isNarrative = activity.kind === "narrative";
        const isThinking = activity.kind === "thinking";

        if (isThinking) {
          return (
            <ThinkingActivityRow
              key={`${activity.id}:${activity.status}`}
              activity={activity}
              detail={detail}
            />
          );
        }

        return (
          <div
            key={activity.id}
            className={`stream-activity-row ${activity.status}${isThinking ? " thinking" : ""}${isNarrative ? " narrative" : ""}`}
            role="listitem"
            aria-label={`${activity.label} · ${detail}${duration}`}
          >
            <StreamActivityGlyph activity={activity} />
            {isNarrative ? (
              <div className="stream-activity-narrative">
                <MessageBody role="assistant" text={detail} />
              </div>
            ) : (
              <>
                <span className="stream-activity-label">{activity.label}</span>
                <span className="stream-activity-separator" aria-hidden="true">·</span>
                <span className="stream-activity-detail">{detail}</span>
                {duration ? <span className="stream-activity-duration">{duration}</span> : null}
                {activity.status === "running" || activity.status === "error" ? (
                  <span className="stream-activity-state" aria-label={activity.status === "running" ? "进行中" : "失败"}>
                    {activity.status === "running" ? <span className="stream-activity-spinner" aria-hidden="true" /> : "×"}
                  </span>
                ) : null}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function InterruptedTurnDivider() {
  return (
    <div className="interrupted-history">
      <div className="stream-activity-interrupted" role="status" aria-label="本次处理已终止">
        <span className="stream-activity-interrupted-line" aria-hidden="true" />
        <span>本次处理已终止</span>
        <span className="stream-activity-interrupted-line" aria-hidden="true" />
      </div>
    </div>
  );
}

function App() {
  const [state, setState] = useState<DshAppState | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [bootstrapRetryKey, setBootstrapRetryKey] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeSettingsTab, setActiveSettingsTab] = useState<"runtime" | "chat" | "vision" | "tools">("runtime");
  const [draft, setDraft] = useState("");
  const [pendingVoiceTranscript, setPendingVoiceTranscript] = useState<string | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<"idle" | "preparing" | "recording" | "transcribing">("idle");
  const [voicePreparationText, setVoicePreparationText] = useState("");
  const [selectedAttachments, setSelectedAttachments] = useState<DshSelectedFile[]>([]);
  const [clarificationDraftState, setClarificationDraftState] = useState<{
    requestId: string;
    answers: Record<string, DshQuestionDraft>;
  } | null>(null);
  const clarificationRequestId = state?.pendingClarification?.requestId;
  const clarificationDraft = clarificationRequestId && clarificationDraftState?.requestId === clarificationRequestId
    ? clarificationDraftState.answers
    : {};
  const [isThreadLoading, setIsThreadLoading] = useState(false);
  const [dismissedFiles, setDismissedFiles] = useState<string[] | null>(null);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [archivedThread, setArchivedThread] = useState<{ id: string; title: string } | null>(null);

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
      const saved = readMigratedLocalValue("statpilot_recent_folders", "hermes_recent_folders");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [isFolderMenuOpen, setIsFolderMenuOpen] = useState(false);
  const [workspaceSelectionLocked, setWorkspaceSelectionLocked] = useState(false);
  const folderMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isFolderMenuOpen) return;

    function handleClickOutside(e: MouseEvent) {
      if (folderMenuRef.current && !folderMenuRef.current.contains(e.target as Node)) {
        setIsFolderMenuOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isFolderMenuOpen]);

  const [activeBranch, setActiveBranch] = useState<string | null>(null);
  const [activeMainTab, setActiveMainTab] = useState<"chat" | "skills" | "archive">("chat");
  const [skillsSearchQuery, setSkillsSearchQuery] = useState("");
  const [selectedSkillTag, setSelectedSkillTag] = useState<string | null>(null);
  const [stylePickerSkillName, setStylePickerSkillName] = useState<string | null>(null);
  const [selectedDigestItems, setSelectedDigestItems] = useState<Record<string, DigestItem>>({});

  function handleToggleDigestItem(item: DigestItem) {
    setSelectedDigestItems((prev) => {
      const next = { ...prev };
      if (next[item.id]) {
        delete next[item.id];
      } else {
        next[item.id] = item;
      }
      return next;
    });
  }

  function handleToggleAllDigestItems(items: DigestItem[]) {
    setSelectedDigestItems((prev) => {
      const next = { ...prev };
      const allSelected = items.every((it) => Boolean(next[it.id]));
      if (allSelected) {
        items.forEach((it) => delete next[it.id]);
      } else {
        items.forEach((it) => {
          next[it.id] = it;
        });
      }
      return next;
    });
  }

  function isWorkspaceLocked() {
    // 只有在当前会话已经产生真实交互消息或正在生成中时，才锁定工作区选择
    // 在用户发消息前，允许自由切换工作区，并在输入框底部清晰展示当前选中的文件夹
    return workspaceSelectionLocked || Boolean(
      (activeMessages && activeMessages.length > 0) ||
      state?.activeDraft ||
      (state?.messages && state.messages.length > 0)
    );
  }

  function handleClearSelectedDigestItems() {
    setSelectedDigestItems({});
  }

  const selectedDigestList = useMemo(() => Object.values(selectedDigestItems), [selectedDigestItems]);

  function formatSelectedItemsForPrompt(items: DigestItem[]): string {
    return items
      .map((item, idx) => {
        let line = `${idx + 1}. 《${item.title}》`;
        if (item.organization) line += `（${item.organization}）`;
        if (item.publish_time) line += ` [${item.publish_time}]`;
        if (item.summary) line += `\n   摘要：${item.summary}`;
        return line;
      })
      .join("\n\n");
  }

  function handleDigestActionBriefing() {
    if (selectedDigestList.length === 0) return;
    const itemsText = formatSelectedItemsForPrompt(selectedDigestList);
    const prompt = `请针对我勾选的这 ${selectedDigestList.length} 条统计/政务动态进行深度分析与核心要点提炼：\n\n${itemsText}`;
    setDraft(prompt);
    focusEditor();
  }

  function handleDigestActionCompare() {
    if (selectedDigestList.length < 2) return;
    const itemsText = formatSelectedItemsForPrompt(selectedDigestList);
    const prompt = `请对我勾选的这 ${selectedDigestList.length} 条统计/政务动态进行交叉对比，梳理出各单位在工作重点、技术路径、建设进度上的异同与值得借鉴的亮点：\n\n${itemsText}`;
    setDraft(prompt);
    focusEditor();
  }

  function handleDigestActionGenerateHtml() {
    if (selectedDigestList.length === 0) return;
    handleUseSkillInChat("info_digest_html");
    const itemsText = formatSelectedItemsForPrompt(selectedDigestList);
    const prompt = `请根据我勾选的这 ${selectedDigestList.length} 条动态生成 HTML 参阅报表，默认使用极客卡片风：\n\n${itemsText}`;
    setDraft(prompt);
    focusEditor();
  }
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const voiceCaptureRef = useRef<{ recorder: MediaRecorder; stream: MediaStream; chunks: Blob[] } | null>(null);
  const voiceSetupOperationRef = useRef(0);
  const voiceRecordingTimeoutRef = useRef<number | null>(null);
  const currentVoiceThreadId = state?.activeThreadId ?? null;
  const activeVoiceThreadIdRef = useRef<string | null>(currentVoiceThreadId);
  activeVoiceThreadIdRef.current = currentVoiceThreadId;
  const voiceObservedThreadIdRef = useRef<string | null>(currentVoiceThreadId);

  function focusEditor() {
    window.setTimeout(() => {
      textareaRef.current?.focus();
    }, 0);
  }

  async function waitForVoiceProviderReady(operation: number): Promise<boolean> {
    if (!window.dshDesktop) throw new Error("DSH 语音接口尚未连接");
    let catalog = await window.dshDesktop.getSpeechCatalog();
    let provider = catalog.providers.find((item) => item.id === VOICE_PROVIDER_ID);
    if (!provider) throw new Error("当前 DSH profile 没有启用本地语音识别 Bundle，请重启应用后重试");

    let phase = provider.preparation?.phase || "unprepared";
    if (phase !== "ready") {
      if (["unprepared", "standby", "cancelled", "failed"].includes(phase)) {
        const shouldPrepare = window.confirm("首次使用需要下载或加载本地 SenseVoice 语音模型。录音只会发送到本机 DSH，并在转写后放入草稿，不会自动发送。现在准备吗？");
        if (!shouldPrepare) return false;
        await window.dshDesktop.prepareSpeechProvider(VOICE_PROVIDER_ID);
      }

      setVoiceStatus("preparing");
      const deadline = Date.now() + 30 * 60 * 1000;
      while (Date.now() < deadline) {
        if (operation !== voiceSetupOperationRef.current) return false;
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
        catalog = await window.dshDesktop.getSpeechCatalog();
        provider = catalog.providers.find((item) => item.id === VOICE_PROVIDER_ID);
        if (!provider) throw new Error("DSH 本地语音识别 Provider 已不可用");
        phase = provider.preparation?.phase || "unprepared";
        const preparation = provider.preparation;
        const progress = preparation?.totalBytes && preparation.completedBytes !== undefined
          ? ` ${Math.round((preparation.completedBytes / preparation.totalBytes) * 100)}%`
          : "";
        setVoicePreparationText(`${preparation?.message || "正在准备本地语音模型"}${progress}`);
        if (phase === "ready") break;
        if (phase === "failed") throw new Error(preparation?.message || "本地语音模型准备失败");
        if (phase === "cancelled") return false;
      }
      if (phase !== "ready") throw new Error("准备本地语音模型超时，请稍后重试");
    }
    setVoicePreparationText("");
    return true;
  }

  function stopVoiceRecording() {
    const capture = voiceCaptureRef.current;
    if (capture && capture.recorder.state !== "inactive") capture.recorder.stop();
  }

  async function transcribeVoiceRecording(recording: Blob, operation: number, targetThreadId: string | null) {
    if (!window.dshDesktop) return;
    setVoiceStatus("transcribing");
    try {
      const catalog = await window.dshDesktop.getSpeechCatalog();
      const audioBase64 = await encodeSpeechWavBase64(recording);
      const result = await window.dshDesktop.transcribeSpeech({
        audioBase64,
        providerId: VOICE_PROVIDER_ID,
        language: catalog.selection.language || "auto",
      });
      const transcript = result.text.trim();
      if (!transcript) throw new Error("没有识别到语音文字");
      if (operation !== voiceSetupOperationRef.current || activeVoiceThreadIdRef.current !== targetThreadId) {
        setPendingVoiceTranscript(transcript);
        return;
      }
      setDraft((current) => current.trim() ? `${current.trimEnd()}\n${transcript}` : transcript);
      focusEditor();
    } catch (error) {
      if (operation === voiceSetupOperationRef.current) {
        const detail = error instanceof Error ? error.message : String(error);
        window.alert(`语音转写失败：${detail}`);
      }
    } finally {
      if (operation === voiceSetupOperationRef.current) {
        setVoiceStatus("idle");
        setVoicePreparationText("");
      }
    }
  }

  async function handleVoiceInput() {
    if (voiceStatus === "recording") {
      stopVoiceRecording();
      return;
    }
    if (voiceStatus === "preparing") {
      voiceSetupOperationRef.current += 1;
      await window.dshDesktop.cancelSpeechPreparation(VOICE_PROVIDER_ID).catch(() => {});
      setVoiceStatus("idle");
      setVoicePreparationText("");
      return;
    }
    if (voiceStatus !== "idle" || !window.dshDesktop) return;

    const operation = ++voiceSetupOperationRef.current;
    const targetThreadId = activeVoiceThreadIdRef.current;
    let pendingStream: MediaStream | null = null;
    setVoiceStatus("preparing");
    try {
      const ready = await waitForVoiceProviderReady(operation);
      if (!ready || operation !== voiceSetupOperationRef.current) {
        setVoiceStatus("idle");
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        throw new Error("当前系统暂不支持浏览器录音");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      pendingStream = stream;
      if (operation !== voiceSetupOperationRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        pendingStream = null;
        return;
      }

      const recorder = new MediaRecorder(stream);
      const capture = { recorder, stream, chunks: [] as Blob[] };
      voiceCaptureRef.current = capture;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) capture.chunks.push(event.data);
      };
      recorder.onstop = () => {
        if (voiceRecordingTimeoutRef.current !== null) {
          window.clearTimeout(voiceRecordingTimeoutRef.current);
          voiceRecordingTimeoutRef.current = null;
        }
        stream.getTracks().forEach((track) => track.stop());
        if (voiceCaptureRef.current !== capture) return;
        voiceCaptureRef.current = null;
        const recording = new Blob(capture.chunks, { type: recorder.mimeType || "audio/webm" });
        if (recording.size === 0) {
          setVoiceStatus("idle");
          window.alert("没有录到音频，请检查麦克风权限后重试。");
          return;
        }
        void transcribeVoiceRecording(recording, operation, targetThreadId);
      };
      recorder.start();
      pendingStream = null;
      setVoiceStatus("recording");
      voiceRecordingTimeoutRef.current = window.setTimeout(stopVoiceRecording, MAX_VOICE_SECONDS * 1000);
    } catch (error) {
      pendingStream?.getTracks().forEach((track) => track.stop());
      if (operation === voiceSetupOperationRef.current) {
        const detail = error instanceof Error ? error.message : String(error);
        setVoiceStatus("idle");
        setVoicePreparationText("");
        window.alert(`无法开始语音输入：${detail}`);
      }
    }
  }

  useEffect(() => () => {
    voiceSetupOperationRef.current += 1;
    if (voiceRecordingTimeoutRef.current !== null) window.clearTimeout(voiceRecordingTimeoutRef.current);
    const capture = voiceCaptureRef.current;
    voiceCaptureRef.current = null;
    if (capture) {
      if (capture.recorder.state !== "inactive") capture.recorder.stop();
      capture.stream.getTracks().forEach((track) => track.stop());
    }
  }, []);

  useEffect(() => {
    const threadChanged = voiceObservedThreadIdRef.current !== currentVoiceThreadId;
    voiceObservedThreadIdRef.current = currentVoiceThreadId;
    if (activeMainTab === "chat" && !settingsOpen && !threadChanged) return;

    voiceSetupOperationRef.current += 1;
    if (voiceRecordingTimeoutRef.current !== null) {
      window.clearTimeout(voiceRecordingTimeoutRef.current);
      voiceRecordingTimeoutRef.current = null;
    }
    const capture = voiceCaptureRef.current;
    voiceCaptureRef.current = null;
    if (capture) {
      if (capture.recorder.state !== "inactive") capture.recorder.stop();
      capture.stream.getTracks().forEach((track) => track.stop());
    }
    setVoiceStatus("idle");
    setVoicePreparationText("");
  }, [activeMainTab, currentVoiceThreadId, settingsOpen]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      const scrollH = textareaRef.current.scrollHeight;
      const targetH = Math.min(Math.max(scrollH, 64), 220);
      textareaRef.current.style.height = `${targetH}px`;
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
          }, 0);
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

  function startSkillTask(skillName: string, prompt: string) {
    handleUseSkillInChat(skillName);
    setDraft(prompt);
    focusEditor();
  }

  function handleQuickSuggestionUse(skillName: string) {
    setStylePickerSkillName(skillName);
  }

  function handleSkillPageUse(skillName: string) {
    if (REPORT_SKILL_NAMES.has(skillName)) {
      setStylePickerSkillName(skillName);
      return;
    }

    startSkillTask(
      skillName,
      BUILTIN_SKILL_START_PROMPTS[skillName] ||
        "请使用当前技能完成我的任务，并为所有事实性内容附发布单位或网站全称、文章来源/页面完整标题和具体原文链接。",
    );
  }

  function handleReportStyleSelect(styleId: string) {
    const skillName = stylePickerSkillName;
    const style = REPORT_STYLE_OPTIONS.find((option) => option.id === styleId);
    if (!skillName || !style) return;

    const normalizedSkill = skillName.replace(/_/g, "-");
    let prompt = "";
    if (normalizedSkill === "info-digest-html") {
      prompt = `请生成动态信息汇总 HTML 报表，使用内置“${style.label}”风格模版（template_style: ${style.id}）。采集或整理统计、政务和信息化动态，直接在工作区 output/ 目录下生成完整的独立 HTML 文件；每条信息必须标明发布单位或网站全称、完整标题、发布日期和具体原文链接，并在对话末尾给出 [打开输出目录] 链接。`;
    } else if (normalizedSkill === "weekly-report") {
      prompt = `请采集最近 7 天统计信息化、数字化、人工智能和大数据相关动态，使用内置“${style.label}”风格模版（template_style: ${style.id}），生成统计信息化动态周报独立的 HTML 文件并写入工作区 output/ 目录；每条信息必须标明发布单位或网站全称、完整标题、发布日期和具体原文链接，并在对话末尾给出 [打开输出目录] 链接。`;
    } else if (normalizedSkill === "price-index-gdp-impact") {
      prompt = `请默认以深圳市为分析对象，分析 CPI、PPI、GDP 平减指数等价格指数对 GDP 各项（消费、投资、净出口及名义/实际 GDP）的影响；优先使用深圳市统计局及深圳市政府官方统计数据，国家和广东省数据只作口径或对照，区分相关性与因果性，并为每个事实附发布单位或网站全称、完整标题和具体原文链接。\n\n【输出要求】：请直接使用内置“${style.label}”风格模版（template_style: ${style.id}），生成完整的可视化独立 HTML 报告文件并写入工作区 output/ 目录（如 output/价格指数×深圳GDP影响速查卡.html）。页面必须包含顶部 KPI 芯片、吸顶章节导航、高密度映射表格、证据分级标签及可点击原文超链接；严格遵守表格自然流排版，严禁使用导致内容遮挡的样式；并在对话最后提供 [打开输出目录] 链接。`;
    } else if (normalizedSkill === "source-verification") {
      prompt = `请核验我接下来提交的文件或链接：确认是否为官方来源、发布日期、发布机构、具体原文链接是否有效，并识别重复、转载和二次改写关系；输出逐项证据和发布单位或网站全称、完整标题、具体原文链接。\n\n【输出要求】：请同时使用内置“${style.label}”风格模版（template_style: ${style.id}），直接在工作区 output/ 目录生成独立的 HTML 证据核验报告文件，包含核验结论 KPI、核验结果明细表、重复转载对照表和完整可点击来源链，并在对话末尾给出 [打开输出目录] 链接。`;
    } else if (normalizedSkill === "gov-official-document-drafting") {
      prompt = `请按深圳市统计局官方网站公开页面的政务文风起草公文：先根据我的任务判断合适的文种，保留文号、落款、联系人等待补字段，不虚构正式发布信息，并为事实、政策依据和数据附发布单位或网站全称、完整标题和具体原文链接。\n\n【输出要求】：除了在对话中提供可直接审阅的 Markdown 公文草案外，请同时使用内置“${style.label}”风格模版（template_style: ${style.id}），在工作区 output/ 目录生成一份排版规范、打印友好且来源标注完整的独立 HTML 参阅公文文件，并在对话末尾给出 [打开输出目录] 链接。`;
    } else {
      prompt = `${BUILTIN_SKILL_START_PROMPTS[normalizedSkill] || BUILTIN_SKILL_START_PROMPTS[skillName] || "请使用当前技能完成我的任务，并为所有事实性内容附发布单位或网站全称、文章来源/页面完整标题和具体原文链接。"}\n\n【输出要求】：请按“${style.label}”风格（template_style: ${style.id}）生成独立可打开的 HTML 成果文件并保存到工作区 output/ 目录，并在末尾给出可点击链接：${style.description}`;
    }

    setStylePickerSkillName(null);
    startSkillTask(skillName, prompt);
  }

  async function handleSelectAttachments() {
    if (!window.dshDesktop) return;
    try {
      const files = await window.dshDesktop.selectFiles();
      if (files.length === 0) return;
      setSelectedAttachments((previous) => {
        const existingPaths = new Set(previous.map((file) => file.path));
        return [...previous, ...files.filter((file) => !existingPaths.has(file.path))];
      });
      focusEditor();
    } catch (error) {
      console.error("Failed to select attachments:", error);
    }
  }

  function removeAttachment(filePath: string) {
    setSelectedAttachments((previous) => previous.filter((file) => file.path !== filePath));
    focusEditor();
  }

  async function handleStopMessage() {
    if (!window.dshDesktop) return;
    try {
      const nextState = await window.dshDesktop.stopMessage();
      setState(nextState);
    } finally {
      setIsThreadLoading(false);
      setClarificationDraftState(null);
    }
  }

  async function respondApproval(requestId: string, choice: "once" | "deny") {
    if (!window.dshDesktop) return;
    try {
      const nextState = await window.dshDesktop.respondApproval(requestId, choice);
      setState(nextState);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      window.alert(`权限审批提交失败：${detail}`);
    }
  }

  async function handleSelectWorkspaceFolder() {
    if (!window.dshDesktop || isWorkspaceLocked()) return;
    setIsFolderMenuOpen(false);
    const result = await window.dshDesktop.selectWorkspaceFolder();
    if (result) {
      setWorkspaceSelectionLocked(true);
      setActiveBranch(result.branch);
      const newEntry = { path: result.cwd, name: result.folderName };
      setRecentFolders((prev) => {
        const filtered = prev.filter((item) => item.path !== result.cwd);
        const updated = [newEntry, ...filtered].slice(0, 5);
        localStorage.setItem("statpilot_recent_folders", JSON.stringify(updated));
        return updated;
      });
      const nextState = await window.dshDesktop.getState();
      setState(nextState);
    }
  }

  async function handleSwitchWorkspaceFolder(folderPath: string) {
    if (!window.dshDesktop || isWorkspaceLocked()) return;
    setIsFolderMenuOpen(false);
    setActiveBranch(null);
    const nextState = await window.dshDesktop.updateSettings({ cwd: folderPath });
    // 选完文件夹不立即锁定，保留在输入框左下方展示当前选中的文件夹名称，等用户发消息后再锁定
    setState(nextState);
  }

  const [rightSidebarOpen, setRightSidebarOpen] = useState(false);
  const [threadFiles, setThreadFiles] = useState<string[]>([]);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = readMigratedLocalValue("statpilot_sidebar_width", "hermes_sidebar_width");
    if (saved) {
      const parsed = parseInt(saved, 10);
      if (!isNaN(parsed) && parsed >= 220 && parsed <= 500) {
        return parsed;
      }
    }
    return 270;
  });

  const [isResizing, setIsResizing] = useState(false);
  const isResizingRef = useRef(false);

  const startResizing = (mouseDownEvent: React.MouseEvent) => {
    mouseDownEvent.preventDefault();
    isResizingRef.current = true;
    setIsResizing(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    
    const handleMouseMove = (mouseMoveEvent: MouseEvent) => {
      if (!isResizingRef.current) return;
      const newWidth = mouseMoveEvent.clientX;
      if (newWidth >= 220 && newWidth <= 500) {
        setSidebarWidth(newWidth);
        localStorage.setItem("statpilot_sidebar_width", String(newWidth));
      }
    };

    const handleMouseUp = () => {
      isResizingRef.current = false;
      setIsResizing(false);
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
  const [customModelInput, setCustomModelInput] = useState("");
  const [selectedModelToAdd, setSelectedModelToAdd] = useState("");
  const [isManualInputMode, setIsManualInputMode] = useState(false);
  const [draftSettings, setDraftSettings] = useState<DshAppState["settings"]>({
    dshBin: "",
    yoloMode: true,
    model: "",
    cwd: "",
    defaultOutputDir: "output",
    customModels: [],
    apiProvider: "deepseek",
    apiKey: "",
    apiBaseUrl: "",
  });
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLElement | null>(null);
  const isAutoScrollUnlockedRef = useRef(false);
  const [showScrollBottomBtn, setShowScrollBottomBtn] = useState(false);
  const activeDraftScrollKey = state?.activeDraft?.segments
    ?.map((segment) => `${segment.reasoning ?? ""}\u0000${segment.text ?? ""}`)
    .join("\u0001");

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let disposed = false;
    let receivedUpdate = false;
    let hasState = false;

    function isUsableState(value: unknown): value is DshAppState {
      if (typeof value !== "object" || value === null) return false;
      const candidate = value as Record<string, unknown>;
      return typeof candidate.status === "string"
        && typeof candidate.settings === "object"
        && candidate.settings !== null
        && typeof candidate.runtime === "object"
        && candidate.runtime !== null;
    }

    function applyState(nextState: DshAppState) {
      if (disposed || !isUsableState(nextState)) return;
      hasState = true;
      setState(nextState);
      setBootstrapError(null);
      if (!headerModelDirtyRef.current) {
        setHeaderModelSelection(nextState.settings.model || "");
      }
      setDraftSettings(withDisplayModel(nextState));
    }

    const bridge = window.dshDesktop;
    if (!bridge) {
      queueMicrotask(() => {
        if (!disposed) setBootstrapError("桌面运行时连接不可用，请重启应用后重试。");
      });
      return () => {
        disposed = true;
      };
    }

    // Subscribe before reading the initial snapshot so startup broadcasts cannot
    // be lost while the renderer is waiting for the IPC round trip.
    try {
      unsubscribe = bridge.onState((nextState) => {
        if (!isUsableState(nextState)) return;
        receivedUpdate = true;
        applyState(nextState);
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      queueMicrotask(() => {
        if (!disposed) setBootstrapError(`订阅工作台状态失败：${detail}`);
      });
      return () => {
        disposed = true;
      };
    }

    const timeout = window.setTimeout(() => {
      if (!disposed && !hasState) {
        setBootstrapError("等待桌面主进程状态超过 5 秒。可以重试连接；如果仍失败，请完全退出后重新启动应用。");
      }
    }, 5000);

    void Promise.resolve().then(() => bridge.getState()).then((initial) => {
      if (receivedUpdate) {
        window.clearTimeout(timeout);
        return;
      }
      if (!isUsableState(initial)) {
        window.clearTimeout(timeout);
        setBootstrapError("桌面主进程没有返回有效的工作台状态。可以重试连接；如果仍失败，请完全退出后重新启动应用。");
        return;
      }
      window.clearTimeout(timeout);
      applyState(initial);
    }).catch((error: unknown) => {
      window.clearTimeout(timeout);
      if (disposed) return;
      const detail = error instanceof Error ? error.message : String(error);
      const missingHandler = /No handler registered for ['"]dsh:getState['"]/.test(detail);
      setBootstrapError(missingHandler
        ? "当前界面与桌面主进程版本不一致。请完全退出并重新启动应用。"
        : `读取工作台状态失败：${detail}`);
    });

    return () => {
      disposed = true;
      window.clearTimeout(timeout);
      unsubscribe?.();
    };
  }, [bootstrapRetryKey]);

  // Load and auto-extract files when active thread or messages change
  useEffect(() => {
    const threadId = state?.activeThreadId;
    if (!threadId) {
      setThreadFiles([]);
      return;
    }

    const key = `statpilot_files_${threadId}`;
    let filesFromStorage: string[] = [];
    const existingStr = readMigratedLocalValue(key, `hermes_files_${threadId}`);
    if (existingStr) {
      try {
        const parsed = JSON.parse(existingStr);
        if (Array.isArray(parsed)) {
          filesFromStorage = parsed;
        }
      } catch (e) {
        // ignore
      }
    }

    const filesFromMessages: string[] = [];
    const activeCwd = state?.activeThread?.cwd || state?.settings?.cwd || "";

    const expandPath = (rawPath: string) => {
      let cleaned = rawPath.trim().replace(/^[`'"]|[`'"]$/g, "");
      let homeDir = "/Users/stoffel";
      const homeMatch = activeCwd.match(/^(\/Users\/[^\/]+)/);
      if (homeMatch) homeDir = homeMatch[1];

      if (cleaned.startsWith("~/")) {
        cleaned = homeDir + cleaned.slice(1);
      } else if (!cleaned.startsWith("/")) {
        cleaned = activeCwd ? (activeCwd.endsWith("/") ? activeCwd + cleaned : activeCwd + "/" + cleaned) : cleaned;
      }

      const braceMatch = cleaned.match(/^([^{}\n]+)\.\{([a-zA-Z0-9,]+)\}$/);
      if (braceMatch) {
        const base = braceMatch[1];
        const exts = braceMatch[2].split(",");
        return exts.map((ext) => `${base}.${ext.trim()}`);
      }
      return [cleaned];
    };

    (state?.messages || []).forEach((msg) => {
      if (msg.role !== "assistant") return;
      const text = msg.text || "";

      // 1. Extract markdown links like [xxx](file:///path/to/file)
      const linkMatches = text.matchAll(/\[[^\]]*\]\((file:\/\/\/[^\)\s]+)\)/g);
      for (const m of linkMatches) {
        const fileUrl = m[1];
        if (fileUrl) {
          try {
            let pathName = decodeURIComponent(fileUrl.replace(/^file:\/\/\/?/, "/"));
            if (!pathName.startsWith("/")) pathName = "/" + pathName;
            filesFromMessages.push(...expandPath(pathName));
          } catch {
            // ignore
          }
        }
      }

      // 2. Extract explicit saved file headers like 文件已保存： ~/Downloads/scope 测试/国家统计局周报_20260806.{txt,json,html}
      const savedMatches = text.matchAll(/(?:文件已保存|文件保存于|保存至|产出文件|文件产出)[:：]\s*([^\n]+)/gi);
      for (const sm of savedMatches) {
        const line = sm[1].trim();
        const codeInLine = line.match(/`([^`\n]+)`/);
        const pathStr = codeInLine ? codeInLine[1] : line.split(/\s+/)[0];
        if (pathStr) {
          filesFromMessages.push(...expandPath(pathStr));
        }
      }

      // 3. Extract folder headers like 📁 产出文件 （ /Users/... ）
      let folderPath = activeCwd;
      const folderMatch = text.match(/📁\s*产出文件\s*[\(（]\s*([^\)）\n]+)\s*[\)）]/);
      if (folderMatch) {
        folderPath = folderMatch[1].trim();
      }

      // 4. Extract backticked file names ending with file extensions or brace expansions
      const codeMatches = text.matchAll(/`([^`\n]+\.(?:html|json|csv|xlsx|pdf|docx|txt|png|jpg|jpeg|zip|py|sh|md|\{[a-zA-Z0-9,]+\}))`/gi);
      for (const m of codeMatches) {
        const rawName = m[1].trim();
        if (rawName.startsWith("/") || rawName.startsWith("~/")) {
          filesFromMessages.push(...expandPath(rawName));
        } else if (folderPath) {
          const combined = folderPath.endsWith("/") ? folderPath + rawName : folderPath + "/" + rawName;
          filesFromMessages.push(...expandPath(combined));
        }
      }
    });

    const lastGen = state?.lastGeneratedFiles || [];
    const normalizeFileIdentity = (filePath: string) => {
      let normalized = filePath.trim().replace(/^file:\/\//i, "");
      // Markdown file URLs on Windows can arrive as /C:/... while scan results
      // use C:\\...; normalize both forms before merging the sources.
      normalized = normalized.replace(/^\/(?=[A-Za-z]:[\\/])/, "");
      normalized = normalized.replace(/[\\/]+/g, "/");
      return normalized.replace(/\/$/, "").toLowerCase();
    };
    const allFiles = Array.from(
      new Map(
        [...filesFromStorage, ...lastGen, ...filesFromMessages]
          .filter(Boolean)
          .map((file) => [normalizeFileIdentity(file), file] as const)
      ).values()
    );

    if (allFiles.length > 0) {
      localStorage.setItem(key, JSON.stringify(allFiles));
    }
    setThreadFiles(allFiles);
  }, [state?.activeThreadId, state?.messages, state?.lastGeneratedFiles]);

  useEffect(() => {
    // 如果用户手动向上滚动解锁了自动跟随，则保持在用户浏览位置，不强行将页面拽回底部
    if (isAutoScrollUnlockedRef.current) {
      return;
    }

    // Reasoning is streamed separately from the final answer. Include both the
    // top-level fields and segment content so the viewport follows while the
    // model is still thinking, not only after answer text arrives.
    const frame = window.requestAnimationFrame(() => {
      const end = messagesEndRef.current;
      const scroller = end?.closest(".message-scroller") as HTMLElement | null;
      if (!end || !scroller) return;

      // The composer is an absolute bottom dock, so scrollIntoView({block:
      // "end"}) places the newest text underneath it. Calculate the visible
      // bottom edge explicitly and keep the stream above the dock.
      const composerHeight = composerRef.current?.getBoundingClientRect().height ?? 180;
      const scrollerRect = scroller.getBoundingClientRect();
      const endRect = end.getBoundingClientRect();
      const visibleBottom = scrollerRect.bottom - composerHeight - 24;
      const delta = endRect.bottom - visibleBottom;
      if (Math.abs(delta) < 1) return;

      scroller.scrollTo({
        top: Math.max(0, scroller.scrollTop + delta),
        // Smooth scrolling on every streaming delta queues animations and can
        // visibly lag behind the model. Track an active stream immediately.
        behavior: state?.activeDraft ? "auto" : "smooth",
      });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [
    state?.messages.length,
    state?.activeDraft,
    state?.activeDraft?.text,
    state?.activeDraft?.reasoning,
    activeDraftScrollKey,
  ]);

  function handleMessagesScroll(event: React.UIEvent<HTMLElement>) {
    const scroller = event.currentTarget;
    const composerHeight = composerRef.current?.getBoundingClientRect().height ?? 180;
    const distanceFromBottom = scroller.scrollHeight - (scroller.scrollTop + scroller.clientHeight);

    // 用户手动向上翻阅（距离底部超过一定距离）时，解锁自动跟随并显示“回到底部”按钮
    if (distanceFromBottom > composerHeight + 50) {
      if (!isAutoScrollUnlockedRef.current) {
        isAutoScrollUnlockedRef.current = true;
        setShowScrollBottomBtn(true);
      }
    } else {
      // 用户手动滚回了底部附近，重新恢复自动跟随锁定
      if (isAutoScrollUnlockedRef.current) {
        isAutoScrollUnlockedRef.current = false;
        setShowScrollBottomBtn(false);
      }
    }
  }

  function scrollToBottom() {
    isAutoScrollUnlockedRef.current = false;
    setShowScrollBottomBtn(false);
    const end = messagesEndRef.current;
    const scroller = end?.closest(".message-scroller") as HTMLElement | null;
    if (!end || !scroller) return;

    const composerHeight = composerRef.current?.getBoundingClientRect().height ?? 180;
    const scrollerRect = scroller.getBoundingClientRect();
    const endRect = end.getBoundingClientRect();
    const visibleBottom = scrollerRect.bottom - composerHeight - 24;
    const delta = endRect.bottom - visibleBottom;

    scroller.scrollTo({
      top: Math.max(0, scroller.scrollTop + delta),
      behavior: "smooth",
    });
  }

  useEffect(() => {
    const isModelSwitching = !!state?.busy && !!state?.status && state.status.includes("切换模型");
    const isBusy = isModelSwitching || !!settingsBusyText;
    if (!isBusy) {
      setBusyElapsedSeconds(0);
      return;
    }

    setBusyElapsedSeconds(0);
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setBusyElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    }, 250);

    return () => window.clearInterval(timer);
  }, [state?.busy, state?.status, settingsBusyText]);

  // Reset draft settings to current actual saved settings whenever settings modal is opened
  useEffect(() => {
    if (settingsOpen && state) {
      setDraftSettings(withDisplayModel(state));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen]);

  async function createNewChat() {
    if (!window.dshDesktop) {
      return;
    }

    setActiveMainTab("chat");
    setSelectedAttachments([]);
    setWorkspaceSelectionLocked(false);
    setIsFolderMenuOpen(false);
    setActiveBranch(null);
    setIsThreadLoading(true);
    isAutoScrollUnlockedRef.current = false;
    setShowScrollBottomBtn(false);
    try {
      const nextState = await window.dshDesktop.newThread();
      setState(nextState);
    } finally {
      setIsThreadLoading(false);
    }
  }

  async function selectThread(threadId: string) {
    if (!window.dshDesktop) {
      return;
    }

    setActiveMainTab("chat");
    setSelectedAttachments([]);
    setWorkspaceSelectionLocked(false);
    isAutoScrollUnlockedRef.current = false;
    setShowScrollBottomBtn(false);
    setIsThreadLoading(true);
    try {
      const nextState = await window.dshDesktop.selectThread(threadId);
      setState(nextState);
      if (window.dshDesktop.ackThreadCompleted) {
        void window.dshDesktop.ackThreadCompleted(threadId);
      }
    } finally {
      setIsThreadLoading(false);
    }
  }

  const [navInterruptConfirm, setNavInterruptConfirm] = useState<{
    open: boolean;
    targetType: "newChat" | "selectThread";
    targetThreadId?: string;
  }>({ open: false, targetType: "newChat" });

  function handleSafeCreateNewChat() {
    if (state?.busy) {
      setNavInterruptConfirm({ open: true, targetType: "newChat" });
      return;
    }
    setActiveMainTab("chat");
    void createNewChat();
  }

  function handleSafeSelectThread(threadId: string) {
    if (threadId === state?.activeThreadId) {
      return;
    }
    if (state?.busy) {
      setNavInterruptConfirm({ open: true, targetType: "selectThread", targetThreadId: threadId });
      return;
    }
    void selectThread(threadId);
  }

  async function handleConfirmNavInterrupt() {
    const { targetType, targetThreadId } = navInterruptConfirm;
    setNavInterruptConfirm({ open: false, targetType: "newChat" });
    if (window.dshDesktop && state?.busy) {
      try {
        const nextState = await window.dshDesktop.stopMessage();
        setState(nextState);
      } catch (e) {
        console.error("Failed to stop message on nav interrupt:", e);
      }
    }
    if (targetType === "newChat") {
      setActiveMainTab("chat");
      await createNewChat();
    } else if (targetType === "selectThread" && targetThreadId) {
      await selectThread(targetThreadId);
    }
  }

  function handleCancelNavInterrupt() {
    setNavInterruptConfirm({ open: false, targetType: "newChat" });
  }

  async function archiveThreadFromSidebar(threadId: string, threadName?: string | null) {
    if (!window.dshDesktop) {
      return;
    }

    const confirmed = window.confirm(
      `确认从侧边栏移除这条对话吗？\n\nDSH 会将对话归档，历史记录仍会保留在本地。${threadName ? `\n\n${threadName}` : ""}`
    );
    if (!confirmed) {
      return;
    }

    const wasActive = state?.activeThreadId === threadId;
    setIsThreadLoading(true);
    try {
      const nextState = await window.dshDesktop.archiveThread(threadId);
      setState(nextState);
      setArchivedThread({ id: threadId, title: threadName || "这条对话" });
      if (wasActive) {
        setActiveMainTab("chat");
        setDraft("");
        setSelectedAttachments([]);
        setSelectedSkillTag(null);
        setActiveBranch(null);
        setWorkspaceSelectionLocked(false);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      window.alert(`未能移除对话：${detail}`);
    } finally {
      setIsThreadLoading(false);
    }
  }

  async function undoArchiveThread() {
    if (!archivedThread || !window.dshDesktop) return;

    try {
      const nextState = await restoreArchivedThread(archivedThread.id);
      setState(nextState);
      setArchivedThread(null);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      window.alert(`恢复对话失败：${detail}`);
    }
  }

  async function restoreArchivedThread(threadId: string) {
    if (!window.dshDesktop) {
      throw new Error("桌面端接口尚未就绪");
    }

    setIsThreadLoading(true);
    try {
      const nextState = await window.dshDesktop.unarchiveThread(threadId);
      if (archivedThread?.id === threadId) {
        setArchivedThread(null);
      }
      return nextState;
    } finally {
      setIsThreadLoading(false);
    }
  }

  async function permanentlyDeleteArchivedThread(threadId: string, title: string) {
    if (!window.dshDesktop) return;

    const confirmed = window.confirm(
      `确定彻底删除“${title}”吗？\n\n会话日志和工作区关联会删除，且无法恢复。DSH 全局附件库中的共享数据或缓存可能仍会保留。`
    );
    if (!confirmed) return;

    const wasActive = state?.activeThreadId === threadId;
    setIsThreadLoading(true);
    try {
      const result = await window.dshDesktop.deleteArchivedThread(threadId);
      setState(result.state);
      if (archivedThread?.id === threadId) setArchivedThread(null);
      if (wasActive) {
        setActiveMainTab("chat");
        setDraft("");
        setSelectedAttachments([]);
        setSelectedSkillTag(null);
        setActiveBranch(null);
        setWorkspaceSelectionLocked(false);
      }
      if (result.pendingDeletion) {
        window.alert("删除请求已保存；DSH 会继续重试，若本次未完成，下次启动会接着清理。");
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      window.alert(`彻底删除失败：${detail}`);
    } finally {
      setIsThreadLoading(false);
    }
  }

  async function sendMessage() {
    const rawText = draft.trim();
    const attachmentText = selectedAttachments.length > 0
      ? [
          "我已附上以下文件，请直接阅读附件内容后完成本次任务：",
          ...selectedAttachments.map((file, index) => `${index + 1}. ${file.name}`),
        ].join("\n")
      : "";
    const taskText = rawText || (selectedAttachments.length > 0 ? "请先概述这些文件的内容、来源和可用字段。" : "");
    if ((!taskText && !selectedSkillTag) || !window.dshDesktop) {
      return;
    }

    const text = [
      selectedSkillTag ? `@${selectedSkillTag}` : "",
      taskText,
      attachmentText,
    ].filter(Boolean).join("\n\n").trim();
    const previousDraft = draft;
    const previousSkillTag = selectedSkillTag;
    const previousAttachments = selectedAttachments;

    setDraft("");
    setSelectedSkillTag(null);
    setSelectedAttachments([]);
    setWorkspaceSelectionLocked(true);
    isAutoScrollUnlockedRef.current = false;
    setShowScrollBottomBtn(false);
    try {
      const nextState = await window.dshDesktop.sendMessage({
        text,
        attachments: previousAttachments.map(({ path, name }) => ({ path, name })),
      });
      setState(nextState);
      if (nextState.error) {
        setDraft(previousDraft);
        setSelectedSkillTag(previousSkillTag);
        setSelectedAttachments(previousAttachments);
      }
    } catch (e: any) {
      console.error("Failed to send message:", e);
      setDraft(previousDraft);
      setSelectedSkillTag(previousSkillTag);
      setSelectedAttachments(previousAttachments);
      try {
        const currentState = await window.dshDesktop.getState();
        setState(currentState);
      } catch {}
    }
  }

  async function respondClarification() {
    const pending = state?.pendingClarification;
    if (!pending || !window.dshDesktop?.respondClarification) return;
    const answers = pending.questions.map((question) => {
      const draftAnswer = clarificationDraft[question.id] || { selected: [], custom: "" };
      const custom = draftAnswer.custom.trim();
      return {
        id: question.id,
        selected: question.multiSelect === true || !custom ? draftAnswer.selected : [],
        ...(custom ? { custom } : {}),
      };
    });
    try {
      const nextState = await window.dshDesktop.respondClarification(pending.requestId, answers);
      setState(nextState);
    } catch (e) {
      console.error("Failed to respond to clarification:", e);
      const detail = e instanceof Error ? e.message : String(e);
      window.alert(`提交回答失败：${detail}`);
    }
  }

  async function cancelClarification() {
    const pending = state?.pendingClarification;
    if (!pending || !window.dshDesktop?.cancelClarification) return;
    try {
      const nextState = await window.dshDesktop.cancelClarification(pending.requestId);
      setState(nextState);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      window.alert(`关闭提问失败：${detail}`);
    }
  }

  function updateClarificationDraft(questionId: string, patch: Partial<DshQuestionDraft>) {
    const requestId = state?.pendingClarification?.requestId;
    if (!requestId) return;
    setClarificationDraftState((current) => {
      const answers = current?.requestId === requestId ? current.answers : {};
      return {
        requestId,
        answers: {
          ...answers,
          [questionId]: {
            ...(answers[questionId] || { selected: [], custom: "" }),
            ...patch,
          },
        },
      };
    });
  }

  async function saveSettings() {
    if (!window.dshDesktop) {
      return;
    }

    setSettingsBusyText("正在保存配置并应用...");
    const workspaceChanged = draftSettings.cwd !== state?.settings.cwd;

    const customList = Array.isArray(draftSettings.customModels) ? [...draftSettings.customModels] : [];
    if (draftSettings.model && !customList.includes(draftSettings.model)) {
      customList.push(draftSettings.model);
    }
    const finalSettings = {
      ...draftSettings,
      customModels: Array.from(new Set(customList.map(String).map((s) => s.trim()).filter(Boolean))),
    };

    try {
      const nextState = await window.dshDesktop.updateSettings(finalSettings);
      if (workspaceChanged) {
        setWorkspaceSelectionLocked(true);
      }
      setState(nextState);
      setSettingsOpen(false);
    } catch (e) {
      console.error("Failed to save settings:", e);
    } finally {
      setSettingsBusyText(null);
    }
  }

  async function clearCurrentProviderApiKey() {
    if (!window.dshDesktop || !state) return;
    const provider = draftSettings.apiProvider;
    if (!state.providerCredentialStatus?.[provider]?.writable) return;
    if (!window.confirm(`清除 DSH 中保存的 ${provider} API Key？`)) return;

    setSettingsBusyText("正在清除 DSH 凭据...");
    try {
      const nextState = await window.dshDesktop.clearProviderApiKey(provider);
      setState(nextState);
      setDraftSettings((current) => ({ ...current, apiKey: "" }));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      window.alert(`清除 API Key 失败：${detail}`);
    } finally {
      setSettingsBusyText(null);
    }
  }

  async function closeSettingsModal() {
    if (!window.dshDesktop) {
      setSettingsOpen(false);
      return;
    }

    const loginPending = ["initializing", "waiting-browser", "exchanging", "committing"].includes(state?.account?.attempt?.phase || "");
    setSettingsBusyText(loginPending ? "正在取消 DeepSeek 账号登录..." : "正在关闭...");
    try {
      if (loginPending) {
        const nextState = await window.dshDesktop.cancelAccountSignIn();
        setState(nextState);
        setIsLoggingIn(false);
      }
      setSettingsOpen(false);
    } catch (e) {
      console.error("Failed to close settings:", e);
    } finally {
      setSettingsBusyText(null);
    }
  }

  async function startDshAccountSignIn() {
    if (!window.dshDesktop || !state) {
      return;
    }
    setIsLoggingIn(true);
    try {
      const nextState = await window.dshDesktop.startAccountSignIn();
      setState(nextState);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      window.alert(`DeepSeek 账号登录失败：${detail}`);
    } finally {
      setIsLoggingIn(false);
    }
  }

  async function signOutDshAccount() {
    if (!window.dshDesktop) return;
    try {
      const nextState = await window.dshDesktop.signOutAccount();
      setState(nextState);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      window.alert(`退出 DeepSeek 账号失败：${detail}`);
    }
  }

  function handleAddCustomModel(modelToAdd?: string) {
    const modelName = (modelToAdd || (isManualInputMode ? customModelInput : selectedModelToAdd) || customModelInput).trim();
    if (!modelName) return;

    setDraftSettings((current: DshAppState["settings"]) => {
      const presets = (PROVIDER_PRESET_MODELS[current.apiProvider || "deepseek"] || PROVIDER_PRESET_MODELS["deepseek"]).map((m) => m.id);
      const existingList = Array.isArray(current.customModels) && current.customModels.length > 0
        ? current.customModels
        : presets;
      const nextCustomModels = Array.from(new Set([...existingList, modelName]));
      return {
        ...current,
        model: modelName,
        customModels: nextCustomModels,
      };
    });
    setCustomModelInput("");
    setSelectedModelToAdd("");
    setIsManualInputMode(false);
  }

  function handleRemoveCustomModel(modelToRemove: string) {
    setDraftSettings((current: DshAppState["settings"]) => {
      const presets = (PROVIDER_PRESET_MODELS[current.apiProvider || "deepseek"] || PROVIDER_PRESET_MODELS["deepseek"]).map((m) => m.id);
      const existingList = Array.isArray(current.customModels) && current.customModels.length > 0
        ? current.customModels
        : presets;
      const nextCustomModels = existingList.filter((m) => m !== modelToRemove);
      return {
        ...current,
        customModels: nextCustomModels,
        model: current.model === modelToRemove ? (nextCustomModels[0] || "") : current.model,
      };
    });
  }

  async function applyModelChange(selectedModel: string) {
    if (!window.dshDesktop) {
      return;
    }
    setHeaderModelSelection(selectedModel);
    headerModelDirtyRef.current = true;
    const customList = Array.isArray(state?.settings.customModels) ? [...state.settings.customModels] : [];
    if (selectedModel && !customList.includes(selectedModel)) {
      customList.push(selectedModel);
    }
    const nextState = await window.dshDesktop.updateSettings({
      ...state?.settings,
      model: selectedModel,
      customModels: customList,
    });
    setState(nextState);
    await window.dshDesktop.switchSessionModel(selectedModel);
  }

  async function registerNewSkill() {
    if (!window.dshDesktop) {
      return;
    }
    const nextState = await window.dshDesktop.registerSkillFile();
    setState(nextState);
  }

  async function unregisterSkill(path: string) {
    if (!window.dshDesktop) {
      return;
    }
    const nextState = await window.dshDesktop.unregisterSkill(path);
    setState(nextState);
  }

  async function repairRuntime() {
    if (!window.dshDesktop) {
      return;
    }
    const nextState = await window.dshDesktop.repairRuntime();
    setState(nextState);
  }

  const currentCwd = state?.activeThread?.cwd || state?.settings.cwd || "";
  const currentFolderName = currentCwd ? currentCwd.split(/[/\\]/).filter(Boolean).pop() || currentCwd : "选择项目";

  const activeThread = state?.activeThread ?? null;
  const activeMessages = state?.messages ?? EMPTY_MESSAGES;
  const activeThreadTitle = activeMessages.find((message) => message.role === "user")?.text?.trim() || "";
  const orderedThreads = useMemo(() => {
    const threads = [...(state?.threads ?? [])];
    const activeId = state?.activeThreadId;
    if (activeId && activeThread && activeThreadTitle) {
      const activeIndex = threads.findIndex((thread) => thread.id === activeId);
      if (activeIndex === -1) {
        threads.push({
          ...activeThread,
          name: activeThread.name || activeThreadTitle,
          preview: activeThread.preview || activeThreadTitle,
        });
      } else if (!threads[activeIndex].name && !threads[activeIndex].preview) {
        threads[activeIndex] = {
          ...threads[activeIndex],
          name: activeThreadTitle,
          preview: activeThreadTitle,
        };
      }
    }
    return threads.sort((a, b) => b.updatedAt - a.updatedAt);
  }, [activeThread, activeThreadTitle, state?.activeThreadId, state?.threads]);

  const runningTaskCount = (state?.threads || []).filter((t) => t.taskStatus === "running").length;
  const queuedTaskCount = (state?.threads || []).filter((t) => t.taskStatus === "queued").length;
  const concurrencyOverview = runningTaskCount > 0
    ? `${runningTaskCount} 个任务运行中${queuedTaskCount > 0 ? ` (${queuedTaskCount} 个排队)` : ""}`
    : null;

  const groupedThreads = useMemo(() => {
    const groups: Array<{ folderName: string; threads: DshThreadSummary[] }> = [];
    const map = new Map<string, DshThreadSummary[]>();

    for (const thread of orderedThreads) {
      const rawCwd = (thread.cwd || "").trim();
      let folderName = "默认";
      if (rawCwd) {
        const parts = rawCwd.split(/[/\\]/).filter(Boolean);
        const name = parts.length > 0 ? parts[parts.length - 1] : "";
        if (name && name !== "sz-gov-scope" && name !== "stat-pilot") {
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
  const activeName = formatCleanTaskTitle(activeThread?.name || activeThread?.preview || "新对话");
  const hasUnresolvedHistoricalTurn = Boolean(
    activeMessages.length > 0 &&
      activeMessages[activeMessages.length - 1]?.role === "user" &&
      !state?.activeDraft &&
      !state?.busy &&
      !state?.error &&
      !isThreadLoading &&
      state?.status === "Ready."
  );

  const renderTurnGroups = useMemo(() => {
    interface RenderTurnGroup {
      id: string;
      role: "user" | "assistant";
      messages: DshChatMessage[];
    }
    const groups: RenderTurnGroup[] = [];
    for (const message of activeMessages) {
      if (message.role === "user") {
        groups.push({
          id: message.id,
          role: "user",
          messages: [message],
        });
      } else {
        const lastGroup = groups[groups.length - 1];
        if (lastGroup && lastGroup.role === "assistant") {
          lastGroup.messages.push(message);
        } else {
          groups.push({
            id: message.id,
            role: "assistant",
            messages: [message],
          });
        }
      }
    }
    return groups;
  }, [activeMessages]);
  const hasDeepSeekAccount = state?.account?.status === "credential-stored";
  const selectedProvider = state?.settings.apiProvider || "deepseek";
  const hasProviderApiKey = Boolean(state?.providerCredentialStatus?.[selectedProvider]?.configured);
  const needsProviderSetup = !hasProviderApiKey && !(selectedProvider === "deepseek" && hasDeepSeekAccount);
  const runtimeInstalled = !!state?.runtime.installed;
  const currentProviderPresets = (PROVIDER_PRESET_MODELS[state?.settings.apiProvider || "deepseek"] || PROVIDER_PRESET_MODELS["deepseek"]).map((m) => m.id);
  const currentSavedModel = state?.settings.model;
  const savedCustomModels = Array.isArray(state?.settings.customModels) ? state.settings.customModels : [];
  const draftCustomModels = Array.isArray(draftSettings.customModels) ? draftSettings.customModels : [];
  const customModelList = Array.from(
    new Set(
      [
        currentSavedModel,
        ...savedCustomModels,
        ...draftCustomModels,
        ...currentProviderPresets,
      ].filter(Boolean) as string[]
    )
  );

  const quickModelOptions = customModelList;

  const currentActiveModel = state?.settings.model || "";
  const quickModelDirty = !!state && !!headerModelSelection && headerModelSelection !== currentActiveModel;
  const selectedSkillDisplayName = selectedSkillTag
    ? state?.skills.find((skill) => skill.name === selectedSkillTag)?.displayName || BUILTIN_SKILL_DISPLAY_NAMES[selectedSkillTag] || selectedSkillTag
    : "";
  const isModelSwitching = !!state?.busy && !!state?.status && state.status.includes("切换模型");
  const isDshUnavailable = !state?.runtime.installed || (!!state?.error && (
    state.error.includes("ENOENT") || 
    state.error.includes("找不到 DSH") ||
    state.error.includes("No module named") ||
    state.error.includes("DSH backend exited") ||
    state.error.includes("Could not connect to DSH service") ||
    state.error.includes("did not become ready") ||
    state.error.includes("DSH runtime source not found")
  ));
  const isInitializing = !!state && !state.error && (
    state.status.startsWith("正在") ||
    state.status.startsWith("Starting") ||
    state.status.startsWith("Installing") ||
    state.status.startsWith("Preparing") ||
    state.status.startsWith("Connecting") ||
    !state.runtime.installed
  );
  const isCurrentThreadBusy = Boolean(state?.busy);
  const canSend = !needsProviderSetup && !isDshUnavailable && !isCurrentThreadBusy && !isThreadLoading && !isInitializing;

  const statusDotClass = isInitializing
    ? "warning"
    : isDshUnavailable
    ? "error"
    : needsProviderSetup
      ? "warning"
      : state?.error
        ? "error"
        : runningTaskCount > 0 || state?.busy
          ? "busy"
          : "";

  const statusLabel = isInitializing
    ? (state?.status || "加载中...")
    : isDshUnavailable
    ? "运行时未就绪"
    : needsProviderSetup
      ? (state?.settings.apiProvider === "deepseek" && !hasDeepSeekAccount ? "未登录 DeepSeek 账号或未配置 API Key" : "未配置 API 密钥")
      : state?.error
        ? "运行异常"
        : (concurrencyOverview || state?.status || "Ready.");

  if (!state) {
    return (
      <div
        className="shell startup-shell"
        style={{ "--sidebar-w": `${sidebarWidth}px` } as React.CSSProperties}
      >
        <aside className="sidebar startup-sidebar">
          <div className={`sidebar-resizer ${isResizing ? "resizing" : ""}`} onMouseDown={startResizing} />
          <div className="brand">
            <div className="brand-main">
              <img className="brand-logo" src={szLogo} alt="" />
              <div className="brand-title">
                <p className="eyebrow">深圳市统计局</p>
                <h1>深小统</h1>
                <span className="app-version">v{__APP_VERSION__}</span>
              </div>
            </div>
          </div>
          <div className={`startup-sidebar-status ${bootstrapError ? "has-error" : ""}`} role="status">
            <span className="startup-sidebar-status-dot" aria-hidden="true" />
            <div>
              <strong>{bootstrapError ? "启动遇到问题" : "正在启动"}</strong>
              <span>
                {bootstrapError?.includes("主进程版本不一致") ? "桌面主进程需要重启" : bootstrapError ? "等待工作台状态失败" : "等待桌面进程响应"}
              </span>
            </div>
          </div>
        </aside>
        <main className="chat startup-chat">
          <div className="startup-boot-panel" role="status" aria-live="polite" aria-busy={!bootstrapError}>
            <div className="startup-boot-mark" aria-hidden="true">
              <span className="startup-boot-glow" />
              <span className="startup-boot-ring startup-boot-ring-outer" />
              <span className="startup-boot-ring startup-boot-ring-inner" />
              <span className="startup-boot-ring-dot" />
              <div className="startup-boot-logo">
                <img src={szLogo} alt="" />
              </div>
            </div>
            <div className="startup-boot-copy">
              <p className="startup-loading-eyebrow">STATPILOT · DESKTOP WORKSPACE</p>
              <h2>{bootstrapError ? "工作台暂不可用" : "正在启动桌面工作台"}</h2>
              <p className={bootstrapError ? "startup-boot-error" : ""}>
                {bootstrapError || "正在读取桌面进程状态，随后会连接本地 DSH 运行时。"}
              </p>
            </div>
            {bootstrapError && bootstrapError.includes("主进程版本不一致") ? null : bootstrapError ? (
              <button
                className="startup-boot-retry"
                type="button"
                onClick={() => {
                  setBootstrapError(null);
                  setBootstrapRetryKey((current) => current + 1);
                }}
              >
                重试连接
              </button>
            ) : (
              <div className="startup-boot-loader" aria-hidden="true">
                <span />
              </div>
            )}
            <div className="startup-boot-meta">
              <span className="startup-boot-meta-dot" aria-hidden="true" />
              <span>
                {bootstrapError?.includes("主进程版本不一致")
                  ? "请完全退出应用，再重新打开。"
                  : bootstrapError
                    ? "如果问题持续，请重新启动应用。"
                    : "桌面进程通常会在几秒内响应"}
              </span>
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div
      className={`shell ${rightSidebarOpen ? "with-right-sidebar" : ""}`}
      style={{ "--sidebar-w": `${sidebarWidth}px` } as React.CSSProperties}
    >
      <aside className="sidebar">
        <div className={`sidebar-resizer ${isResizing ? "resizing" : ""}`} onMouseDown={startResizing} />
        <div className="brand">
          <div className="brand-main">
            <img className="brand-logo" src={szLogo} alt="" />
            <div className="brand-title">
              <p className="eyebrow">深圳市统计局</p>
              <h1>深小统</h1>
              <span className="app-version">v{__APP_VERSION__}</span>
            </div>
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
            onClick={handleSafeCreateNewChat}
            disabled={isDshUnavailable}
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

          <button
            type="button"
            className={`sidebar-action-item ${activeMainTab === "archive" ? "!bg-blue-50/80 !text-blue-600 font-bold" : ""}`}
            onClick={() => setActiveMainTab("archive")}
            title="查看和恢复已归档对话"
          >
            <svg className="w-4.5 h-4.5 text-current shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 4h18v4H3z" />
              <path d="M5 8v12h14V8" />
              <path d="M10 12h4m-2-2v4" />
            </svg>
            <span>已归档</span>
            <span className="sidebar-action-count">{state?.archivedThreads?.length ?? 0}</span>
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
                      const title = formatCleanTaskTitle(thread.name || thread.preview || "未命名对话");
                      const isActive = thread.id === state.activeThreadId;
                      const taskStatus = thread.taskStatus || "idle";
                      return (
                        <div
                          key={thread.id}
                          className={`thread-item-slim group ${isActive ? "active" : ""} ${taskStatus !== "idle" ? `task-${taskStatus}` : ""}`}
                          onClick={() => handleSafeSelectThread(thread.id)}
                          title={`${title} • ${formatRelativeTime(thread.updatedAt)}`}
                        >
                          <span className="thread-item-slim-title">{title}</span>

                          {taskStatus === "running" && (
                            <span className="thread-task-badge running" title="后台正在执行分析中...">
                              <span className="thread-task-spinner" />
                              <span className="thread-task-text">运行中</span>
                            </span>
                          )}
                          {taskStatus === "approving" && (
                            <span className="thread-task-badge approving" title="任务需要安全授权，点击进入处理">
                              <span className="thread-task-dot approving" />
                              <span className="thread-task-text">待授权</span>
                            </span>
                          )}
                          {taskStatus === "clarifying" && (
                            <span className="thread-task-badge clarifying" title="任务需要补充确认信息，点击进入回复">
                              <span className="thread-task-dot clarifying" />
                              <span className="thread-task-text">待确认</span>
                            </span>
                          )}
                          {taskStatus === "queued" && (
                            <span className="thread-task-badge queued" title="排队等待空闲槽位...">
                              <span className="thread-task-dot" />
                              <span className="thread-task-text">排队中</span>
                            </span>
                          )}
                          {taskStatus === "completed" && (
                            <span className="thread-task-badge completed" title="任务已完成，点击查看">
                              <span className="thread-task-text">✓ 完成</span>
                            </span>
                          )}

                          <button
                            type="button"
                            className="thread-item-slim-delete"
                            onClick={(event) => {
                              event.stopPropagation();
                              void archiveThreadFromSidebar(thread.id, title);
                            }}
                            title="从侧边栏移除对话"
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
          onUseSkill={handleSkillPageUse}
        />
      ) : activeMainTab === "archive" ? (
        <ArchivedThreadsPage
          threads={state?.archivedThreads ?? []}
          isBusy={isThreadLoading}
          onRestore={(threadId) => {
            void restoreArchivedThread(threadId)
              .then(setState)
              .catch((error) => {
                const detail = error instanceof Error ? error.message : String(error);
                window.alert(`恢复对话失败：${detail}`);
              });
          }}
          onDelete={(threadId, title) => void permanentlyDeleteArchivedThread(threadId, title)}
          onNewChat={handleSafeCreateNewChat}
        />
      ) : (
        <main className="chat">
          <header className="chat-header">
            <div className="chat-header-title">
              <p className="eyebrow">Intel Agent Console</p>
              <h2 title={activeName}>{activeName}</h2>
            </div>
            <div className="header-actions">
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
                    value={headerModelSelection || currentActiveModel}
                    onChange={(event) => {
                      headerModelDirtyRef.current = true;
                      setHeaderModelSelection(event.target.value);
                    }}
                    className="header-model-select"
                    disabled={state.busy}
                    title={
                      quickModelDirty
                        ? `当前：${currentActiveModel}，切换到：${headerModelSelection}。点击“应用切换”后在当前对话内立即生效。`
                        : "直接在这里选目标模型，然后点击“应用切换”。"
                    }
                  >
                    {!currentActiveModel && <option value="">未设置模型</option>}
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
                      title={`当前：${currentActiveModel}，切换到：${headerModelSelection}。点击“应用切换”后在当前对话内立即生效。`}
                    >
                      应用切换
                    </button>
                  )}
                </div>
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

          <section className="message-scroller" onScroll={handleMessagesScroll}>
            {isThreadLoading || isInitializing ? (
              <div className="thread-loading-wrapper flex flex-col gap-6 w-full max-w-[860px] mx-auto py-4 px-2 overflow-hidden animate-fade-in">
                <div className="loading-status-bar flex items-center justify-center gap-2.5 py-1.5 px-4 rounded-full bg-blue-50/90 border border-blue-200/60 w-fit mx-auto shadow-xs text-xs font-medium text-blue-700">
                  <span className="loading-spinner-ring" />
                  <span>{isInitializing ? "正在加载深小统..." : "正在同步加载对话历史与结构化数据..."}</span>
                </div>

                {/* Assistant Bubble Skeleton */}
                <div className="w-full max-w-[560px] bg-white border border-slate-200/90 rounded-[18px] rounded-bl-sm p-4.5 flex flex-col gap-3 shadow-xs self-start">
                  <div className="flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-full bg-blue-600/10 flex items-center justify-center shrink-0">
                      <svg className="w-4 h-4 text-blue-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                      </svg>
                    </div>
                    <div className="h-3.5 skeleton-shimmer rounded-full w-24" />
                  </div>
                  <div className="flex flex-col gap-2.5 pt-1">
                    <div className="h-3.5 skeleton-shimmer rounded-md w-11/12" />
                    <div className="h-3.5 skeleton-shimmer rounded-md w-4/5" />
                    <div className="h-3.5 skeleton-shimmer rounded-md w-3/5" />
                  </div>
                </div>

                {/* User Bubble Skeleton */}
                <div className="w-full max-w-[440px] bg-gradient-to-r from-blue-600/90 to-blue-700/90 border border-blue-500/30 rounded-[18px] rounded-br-sm p-4 flex flex-col gap-2.5 self-end shadow-xs">
                  <div className="flex items-center justify-end gap-2">
                    <div className="h-3.5 skeleton-shimmer-blue rounded-full w-14" />
                  </div>
                  <div className="flex flex-col gap-2 items-end">
                    <div className="h-3.5 skeleton-shimmer-blue rounded-md w-11/12" />
                    <div className="h-3.5 skeleton-shimmer-blue rounded-md w-3/4" />
                  </div>
                </div>

                {/* Assistant Bubble Skeleton 2 with reasoning trace placeholder */}
                <div className="w-full max-w-[620px] bg-white border border-slate-200/90 rounded-[18px] rounded-bl-sm p-4.5 flex flex-col gap-3.5 shadow-xs self-start">
                  <div className="flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-full bg-blue-600/10 flex items-center justify-center shrink-0">
                      <svg className="w-4 h-4 text-blue-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                      </svg>
                    </div>
                    <div className="h-3.5 skeleton-shimmer rounded-full w-28" />
                  </div>

                  {/* Reasoning placeholder box */}
                  <div className="p-3 rounded-xl border border-blue-100 bg-blue-50/40 flex flex-col gap-2">
                    <div className="h-3 skeleton-shimmer rounded-md w-32" />
                    <div className="h-2.5 skeleton-shimmer rounded-md w-11/12 opacity-80" />
                  </div>

                  <div className="flex flex-col gap-2.5">
                    <div className="h-3.5 skeleton-shimmer rounded-md w-full" />
                    <div className="h-3.5 skeleton-shimmer rounded-md w-10/12" />
                    <div className="h-3.5 skeleton-shimmer rounded-md w-1/2" />
                  </div>
                </div>
              </div>
            ) : (
              <>
                {isDshUnavailable ? (
                  <div className="onboarding-card">
                    <div className="onboarding-title">
                      <h3>DSH 运行时未就绪</h3>
                    </div>
                    <p>桌面客户端目前无法启动随应用提供的 DeepSeek Harness 运行时。</p>
                    <div className="guide-steps">
                      <div className="step-item">
                        <strong>重新启动 DSH 服务</strong>
                        <p>尝试重新启动本地 DSH 服务；如果仍失败，请将错误详情提供给维护人员。</p>
                      </div>
                    </div>
                    {state.error ? (
                      <div className="step-item">
                        <strong>当前错误详情</strong>
                        <p><code>{state.error}</code></p>
                      </div>
                    ) : null}
                    <div className="onboarding-footer">
                      <button className="primary-button" onClick={() => void repairRuntime()}>重新启动 DSH</button>
                    </div>
                  </div>
                ) : needsProviderSetup ? (
                  <div className="onboarding-card">
                    <div className="onboarding-title">
                    <h3>先配置模型 API</h3>
                    </div>
                    <p>
                      {state.settings.apiProvider === "deepseek"
                        ? "在设置中填写 DeepSeek API Key，或登录 DeepSeek 账号后即可开始对话。"
                        : "先在右上角「设置」里填好 provider、model 和 API key，就可以开始对话。"}
                    </p>
                    <div className="guide-steps">
                      {state.settings.apiProvider === "deepseek" ? (
                        <div className="step-item">
                          <strong>推荐配置</strong>
                          <p>使用 DeepSeek V4.1 Flash（模型 ID：<b>deepseek-flash</b>），再填入 API Key 或登录 DeepSeek 账号。</p>
                        </div>
                      ) : (
                        <div className="step-item">
                          <strong>模型 API 配置</strong>
                          <p>在设置中选择 provider，并配置模型、API Key 与必要的 Base URL。</p>
                        </div>
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

                {!isDshUnavailable && !needsProviderSetup && activeMessages.length === 0 && !state.activeDraft && (
                  <div className="trae-hero-container">
                    <div className="trae-hero-badge">
                      <svg className="w-4 h-4 text-blue-600 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="6.5" strokeWidth="1.8" />
                        <circle cx="12" cy="12" r="2" fill="currentColor" />
                        <line x1="12" y1="1.5" x2="12" y2="4.5" strokeWidth="1.8" />
                        <line x1="12" y1="19.5" x2="12" y2="22.5" strokeWidth="1.8" />
                        <line x1="1.5" y1="12" x2="4.5" y2="12" strokeWidth="1.8" />
                        <line x1="19.5" y1="12" x2="22.5" y2="12" strokeWidth="1.8" />
                      </svg>
                      <span>深圳市统计局 · 智能工作台</span>
                    </div>

          <h2 className="trae-hero-title">深小统</h2>
                    <p className="trae-hero-subtitle">
                      高效检索政务统计数据、自动化分析公文报告、智能代码生成与数据洞察
                    </p>

                    <div className="trae-quick-suggestions">
                      <button
                        type="button"
                        className="trae-suggestion-card"
                        onClick={() => handleQuickSuggestionUse("weekly-report")}
                      >
                        <span className="icon">📊</span>
                        <div className="text-content">
                          <strong>统计信息化动态采集与周报</strong>
                          <p>采集官方统计动态，筛选信息化主题并生成周报</p>
                        </div>
                      </button>

                      <button
                        type="button"
                        className="trae-suggestion-card"
                        onClick={() => handleQuickSuggestionUse("price-index-gdp-impact")}
                      >
                        <span className="icon">📈</span>
                        <div className="text-content">
                          <strong>价格指数对 GDP 各项影响分析</strong>
                          <p>默认分析深圳市，拆解 CPI、PPI 等指数对 GDP 各项的传导影响</p>
                        </div>
                      </button>

                      <button
                        type="button"
                        className="trae-suggestion-card"
                        onClick={() => handleQuickSuggestionUse("source-verification")}
                      >
                        <span className="icon">🔎</span>
                        <div className="text-content">
                          <strong>官方来源与转载核验</strong>
                          <p>核验来源、发布日期、机构、链接及重复转载关系</p>
                        </div>
                      </button>

                      <button
                        type="button"
                        className="trae-suggestion-card"
                        onClick={() => handleQuickSuggestionUse("gov-official-document-drafting")}
                      >
                        <span className="icon">📝</span>
                        <div className="text-content">
                          <strong>起草政务公文</strong>
                          <p>按深圳统计官网公开风格起草通知、报告与工作方案</p>
                        </div>
                      </button>
                    </div>
                  </div>
                )}

                {!isDshUnavailable && renderTurnGroups.map((group, groupIdx) => {
                  const isLastGroup = groupIdx === renderTurnGroups.length - 1;
                  const isThisGroupStreaming = Boolean(state?.activeDraft) && isLastGroup && group.role === "assistant";

                  if (group.role === "user") {
                    const msg = group.messages[0];
                    const rawText = msg.text || "";
                    const skillMatch = rawText.match(/^@([a-zA-Z0-9_\-]+)(?:\s+|$)/);
                    const invokedSkillName = skillMatch ? skillMatch[1] : null;
                    const invokedSkillDisplayName = invokedSkillName
                      ? state?.skills.find((s) => s.name === invokedSkillName)?.displayName ||
                        BUILTIN_SKILL_DISPLAY_NAMES[invokedSkillName] ||
                        invokedSkillName
                      : null;
                    const cleanText = invokedSkillName
                      ? rawText.replace(/^@[a-zA-Z0-9_\-]+\s*/, "").trim()
                      : rawText;

                    return (
                      <article key={group.id} className="bubble user">
                        <div className="bubble-head">
                          <strong>你</strong>
                        </div>
                        {invokedSkillName && (
                          <div style={{ marginBottom: "8px" }}>
                            <span
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "5px",
                                padding: "3px 10px 3px 8px",
                                borderRadius: "20px",
                                fontSize: "0.80rem",
                                fontWeight: 500,
                                whiteSpace: "nowrap",
                                userSelect: "none",
                                background: "#fef3c7",
                                color: "#92400e",
                                border: "1px solid rgba(217, 119, 6, 0.35)",
                                boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
                                lineHeight: 1.2,
                                verticalAlign: "middle",
                              }}
                            >
                              <svg className="w-3.5 h-3.5 text-amber-700 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                              </svg>
                              <span>{invokedSkillDisplayName}</span>
                            </span>
                          </div>
                        )}
                        <MessageBody role="user" text={cleanText} />
                      </article>
                    );
                  }

                  // Assistant turn group
                  const historyMsgs = group.messages;
                  // The DSH UI keeps the process trail above one final
                  // answer. Reasoning is represented by Think activities, not
                  // rendered again as a second block in the answer body.
                  const answerTexts = (isThisGroupStreaming
                    ? [state?.activeDraft?.text?.trim() || ""]
                    : historyMsgs.map((message) => message.text?.trim() || "")
                  ).filter((text, index, texts) => text.length > 0 && (index === 0 || text !== texts[index - 1]));
                  const fullTurnAnswerText = answerTexts.join("\n\n").trim();
                  const digestItems = extractDigestItems(fullTurnAnswerText);
                  const activityItems = [
                    ...historyMsgs.flatMap((message) => message.activities ?? []),
                    ...(isThisGroupStreaming ? (state?.activeDraft?.activities ?? []) : []),
                  ];
                  const isInterrupted = historyMsgs.some((message) => message.meta === "interrupted");

                  return (
                    <React.Fragment key={group.id}>
                      <article className={`bubble assistant ${isThisGroupStreaming ? "streaming" : ""}`}>
                      <div className="bubble-head">
                        <strong>深小统</strong>
                      </div>

                      <StreamActivityTimeline
                        activities={activityItems}
                        live={isThisGroupStreaming}
                      />

                      {answerTexts.map((text, index) => (
                        <MessageBody key={`${group.id}-answer-${index}`} role="assistant" text={text} />
                      ))}

                      {/* Streaming loading indicator while generating response */}
                      {isThisGroupStreaming ? (
                        <div className="streaming-loading-bar">
                          <span className="streaming-loading-dot" />
                          <span>
                            {state?.status && state.status !== "Running..." && state.status !== "Ready."
                              ? state.status
                              : "正在思考与处理中…"}
                          </span>
                        </div>
                      ) : null}

                      <CheckableItemSection
                        items={digestItems}
                        selectedMap={selectedDigestItems}
                        onToggleItem={handleToggleDigestItem}
                        onToggleAll={handleToggleAllDigestItems}
                      />
                      </article>
                      {isInterrupted ? <InterruptedTurnDivider /> : null}
                    </React.Fragment>
                  );
                })}

                {hasUnresolvedHistoricalTurn ? (
                  <InterruptedTurnDivider />
                ) : null}

                {!isDshUnavailable && state?.activeDraft && (renderTurnGroups.length === 0 || renderTurnGroups[renderTurnGroups.length - 1].role !== "assistant") ? (
                  <article className="bubble assistant streaming">
                    <div className="bubble-head">
                      <strong>深小统</strong>
                    </div>
                    <StreamActivityTimeline activities={state.activeDraft.activities ?? []} live />
                    {state.activeDraft.text?.trim() ? (
                      <MessageBody role="assistant" text={state.activeDraft.text.trim()} />
                    ) : null}
                    <div className="streaming-loading-bar">
                      <span className="streaming-loading-dot" />
                      <span>
                        {state?.status && state.status !== "Running..." && state.status !== "Ready."
                          ? state.status
                          : "正在思考与处理中…"}
                      </span>
                    </div>
                  </article>
                ) : null}

                {!isDshUnavailable && state?.busy && !state?.activeDraft && state?.status?.includes("排队") ? (
                  <article className="bubble assistant queued-bubble">
                    <div className="bubble-head">
                      <strong>深小统</strong>
                    </div>
                    <div className="task-queue-banner">
                      <span className="task-queue-spinner" />
                      <div className="task-queue-info">
                        <span className="task-queue-title">任务已进入排队队列</span>
                        <span className="task-queue-desc">{state.status}（前序任务完成释放槽位后，将自动无缝接力启动）</span>
                      </div>
                    </div>
                  </article>
                ) : null}
              </>
            )}

            <div ref={messagesEndRef} />
          </section>

          <footer ref={composerRef} className="composer">
            {showScrollBottomBtn && (
              <div className="scroll-bottom-container">
                <button
                  type="button"
                  className="scroll-to-bottom-pill"
                  onClick={scrollToBottom}
                  title="点击滚到最新内容"
                >
                  <svg className="w-3.5 h-3.5 text-blue-600 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                  <span>回到底部</span>
                </button>
              </div>
            )}
            {selectedDigestList.length > 0 && (
              <div className="digest-composer-toolbar">
                <div className="digest-bar-info">
                  <span className="digest-bar-badge">已选择 {selectedDigestList.length} 项动态</span>
                  <button
                    type="button"
                    className="digest-bar-clear"
                    onClick={handleClearSelectedDigestItems}
                  >
                    清空
                  </button>
                </div>
                <div className="digest-bar-actions">
                  <button
                    type="button"
                    className="digest-bar-btn"
                    onClick={handleDigestActionBriefing}
                  >
                    ✨ 提炼简报
                  </button>
                  <button
                    type="button"
                    className={`digest-bar-btn ${selectedDigestList.length < 2 ? "disabled" : ""}`}
                    disabled={selectedDigestList.length < 2}
                    title={selectedDigestList.length < 2 ? "至少需勾选 2 条动态才能交叉比对" : "交叉比对分析"}
                    onClick={handleDigestActionCompare}
                  >
                    🔀 比对分析 {selectedDigestList.length < 2 ? "(需≥2条)" : ""}
                  </button>
                  <button
                    type="button"
                    className="digest-bar-btn primary"
                    onClick={handleDigestActionGenerateHtml}
                  >
                    📰 生成动态信息汇总 HTML 报表
                  </button>
                </div>
              </div>
            )}

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
                      void window.dshDesktop?.getState().then(setState);
                    }}
                  >
                    🔑 前往 DeepSeek 账号设置 →
                  </button>
                ) : null}
              </div>
            ) : null}

            {state?.pendingApproval ? (
              <div className="composer-approval-banner">
                <div className="composer-approval-info">
                  <div className="composer-approval-title">
                    <svg className="w-5 h-5 shrink-0" style={{ color: "#d97706" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                    </svg>
                    <strong>安全指令拦截 - 等待授权许可</strong>
                  </div>
                  <div className="composer-approval-desc">
                    {state.pendingApproval.description}
                  </div>
                  {state.pendingApproval.command ? (
                    <pre className="composer-approval-code">{state.pendingApproval.command}</pre>
                  ) : null}
                </div>
                <div className="composer-approval-actions">
                  <button
                    type="button"
                    className="composer-approval-btn approve"
                    onClick={() => void respondApproval(state.pendingApproval!.requestId, "once")}
                  >
                    ✓ 本次允许
                  </button>
                  <button
                    type="button"
                    className="composer-approval-btn deny"
                    onClick={() => void respondApproval(state.pendingApproval!.requestId, "deny")}
                  >
                    ✕ 拒绝
                  </button>
                </div>
              </div>
            ) : null}

            {state?.pendingClarification ? (
              <div className="composer-clarification-banner">
                <div className="composer-clarification-title">
                  <span aria-hidden="true">💬</span>
                  <strong>
                    {state.pendingClarification.questions.some((question) => question.intent?.kind === "plan-review")
                      ? "计划待审"
                      : "需要补充信息"}
                  </strong>
                  <button
                    type="button"
                    className="composer-clarification-close"
                    onClick={() => void cancelClarification()}
                    title="关闭提问并返回对话"
                    aria-label="关闭提问并返回对话"
                  >
                    ×
                  </button>
                </div>
                {state.pendingClarification.questions.map((question, index) => {
                  const answer = clarificationDraft[question.id] || { selected: [], custom: "" };
                  return (
                    <section className="composer-clarification-question-card" key={question.id}>
                      {question.header ? <div className="composer-clarification-header">{question.header}</div> : null}
                      <div className="composer-clarification-question">
                        {state.pendingClarification.questions.length > 1 ? `${index + 1}. ` : ""}{question.question}
                      </div>
                      {question.detail ? <div className="composer-clarification-detail">{question.detail}</div> : null}
                      {question.options?.length ? (
                        <div className="composer-clarification-choices">
                          {question.options.map((option) => {
                            const selected = answer.selected.includes(option.label);
                            return (
                              <button
                                key={option.label}
                                type="button"
                                aria-pressed={selected}
                                className={`composer-clarification-choice ${selected ? "selected" : ""}`}
                                onClick={() => {
                                  const nextSelected = question.multiSelect
                                    ? selected
                                      ? answer.selected.filter((label) => label !== option.label)
                                      : [...answer.selected, option.label]
                                    : [option.label];
                                  updateClarificationDraft(question.id, {
                                    selected: nextSelected,
                                    ...(question.multiSelect ? {} : { custom: "" }),
                                  });
                                }}
                              >
                                <span>{option.label}</span>
                                {option.description ? <small>{option.description}</small> : null}
                              </button>
                            );
                          })}
                        </div>
                      ) : null}
                      <div className="composer-clarification-input-row">
                        <input
                          value={answer.custom}
                          onChange={(event) => updateClarificationDraft(question.id, {
                            custom: event.target.value,
                            ...(question.multiSelect ? {} : { selected: [] }),
                          })}
                          placeholder={question.options?.length ? "其他回答（可选）" : "输入回答"}
                          aria-label={`${question.header || "问题"}的补充回答`}
                        />
                        <button
                          type="button"
                          className="composer-clarification-skip"
                          onClick={() => updateClarificationDraft(question.id, { selected: [], custom: "" })}
                        >
                          跳过
                        </button>
                      </div>
                    </section>
                  );
                })}
                <div className="composer-clarification-footer">
                  <span>所选选项与补充内容会一并提交给 DSH。</span>
                  <button
                    type="button"
                    className="composer-clarification-submit"
                    disabled={isThreadLoading}
                    onClick={() => void respondClarification()}
                  >
                    提交回答
                  </button>
                </div>
              </div>
            ) : null}

            <div className="trae-composer-card">
              {selectedAttachments.length > 0 && (
                <div className="trae-selected-files" aria-label="待提交文件">
                  <div className="trae-selected-files-header">
                    <span>已选择文件</span>
                    <span>{selectedAttachments.length} 个</span>
                  </div>
                  <div className="trae-attachment-list">
                    {selectedAttachments.map((file) => (
                      <span key={file.path} className="trae-attachment-pill" title={file.path}>
                        <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                        </svg>
                        <span className="trae-attachment-name">{file.name}</span>
                        {formatFileSize(file.size) && <span className="trae-attachment-size">{formatFileSize(file.size)}</span>}
                        <button
                          type="button"
                          className="trae-attachment-remove"
                          onClick={() => removeAttachment(file.path)}
                          title={`移除 ${file.name}`}
                          aria-label={`移除 ${file.name}`}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {selectedSkillTag && (
                <span className="trae-skill-tag-pill" data-skill={selectedSkillTag}>
                  <svg className="w-3.5 h-3.5 shrink-0" style={{ color: "#734b26" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                  </svg>
                  <span className="trae-skill-tag-name" title={selectedSkillTag}>{selectedSkillDisplayName}</span>
                  <button
                    type="button"
                    className="trae-skill-tag-remove"
                    tabIndex={-1}
                    onClick={() => {
                      setSelectedSkillTag(null);
                      focusEditor();
                    }}
                    title="移除技能"
                  >
                    ×
                  </button>
                </span>
              )}

              {pendingVoiceTranscript && (
                <div className="trae-voice-pending" role="status">
                  <div className="trae-voice-pending-heading">
                    <strong>语音已转写，但当前对话已切换</strong>
                    <span>结果尚未加入任何对话，可检查后手动插入。</span>
                  </div>
                  <p>{pendingVoiceTranscript}</p>
                  <div className="trae-voice-pending-actions">
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => {
                        setDraft((current) => current.trim() ? `${current.trimEnd()}\n${pendingVoiceTranscript}` : pendingVoiceTranscript);
                        setPendingVoiceTranscript(null);
                        focusEditor();
                      }}
                    >
                      插入当前草稿
                    </button>
                    <button type="button" className="text-action-button" onClick={() => setPendingVoiceTranscript(null)}>
                      丢弃
                    </button>
                  </div>
                </div>
              )}

              <textarea
                ref={textareaRef}
                className="trae-composer-textarea"
                value={draft}
                disabled={isDshUnavailable || needsProviderSetup}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    if (isCurrentThreadBusy) {
                      void handleStopMessage();
                    } else {
                      void sendMessage();
                    }
                  }
                }}
                placeholder={
                  isDshUnavailable
                    ? "运行时未就绪，消息框已禁用"
                    : needsProviderSetup
                      ? "请先在设置中配置 API Key 或 DeepSeek 账号，消息框暂不可用"
                      : "输入任务需求，或先添加文件..."
                }
              />

              <div className="trae-composer-actions-bar">
                <div className="trae-composer-actions-left">
                  <button
                    type="button"
                    className="trae-attach-button"
                    onClick={() => void handleSelectAttachments()}
                    disabled={isDshUnavailable || Boolean(state.busy) || isThreadLoading}
                    title="添加要提交给智能体的本地文件"
                  >
                    <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                    </svg>
                    <span>添加文件</span>
                    {selectedAttachments.length > 0 && <span className="trae-attach-count">{selectedAttachments.length}</span>}
                  </button>
                  <button
                    type="button"
                    className={`trae-voice-button ${voiceStatus === "recording" ? "recording" : ""}`}
                    onClick={() => void handleVoiceInput()}
                    disabled={isDshUnavailable || isThreadLoading || (Boolean(state?.busy) && voiceStatus === "idle") || voiceStatus === "transcribing"}
                    title={voicePreparationText || (voiceStatus === "recording" ? "停止录音并转成草稿" : voiceStatus === "preparing" ? "取消语音模型准备" : "本地语音转写；结果放入草稿，不会自动发送")}
                    aria-label={voiceStatus === "recording" ? "停止录音" : voiceStatus === "preparing" ? "取消语音模型准备" : "语音输入"}
                  >
                    <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      {voiceStatus === "recording" ? (
                        <rect x="6" y="6" width="12" height="12" rx="2" />
                      ) : (
                        <>
                          <rect x="9" y="2" width="6" height="12" rx="3" />
                          <path d="M5 10a7 7 0 0 0 14 0M12 17v5m-4 0h8" />
                        </>
                      )}
                    </svg>
                    <span>{voiceStatus === "recording" ? "停止" : voiceStatus === "preparing" ? "取消准备" : voiceStatus === "transcribing" ? "转写中" : "语音输入"}</span>
                  </button>
                  {voiceStatus === "preparing" && voicePreparationText && (
                    <span className="trae-voice-status" role="status">{voicePreparationText}</span>
                  )}

                  {!isWorkspaceLocked() && (
                  <div ref={folderMenuRef} className="relative">
                  <button
                    type="button"
                    className={`trae-selector-pill ${currentCwd ? "!border-blue-300 !text-blue-700 !bg-blue-50/80 font-medium" : ""}`}
                    onClick={() => setIsFolderMenuOpen((prev) => !prev)}
                    title={currentCwd ? `当前工作区：${currentCwd}（发消息前可点击更换）` : "选择项目工作区（可选）"}
                  >
                    <svg className={`w-3.5 h-3.5 ${currentCwd ? "text-blue-600" : "text-slate-500"} shrink-0`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
                    </svg>
                    <span className="truncate" style={{ maxWidth: "220px" }}>
                      {currentCwd ? currentFolderName : "选择文件夹（可选）"}
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
                        {currentCwd || "未选择项目工作区"}
                      </div>

                      {recentFolders.length > 0 && (
                        <>
                          <div className="trae-popover-header" style={{ marginTop: "4px" }}>最近使用项目历史</div>
                          {recentFolders.map((folder) => (
                            <button
                              key={folder.path}
                              type="button"
                              className={`trae-popover-item ${folder.path === currentCwd ? "active" : ""}`}
                              onClick={() => void handleSwitchWorkspaceFolder(folder.path)}
                            >
                              <span className="truncate flex items-center gap-1.5">
                                <svg className="w-3.5 h-3.5 text-slate-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
                                </svg>
                                {folder.name}
                              </span>
                              {folder.path === currentCwd && <span style={{ color: "#2563eb" }}>✓</span>}
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

                        {!!currentCwd && (
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
                  )}
                </div>

                {/* Right Side: Send or Stop Button */}
              {isCurrentThreadBusy ? (
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
                  disabled={(!draft.trim() && !selectedSkillTag && selectedAttachments.length === 0) || !canSend}
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

          <div className="composer-bottom-info">
            <span className="flex items-center gap-1.5 font-medium text-slate-500">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block animate-pulse"></span>
              深小统智能工作台
            </span>
            <span className="text-slate-400">支持 PDF / Word / Excel / CSV / 图片 · Shift + Enter 换行 · Enter 发送</span>
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
                  智能体执行导出或抓取任务后，生成的文件默认保存至 <b>{state?.settings.defaultOutputDir || "output"}/任务子目录/</b>。
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
                            onClick={() => void window.dshDesktop.openExternal(`file://${file}`)}
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
                              void window.dshDesktop.openExternal(`file://${dirPath}`);
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
                const targetCwd = state?.activeThread?.cwd || state?.settings?.cwd || "";
                const defaultOutputDir = state?.settings?.defaultOutputDir || "output";
                let resolvedPath = defaultOutputDir;
                if (targetCwd && !defaultOutputDir.startsWith("/") && !defaultOutputDir.includes(":")) {
                  resolvedPath = `${targetCwd}/${defaultOutputDir}`;
                } else if (!targetCwd && threadFiles[0]) {
                  const parts = threadFiles[0].split(/[/\\]/);
                  parts.pop();
                  resolvedPath = parts.join("/") || defaultOutputDir;
                }
                void window.dshDesktop.openExternal(`file://${resolvedPath}`);
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
                      onClick={() => void window.dshDesktop.openExternal(`file://${file}`)}
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
                const targetCwd = state?.activeThread?.cwd || state?.settings?.cwd || "";
                const defaultOutputDir = state?.settings?.defaultOutputDir || "output";
                let resolvedPath = defaultOutputDir;
                const firstFile = state.lastGeneratedFiles?.[0];
                if (firstFile) {
                  const parts = firstFile.split(/[/\\]/);
                  parts.pop();
                  resolvedPath = parts.join("/") || defaultOutputDir;
                } else if (targetCwd && !defaultOutputDir.startsWith("/") && !defaultOutputDir.includes(":")) {
                  resolvedPath = `${targetCwd}/${defaultOutputDir}`;
                }
                void window.dshDesktop.openExternal(`file://${resolvedPath}`);
              }}
            >
              打开输出目录
            </button>
          </div>
        </div>
      )}

      {archivedThread && (
        <div className="file-alert-toast archive-session-toast" role="status" aria-live="polite">
          <div className="toast-header">
            <span className="toast-icon" aria-hidden="true">✓</span>
            <strong>对话已从侧边栏移除</strong>
            <button
              className="toast-close"
              onClick={() => setArchivedThread(null)}
              aria-label="关闭提示"
            >
              ×
            </button>
          </div>
          <div className="toast-body">
            <p>{archivedThread.title}已归档，历史记录仍保留在本地。</p>
          </div>
          <div className="toast-footer">
            <button className="toast-open-dir-button" onClick={() => void undoArchiveThread()}>
              撤销归档
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
                  图片理解
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
                {activeSettingsTab === "vision" && <h3>图片理解 (Image Understanding)</h3>}
                {activeSettingsTab === "tools" && <h3>外部工具 & API 配置</h3>}
              </div>

              <div className="settings-content-body">
                {activeSettingsTab === "runtime" && (
                  <div className="settings-tab-pane">
                    <label>
                      Workspace CWD (工作区路径)
                      <input
                        value={draftSettings.cwd}
                        disabled={isWorkspaceLocked()}
                        onChange={(event) =>
                          setDraftSettings((current: DshAppState["settings"]) => ({
                            ...current,
                            cwd: event.target.value,
                          }))
                        }
                        placeholder="/path/to/workspace"
                      />
                      {isWorkspaceLocked() && <small className="field-hint">当前对话已绑定工作区，请点击“新建任务”后再更换。</small>}
                    </label>

                    <label>
                      默认输出文件夹
                      <input
                        value={draftSettings.defaultOutputDir || ""}
                        onChange={(event) =>
                          setDraftSettings((current: DshAppState["settings"]) => ({
                            ...current,
                            defaultOutputDir: event.target.value,
                          }))
                        }
                            placeholder="output"
                      />
                      <small className="field-hint">
                        智能体产生的文件将默认保存到该文件夹下的子目录中。支持相对路径（相对于工作区）或绝对路径。
                      </small>
                    </label>

                    <div className="skills-section">
                      <div className="skills-section-header">
                        <h4>DSH 运行时</h4>
                        <span>{runtimeInstalled ? "已就绪" : "未就绪"}</span>
                      </div>
                      <div className="skills-list-container">
                        <div className="skill-card">
                          <div className="skill-info">
                            <strong className="skill-card-header">DeepSeek DSH 运行时</strong>
                            <p className="skill-card-desc">应用启动本地 DSH 服务，并使用随安装包提供的 Node.js 运行时。</p>
                            <span className="skill-card-path">{state?.runtime.installDir}</span>
                            <span className="skill-card-path">{state?.runtime.homeDir}</span>
                          </div>
                        </div>
                      </div>
                      <div className="modal-actions-inline">
                        <button className="secondary-button" onClick={() => void repairRuntime()}>
                          重新启动 DSH
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {activeSettingsTab === "chat" && (
                  <div className="settings-tab-pane">
                    <p className="field-hint">当前使用 DSH 本地服务连接 DeepSeek API。</p>

                    <div className={`yolo-setting-card ${draftSettings.yoloMode ? "enabled" : "disabled"}`}>
                      <div className="yolo-setting-copy">
                        <div className="yolo-setting-title">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M12 3 5 6v5c0 4.7 2.9 8.1 7 10 4.1-1.9 7-5.3 7-10V6l-7-3Z" />
                            <path d="m9.2 12 1.8 1.8 3.9-4" />
                          </svg>
                          <strong>YOLO / 自动执行</strong>
                          <span className={`yolo-setting-status ${draftSettings.yoloMode ? "on" : "off"}`}>
                            {draftSettings.yoloMode ? "已开启" : "已关闭"}
                          </span>
                        </div>
                        <p>
                          开启后，新对话使用 DSH Full Access 权限预设，不受工作区沙箱限制且不会弹出普通审批；关闭后，新对话仅允许在工作区内写入，范围外操作需要授权。
                          <br />
                          此设置只影响新对话，已有对话保留创建时的权限。DSH 发出的审批请求仍会显示在授权面板中。
                        </p>
                      </div>
                      <label className="yolo-toggle" title="切换 YOLO 自动执行模式">
                        <input
                          type="checkbox"
                          checked={draftSettings.yoloMode}
                          onChange={(event) =>
                            setDraftSettings((current: DshAppState["settings"]) => ({
                              ...current,
                              yoloMode: event.target.checked,
                            }))
                          }
                        />
                        <span className="yolo-toggle-track" aria-hidden="true">
                          <span className="yolo-toggle-thumb" />
                        </span>
                      </label>
                    </div>

                    <label>
                      Model (对话模型)
                      <div className="provider-models-manager" style={{ marginTop: "4px" }}>
                          <div style={{ fontSize: "12.5px", color: "#64748b", marginBottom: "8px", lineHeight: 1.4 }}>
                            模型在下拉框选择或手动输入模型 ID 后，点击右侧 [+] 按钮添加到列表。
                          </div>

                          <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "14px" }}>
                            {!isManualInputMode ? (
                              <div style={{ position: "relative", flex: 1 }}>
                                <select
                                  value={selectedModelToAdd}
                                  onChange={(e) => {
                                    if (e.target.value === "__manual__") {
                                      setIsManualInputMode(true);
                                      setSelectedModelToAdd("");
                                      setTimeout(() => {
                                        document.getElementById("manual-model-input")?.focus();
                                      }, 50);
                                    } else {
                                      setSelectedModelToAdd(e.target.value);
                                    }
                                  }}
                                  style={{
                                    width: "100%",
                                    height: "36px",
                                    padding: "0 34px 0 12px",
                                    borderRadius: "8px",
                                    border: "1px solid #cbd5e1",
                                    fontSize: "13px",
                                    backgroundColor: "#ffffff",
                                    color: selectedModelToAdd ? "#0f172a" : "#64748b",
                                    boxSizing: "border-box",
                                    appearance: "none",
                                    WebkitAppearance: "none",
                                    cursor: "pointer",
                                  }}
                                >
                                  <option value="">选择模型以添加...</option>
                                  {(PROVIDER_PRESET_MODELS[draftSettings.apiProvider || "deepseek"] || PROVIDER_PRESET_MODELS["deepseek"]).map((preset) => (
                                    <option key={preset.id} value={preset.id}>
                                      {preset.id} — {preset.desc}
                                    </option>
                                  ))}
                                  <option value="__manual__">✍️ 手动输入模型 ID...</option>
                                </select>
                                <div style={{ position: "absolute", right: "12px", top: "50%", transform: "translateY(-50%)", pointerEvents: "none", display: "flex", alignItems: "center" }}>
                                  <svg className="w-4 h-4 text-slate-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="m6 9 6 6 6-6" />
                                  </svg>
                                </div>
                              </div>
                            ) : (
                              <div style={{ position: "relative", flex: 1, display: "flex", alignItems: "center" }}>
                                <input
                                  id="manual-model-input"
                                  type="text"
                                  value={customModelInput}
                                  onChange={(e) => setCustomModelInput(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                      e.preventDefault();
                                      handleAddCustomModel();
                                    }
                                  }}
                                  placeholder="输入模型 ID，例如 qwen-plus 或 claude-3-5-sonnet"
                                  style={{
                                    width: "100%",
                                    height: "36px",
                                    padding: "0 74px 0 12px",
                                    borderRadius: "8px",
                                    border: "1px solid #3b82f6",
                                    fontSize: "13px",
                                    backgroundColor: "#ffffff",
                                    color: "#0f172a",
                                    boxSizing: "border-box",
                                    outline: "none",
                                  }}
                                />
                                <button
                                  type="button"
                                  onClick={() => {
                                    setIsManualInputMode(false);
                                    setCustomModelInput("");
                                  }}
                                  title="返回下拉选择"
                                  style={{
                                    position: "absolute",
                                    right: "6px",
                                    height: "26px",
                                    padding: "0 8px",
                                    borderRadius: "5px",
                                    fontSize: "11px",
                                    color: "#64748b",
                                    backgroundColor: "#f1f5f9",
                                    border: "none",
                                    cursor: "pointer",
                                  }}
                                >
                                  切回下拉
                                </button>
                              </div>
                            )}

                            <button
                              type="button"
                              onClick={() => handleAddCustomModel()}
                              disabled={isManualInputMode ? !customModelInput.trim() : !selectedModelToAdd}
                              title="添加到列表并设为当前生效模型"
                              style={{
                                width: "36px",
                                height: "36px",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                borderRadius: "8px",
                                border: "1px solid #cbd5e1",
                                backgroundColor: (isManualInputMode ? customModelInput.trim() : selectedModelToAdd) ? "#2563eb" : "#f1f5f9",
                                color: (isManualInputMode ? customModelInput.trim() : selectedModelToAdd) ? "#ffffff" : "#94a3b8",
                                fontSize: "18px",
                                fontWeight: 600,
                                cursor: (isManualInputMode ? customModelInput.trim() : selectedModelToAdd) ? "pointer" : "not-allowed",
                                transition: "all 0.15s ease",
                                flexShrink: 0,
                              }}
                            >
                              +
                            </button>

                            <button
                              type="button"
                              onClick={() => {
                                const defaultPresets = (PROVIDER_PRESET_MODELS[draftSettings.apiProvider || "deepseek"] || PROVIDER_PRESET_MODELS["deepseek"]).map((m) => m.id);
                                setDraftSettings((current) => ({
                                  ...current,
                                  customModels: defaultPresets,
                                  model: current.model && defaultPresets.includes(current.model) ? current.model : (defaultPresets[0] || ""),
                                }));
                              }}
                              title="恢复当前 Provider 预设推荐模型列表"
                              style={{
                                height: "36px",
                                display: "flex",
                                alignItems: "center",
                                gap: "6px",
                                padding: "0 12px",
                                borderRadius: "8px",
                                border: "1px solid #cbd5e1",
                                backgroundColor: "#ffffff",
                                color: "#334155",
                                fontSize: "12.5px",
                                cursor: "pointer",
                                flexShrink: 0,
                              }}
                            >
                              <svg className="w-3.5 h-3.5 text-slate-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                              </svg>
                              <span>刷新列表</span>
                            </button>
                          </div>

                          <div style={{ marginBottom: "10px" }}>
                            <div style={{ fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "8px" }}>
                              已加入 Provider 的模型：
                            </div>

                            {draftSettings.apiProvider === "deepseek" && (
                              <div style={{ fontSize: "12px", color: "#64748b", marginBottom: "8px", lineHeight: 1.4 }}>
                                默认使用 <b>deepseek-flash</b>（V4.1 Flash，支持原生视觉理解）；官方 API 当前也将兼容 ID <b>deepseek-v4-pro</b> 路由到 V4.1 Flash。
                              </div>
                            )}

                            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                              {(() => {
                                const presets = (PROVIDER_PRESET_MODELS[draftSettings.apiProvider || "deepseek"] || PROVIDER_PRESET_MODELS["deepseek"]).map((m) => m.id);
                                const currentList = Array.isArray(draftSettings.customModels) && draftSettings.customModels.length > 0
                                  ? draftSettings.customModels
                                  : presets;
                                const fullList = Array.from(new Set([draftSettings.model, ...currentList].filter(Boolean) as string[]));

                                return fullList.map((modelId) => {
                                  const isSelected = (draftSettings.model || presets[0]) === modelId;
                                  return (
                                    <div
                                      key={modelId}
                                      onClick={() => {
                                        setDraftSettings((current) => ({
                                          ...current,
                                          model: modelId,
                                        }));
                                      }}
                                      style={{
                                        display: "inline-flex",
                                        alignItems: "center",
                                        gap: "8px",
                                        padding: "6px 12px",
                                        borderRadius: "8px",
                                        fontSize: "13px",
                                        fontFamily: "monospace",
                                        cursor: "pointer",
                                        border: isSelected ? "1.5px solid #3b82f6" : "1px solid #cbd5e1",
                                        backgroundColor: isSelected ? "#eff6ff" : "#f8fafc",
                                        color: isSelected ? "#1d4ed8" : "#334155",
                                        fontWeight: isSelected ? 600 : 500,
                                        boxShadow: isSelected ? "0 1px 3px rgba(59, 130, 246, 0.15)" : "none",
                                        transition: "all 0.15s ease",
                                      }}
                                      title={isSelected ? "当前生效的默认模型" : "点击切换为此模型"}
                                    >
                                      <span>
                                        {draftSettings.apiProvider === "deepseek" && modelId === "deepseek-flash"
                                          ? "deepseek-flash · V4.1 Flash"
                                          : modelId}
                                      </span>
                                      <span
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleRemoveCustomModel(modelId);
                                        }}
                                        title="移除此模型"
                                        style={{
                                          display: "inline-flex",
                                          alignItems: "center",
                                          justifyContent: "center",
                                          width: "16px",
                                          height: "16px",
                                          borderRadius: "50%",
                                          fontSize: "11px",
                                          color: isSelected ? "#2563eb" : "#94a3b8",
                                          backgroundColor: isSelected ? "rgba(59, 130, 246, 0.15)" : "rgba(0, 0, 0, 0.06)",
                                          cursor: "pointer",
                                          transition: "background-color 0.15s",
                                        }}
                                      >
                                        ✕
                                      </span>
                                    </div>
                                  );
                                });
                              })()}
                            </div>
                          </div>

                          <div style={{ fontSize: "12px", color: "#64748b", margin: "6px 0 0 0" }}>
                            蓝色高亮项为当前生效的默认模型，点击其他模型标签可直接切换。
                          </div>
                        </div>
                    </label>

                    <label>
                      API Provider (大模型提供商)
                      <select
                        value={draftSettings.apiProvider}
                        onChange={(event) => {
                          const newProvider = event.target.value as DshAppState["settings"]["apiProvider"];
                          setDraftSettings((current: DshAppState["settings"]) => ({
                            ...current,
                            apiProvider: newProvider,
                            apiBaseUrl: newProvider === "deepseek" && !current.apiBaseUrl ? "https://api.deepseek.com" : current.apiBaseUrl,
                          }));
                        }}
                        className="settings-select"
                      >
                        <option value="openai">OpenAI</option>
                        <option value="openrouter">OpenRouter</option>
                        <option value="deepseek">DeepSeek</option>
                        <option value="custom">自定义 OpenAI 兼容接口</option>
                      </select>
                    </label>

                        {draftSettings.apiProvider !== "deepseek" && (
                          <p className="field-hint" role="status">
                            当前模型将由 DSH 的 {draftSettings.apiProvider === "custom" ? "自定义" : draftSettings.apiProvider} provider 路由处理。
                          </p>
                        )}

                    <label>
                      API Key (密钥)
                      <input
                        type="password"
                        autoComplete="new-password"
                        value={draftSettings.apiKey}
                        onChange={(event) =>
                          setDraftSettings((current: DshAppState["settings"]) => ({
                            ...current,
                            apiKey: event.target.value,
                          }))
                        }
                        placeholder={state?.providerCredentialStatus?.[draftSettings.apiProvider]?.configured ? "已由 DSH 保存；输入新密钥可替换" : "sk-..."}
                      />
                      <small className="field-hint">
                        密钥仅写入 DSH 凭据库，不会回显或保存在应用设置文件中。{state?.providerCredentialStatus?.[draftSettings.apiProvider]?.configured ? "留空会保留现有密钥。" : ""}
                      </small>
                      {state?.providerCredentialStatus?.[draftSettings.apiProvider]?.configured && state?.providerCredentialStatus?.[draftSettings.apiProvider]?.writable && (
                        <button type="button" className="text-action-button danger" onClick={() => void clearCurrentProviderApiKey()}>
                          清除 DSH 中保存的密钥
                        </button>
                      )}
                      {state?.providerCredentialStatus?.[draftSettings.apiProvider]?.configured && !state?.providerCredentialStatus?.[draftSettings.apiProvider]?.writable && (
                        <small className="field-hint">该密钥由只读环境变量提供，请在启动环境中清除。</small>
                      )}
                    </label>

                    {draftSettings.apiProvider === "custom" && (
                      <label>
                        API Base URL
                        <input
                          value={draftSettings.apiBaseUrl}
                          onChange={(event) =>
                            setDraftSettings((current: DshAppState["settings"]) => ({
                              ...current,
                              apiBaseUrl: event.target.value,
                            }))
                          }
                          placeholder="https://api.example.com/v1"
                        />
                      </label>
                    )}

                    {draftSettings.apiProvider === "deepseek" && state && (
                      <section className="dsh-account-settings-card">
                        <div className="dsh-account-settings-heading">
                          <div>
                            <h4>DeepSeek 账号</h4>
                            <p>账号授权由 DSH 保存和管理。未配置 DeepSeek API Key 时，新对话会使用此账号。</p>
                          </div>
                          <span className={`dsh-account-status ${state.account?.status === "credential-stored" ? "connected" : "disconnected"}`}>
                            {state.account?.status === "credential-stored" ? "已登录" : "未登录"}
                          </span>
                        </div>

                        {state.account?.attempt && ["initializing", "waiting-browser", "exchanging", "committing"].includes(state.account.attempt.phase) && (
                          <p className="dsh-account-progress" role="status">
                            {state.account.attempt.phase === "waiting-browser" ? "已打开浏览器，请完成 DeepSeek 授权。" : "正在准备账号授权…"}
                          </p>
                        )}
                        {state.account?.attempt && ["failed", "expired"].includes(state.account.attempt.phase) && (
                          <p className="dsh-account-error" role="alert">
                            登录{state.account.attempt.phase === "expired" ? "已过期" : "失败"}（{state.account.attempt.errorCode || "未知错误"}），可以重新登录。
                          </p>
                        )}

                        <div className="dsh-account-actions">
                          {state.account?.status === "credential-stored" ? (
                            <>
                              <button type="button" className="secondary-button" onClick={() => void window.dshDesktop.openExternal(state.account!.links.usageUrl)}>
                                账号用量
                              </button>
                              <button type="button" className="secondary-button" onClick={() => void window.dshDesktop.openExternal(state.account!.links.topUpUrl)}>
                                充值
                              </button>
                              <button type="button" className="text-action-button danger" onClick={() => void signOutDshAccount()}>
                                退出账号
                              </button>
                            </>
                          ) : ["initializing", "waiting-browser", "exchanging", "committing"].includes(state.account?.attempt?.phase || "") ? (
                            <button type="button" className="secondary-button" onClick={() => void window.dshDesktop.cancelAccountSignIn().then(setState)}>
                              取消登录
                            </button>
                          ) : (
                            <button type="button" className="primary-button" onClick={() => void startDshAccountSignIn()} disabled={state.busy || isLoggingIn}>
                              {isLoggingIn ? "正在打开浏览器…" : "登录 DeepSeek 账号"}
                            </button>
                          )}
                        </div>
                      </section>
                    )}
                  </div>
                )}

                {activeSettingsTab === "vision" && (
                  <div className="settings-tab-pane">
                    <p className="tab-pane-desc" role="note">
                      图片通过 DSH 原生附件接口提交给当前对话模型。DeepSeek 默认模型 deepseek-flash（V4.1 Flash）支持视觉理解；无需单独配置视觉模型。
                    </p>
                  </div>
                )}

                {activeSettingsTab === "tools" && (
                  <div className="settings-tab-pane">
                    <p className="tab-pane-desc" role="note">
                      DSH 基础 profile 已提供 DeepSeek 原生 web_search，并复用上方由 DSH 管理的 DeepSeek API Key。语音输入接入 DSH 本地 SenseVoice，转写结果只写入草稿；首次使用需确认下载模型。
                    </p>

                    <h4 className="settings-section-title">当前已接入的工具</h4>
                    <p className="field-hint">网页检索由 DSH 的 DeepSeek 原生 web_search 提供。语音输入由本地 SenseVoice 转写，不会自动发送录音或识别结果。</p>

                    <h4 className="settings-section-title" style={{ marginTop: "12px" }}>未迁移的旧配置</h4>
                    <p className="field-hint">迁移前的 Firecrawl、Exa、FAL、Browserbase 和 OpenAI Voice 项只有密钥输入框，没有连接到任何后端调用。应用成功启动后会清除这些未使用的旧设置，不会迁移到 DSH。</p>
                  </div>
                )}
              </div>

              {/* Shared Footer Actions */}
              <div className="settings-content-footer">
                <p className="modal-copy">
                  主对话、图片附件、DeepSeek 原生网页检索和本地语音转写通过 DSH 工作；独立视觉后端及旧版 Firecrawl/Exa、FAL、Browserbase 配置没有接入后端。
                </p>
                <div className="modal-actions">
                  <button className="secondary-button" onClick={() => void closeSettingsModal()}>
                    {isLoggingIn ? "取消登录并关闭" : "取消"}
                  </button>
                  <button className="primary-button" onClick={() => void saveSettings()}>
                    保存并应用
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {stylePickerSkillName ? (
        <ReportStylePicker
          skillName={stylePickerSkillName}
          onCancel={() => setStylePickerSkillName(null)}
          onSelect={handleReportStyleSelect}
        />
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
          elapsedSeconds={busyElapsedSeconds}
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
                  <p style={{ margin: 0, fontSize: "11.5px", color: "#64748b" }}>DSH 身份验证未通过</p>
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
                DSH 认证信息可能已失效。检查当前 provider 的 API Key，或在 DeepSeek 账号卡片中重新授权。
              </p>

              <div className="error-step-card">
                <div className="error-step-card-title">
                  <span>🔑 检查 DSH provider 凭据</span>
                </div>
                <ol className="error-step-list">
                  <li>打开应用内的 <b>设置 / 模型与账号登录</b> 界面。</li>
                  <li>核对所选 provider 的 API Key 是否有效。</li>
                  <li>如果使用 DeepSeek 账号，退出后重新登录并在浏览器中完成授权。</li>
                </ol>
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
                  void window.dshDesktop?.getState().then(setState);
                }}
                style={{ background: "linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)", borderColor: "#1d4ed8" }}
              >
                前往账号设置（设置 → 模型与账号登录）
              </button>
            </div>
          </div>
        </div>
      )}

      {navInterruptConfirm.open && (
        <div className="modal-backdrop" style={{ zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div
            style={{
              width: "100%",
              maxWidth: 420,
              backgroundColor: "#ffffff",
              borderRadius: 16,
              boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)",
              padding: "24px 26px",
              border: "1px solid #e2e8f0",
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 18 }}>
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 10,
                  backgroundColor: "#fef3c7",
                  color: "#d97706",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              </div>
              <div style={{ flex: 1 }}>
                <h3 style={{ fontSize: 16, fontWeight: 600, color: "#0f172a", margin: "0 0 6px 0" }}>确认中断当前任务？</h3>
                <p style={{ fontSize: 13.5, color: "#64748b", margin: 0, lineHeight: 1.55 }}>
                  当前任务正在分析生成中，新建或切换任务将中断当前执行，是否确认中断？
                </p>
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button
                type="button"
                className="secondary-button"
                onClick={handleCancelNavInterrupt}
                style={{ padding: "7px 16px", borderRadius: 8, fontSize: 13, cursor: "pointer" }}
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmNavInterrupt()}
                style={{
                  padding: "7px 18px",
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 500,
                  backgroundColor: "#ef4444",
                  color: "#ffffff",
                  border: "none",
                  cursor: "pointer",
                  boxShadow: "0 1px 2px 0 rgba(239, 68, 68, 0.35)",
                }}
              >
                确认中断
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ReportStylePicker({
  skillName,
  onCancel,
  onSelect,
}: {
  skillName: string;
  onCancel: () => void;
  onSelect: (styleId: string) => void;
}) {
  const skillDisplayName = BUILTIN_SKILL_DISPLAY_NAMES[skillName] || "HTML 报表技能";

  return (
    <div className="modal-backdrop report-style-picker-backdrop" onClick={onCancel}>
      <div className="report-style-picker" onClick={(event) => event.stopPropagation()}>
        <div className="report-style-picker-header">
          <div>
            <p className="eyebrow">先选输出风格</p>
            <h3>{skillDisplayName}</h3>
            <p>
              选择后会自动进入对话输入框，技能将直接使用该风格模版生成可打开的 HTML 成果文件并保存到工作区 output/ 目录。
            </p>
          </div>
          <button type="button" className="report-style-picker-close" onClick={onCancel} aria-label="关闭风格选择">
            ×
          </button>
        </div>

        <div className="report-style-picker-grid">
          {REPORT_STYLE_OPTIONS.map((style, index) => (
            <button
              key={style.id}
              type="button"
              className={`report-style-option tone-${style.tone}`}
              onClick={() => onSelect(style.id)}
            >
              <span className="report-style-option-index">0{index + 1}</span>
              <span className="report-style-option-copy">
                <strong>{style.label}</strong>
                {index === 0 && <em>推荐</em>}
                <small>{style.description}</small>
              </span>
              <span className="report-style-option-arrow" aria-hidden="true">↗</span>
            </button>
          ))}
        </div>

        <div className="report-style-picker-footer">
          <span>也可以进入输入框后直接补充标题、时间范围和站点范围。</span>
          <button type="button" className="secondary-button" onClick={onCancel}>取消</button>
        </div>
      </div>
    </div>
  );
}

function ArchivedThreadsPage({
  threads,
  isBusy,
  onRestore,
  onDelete,
  onNewChat,
}: {
  threads: DshThreadSummary[];
  isBusy: boolean;
  onRestore: (threadId: string) => void;
  onDelete: (threadId: string, title: string) => void;
  onNewChat: () => void;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const orderedThreads = useMemo(
    () => [...threads].sort((a, b) => b.updatedAt - a.updatedAt),
    [threads]
  );
  const filteredThreads = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    if (!query) return orderedThreads;
    return orderedThreads.filter((thread) =>
      `${thread.name || thread.preview || ""} ${thread.cwd || ""}`.toLocaleLowerCase().includes(query)
    );
  }, [orderedThreads, searchQuery]);

  return (
    <main className="archive-page-view">
      <header className="archive-page-header">
        <div>
          <p className="eyebrow">对话管理</p>
          <h2>已归档对话</h2>
          <p className="archive-page-subtitle">归档会把对话从任务列表隐藏；恢复后会重新出现在任务列表中。</p>
        </div>
        <button type="button" className="primary-button" onClick={onNewChat}>新建任务</button>
      </header>

      <label className="archive-search-label">
        <span className="sr-only">搜索已归档对话</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-4-4" />
        </svg>
        <input
          type="search"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="按对话标题或工作区搜索"
        />
      </label>

      <p className="archive-page-note">
        归档可随时恢复。彻底删除会移除会话日志和工作区关联且无法恢复；DSH 全局附件库中的共享数据或缓存可能仍会保留。
      </p>

      {filteredThreads.length === 0 ? (
        <div className="archive-page-empty">
          <span aria-hidden="true">▱</span>
          <h3>{threads.length === 0 ? "暂无已归档对话" : "没有匹配的对话"}</h3>
          <p>{threads.length === 0 ? "从任务列表移除的对话会保留在这里，可随时恢复。" : "试试其他标题或工作区名称。"}</p>
        </div>
      ) : (
        <div className="archive-thread-list">
          {filteredThreads.map((thread) => {
            const title = formatCleanTaskTitle(thread.name || thread.preview || "未命名对话");
            return (
              <article className="archive-thread-card" key={thread.id}>
                <div className="archive-thread-copy">
                  <h3 title={title}>{title}</h3>
                  <p>{thread.cwd || "默认工作区"}</p>
                </div>
                <div className="archive-thread-actions">
                  <button type="button" className="secondary-button" onClick={() => onRestore(thread.id)} disabled={isBusy}>
                    恢复到任务列表
                  </button>
                  <button
                    type="button"
                    className="archive-delete-button"
                    onClick={() => onDelete(thread.id, title)}
                    disabled={isBusy}
                    title="永久删除此对话及本地记录"
                  >
                    彻底删除
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </main>
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
  skills: DshAppState["skills"];
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  onImportSkill: () => void;
  onUnregisterSkill: (path: string) => void;
  onUseSkill: (skillName: string) => void;
}) {
  const filteredSkills = useMemo(() => {
    return skills.filter((s) => {
      const q = searchQuery.toLowerCase().trim();
      const displayName = s.displayName || BUILTIN_SKILL_DISPLAY_NAMES[s.name] || s.name;
      return !q || s.name.toLowerCase().includes(q) || displayName.toLowerCase().includes(q) || s.description.toLowerCase().includes(q);
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
            {filteredSkills.map((skill) => {
              const isOfficialBuiltin = [
                "info-digest-html",
                "weekly-report",
                "price-index-gdp-impact",
                "source-verification",
                "gov-official-document-drafting",
                "info_digest_html",
                "weekly_report",
                "price_index_gdp_impact",
                "source_verification",
                "gov_official_document_drafting",
              ].includes(skill.name);

              const icon = BUILTIN_SKILL_ICONS[skill.name] || "🧩";
              const displayName = skill.displayName || BUILTIN_SKILL_DISPLAY_NAMES[skill.name] || skill.name;

              return (
                <div key={skill.path} className={`skills-grid-card ${isOfficialBuiltin ? "border-blue-200/80 bg-slate-50/40" : ""}`}>
                  <div className="skills-card-top">
                    <div className="skills-card-icon text-lg flex items-center justify-center">
                      {icon}
                    </div>
                    <div className="skills-card-info">
                      <div className="flex items-center gap-2 mb-0.5">
                        <h4 title={skill.name} className="truncate">{displayName}</h4>
                        {isOfficialBuiltin && (
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-blue-100/80 text-blue-700 border border-blue-200 shrink-0">
                            官方内置
                          </span>
                        )}
                      </div>
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
                      使用技能
                    </button>
                    {!isOfficialBuiltin && (
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
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught an unhandled error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: "40px 20px", textAlign: "center", fontFamily: "sans-serif", background: "#f8fafc", minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
          <h2 style={{ fontSize: "1.25rem", color: "#0f172a", marginBottom: "8px" }}>应用遇到意料之外的界面异常</h2>
          <p style={{ color: "#ef4444", fontSize: "0.88rem", maxWidth: "600px", margin: "12px 0 24px 0", wordBreak: "break-word" }}>
            {this.state.error?.message || "未知错误"}
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: "8px 20px",
              background: "#2563eb",
              color: "#fff",
              border: "none",
              borderRadius: "6px",
              cursor: "pointer",
              fontSize: "0.88rem",
              fontWeight: 500,
            }}
          >
            刷新页面恢复
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function AppWithErrorBoundary() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}
