# 官方政务网站接入与安全准入铁律 (Official Gov Websites Safety Rule)

## 规则摘要
本规则旨在强制约束 Agent 在进行数据采集、政务信息检索、政策对比及统计分析任务时，只能访问我国官方认证的政务门户与统计局网站，杜绝“野生数据”、第三方自媒体中转网及未认证非法站点的安全隐患。

## 铁律一：域名与后缀强制白名单
1. **官方域名后缀要求**：
   - 必须严格限定为我国官方政务专用域名后缀：`.gov.cn`（中国大陆政府网）、`.gov.hk`（香港特区政府）、`.gov.mo`（澳门特区政府）。
   - 严禁抓取、引用或依赖商业中转站（如 `.com`、`.net`、`.org`、`.xyz`）提供的二手“政务/统计”数据。

2. **内置索引优先准则**：
   - Agent 在需要查找或确定目标单位的官网及栏目地址时，**必须优先查阅本地内置数据文件**：
     - [`src/data/china_gov_websites.json`](file:///Users/stoffel/CodeFile/sz-gov-scope/src/data/china_gov_websites.json)
     - [`src/data/china_stats_websites.json`](file:///Users/stoffel/CodeFile/sz-gov-scope/src/data/china_stats_websites.json)
   - 严禁随意凭空猜测未验证的政府网站 URL。

## 铁律二：数据直连与来源追溯
1. 所有呈现给用户的动态条目、政策文件或统计数据，必须附带直连官方域名（`https://*.gov.cn/...`）的原文出处链接。
2. 对于含有第三方泛域名广告重定向或 URL 风险的站点，必须触发 SSL 降级/请求校验机制或直接拒绝对接。

## 铁律三：全流程智能校验
1. 抓取与摘要生成阶段：提取数据时必须校验 URL 域名是否在 `china_gov_websites.json` 的官方名录库中。
2. 呈现参阅材料/HTML 报表时：所有引用来源必须标注单位全称及 `.gov.cn` 权威备案标志。
