---
name: info_digest_html
display_name: 动态信息汇总 HTML 报表
description: 统计与政务动态汇总 HTML 报表生成器。能将 JSON / Markdown 形式的统计局或政务动态数据，一键填充并生成 5 种视觉风格的专业 HTML 参阅材料与互动仪表盘。支持勾选项目实时生成，内置筛选、检索、响应式适配与源数据统计。
version: 1.0.0
author: Antigravity
inputs:
  items:
    type: array
    description: 选中的动态条目 JSON 数组（包含 title, organization, publish_time, summary, link, category）。
  template_style:
    type: string
    description: HTML 报表模版风格，可选 'geek' (极客周报卡片风/默认), 'classic' (庄重朱红风), 'slate' (现代板岩风), 'dark' (数字暗黑海洋风), 'swiss' (先锋报刊/瑞士极简风)。
    default: "geek"
  report_title:
    type: string
    description: 报表主标题。
    default: "统计信息化与数字化转型动态监测"
---

# 统计与政务动态汇总 HTML 报表生成器 (info_digest_html)

## 技能定位
本 Skill 专门用于将数据采集层抓取到的统计局/政府部门工作动态（JSON 或 Markdown 条目），一键合成排版精美、交互完备的 **统一 HTML 参阅报表**。

## 5 大视觉风格模版

Skill 内置 5 种经过严格审美设计与响应式调校的 HTML 模版（存放在 `./templates/`）：

1. `template_geek_weekly.html` (**极客周报与智能卡片风 - 默认推荐**)
   - **特点**：时间轴信息流、微动画滑入、支持模糊检索与多维筛选、响应式卡片 Bento 风格。
2. `template_authority_classic.html` (**庄重权威与经典朱红风**)
   - **特点**：传统政务参阅件质感、双线朱红花边、宣纸底色、古朴严肃。
3. `template_slate_tech.html` (**现代板岩与科技极简风**)
   - **特点**：现代数字政府看板、极轻板岩灰、Bento KPI 指标盒。
4. `template_dark_ocean.html` (**数字治理与暗黑海洋风**)
   - **特点**：暗黑极客主题、深海发光科技感、适合大屏或夜间汇报。
5. `template_swiss_editorial.html` (**先锋报刊与瑞士极简风**)
   - **特点**：国际主义黑白网格、克莱因蓝高亮、报纸大版面风格。

## 模版替换规则与数据注入说明

当用户请求生成 HTML 报表或调用本 Skill 时，请按照以下流程操作：

1. **确定所选条目**：获取用户勾选的或当前聊天上下文中分析出的结构化 JSON 条目（包含 `title`, `organization`, `publish_time`, `summary`, `link`, `category`）。
2. **选择模版**：根据用户偏好或默认推荐选择 `./templates/` 下对应的 `.html` 文件。
3. **内容注入**：
   - 替换页面 `<title>` 和 `<h1>` 主标题为指定 `report_title`。
   - 替换更新时间为当前日期（如 `2026年7月10日`）。
   - 替换 KPI 统计卡片中的条目总数与各分类数量。
   - 动态渲染或替换卡片/时间轴列表 HTML 节点（填入各条目的 `title`, `organization`, `publish_time`, `summary`, `link` 等）。
4. **输出文件**：将生成的完整 HTML 代码保存为工作区 `output/` 目录下的 `.html` 文件（如 `output/统计信息化与数字化转型动态监测.html`），严禁直接写入工作区根目录；并在对话回复中输出可直接点击的 Markdown 链接 `[打开输出目录](file:///.../output/)`。

## HTML 排版安全与防遮挡规范（硬性准则）

1. **吸顶导航与锚点留白**：带有置顶过滤或吸顶导航条时，所有 `section`、`.sec` 及具有 `id` 的锚点跳转容器**必须带有 `scroll-margin-top: 84px`**，确保通过锚点跳转定位时标题绝不被吸顶控件遮挡。
2. **【严禁项】表格安全排版**：如果报表中包含数据表格，必须使用模板内置的 `.tbl-wrap` 和标准自然流 `thead th`，**绝对严禁**在横向滚动容器内对 `thead th` 添加带有 top 像素偏移的 sticky 定位，避免表头盖住首行文字。
3. **【标准安全 CSS】**：
```css
section, .sec, [id] { scroll-margin-top: 84px; }
.tbl-wrap { overflow-x: auto; border: 1px solid var(--border-blue); border-radius: 12px; background: var(--surface); margin: 16px 0; }
table { border-collapse: collapse; width: 100%; font-size: 12.8px; min-width: 680px; }
thead th { background: #eef4ff; color: #1e3a8a; font-size: 11.5px; padding: 10px 14px; text-align: left; white-space: nowrap; border-bottom: 2px solid var(--border-blue); }
tbody td { padding: 10px 14px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
tbody tr:nth-child(even) { background: #fafcff; }
tbody tr:hover { background: #f0f6ff; }
```

## 来源展示硬性要求

本技能的来源要求是强制要求，无论输出是摘要、卡片、图表、表格、指标卡还是结论，都必须同时提供：发布单位或网站全称、文章来源/页面完整标题、指向具体文章或页面的原文链接。只写单位、网站名、域名、栏目页或搜索结果页均不合格；无法确认时必须写“来源：未提供/待核验”，不得补写链接。

- 每张动态卡片、图表、表格和指标卡都必须显示具体来源，格式为：`来源：[单位]：《文章标题》`。
- 来源文字必须使用该条数据的 `link` 作为可点击链接，点击后直接打开原文页面。
- 禁止只显示“数据来源：深圳市统计局”或“来源：某某单位”；如果一张图表由多篇文章支撑，必须逐项列出对应的单位、文章标题和链接。
- 如果只有单位而没有具体文章标题或链接，必须标记“来源：未提供/待核验”，不能自行补写标题或 URL。
