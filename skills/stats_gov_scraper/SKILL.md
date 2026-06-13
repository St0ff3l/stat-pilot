---
name: 国家统计局数据发布详情深度分析与本地入库器
description: 像素级控版。全面支持原网页中的文字段落、趋势折线“图”以及结构化数据“表”的 1:1 完整提取。强制使用变量赋值，彻底封锁大模型重命名与合并文件的行为。
version: 4.0.0
author: Stoffel
inputs:
  item_limit:
    type: integer
    description: 仅抓取列表最上方的最新 XX 条文章。
    default: 0
  pages:
    type: integer
    description: 需要抓取的列表页数。
    default: 1
---

# 技能执行协议 (NBS Perfect-Alignment Scraper)

## 基础配置
- **入口网址**: `https://www.stats.gov.cn/sj/zxfb/`

## 执行指南与自动化步骤

### 第一步：机械化列表文本抓取
1. 导航至目标网址，定位列表中的新闻链接元素（`<a>` 标签）。
2. **文本强绑定（绝对铁律）**：
   - 直接提取该链接元素的 `innerText` 原始文本。
   - 将该整段文本（包含所有时间前缀、百分比数字、特殊标点）不加修饰地赋值给变量 `EXACT_STRING`。
3. **数量截断**：根据 `{{inputs.item_limit}}` 或 `{{inputs.pages}}` 限制收集任务，存入队列。

### 第二步：详情页「文本+图+表」1:1 像素级解析（核心升级）
依次打开链接，在解析每个页面时，大模型必须扮演严格的数据解构器，严禁主观提炼，必须将页面拆解为**文字、表、图**三种独立的标准资产：

1. **文字段落对应**：按正文自然段或小标题，完整将文本 and 提取出的离散指标填入 `text_sections`。
2. **结构化“表（Tables）”还原（无损映射）**：
   - 识别页面中的所有 HTML 数据表格。
   - 提取表格的标题，将其作为 `table_title`。
   - 提取表格的第一行（或前几行定义列名的部分）作为 `headers` 数组。
   - 将表格下方的所有数据行，按行、列顺序转化为二维数组 `rows`，彻底保留表格的矩阵结构。
3. **趋势“图（Charts）”还原**：
   - 识别底部的折线图，按时间横轴精确抓取所有标注点，拼装成 `raw_data_stream` 字符串流。
4. **机械化无污染写盘**：
   - **文件保存位置与操作**：大模型**必须且只能**调用本地文件写入工具，将每个页面的解析结果 JSON 内容以文件名 `Filename = EXACT_STRING + ".json"` 写入到当前工作区（`cwd`）下的 `scraped_data/` 目录中。
   - **严禁**自作聪明在文件名添加日期前缀或删减字词，否则触发系统 FATAL ERROR。
   - **对话输出限制（绝对铁律）**：为了保持界面整洁，**严禁在对话回复中直接输出或显示完整的 JSON 文本**。大模型在对话中只需输出“已成功抓取并写入文件：`scraped_data/[Filename]`”，以及一个极简的 100 字内核心数据结论即可，绝对不要把庞大的 JSON 结构输出在聊天气泡中。
   - 每完成一篇，立即关闭页面、**销毁内存缓存**。**坚决禁止**生成 `all_articles.json` 或任何合并汇总文件。

---

## 规范 JSON 输出格式 (Strict Complete Schema)

```json
{
  "metadata": {
    "title": "必须原样输出 EXACT_STRING 变量的值，逐字对齐",
    "publish_date": "YYYY-MM-DD",
    "source": "国家统计局",
    "statistical_period": "文中提取的统计周期"
  },
  "text_sections": [
    {
      "section_index": 1,
      "section_heading": "原文段落小标题（若无则填主要主题）",
      "raw_paragraph_text": "段落完整原文",
      "section_indicators": [
        {
          "indicator_name": "具体指标名称",
          "single_month_value": "当月数值（若无为 null）",
          "single_month_yoy_growth": 4.1, 
          "cumulative_value": "累计数值（若无为 null）",
          "cumulative_yoy_growth": 5.6,
          "remarks": "补充说明"
        }
      ]
    }
  ],
  "data_tables": [
    {
      "table_id": "表1",
      "table_title": "原文标准的统计表格名称（如：2026年4月份70个大中城市...价格指数）",
      "headers": ["表头列名1", "表头列名2", "表头列名3"],
      "rows": [
        ["行1列1数据", "行1列2数据", "行1列3数据"],
        ["行2列1数据", "行2列2数据", "行2列3数据"]
      ]
    }
  ],
  "charts_analysis": [
    {
      "chart_id": "图1",
      "chart_title": "原文标准图表标题",
      "time_span": "横轴时间跨度",
      "raw_data_stream": "格式：2025年4月(6.1%) -> 5月(5.8%) -> ...",
      "trend_features": "原图展现的波动形态及原文定性描述",
      "extreme_values": {
        "max_point": "最高点月份及数值",
        "min_point": "最低点月份及数值"
      },
      "latest_judgment": "最新月份边际变化的解说"
    }
  ],
  "comprehensive_judgment": "结合该篇文章整体数据的综合态势总结，约200-300字。"
}
```
