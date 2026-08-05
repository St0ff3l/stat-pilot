---
name: info_digest_html
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
4. **输出文件**：将生成的完整 HTML 代码保存为 `.html` 文件（如 `output_report.html`），并给用户提供预览和浏览器直接打开提示。
