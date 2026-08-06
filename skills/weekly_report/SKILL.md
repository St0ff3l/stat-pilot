---
name: weekly_report
description: 统计信息化动态采集与周报 HTML 生成器。AI 驱动采集国家及各省市区 23 个统计局官网与公众号"工作动态"文章，按信息化、AI、大数据等关键词筛选，支持代码脚本辅助（baseline_collector.py）与 5 种视觉风格的 HTML 参阅报表与周报生成。
version: 2.0.0
author: Stoffel
inputs:
  days_back:
    type: integer
    description: 回溯天数，默认最近 7 天（含当天）。
    default: 7
  keyword_filter:
    type: string
    description: 逗号分隔的关键词列表，用于覆盖默认筛选关键词（可选）。
    default: ""
  output_format:
    type: string
    description: 输出格式，可选 txt, json, html, both。
    default: "both"
  template_style:
    type: string
    description: HTML 报表模版风格，可选 'geek' (默认极客卡片), 'classic' (庄重朱红), 'slate' (现代板岩), 'dark' (暗黑海洋), 'swiss' (先锋报刊)。
    default: "geek"
  sites:
    type: string
    description: 逗号分隔的站点 ID 列表，留空 = 全部 23 个站点。站点 ID 见下文清单。
    default: ""
---

# 统计信息化动态采集与周报生成器 (weekly_report)

## 任务目标
从 23 个统计局（1 国家级 + 9 省级 + 8 副省级/重点城市 + 5 扩展站点）的官网"工作动态"等栏目及官方微信公众号，采集最近 N 天（默认 7 天）的文章，筛选出与信息化建设、数字化转型、统计平台、AI 应用、大数据等主题相关的文稿，最终支持以 txt 文本、JSON 数据、Markdown 参阅周报及 5 种风格的 HTML 交互仪表盘输出。

## 执行方式与附带代码

本 Skill 附带了代码工具与模版资源（存放在本 Skill 目录内）：
1. **基线抓取脚本**：`./scripts/baseline_collector.py`
   - 提供 23 站点 59 栏目的完整配置（URL / 栏目 / CSS 选择器）、关键词清单与关联度规则。
   - 当需要进行批量自动化抓取或作为参考规则时，AI 可直接读取或调用该 Python 脚本。
2. **周报 Markdown 模版**：`./gov_news_template.md`
   - 用于生成格式化的《政务与统计信息化动态周报》Markdown 参阅文件。
3. **HTML 报表模版**：`./templates/` 下的 5 种视觉风格 `.html`
   - 当输出格式需要包含 HTML 报表时，直接读取对应模版并填入渲染后的 JSON 条目。

## 数据来源清单（23 站点 59 栏目）

> 以下配置参照 `baseline_collector.py` 的 `_build_default_sites()` 函数。每个栏目标注了列表页 URL、分页模式、详情页选择器提示。AI 抓取时应参照这些信息定位列表项与详情正文。

### 国家级

#### 国家统计局（stats_national）
- 栏目1：统计动态 https://www.stats.gov.cn/xw/tjxw/tjdt/ （分页 index_n：index.html / index_1.html，SSL 降级 http）
- 栏目2：通知公告 https://www.stats.gov.cn/xw/tjxw/tzgg/
- 列表选择器：`.list-content ul li`，链接 `a.fl`，日期 `span`
- 详情选择器：标题 `.article_title` · 日期 `.center_xilan_info` · 正文 `.center_xilan_con`
- 域名白名单：stats.gov.cn

### 省级（9 个）

#### 广东省统计局（stats_gd）
- 栏目1：省局要事 http://stats.gd.gov.cn/gzys/ （index_n）
- 栏目2：各地要事 http://stats.gd.gov.cn/gdys/
- 栏目3：通知公告 http://stats.gd.gov.cn/ggl217/
- 栏目4：图片新闻 http://stats.gd.gov.cn/tpxw1508/
- 列表选择器：`.overview-news-list .news-item`，链接 `a.news-link, a`，日期 `.news-date, span`
- 详情选择器：标题 `.article-title` · 日期 `.article-info` · 正文 `.article-content-text`
- 域名白名单：stats.gd.gov.cn, stats.gov.cn

#### 浙江省统计局（stats_zj）【JSON API】
- 栏目1：统计要闻 https://tjj.zj.gov.cn/api-gateway/jpaas-publish-server/front/page/build/unit （JSON API，pageId=1562308）
- 栏目2：统计快讯 同上 API，pageId=1562009
- 栏目3：文件通知 同上 API，pageId=1525494
- API 参数：webId=3077, pageType=column, tagId=当前栏目_list, tplSetId=XY4xf9Yl4IKd7uKwPD0zP, parseType=bulidstatic
- 请求头：X-Requested-With=XMLHttpRequest, Accept=application/json
- 响应：`data.html` 字段是 HTML 片段，解析其中的 `ul.ImporF_bd-ul li`
- 详情选择器：标题 `.article-title` · 日期 `.article-info` · 正文 `div.main_section`
- 域名白名单：tjj.zj.gov.cn

#### 江苏省统计局（stats_js）
- 栏目1：统计要闻 https://tj.jiangsu.gov.cn/col/col87243/index.html （index_n）
- 栏目2：统计要闻 http://tj.jiangsu.gov.cn/col/col85270/index.html
- 栏目3：通知公告 http://tj.jiangsu.gov.cn/col/col85271/index.html
- 列表选择器：`.news_list li`，链接 `a`，日期 `span`
- 详情选择器：标题 `h1` · 日期 `.pubtime` · 正文 `#bt-box-zoom`
- 域名白名单：tj.jiangsu.gov.cn

#### 山东省统计局（stats_sd）
- 栏目1：省级动态 http://tjj.shandong.gov.cn/col/col156115/index.html （index_n）
- 栏目2：省局动态 http://tjj.shandong.gov.cn/col/col6187/index.html
- 栏目3：通知公告 http://tjj.shandong.gov.cn/col/col6174/index.html
- 列表选择器：`.news_list li`，链接 `a`，日期 `span`
- 详情选择器：标题 `h1` · 日期 `.info` · 正文 `#zoom`（注意：#zoom 内含元数据 table，需忽略"索引号/主题分类"等表）
- 域名白名单：tjj.shandong.gov.cn

#### 四川省统计局（stats_sc）
- 栏目1：统计动态 http://tjj.sc.gov.cn/scstjj/c112153/list.shtml （index_n2：list.shtml / list_2.shtml，跳过 list_1.shtml）
- 栏目2：通知公告 http://tjj.sc.gov.cn/scstjj/c105843/common_list.shtml
- 栏目3：新闻发布会 http://tjj.sc.gov.cn/scstjj/c112119/xwfbh.shtml
- 列表选择器：`.news_list li, .right_list li`，链接 `a`，日期 `span`
- 详情选择器：标题 `h1` · 日期 `.info` · 正文 `#zoomcon`
- 域名白名单：tjj.sc.gov.cn

#### 北京市统计局（stats_bj）
- 栏目1：工作动态 https://tjj.beijing.gov.cn/zwgkai/gzdt/ （index_n）
- 栏目2：通知公告 https://tjj.beijing.gov.cn/zwgkai/tzgg/
- 栏目3：要闻动态 https://tjj.beijing.gov.cn/zwgkai/ywdt/
- 列表选择器：`ul[class*=list] li`，链接 `a`，日期 `span.date`
- 详情选择器：标题 `.article_title` · 日期 `.article_info` · 正文 `.TRS_Editor`
- 域名白名单：tjj.beijing.gov.cn

#### 上海市统计局（stats_sh）【正则策略】
- 栏目1：统计要闻 https://tjj.sh.gov.cn/tjxw/ （index_n2：index.html / index_2.html）
- 栏目2：通知告示 https://tjj.sh.gov.cn/tzgs/ （index_n2，静态策略）
- 主栏目列表结构：`<li><a href="...">标题</a><span class="time">日期</span></li>`
- 通知告示栏目列表结构：`<li><a>标题</a>日期</li>`（日期无 span 包裹）
- 详情选择器：标题 `.article-title` · 日期 `.article-info` · 正文 `.TRS_Editor`
- 域名白名单：tjj.sh.gov.cn

#### 天津市统计局（stats_tj）
- 栏目1：统计工作动态 https://stats.tj.gov.cn/sy_51953/tjgzdt/ （index_n，SSL 降级）
- 栏目2：通知公告 https://stats.tj.gov.cn/sy_51953/tzgg/
- 列表选择器：`.news_list li`，链接 `a`，日期 `span`
- 详情选择器：标题 `h1` · 日期 `.info` · 正文 `.TRS_Editor`
- 域名白名单：stats.tj.gov.cn

#### 重庆市统计局（stats_cq）
- 栏目1：部门动态 http://tjj.cq.gov.cn/zwxx_233/bmdt/ （index_n）
- 栏目2：通知公告 http://tjj.cq.gov.cn/zwxx_233/tzgg/
- 列表选择器：`.news_list li`，链接 `a`，日期 `span`
- 详情选择器：标题 `h2` · 日期 `.info` · 正文 `.TRS_Editor`
- 域名白名单：tjj.cq.gov.cn

### 副省级 / 重点城市（8 个）

#### 广州市统计局（stats_gz）
- 栏目1：工作动态 http://tjj.gz.gov.cn/zzfwzq/gzdt/ （index_n）
- 栏目2：通知公告 http://tjj.gz.gov.cn/open_newzwgk/tzgg/
- 栏目3：图片新闻 http://tjj.gz.gov.cn/news_newtjdt/tpxw/
- 列表选择器：`.news_list li`，链接 `a`，日期 `span`
- 详情选择器：标题 `h3` · 日期 `.info` · 正文 `#zoomcon`
- 域名白名单：tjj.gz.gov.cn

#### 杭州市统计局（stats_hz）
- 栏目1：工作动态 http://tjj.hangzhou.gov.cn/col/col1651400/index.html （index_n）
- 栏目2：区县动态 https://tjj.hangzhou.gov.cn/col/col1652150/index.html
- 栏目3：通知公告 https://tjj.hangzhou.gov.cn/col/col1651600/index.html
- 列表选择器：`.news_list li`，链接 `a`，日期 `span`
- 详情选择器：标题 `h2` · 日期 `.info` · 正文 `.TRS_Editor`
- 域名白名单：tjj.hangzhou.gov.cn

#### 南京市统计局（stats_nj）
- 栏目1：工作动态 https://tjj.nanjing.gov.cn/gzdt/ （index_n）
- 栏目2：统计信息（CPI / 经济运行 / 公报解读） https://tjj.nanjing.gov.cn/tjxx/ （index_n，共 34 页）
- 栏目3：通知公告 http://tjj.nanjing.gov.cn/njstjj/?id=xxgk_228 （单页式入口，分页待勘探）
- 列表选择器：`.news_list li`，链接 `a`，日期 `span`
- 详情选择器：标题 `h1` · 日期 `.info` · 正文 `.TRS_Editor`
- 域名白名单：tjj.nanjing.gov.cn

#### 武汉市统计局（stats_wh）
- 栏目1：统计要闻 https://tjj.wuhan.gov.cn/xwzx/sjyw/ （index_n，index_file=index.shtml）
- 栏目2：区级动态 https://tjj.wuhan.gov.cn/xwzx/qjdt/
- 栏目3：通知公告 https://tjj.wuhan.gov.cn/xwzx/tzgg/
- 栏目4：图片新闻 https://tjj.wuhan.gov.cn/xwzx/tpxw/
- 列表选择器：`.news_list li`，链接 `a`，日期 `span`
- 详情选择器：标题 `h2` · 日期 `.info` · 正文 `#content`
- 域名白名单：tjj.wuhan.gov.cn

#### 青岛市统计局（stats_qd）
- 栏目1：统计要闻 http://qdtj.qingdao.gov.cn/tongjigz/tongjiju_tjyw/ （index_n）
- 栏目2：通知公告 http://qdtj.qingdao.gov.cn/tongjigz/tjj_tzgg/
- 列表选择器：`.news_list li`，链接 `a`，日期 `span`
- 详情选择器：标题 `h1` · 日期 `.info` · 正文 `.TRS_Editor`
- 域名白名单：qdtj.qingdao.gov.cn, qingdao.gov.cn

#### 厦门市统计局（stats_xm）
- 栏目1：统计工作 https://tjj.xm.gov.cn/zwgk/gzdt/ （index_n，index_file=index.htm）
- 栏目2：图片新闻 http://tjj.xm.gov.cn/zwgk/tpxw/
- 栏目3：业务通知 http://tjj.xm.gov.cn/zwgk/ywtz/
- 列表选择器：`.news_list li`，链接 `a`，日期 `span`
- 详情选择器：标题 `h1` · 日期 `.info` · 正文 `.TRS_Editor`
- 域名白名单：tjj.xm.gov.cn

#### 宁波市统计局（stats_nb）
- 栏目1：工作动态 http://tjj.ningbo.gov.cn/col/col1229629629/index.html （index_n）
- 栏目2：通知公告 http://tjj.ningbo.gov.cn/col/col1229724514/index.html
- 列表选择器：`.news_list li`，链接 `a`，日期 `span`
- 详情选择器：标题 `h1` · 日期 `.info` · 正文 `.TRS_Editor`
- 域名白名单：tjj.ningbo.gov.cn

#### 苏州市统计局（stats_sz）
- 栏目1：工作动态 http://tjj.suzhou.gov.cn/sztjj/gzdt/list.shtml （index_n）
- 栏目2：政声传递 http://tjj.suzhou.gov.cn/sztjj/zwgg/zscd_list.shtml
- 列表选择器：`.news_list li`，链接 `a`，日期 `span`
- 详情选择器：标题 `h2` · 日期 `.info` · 正文 `.TRS_Editor`
- 域名白名单：tjj.suzhou.gov.cn

### 扩展站点（5 个，来自 Java 工程）

#### 福建省统计局（stats_fj）【POST JSON API】
- 栏目1：统计要闻 https://www.fujian.gov.cn/fjdzapp/search （POST JSON API）
  - POST body：channelid=229105, classsql=chnlid=3504, page=N, prepage=15, sortfield=-docorderpri,-docreltime
  - 响应 JSON：`data` 数组，每项含 `doctitle`（标题）、`docpuburl`（URL）、`docreltime`（日期，可能是时间戳）
  - 分页参数名：page
- 栏目2：市县动态 https://tjj.fujian.gov.cn/xwdt/sxdt/ （静态 HTML，index_n，index_file=index.htm）
- 详情选择器：标题 `h1` · 日期 `.info` · 正文 `.TRS_Editor`
- 域名白名单：fujian.gov.cn, tjj.fujian.gov.cn

#### 河南省统计局（stats_henan）
- 栏目1：统计动态 https://tjj.henan.gov.cn/zwxx/sjdt/ （index_n，SSL 降级）
- 栏目2：通知公告 https://tjj.henan.gov.cn/zwxx/tzgg/
- 列表选择器：`.news_list li`，链接 `a`，日期 `span`
- 详情选择器：依赖全局默认（`.TRS_Editor` / `.content` 等）
- 域名白名单：tjj.henan.gov.cn, henan.gov.cn

#### 深圳市统计局（stats_sz_statistics）
- 栏目1：工作动态 http://tjj.sz.gov.cn/zwgk/zfxxgkml/qt/gzdt/ （index_n2，SSL 降级）
- 栏目2：通知公告 http://tjj.sz.gov.cn/zwgk/zfxxgkml/qt/tzgg/
- 列表选择器：`.news_list li`，链接 `a`（title 属性优先），日期 `span`
- 详情选择器：标题 `.article-title` · 日期 `p.article-time` · 正文 `.TRS_Editor`
- 域名白名单：tjj.sz.gov.cn

#### 深圳市发展和改革委员会（sz_fgw）
- 栏目1：工作动态 http://fgw.sz.gov.cn/zwgk/qt/gzdt/ （index_n2，SSL 降级）
- 栏目2：通知公告 http://fgw.sz.gov.cn/zwgk/qt/tzgg/
- 列表选择器：`.news_list li`，链接 `a`，日期 `span`
- 详情选择器：标题 `.article-title` · 日期 `p.article-time` · 正文 `.TRS_Editor`
- 域名白名单：fgw.sz.gov.cn

#### 深圳市工业和信息化局（sz_gxj）
- 栏目1：工作动态 http://gxj.sz.gov.cn/xxgk/xxgkml/qt/gzdt/ （index_n2，SSL 降级）
- 栏目2：通知公告 http://gxj.sz.gov.cn/xxgk/xxgkml/qt/tzgg/
- 列表选择器：`.news_list li`，链接 `a`，日期 `span`
- 详情选择器：标题 `.article-title` · 日期 `p.article-time` · 正文 `.TRS_Editor`
- 域名白名单：gxj.sz.gov.cn

## 采集规则（绝对铁律）

1. **官网采集范围**：仅采集各单位官网的 "工作动态" / "动态要闻" / "新闻中心" / "政务公开-工作动态" / "通知公告" / "图片新闻" / "新闻发布会" / "各地要闻" / "区县动态" / "政声传递" / "市县动态" 栏目，**严禁**点击或下载任何附件（PDF、Word、Excel、PPT、RAR、7z、gz、tar、视频、音频文件）。
2. **附件过滤**：遇到 URL 以 `.pdf .doc .docx .xls .xlsx .ppt .pptx .wps .et .dps .zip .rar .7z .gz .tar .mp4 .avi .mp3` 结尾的链接，直接跳过，不抓取详情。
3. **域名白名单**：详情页 URL 必须属于该站点的域名白名单，防止跨站跳转。
4. **公众号采集**：必须同时检索各单位官方微信公众号文章，严禁遗漏。
5. **时间窗口**："最近 N 天" 严格定义为 `today - (days_back - 1)` 到 `today`（含当天）。例：days_back=7 → 保留 `[today-6, today]` 共 7 天。仅保留在此时间窗口内发布的文章。
6. **分页规则**：
   - `index_n`：首页 index.html，第 2 页 index_1.html，第 3 页 index_2.html ...
   - `index_n2`：首页 index.html，第 2 页 index_2.html，第 3 页 index_3.html ...（跳过 _1）
   - `page_param`：URL 查询参数翻页（如 ?page=2）
   - 翻页停止条件：本页所有文章都早于时间窗口下界 → 后续页更老，停止翻页。

## 关键词与关联度

### 强关联关键词（标题或正文出现 → 强关联）
`信息化` `数字化` `数字统计` `智慧统计` `统计平台` `统计数据平台` `业务系统` `业务系统升级` `统计现代化改革` `统计云` `云平台` `数据中台` `数据治理` `一网通办` `人工智能` `AI应用` `AI 应用` `大模型` `大数据应用` `大数据建设` `智能统计` `统计大脑` `统计数据共享` `统计信息化` `政务微信` `电子政务`

### 中等关联关键词（单独出现 → 中等关联；与强关联叠加 → 升级为强关联）
`数据共享` `数据质量` `数据安全` `数据采集` `数据上报` `联网直报` `直报平台` `电子台账` `企业电子台账` `统计调查` `统计调查项目` `统计标准` `统计方法` `统计制度` `信息系统` `信息建设` `网络安全` `等保` `密码应用` `政务公开` `政务服务平台` `移动办公` `掌上办公`

### 弱关联关键词（单独出现 → 弱关联，不输出）
`互联网` `网上` `线上` `在线`

### 排除关键词（命中即丢弃，即便正文有强关键词）
`经济数据发布` `GDP` `CPI` `PPI` `PMI` `工业增加值` `人事任免` `任免` `招聘` `拟任职` `公示` `党建` `纪检` `巡察` `主题教育` `党史学习教育` `会议通知` `会议纪要` `会务`

### 关联度判定规则
- **强关联**：标题命中强关键词；或正文命中 ≥2 个强关键词；或强关联+中等关联关键词叠加。
- **中等关联**：正文命中 1 个强关键词；或命中中等关键词。
- **弱关联**：仅命中弱关键词 → **不输出**。
- **无关联**：无关键词命中 → **不输出**。

## AI 执行流程

### 步骤 1：计算时间窗口
- `cutoff_date = today - (days_back - 1)` 天
- 保留 `[cutoff_date, today]` 范围内的文章

### 步骤 2：逐站点抓取列表页
对 `{{inputs.sites}}` 指定的站点（留空则全部 23 个），按站点清单依次执行：

1. 用 `WebFetch` 访问栏目列表页 URL
2. 从返回的 HTML 中提取列表项（参照"列表选择器"提示）
3. 对每个列表项提取：标题（优先 `<a>` 的 title 属性，回退到文本）、链接（相对 URL 需拼接成绝对 URL）、日期（参照"日期选择器"或正则匹配 `\d{4}-\d{2}-\d{2}`）
4. 过滤附件 URL（铁律 2）
5. 过滤非白名单域名的链接（铁律 3）
6. 过滤早于 cutoff_date 的文章
7. 翻页：按分页规则访问下一页，直到本页所有文章都早于 cutoff_date

**JSON API 站点（浙江/福建）特殊处理**：
- 浙江：WebFetch 时需带请求头 `X-Requested-With: XMLHttpRequest`，响应是 JSON，取 `data.html` 字段（HTML 片段）解析
- 福建：需 POST 请求，body 含 channelid/classsql/page 等参数，响应 JSON 的 `data` 数组直接含标题/URL/日期字段

### 步骤 3：抓取详情页
对步骤 2 筛出的每篇合规文章：

1. 用 `WebFetch` 访问详情页 URL
2. 参照"详情选择器"提取：标题、发布日期、正文
3. 日期提取优先级：详情页日期选择器 → meta 标签（pubdate/publishdate/article:published_time 等）→ 列表页日期
4. 正文清洗：移除 script/style/分享/责任编辑；移除含"索引号/主题分类/发布机构"等关键词的元数据 table（文本 < 200 字且含元数据关键词）
5. 正文截断：超过 8000 字截断

### 步骤 4：关键词匹配与关联度判定
- 对标题+正文执行关键词匹配（参照上文关键词清单）
- 命中排除关键词 → 丢弃
- 按关联度判定规则确定强关联/中等关联/弱关联/无关联
- 仅保留强关联和中等关联

### 步骤 5：生成摘要
- 取正文第一句完整句子（按 `。！？；\n` 分句）
- 逐句拼接，总长 ≤ 200 字
- 超过 200 字截断并加 `…`

### 步骤 6：公众号文章补充
- 用 `WebSearch` 检索 `{单位名} 统计局 信息化` 等关键词
- 从搜索结果中提取 `mp.weixin.qq.com/s` 链接
- 用 `WebFetch` 抓取公众号文章（标题 `#activity-name`，正文 `#js_content`，日期 `#post-date`）
- 按步骤 4-5 处理

### 步骤 7：汇总输出
- 全局去重（按 link 去重）
- 排序：关联度优先（强关联在前），同关联度内按发布时间倒序
- 按"输出格式要求"输出 txt + JSON

### 步骤 8：一键直接生成 HTML 参阅报表（必须自动完成）
- 完成 txt 与 JSON 采集输出后，**直接自动生成同名的 HTML 参阅报表**（文件名为 `xxx.html`，如 `国家统计局周报_20260806.html`）。
- **绝对禁止中途挂起停下来询问用户“是否需要生成 HTML 报表”**，必须一次性连贯输出 txt、JSON 及可视化 HTML 报表。

## 输出格式要求

每条数据固定 7 个字段：
1. `title` — 文章标题
2. `organization` — 单位全称
3. `publish_time` — 发布时间（yyyy-mm-dd 格式）
4. `summary` — 200 字以内内容总结
5. `keyword` — 命中的核心关键词（逗号分隔）
6. `relevance` — 关联度（强关联 / 中等关联）
7. `link` — 原文链接

### 输出 1：txt 文本格式
先输出文本块，单条内容分行展示，每条用 `---` 分隔。格式示例：

```
标题：xxx
单位：xxx
时间：xxxx-xx-xx
总结：xxx
关键词：xxx
关联度：强关联
链接：xxx
---
```

### 输出 2：JSON 代码版
紧接 txt 后，输出纯净的 JSON 数组，无注释、无多余文字。字段名固定为：
- `title`
- `organization`
- `publish_time`
- `summary`
- `keyword`
- `relevance`
- `link`

```json
[
  {
    "title": "...",
    "organization": "...",
    "publish_time": "...",
    "summary": "...",
    "keyword": "...",
    "relevance": "...",
    "link": "..."
  }
]
```

### 输出 3：HTML 交互报表产物（必须直接生成）
直接在输出目录生成对应的 `.html` 文件，并在对话末尾给出指向该 HTML 的 `[打开输出目录](file://...)` Markdown 链接。

若无可匹配数据，txt 输出 "本次采集周期内无匹配文章。"，JSON 输出空数组 `[]`。
**绝对禁止编造虚假内容。**

## 公众号检索关键词
用于在搜索引擎中检索统计局官方公众号文章：
- `统计局 信息化`
- `统计局 数字化`
- `统计局 智慧统计`
- `统计局 大数据`
- `统计局 AI 应用`

## 参考实现
`baseline_collector.py` 是本 skill 的 Python 基线参考实现，包含：
- 23 站点 59 栏目的完整配置（`_build_default_sites()` 函数）
- 三种列表抓取策略（static / json_api / regex）
- 三种分页模式（index_n / index_n2 / page_param）
- 附件过滤 + 域名白名单双重防护
- 关键词三级关联度打分
- TXT + JSON 双格式输出

AI 执行本 skill 时应参照该文件的站点配置与选择器，但**使用 WebFetch/浏览器工具抓取，不运行该脚本**。
