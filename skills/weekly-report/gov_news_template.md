# 政务与数据监测仪表盘模版集与 AI 技能调用说明

本工作目录中现包含 **5 套不同视觉风格** 的政务与数据监测仪表盘 HTML 模版。你可以双击这些 HTML 文件在浏览器中直接预览效果。

---

## 一、 模版库风格及对应文件

| 风格名称 | 文件路径 | 适用场景 | 视觉特色 |
| :--- | :--- | :--- | :--- |
| **A. 现代板岩与科技极简风** | [template_slate_tech.html](file:///Users/stoffel/CodeFile/sz-web-template/template_slate_tech.html) | 信息化建设、数字转型、日常工作动态监测 | 浅灰蓝微渐变背景、毛玻璃置顶导航、卡片悬浮响应、高亮分类色彩。 |
| **B. 庄重权威与经典朱红风** | [template_authority_classic.html](file:///Users/stoffel/CodeFile/sz-web-template/template_authority_classic.html) | 党建要闻、中央或省级公文发布、重大活动发布 | 传统中式朱红/金铜/宣纸暖白配色、衬线字体 (宋体)、无底色大图版面、庄重严肃。 |
| **C. 数字治理与暗黑海洋风** | [template_dark_ocean.html](file:///Users/stoffel/CodeFile/sz-web-template/template_dark_ocean.html) | 数字政府大屏展示、高新技术跟踪、大数据监测 | 深空灰蓝背景、暗色半透明卡片、荧光青/荧光绿霓虹边框呼吸效应、高对比度荧光数据指标。 |
| **D. 先锋报刊与瑞士极简风** | [template_swiss_editorial.html](file:///Users/stoffel/CodeFile/sz-web-template/template_swiss_editorial.html) | 深度行业分析报告、学术/专家级政务解读、去AI味高级设计 | 国际主义/瑞士设计风格。无圆角无阴影（纯平极简）、1px纯黑实线分割、非对称网格结构（主次报道大小不同）、克莱因蓝作唯一聚焦色。 |
| **E. 极客周报与智能卡片风** | [template_geek_weekly.html](file:///Users/stoffel/CodeFile/sz-web-template/template_geek_weekly.html) | 极客风周报、论文盘点、轻量化移动端阅读信息流 | 限制 `max-width: 680px` 紧凑双端视口。淡蓝背景与顶部微蓝渐变底色、三栏横向 Bento 统计栏、左侧带有时间戳与圆环节点的纵向贯穿时间线、圆角微蓝边框智能卡片（`border-radius: 16px`）、滚动渐入滑出动画（Scroll Reveal）。 |

*注：所有模版均内置了**实时检索框功能**与**栏目点击自动筛选联动**，不需要刷新页面即可进行实时搜索与分类过滤。*

---

## 二、 技能 (Skill) 调用方式及配置

你可以在你的 AI Agent 技能配置（例如 `SKILL.md`）中，通过指令告诉 AI 如何选择对应的样式。以下是推荐的技能指令模版。

### 1. 技能参数设计 (用户可通过参数指定样式)
建议在技能的提示词中加入以下逻辑：
> **用户指令接收规则**：
> - 如果用户未指定风格，默认采用 `template_geek_weekly.html` (极客周报风) 或 `template_slate_tech.html` (现代板岩与科技极简风)。
> - 如果用户提及“论文盘点/卡片流/极客/小屏/精致/蓝色/时间线”，强烈推荐采用 **`template_geek_weekly.html` (极客周报与智能卡片风)**。
> - 如果用户提及“去AI味/高级设计/杂志/报纸/大排版/克莱因蓝”，采用 `template_swiss_editorial.html` (先锋报刊与瑞士极简风)。
> - 如果用户提及“党建/正式/权威/红头/宋体/传统”，采用 `template_authority_classic.html` (庄重权威与经典朱红风)。
> - 如果用户提及“暗黑/科技/大屏/酷炫/看板/夜间”，采用 `template_dark_ocean.html` (数字治理与暗黑海洋风)。

---

## 三、 针对各样式的 AI 稳定输出 Prompt

为了确保 AI 在生成时百分之百稳定地沿用对应的设计，你可以将对应风格 of CSS 样式和 JS 控制块固化在 Skill 的 Prompt 中。以下是新增的【极客周报风】框架：

### 选定：【E. 极客周报与智能卡片风】时，要求 AI 必须直接套用的框架结构
```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>[标题]</title>
<style>
  :root {
    --bg: #f3f7fb; --surface: #ffffff; --ink: #0f172a; --ink2: #334155; --muted: #64748b; --faint: #94a3b8;
    --brand: #0066ff; --brand-bg: rgba(0, 102, 255, 0.05); --border-blue: #dbeafe;
    --sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; --serif: Georgia, "Nimbus Roman No9 L", "Songti SC", "Noto Serif SC", serif; --mono: "IBM Plex Mono", Courier, monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { scroll-behavior: smooth; }
  body { font-family: var(--sans); color: var(--ink); line-height: 1.6; -webkit-font-smoothing: antialiased; background: var(--bg); padding: 0 0 100px 0; }
  a { color: inherit; text-decoration: none; }
  .container { max-width: 680px; margin: 0 auto; padding: 0 20px; }
  .hero { padding: 54px 0 28px; background: linear-gradient(180deg, #e4effc 0%, #f3f7fb 100%); text-align: center; }
  .sub-badge { display: inline-flex; align-items: center; gap: 6px; background: var(--surface); border: 1px solid var(--border-blue); border-radius: 999px; padding: 6px 16px; font-size: 11.5px; font-weight: 700; color: var(--brand); letter-spacing: 1px; text-transform: uppercase; box-shadow: 0 2px 8px rgba(0, 102, 255, 0.03); margin-bottom: 20px; }
  .sub-badge-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--brand); }
  .hero h1 { font-family: var(--serif); font-weight: 800; font-size: clamp(24px, 4.5vw, 36px); color: var(--ink); letter-spacing: -0.5px; margin-bottom: 12px; line-height: 1.25; }
  .hero h1 em { font-style: normal; color: var(--brand); }
  .hero-meta { font-size: 13px; color: var(--muted); margin-bottom: 28px; }
  .hero-meta span { font-family: var(--mono); font-weight: 600; color: var(--ink2); }
  
  .stats-card { display: flex; flex-direction: row; align-items: center; justify-content: center; background: var(--surface); border: 1px solid var(--border-blue); border-radius: 12px; box-shadow: 0 4px 16px rgba(0, 102, 255, 0.02); margin: 0 auto 10px; max-width: 440px; width: 100%; }
  .stat-col { flex: 1; padding: 14px 10px; text-align: center; border-right: 1px solid #f0f6ff; }
  .stat-col:last-child { border-right: none; }
  .stat-val { font-family: var(--sans); font-weight: 700; font-size: 24px; color: var(--brand); line-height: 1.1; margin-bottom: 4px; }
  .stat-lbl { font-size: 11.5px; color: var(--muted); font-weight: 500; }
  
  .sticky-controls { position: sticky; top: 0; z-index: 100; background: rgba(243, 247, 251, 0.95); backdrop-filter: blur(12px); border-bottom: 1px solid rgba(0, 102, 255, 0.05); padding: 12px 0; margin-bottom: 24px; }
  .controls-in { display: flex; flex-direction: column; gap: 12px; }
  .nav-scroll { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; scrollbar-width: none; }
  .nav-scroll::-webkit-scrollbar { display: none; }
  .nav-pill { white-space: nowrap; padding: 6px 14px; background: var(--surface); border: 1px solid var(--border-blue); border-radius: 999px; font-size: 12.5px; font-weight: 600; color: var(--muted); cursor: pointer; transition: all 0.2s ease; }
  .nav-pill:hover { border-color: var(--brand); color: var(--brand); }
  .nav-pill.active { background: var(--brand); border-color: var(--brand); color: #fff; box-shadow: 0 4px 10px rgba(0, 102, 255, 0.15); }
  .search-pill { position: relative; width: 100%; }
  .search-pill input { width: 100%; padding: 10px 14px 10px 38px; border-radius: 999px; border: 1px solid var(--border-blue); background: var(--surface); font-size: 13px; color: var(--ink); outline: none; transition: all 0.2s; }
  .search-pill input:focus { border-color: var(--brand); box-shadow: 0 0 0 3px rgba(0, 102, 255, 0.08); }
  .search-icon { position: absolute; left: 14px; top: 50%; transform: translateY(-50%); color: var(--muted); display: flex; align-items: center; }
  
  .stream { position: relative; padding: 24px 0 48px; }
  .timeline-item { display: flex; position: relative; gap: 20px; }
  .timeline-line-segment { position: absolute; left: 30px; top: 0; bottom: 0; width: 2px; background: var(--border-blue); z-index: 1; }
  .timeline-left { width: 140px; display: flex; flex-direction: column; align-items: flex-start; justify-content: flex-start; padding-top: 22px; flex-shrink: 0; position: relative; }
  .timeline-dot-wrapper { position: absolute; left: 21px; top: 22px; z-index: 2; }
  .timeline-ring { width: 20px; height: 20px; border-radius: 50%; border: 2px solid var(--brand); background: #fff; display: flex; align-items: center; justify-content: center; box-shadow: 0 0 0 4px rgba(0, 102, 255, 0.08); }
  .timeline-inner-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--brand); }
  .timeline-date { margin-left: 54px; text-align: left; }
  .timeline-time-ago { font-size: 13px; font-weight: 700; color: var(--brand); margin-bottom: 2px; }
  .timeline-full-date { font-size: 11px; color: var(--muted); font-family: var(--mono); }
  .timeline-right { flex: 1; padding-bottom: 32px; }

  .card { background: var(--surface); border: 1px solid rgba(0, 102, 255, 0.08); border-radius: 16px; padding: 24px; box-shadow: 0 4px 12px rgba(0, 102, 255, 0.015); display: flex; flex-direction: column; transition: transform 0.25s, box-shadow 0.25s; }
  .card:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0, 102, 255, 0.05); }
  .card-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
  .num { font-family: var(--mono); font-size: 13px; color: var(--muted); font-weight: 600; }
  .badge { font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 999px; background: #f1f5f9; border: 1px solid #e2e8f0; color: #475569; }
  .badge.orange { background: #fff7ed; border-color: #ffedd5; color: #c2410c; }
  .badge.emerald { background: #ecfdf5; border-color: #d1fae5; color: #047857; }
  .badge.purple { background: #faf5ff; border-color: #f3e8ff; color: #7e22ce; }
  .card-title { font-size: 17.5px; font-weight: 700; line-height: 1.45; color: var(--ink); margin-bottom: 12px; }
  .card-title a { transition: color 0.15s; }
  .card-title a:hover { color: var(--brand); }
  .card-sum { font-size: 14.5px; color: var(--ink2); line-height: 1.7; margin-bottom: 20px; }
  .card-source { font-size: 12px; color: var(--muted); line-height: 1.6; margin: -8px 0 16px; }
  .card-source a { color: var(--muted); text-decoration: underline; text-underline-offset: 2px; }
  .card-foot { display: flex; justify-content: space-between; align-items: center; margin-top: auto; }
  .go { display: inline-flex; align-items: center; gap: 4px; font-size: 13.5px; font-weight: 700; color: var(--brand); transition: gap 0.15s; }
  .go:hover { gap: 7px; }
  .go-arr { font-size: 14px; font-weight: 900; }
  
  .empty-state-view { display: none; text-align: center; color: var(--muted); padding: 48px; background: var(--surface); border: 1px dashed var(--border-blue); border-radius: 12px; font-size: 13.5px; margin-top: 12px; }
  .reveal { opacity: 0; transform: translateY(24px); transition: opacity 0.8s cubic-bezier(0.16, 1, 0.3, 1), transform 0.8s cubic-bezier(0.16, 1, 0.3, 1); will-change: transform, opacity; }
  .reveal.visible { opacity: 1; transform: translateY(0); }
  
  footer { border-top: 1px solid var(--border-blue); margin-top: 60px; padding-top: 40px; color: var(--muted); }
  .foot-h { font-family: var(--serif); font-size: 18px; color: var(--ink); margin-bottom: 10px; font-weight: 800; }
  .foot-sum { font-size: 13.5px; line-height: 1.6; margin-bottom: 24px; }
  .foot-sum b { color: var(--brand); font-family: var(--mono); }
  .src-title { font-size: 12px; font-weight: 700; color: var(--ink); margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
  .src-list { display: flex; flex-wrap: wrap; gap: 6px; }
  .src-chip { font-size: 11px; color: var(--muted); background: var(--surface); border: 1px solid var(--border-blue); border-radius: 4px; padding: 4px 8px; }
  .src-chip.dim { opacity: 0.25; }
  .foot-note { margin-top: 28px; font-size: 12px; color: var(--faint); line-height: 1.8; border-top: 1px solid var(--border-blue); padding-top: 20px; font-family: var(--serif); }
</style>
</head>
...
```

#### 无论哪套模版，动态填充的 Card HTML 节点统一规范：
```html
<div class="timeline-item reveal" data-category="[分类ID，如 sec-practice]">
  <div class="timeline-line-segment"></div>
  <div class="timeline-left">
    <div class="timeline-dot-wrapper">
      <div class="timeline-ring"><div class="timeline-inner-dot"></div></div>
    </div>
    <div class="timeline-date">
      <div class="timeline-time-ago">[相对时间，如 9天前]</div>
      <div class="timeline-full-date">[绝对日期，如 2026-07-01]</div>
    </div>
  </div>
  <div class="timeline-right">
    <article class="card">
      <div class="card-top">
        <span class="num">[两位序号，如 01]</span>
        <span class="badge [orange/emerald/purple/留空]">来源：[发布单位]</span>
      </div>
      <h3 class="card-title">
        <a href="[原文链接]" target="_blank" rel="noopener noreferrer">[标题]</a>
      </h3>
      <p class="card-sum">[摘要，2-3行内]</p>
      <p class="card-source">来源：<a href="[原文链接]" target="_blank" rel="noopener noreferrer">[发布单位]：《[标题]》</a></p>
      <div class="card-foot">
        <a class="go" href="[原文链接]" target="_blank" rel="noopener noreferrer">
          阅读原文 <span class="go-arr">↗</span>
        </a>
      </div>
    </article>
  </div>
</div>
```

---

## 四、 页面底部的通用动态控制 JS（要求 AI 在模版尾部 100% 照抄）

```javascript
document.addEventListener('DOMContentLoaded', () => {
  const searchInput = document.getElementById('search-input');
  const pills = document.querySelectorAll('.nav-pill');
  const items = document.querySelectorAll('.timeline-item');
  const emptyState = document.getElementById('empty-state');
  
  let activeCategory = 'all';
  
  function updateTimelineLines() {
    let firstVisible = null;
    let lastVisible = null;
    let totalVisible = 0;
    
    items.forEach(item => {
      item.classList.remove('first-visible', 'last-visible');
      if (item.style.display !== 'none') {
        totalVisible++;
        if (!firstVisible) firstVisible = item;
        lastVisible = item;
      }
    });
    
    if (firstVisible) firstVisible.classList.add('first-visible');
    if (lastVisible) lastVisible.classList.add('last-visible');
    
    if (totalVisible === 0) {
      emptyState.style.display = 'block';
    } else {
      emptyState.style.display = 'none';
    }
  }

  function applyFilter() {
    const query = searchInput.value.toLowerCase().trim();
    
    items.forEach(item => {
      const text = item.textContent.toLowerCase();
      const category = item.getAttribute('data-category');
      
      const matchesSearch = text.includes(query);
      const matchesCategory = (activeCategory === 'all' || category === activeCategory);
      
      if (matchesSearch && matchesCategory) {
        item.style.display = 'flex';
        item.classList.add('visible');
      } else {
        item.style.display = 'none';
      }
    });
    
    updateTimelineLines();
  }

  searchInput.addEventListener('input', applyFilter);

  pills.forEach(pill => {
    pill.addEventListener('click', () => {
      pills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      activeCategory = pill.getAttribute('data-target');
      applyFilter();
    });
  });

  const revealObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, {
    rootMargin: '0px 0px -8% 0px'
  });
  
  items.forEach(item => {
    revealObserver.observe(item);
  });
  
  updateTimelineLines();
});
```
