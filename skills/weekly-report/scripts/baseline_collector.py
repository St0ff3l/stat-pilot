#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
统计信息化动态采集器 - Baseline 参考实现（大合集）
====================================================

本脚本是「统计信息化动态采集器」技能的 Python 版回退基线。
当技能在新型态站点上无法直接用浏览器工具抓取时，可参考/复用本脚本
的架构与代码片段，快速拼装出可运行的采集器。

设计参考：
- /Users/stoffel/CodeFile/sz-statistics-news-collector 下的 Java 爬虫代码
  （AbstractListSpiderService / WebsiteSpiderFactory / 各站点 List/Detail
  Spider / WeixinDetailSpider / AbstractAttachmentExtractor）
- 技能 SKILL.md 中规定的 19 个统计局清单、采集铁律、双格式输出要求

整体架构（自顶向下）：
    CLI (argparse)
      └── CollectorOrchestrator
            ├── SiteConfigRegistry         # 19 个站点元数据
            ├── HttpClient                 # SSL 信任、重试、编码探测、UA 池
            ├── ListFetcherFactory         # 静态 HTML / JSON API / 正则 三策略
            ├── DetailExtractorFactory     # 通用 + 站点覆盖
            ├── WeixinDetailExtractor      # 微信公众号特殊处理
            ├── KeywordMatcher             # 关键词命中 + 关联度打分
            ├── SummaryGenerator           # 200 字内摘要
            └── OutputFormatter            # TXT + JSON 双格式

依赖：
    pip install requests beautifulsoup4 lxml

用法：
    python baseline_collector.py                       # 默认采集最近 7 天，输出到 ./output
    python baseline_collector.py --days-back 14        # 自定义窗口
    python baseline_collector.py --sites stats_gd,stats_zj   # 仅指定站点
    python baseline_collector.py --include-wechat      # 同时抓公众号（需提供检索词）
    python baseline_collector.py --concurrency 4       # 4 线程并发
    python baseline_collector.py --output-dir ./out --stdout  # 同时落盘与打印

铁律（与 SKILL.md 一致）：
    1) 仅采集"工作动态"等列表栏目，严禁下载任何附件（PDF/Word/Excel/RAR）
    2) 必须同时覆盖官网 + 官方微信公众号
    3) 时间窗口严格 = today - days_back ~ today（含当天）
    4) 弱相关内容（经济数据发布、会议通知、党建、人事）直接排除
    5) 关联度：强关联 / 中等关联；弱关联不输出
    6) 严禁编造内容
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import random
import re
import ssl
import sys
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass, field, replace
from datetime import date, datetime, timedelta
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

try:
    import requests
    from bs4 import BeautifulSoup, Tag
except ImportError as exc:  # pragma: no cover
    sys.stderr.write(
        "[baseline_collector] 缺少依赖：requests / beautifulsoup4。\n"
        "请执行：pip install requests beautifulsoup4 lxml\n"
    )
    raise


# ============================================================================
# 1. 常量：核心关键词、关联度分级、UA 池、超时
# ============================================================================

# 强关联关键词：标题或正文出现 → 直接判为强关联（除非被排除规则命中）
STRONG_KEYWORDS: Tuple[str, ...] = (
    "信息化", "数字化", "数字统计", "智慧统计", "统计平台", "统计数据平台",
    "业务系统", "业务系统升级", "统计现代化改革", "统计云", "云平台",
    "数据中台", "数据治理", "一网通办", "人工智能", "AI应用", "AI 应用",
    "大模型", "大数据应用", "大数据建设", "智能统计", "统计大脑",
    "统计数据共享", "统计信息化", "政务微信", "电子政务",
)

# 中等关联关键词：单独出现 → 中等关联；与强关联关键词叠加 → 升级为强关联
MEDIUM_KEYWORDS: Tuple[str, ...] = (
    "数据共享", "数据质量", "数据安全", "数据采集", "数据上报",
    "联网直报", "直报平台", "电子台账", "企业电子台账", "统计调查",
    "统计调查项目", "统计标准", "统计方法", "统计制度",
    "信息系统", "信息建设", "网络安全", "等保", "密码应用",
    "政务公开", "政务服务平台", "移动办公", "掌上办公",
)

# 弱关联关键词：单独出现 → 弱关联，不输出
WEAK_KEYWORDS: Tuple[str, ...] = (
    "互联网", "网上", "线上", "在线",
)

# 排除关键词：命中即丢弃（即便正文里有强关键词）
EXCLUDE_PATTERNS: Tuple[str, ...] = (
    "经济数据发布", "GDP", "CPI", "PPI", "PMI", "工业增加值",
    "人事任免", "任免", "招聘", "拟任职", "公示",
    "党建", "纪检", "巡察", "主题教育", "党史学习教育",
    "会议通知", "会议纪要", "会务",
)

# 公众号检索关键词（用于在搜索引擎中检索统计局官方公众号文章）
WECHAT_SEARCH_KEYWORDS: Tuple[str, ...] = (
    "统计局 信息化", "统计局 数字化", "统计局 智慧统计",
    "统计局 大数据", "统计局 AI 应用",
)

# 随机 UA 池（与 Java 端 Jsoup.connect().userAgent() 风格一致）
USER_AGENT_POOL: Tuple[str, ...] = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
)

DEFAULT_TIMEOUT = 30  # 秒
DEFAULT_RETRY = 3
DEFAULT_DELAY_MS = 800  # 站点间最小间隔
DETAIL_DELAY_MS = 600   # 详情页间最小间隔
MAX_PAGES_DEFAULT = 30  # 单栏目最多翻页


# ============================================================================
# 2. 数据结构
# ============================================================================

@dataclass
class ArticleListItem:
    """列表页条目（与 Java 端 ArticleListItem 对应）。"""
    title: str = ""
    source_url: str = ""
    publish_date: Optional[datetime] = None
    category: str = ""
    source_department: str = ""
    cover_image_url: Optional[str] = None


@dataclass
class ArticleRecord:
    """最终输出记录（与技能输出 7 字段对应）。"""
    title: str
    organization: str
    publish_time: str  # yyyy-mm-dd
    summary: str
    keyword: str
    relevance: str  # 强关联 / 中等关联
    link: str


@dataclass
class SiteConfig:
    """单站点采集配置。

    list_strategy:
        'static'   - 静态 HTML，用 BeautifulSoup 解析（默认）
        'json_api' - 列表由 JSON 接口返回 HTML 片段（如浙江）
        'regex'    - 用正则直接抽 li>a+span（如上海，兜底）

    pagination:
        'index_n'   - index.html / index_1.html / index_2.html ...（国家统计局、北京）
        'index_n2'  - index.html / index_2.html / index_3.html ...（上海）
        'page_param'- ?page=N
        'none'      - 单页列表
    """
    site_id: str           # 唯一标识，如 stats_gd
    organization: str      # 单位全称
    list_url: str          # 列表入口
    category: str          # 栏目名（如 "工作动态"）
    list_strategy: str = "static"
    pagination: str = "index_n"
    max_pages: int = MAX_PAGES_DEFAULT
    # 静态策略：CSS 选择器（按优先级回退）
    list_item_selectors: Tuple[str, ...] = (
        "ul.list-content li",
        "ul.list li",
        "ul.news-list li",
        "ul li",
    )
    list_link_selector: str = "a"
    list_title_attr: str = "title"  # 优先取该属性，回退到 text()
    list_date_selector: str = "span"
    # 详情页正文选择器
    detail_content_selectors: Tuple[str, ...] = (
        ".center_xilan_con", ".trs_editor_view", ".detail-text-content",
        ".article_content", ".article-content", ".article-content-text",
        ".content", ".TRS_Editor", ".xlcontent", "#UCAP-CONTENT",
        "#js_content", ".rich_media_content",
    )
    detail_title_selectors: Tuple[str, ...] = (
        ".article_title", ".article-title", ".title",
        "h1[class*=title]", "h1", "#activity-name", ".rich_media_title",
    )
    detail_date_selectors: Tuple[str, ...] = (
        ".center_xilan_info", ".article_info", ".article-info", ".info",
        ".pubtime", ".publish-time", ".release-date", ".sj",
        "#post-date", ".rich_media_meta_list .rich_media_meta_item",
    )
    # 站点域名白名单（详情 URL 必须命中其一，防跨站）
    domain_whitelist: Tuple[str, ...] = ()
    # 额外请求头
    extra_headers: Dict[str, str] = field(default_factory=dict)
    # 是否需要 SSL 降级（http 替代 https）
    ssl_downgrade: bool = False
    # 编码覆盖（None = 自动探测）
    encoding_override: Optional[str] = None
    # 列表页响应是否为 JSON（仅 json_api 策略使用）
    api_json_path: str = "data.html"  # 点分路径
    api_base_uri: Optional[str] = None  # 解析 HTML 片段时的 base URI
    # JSON API 策略额外查询参数（如浙江的 webId/pageId 等）
    extra_query: Optional[Dict[str, Any]] = None
    # JSON API 请求方法：GET（默认）或 POST（如福建）
    api_method: str = "GET"
    # POST body（仅 api_method=POST 时使用）
    api_post_data: Optional[Dict[str, str]] = None
    # JSON item 字段映射（直接从 JSON 数组构造 ArticleListItem，
    # 不走 HTML 片段解析；与 api_json_path 互斥）
    # 例如: {"title": "doctitle", "url": "docpuburl", "date": "docreltime"}
    api_item_fields: Optional[Dict[str, str]] = None
    # JSON 分页总页数字段（点分路径，如 "pageCount"）
    api_page_count_path: Optional[str] = None
    # page_param 分页模式下的查询参数名（默认 pageNo，福建用 page）
    page_param_name: str = "pageNo"
    # index_n / index_n2 分页模式下的首页文件名（默认 index.html，厦门用 index.htm）
    index_file: str = "index.html"
    # 正则策略：抓 li>a+span 的正则（必须有 3 个捕获组：href, title, date）
    regex_pattern: Optional[str] = None
    # 公众号配置
    wechat_account: Optional[str] = None  # 官方公众号名称（用于检索）
    # 额外动态栏目（SKILL.md 铁律 1 允许采集"工作动态/动态要闻/新闻中心/政务公开-工作动态"4 类栏目）
    # 每项是 2 元组或 3 元组：
    # - 2 元组 (list_url, category_name)：与主 list_url 共用 list_item_selectors / extra_query 等其他配置（适用静态 HTML 站点）
    # - 3 元组 (list_url, category_name, override_dict)：第 3 项是 dict，支持任意 SiteConfig 字段覆盖：
    #     * 若 key 是 SiteConfig 字段名（如 list_strategy / pagination / page_param_name）→ 直接 replace
    #     * 若 key 是 "extra_query" → 与原 extra_query 合并（值需为 dict）
    #     * 若 key 是 "api_post_data" → 与原 api_post_data 合并（值需为 dict）
    #     * 其他 key（如 pageId / webId / channelid）→ 视为 extra_query 的子项合并（兼容浙江用法）
    #   用途：浙江用 {"pageId": "1562009"} 切换 JSON API 不同栏目；福建用 {"list_strategy": "static"} 从 JSON API 切回静态 HTML
    # 用于覆盖站点的"通知公告 / 新闻发布会 / 各地要闻 / 图片新闻 / 文件通知"等同类动态栏目
    extra_categories: List[Tuple] = field(default_factory=list)
    # 证据来源（按 spider-development skill 的证据标准要求记录）
    # 格式: "list_url 验证来源 | detail_url 验证来源 | 勘探日期"
    evidence: Optional[str] = None


@dataclass
class SyncResult:
    """单站点同步统计（与 Java SyncResult 对应）。"""
    total_new: int = 0
    total_updated: int = 0
    total_skipped: int = 0
    total_failed: int = 0
    total_detail_fetched: int = 0

    def merge(self, other: "SyncResult") -> None:
        self.total_new += other.total_new
        self.total_updated += other.total_updated
        self.total_skipped += other.total_skipped
        self.total_failed += other.total_failed
        self.total_detail_fetched += other.total_detail_fetched

    def __str__(self) -> str:
        return (
            f"新增 {self.total_new} 条 | 更新 {self.total_updated} 条 | "
            f"跳过 {self.total_skipped} 条 | 失败 {self.total_failed} 条 | "
            f"详情抓取 {self.total_detail_fetched} 次"
        )


# ============================================================================
# 3. 站点配置注册表：覆盖技能要求的全部 19 个站点
# ============================================================================

def _build_default_sites() -> List[SiteConfig]:
    """构造 19 个站点配置。

    部分站点（如国家统计局）URL 与选择器来自 sz-statistics-news-collector
    的 Java 实现，以保证 baseline 与生产端行为一致。
    """
    sites: List[SiteConfig] = []

    # ==================== 国家级 ====================
    # 证据：list 来自 Java StatsGovListSpider 实现；详情页选择器来自 Java
    # StatsGovDetailSpider；SSL 降级对齐 Java 端 trustAllHttpsCertificates。
    sites.append(SiteConfig(
        site_id="stats_national",
        organization="国家统计局",
        list_url="https://www.stats.gov.cn/xw/tjxw/tjdt/",
        category="统计动态",
        pagination="index_n",
        list_item_selectors=(".list-content ul li",),
        list_link_selector="a.fl",
        list_date_selector="span",
        domain_whitelist=("stats.gov.cn",),
        ssl_downgrade=True,
        detail_title_selectors=(".article_title", ".title", "h1"),
        detail_date_selectors=(".center_xilan_info", ".article_info", ".info"),
        detail_content_selectors=(
            ".center_xilan_con", ".trs_editor_view", ".detail-text-content",
            ".article_content", ".TRS_Editor",
        ),
        extra_categories=[
            # 通知公告 - SKILL.md 铁律 1 允许的"政务公开-工作动态"类栏目
            # 证据：国家统计局首页导航 [ 通知公告 ](https://www.stats.gov.cn/xw/tjxw/tzgg/)
            ("https://www.stats.gov.cn/xw/tjxw/tzgg/", "通知公告"),
        ],
        evidence="list: Java StatsGovListSpider | detail: Java StatsGovDetailSpider | extra_categories: 首页导航验证 | 2026-07-17",
    ))

    # ==================== 省级（9 个）====================
    # 1. 广东 - 证据：Java GdStatisticsListSpider + GdStatisticsDetailSpider
    sites.append(SiteConfig(
        site_id="stats_gd",
        organization="广东省统计局",
        list_url="http://stats.gd.gov.cn/gzys/",
        category="省局要事",
        pagination="index_n",
        list_item_selectors=(
            ".overview-news-list .news-item",
            ".center_list_con ul li",
            ".list-main-content ul li",
        ),
        list_link_selector="a.news-link, a",
        list_date_selector=".news-date, span",
        domain_whitelist=("stats.gd.gov.cn", "stats.gov.cn"),
        extra_headers={"Referer": "http://stats.gd.gov.cn/"},
        detail_title_selectors=(".article-title", ".title", "h1"),
        detail_date_selectors=(".article-info", ".info", ".pubtime"),
        detail_content_selectors=(
            ".article-content-text", ".article_content", ".TRS_Editor",
            ".center_xilan_con", ".trs_editor_view",
        ),
        extra_categories=[
            # 各地要事 - 各地市统计局动态（动态要闻类）
            # 证据：广东首页导航 [ 各地要事 ](http://stats.gd.gov.cn/gdys/index.html)
            ("http://stats.gd.gov.cn/gdys/", "各地要事"),
            # 通知公告 - 政务公开类，常含统计信息化项目采购、系统建设通知
            # 证据：广东首页导航 [ 通知公告 ](http://stats.gd.gov.cn/ggl217/index.html)
            ("http://stats.gd.gov.cn/ggl217/", "通知公告"),
            # 图片新闻 - 新闻中心类
            # 证据：广东首页导航 [ 省局举办第一期全省乡镇（街道）统计人员培训示范班 ](http://stats.gd.gov.cn/tpxw1508/content/post_4916602.html)
            ("http://stats.gd.gov.cn/tpxw1508/", "图片新闻"),
        ],
        evidence="list: Java GdStatisticsListSpider | detail: Java GdStatisticsDetailSpider | extra_categories: 首页导航验证 | 2026-07-17",
    ))

    # 2. 浙江 - 证据：Java ZjStatisticsListSpider（JSON API + extra_query）
    #    详情页选择器来自浙江站点通用模板（浙江政务统一 CMS）
    sites.append(SiteConfig(
        site_id="stats_zj",
        organization="浙江省统计局",
        list_url="https://tjj.zj.gov.cn/api-gateway/jpaas-publish-server/front/page/build/unit",
        category="统计要闻",
        list_strategy="json_api",
        pagination="page_param",
        list_item_selectors=("ul.ImporF_bd-ul li",),
        list_link_selector="a",
        list_date_selector="span",
        domain_whitelist=("tjj.zj.gov.cn",),
        api_json_path="data.html",
        api_base_uri="https://tjj.zj.gov.cn",
        extra_query={
            "webId": "3077",
            "pageId": "1562308",
            "pageType": "column",
            "tagId": "当前栏目_list",
            "tplSetId": "XY4xf9Yl4IKd7uKwPD0zP",
            "parseType": "bulidstatic",
        },
        extra_headers={
            "X-Requested-With": "XMLHttpRequest",
            "Accept": "application/json, text/javascript, */*",
        },
        detail_title_selectors=(".article-title", ".title", "h1", "#title"),
        detail_date_selectors=(".article-info", ".info", ".pubtime"),
        # 浙江政务统一 CMS 正文容器：div.main_section（在 div.ImporFull 内部，
        # 元数据表之后）。不能用 div.ImporFull，否则会抓进索引号/主题分类等元数据。
        # 证据：WebFetch 详情样本，正文「7月8日至9日...」的直接父链 span>p>div.main_section>div.ImporFull
        detail_content_selectors=(
            "div.main_section",
            ".TRS_Editor", ".trs_editor_view", ".article-content",
            "#zoom", ".content",
        ),
        extra_categories=[
            # 统计快讯 - 动态要闻类
            # 证据：浙江首页 [统计快讯](http://tjj.zj.gov.cn/col/col1562009/index.html)
            # pageId 推断：浙江主栏目 col1562308 → pageId=1562308，按同号规律 col1562009 → pageId=1562009
            (
                "https://tjj.zj.gov.cn/api-gateway/jpaas-publish-server/front/page/build/unit",
                "统计快讯",
                {"pageId": "1562009"},
            ),
            # 文件通知 - 政务公开-工作动态类
            # 证据：浙江首页 [文件通知](http://tjj.zj.gov.cn/col/col1525494/wjtzx/index.html)
            # pageId 推断：col1525494 → pageId=1525494
            (
                "https://tjj.zj.gov.cn/api-gateway/jpaas-publish-server/front/page/build/unit",
                "文件通知",
                {"pageId": "1525494"},
            ),
        ],
        evidence="list: Java ZjStatisticsListSpider | detail: 浙江政务统一 CMS 通用模板 | extra_categories: 首页导航验证 + pageId 按 col 同号规律推断（待实际调用验证） | 2026-07-17",
    ))

    # 3. 江苏 - 证据：WebSearch 验证 col87243=统计要闻 + WebFetch 详情样本
    #    详情样本: /art/2026/2/7/art_87623_11729386.html
    #    标题在页面顶部 H1；日期紧跟在标题后（"2026-02-07 14:38  来源：办公室"）
    #    正文在 .TRS_Editor / #zoom
    sites.append(SiteConfig(
        site_id="stats_js",
        organization="江苏省统计局",
        list_url="https://tj.jiangsu.gov.cn/col/col87243/index.html",
        category="统计要闻",
        pagination="index_n",
        list_item_selectors=(
            ".news_list li", ".list-content ul li",
            "ul.news_list li", "ul li",
        ),
        list_link_selector="a",
        list_date_selector="span",
        domain_whitelist=("tj.jiangsu.gov.cn",),
        detail_title_selectors=("h1", ".article-title", ".title"),
        detail_date_selectors=(".pubtime", ".info", ".article-info"),
        # 江苏政务 CMS 正文容器：#bt-box-zoom（div.bt-box-main-txt.zoom#bt-box-zoom）
        # 证据：WebFetch 详情样本 /art/2026/7/2/art_85269_11799738.html
        # 正文「7月...」的直接父链 span>p>div#bt-box-zoom>div.bt-box-content-main
        detail_content_selectors=(
            "#bt-box-zoom", ".bt-box-main-txt",
            ".TRS_Editor", ".trs_editor_view", "#zoom",
            ".article-content", ".content",
        ),
        extra_categories=[
            # 统计要闻 - 首页"更多>"验证的另一个省局动态栏目（与主栏目 col87243 互补）
            # 证据：江苏首页 [更多>](http://tj.jiangsu.gov.cn/col/col85270/index.html)
            ("http://tj.jiangsu.gov.cn/col/col85270/index.html", "统计要闻"),
            # 通知公告 - 政务公开类
            # 证据：江苏首页 [更多>](http://tj.jiangsu.gov.cn/col/col85271/index.html)
            ("http://tj.jiangsu.gov.cn/col/col85271/index.html", "通知公告"),
        ],
        evidence="list: WebSearch col87243 | detail: /art/2026/2/7/art_87623_11729386.html | extra_categories: 首页导航验证 | 2026-07-17",
    ))

    # 4. 山东 - 证据：WebSearch 验证 col156115=省级动态 + WebFetch 详情样本
    #    详情样本: /art/2024/11/29/art_6187_10315251.html
    #    标题在 H1；日期: "发布日期：2024-11-29 18:09:25"
    #    正文在 .content / .TRS_Editor
    sites.append(SiteConfig(
        site_id="stats_sd",
        organization="山东省统计局",
        list_url="http://tjj.shandong.gov.cn/col/col156115/index.html",
        category="省级动态",
        pagination="index_n",
        list_item_selectors=(
            ".news_list li", ".list-content ul li",
            "ul.news_list li", "ul li",
        ),
        list_link_selector="a",
        list_date_selector="span",
        domain_whitelist=("tjj.shandong.gov.cn",),
        detail_title_selectors=("h1", ".article-title", ".title"),
        detail_date_selectors=(".info", ".pubtime", ".article-info"),
        # 山东政务 CMS 正文容器：#zoom（但 #zoom 内含元数据 <table>，依赖
        # extract_content 的元数据表清理逻辑移除索引号/主题分类等）
        # 证据：WebFetch 详情样本 /art/2021/11/11/art_104028_10291742.html
        # 正文 div 是 #zoom 的第 2 个 div 子节点，元数据 table 在兄弟 div 内
        detail_content_selectors=(
            "#zoom",
            ".TRS_Editor", ".trs_editor_view", ".content",
            ".article-content",
        ),
        extra_categories=[
            # 省局动态 - 首页"更多》"验证的省局自身动态栏目
            # 证据：山东首页 [省局动态[更多》]](http://tjj.shandong.gov.cn/col/col6187/index.html)
            ("http://tjj.shandong.gov.cn/col/col6187/index.html", "省局动态"),
            # 通知公告 - 政务公开类
            # 证据：山东首页 [通知公告[更多》]](http://tjj.shandong.gov.cn/col/col6174/index.html)
            ("http://tjj.shandong.gov.cn/col/col6174/index.html", "通知公告"),
        ],
        evidence="list: WebSearch col156115 | detail: /art/2024/11/29/art_6187_10315251.html | extra_categories: 首页导航验证 | 2026-07-17",
    ))

    # 5. 四川 - 证据：WebSearch 验证 c112153=统计动态 + WebFetch 详情样本
    #    详情样本: /scstjj/c112153/2025/9/24/f274f4ab208948bab6bbba8930af522a.shtml
    #    标题在 H1；日期: "日期：2025-09-24 17:15"
    #    正文在 .content / .TRS_Editor
    sites.append(SiteConfig(
        site_id="stats_sc",
        organization="四川省统计局",
        list_url="http://tjj.sc.gov.cn/scstjj/c112153/list.shtml",
        category="统计动态",
        # 四川分页：list.shtml / list_2.shtml / list_3.shtml（跳过 list_1.shtml）
        # 证据：WebFetch list_1.shtml → 404，list_2.shtml → 200，属 index_n2 模式
        pagination="index_n2",
        list_item_selectors=(
            ".news_list li", ".right_list li", ".list-content ul li",
            "ul.news_list li", "ul li",
        ),
        list_link_selector="a",
        list_date_selector="span",
        domain_whitelist=("tjj.sc.gov.cn",),
        detail_title_selectors=("h1", ".article-title", ".title"),
        detail_date_selectors=(".info", ".pubtime", ".article-info"),
        # 四川政务 CMS 正文容器：#zoomcon（div.article-content#zoomcon）
        # 证据：WebFetch 详情样本 /scstjj/c112117/2026/7/16/756e2b8ba9824cd6bbe61de2a5659524.shtml
        # 正文直接父是 div.article-content#zoomcon
        detail_content_selectors=(
            "#zoomcon", ".article-content",
            ".TRS_Editor", ".trs_editor_view", ".content", "#zoom",
        ),
        extra_categories=[
            # 通知公告 - 政务公开类，URL 是 common_list.shtml（分页可能不同，待验证）
            # 证据：四川首页导航 [ 通知公告 ](http://tjj.sc.gov.cn/scstjj/c105843/common_list.shtml)
            ("http://tjj.sc.gov.cn/scstjj/c105843/common_list.shtml", "通知公告"),
            # 新闻发布会 - 新闻中心类
            # 证据：四川首页导航 [ 新闻发布会 ](http://tjj.sc.gov.cn/scstjj/c112119/xwfbh.shtml)
            ("http://tjj.sc.gov.cn/scstjj/c112119/xwfbh.shtml", "新闻发布会"),
        ],
        evidence="list: WebSearch c112153 | detail: /scstjj/c112153/2025/9/24/f274f4ab208948bab6bbba8930af522a.shtml | extra_categories: 首页导航验证 | 2026-07-17",
    ))

    # 6. 北京 - 证据：Java BjStatisticsListSpider 实现
    #    list: ul[class*=list] li / span.date
    #    detail: 北京政务统一 CMS（.article_title / .article_info / .TRS_Editor）
    sites.append(SiteConfig(
        site_id="stats_bj",
        organization="北京市统计局",
        list_url="https://tjj.beijing.gov.cn/zwgkai/gzdt/",
        category="工作动态",
        pagination="index_n",
        list_item_selectors=("ul[class*=list] li",),
        list_link_selector="a",
        list_date_selector="span.date",
        domain_whitelist=("tjj.beijing.gov.cn",),
        ssl_downgrade=False,
        detail_title_selectors=(".article_title", ".title", "h1"),
        detail_date_selectors=(".article_info", ".info", ".pubtime"),
        detail_content_selectors=(
            ".TRS_Editor", ".trs_editor_view", ".article_content",
            ".center_xilan_con",
        ),
        extra_categories=[
            # 通知公告 - 政务公开类，常含统计信息化项目采购、系统建设通知
            # 证据：北京首页 [通知公告](https://tjj.beijing.gov.cn/zwgkai/tzgg/)
            ("https://tjj.beijing.gov.cn/zwgkai/tzgg/", "通知公告"),
            # 要闻动态 - 新闻中心类
            # 证据：北京首页 [要闻动态](https://tjj.beijing.gov.cn/zwgkai/ywdt/)
            ("https://tjj.beijing.gov.cn/zwgkai/ywdt/", "要闻动态"),
        ],
        evidence="list: Java BjStatisticsListSpider | detail: 北京政务统一 CMS | extra_categories: 首页导航验证 | 2026-07-17",
    ))

    # 7. 上海 - 证据：Java ShStatisticsListSpider（正则策略 + index_n2 分页）
    #    详情页选择器来自上海政务统一 CMS
    sites.append(SiteConfig(
        site_id="stats_sh",
        organization="上海市统计局",
        list_url="https://tjj.sh.gov.cn/tjxw/",
        category="统计要闻",
        list_strategy="regex",
        pagination="index_n2",
        regex_pattern=(
            r'<li>\s*<a href="([^"]+)"[^>]*>([^<]+)</a>\s*'
            r'<span class="time">([^<]+)</span>\s*</li>'
        ),
        domain_whitelist=("tjj.sh.gov.cn",),
        detail_title_selectors=(".article-title", ".title", "h1", "#title"),
        detail_date_selectors=(".article-info", ".info", ".pubtime"),
        detail_content_selectors=(
            ".TRS_Editor", ".trs_editor_view", ".article-content",
            "#zoom", ".content",
        ),
        extra_categories=[
            # 通知告示 - 政务公开类
            # 证据：WebFetch https://tjj.sh.gov.cn/tzgs/ 验证列表结构
            # 注意：通知告示栏目 HTML 是 `<li><a>标题</a>日期</li>`（日期无 span 包裹），
            # 与主栏目 regex（要求 <span class="time">）不兼容，故用 3 元组切到 static 策略，
            # 日期走 parse_static_items 的 regex 兜底（re.search \d{4}-\d{2}-\d{2}）。
            # 详情样本: /tzgs/20260518/7632f9b6cb774e9bb3ea1810ef216d3d.html
            ("https://tjj.sh.gov.cn/tzgs/", "通知告示", {
                "list_strategy": "static",
                "pagination": "index_n2",
                "list_item_selectors": (
                    "ul li", ".news_list li", ".list-content ul li",
                ),
                "list_link_selector": "a",
                "list_date_selector": "span",
            }),
        ],
        evidence="list: Java ShStatisticsListSpider | detail: 上海政务统一 CMS | extra_categories: WebFetch /tzgs/ 验证（HTML 结构与主栏目不同，3 元组切 static） | 2026-07-17",
    ))

    # 8. 天津 - 证据：WebSearch 验证 /sy_51953/tjgzdt/ + WebFetch 详情样本
    #    详情样本: /sy_51953/tjgzdt/202602/t20260227_7251964.html
    #    标题在 H1；日期: "来源：天津市统计局 发布时间：2026-02-27 17:05"
    #    正文在通用 .TRS_Editor / .content
    sites.append(SiteConfig(
        site_id="stats_tj",
        organization="天津市统计局",
        list_url="https://stats.tj.gov.cn/sy_51953/tjgzdt/",
        category="统计工作动态",
        pagination="index_n",
        list_item_selectors=(
            ".news_list li", ".list-content ul li",
            "ul.news_list li", "ul li",
        ),
        list_link_selector="a",
        list_date_selector="span",
        domain_whitelist=("stats.tj.gov.cn",),
        ssl_downgrade=True,
        detail_title_selectors=("h1", ".article-title", ".title"),
        detail_date_selectors=(".info", ".pubtime", ".article-info"),
        detail_content_selectors=(
            ".TRS_Editor", ".trs_editor_view", ".content",
            ".article-content", "#zoom",
        ),
        extra_categories=[
            # 通知公告 - 政务公开类
            # 证据：天津首页 [通知公告](https://stats.tj.gov.cn/sy_51953/tzgg/)
            # 详情样本: /sy_51953/tzgg/202604/t20260407_7277095.html
            ("https://stats.tj.gov.cn/sy_51953/tzgg/", "通知公告"),
        ],
        evidence="list: WebSearch /sy_51953/tjgzdt/ | detail: /sy_51953/tjgzdt/202602/t20260227_7251964.html | extra_categories: 首页导航验证 | 2026-07-17",
    ))

    # 9. 重庆 - 证据：WebSearch 验证 /zwxx_233/bmdt/ + WebFetch 详情样本
    #    详情样本: /zwxx_233/bmdt/202208/t20220808_10984495.html
    #    标题在 H2（"## 市委第七巡视组..."）；日期: "日期： 2022-08-08"
    #    正文在 .content / .TRS_Editor
    sites.append(SiteConfig(
        site_id="stats_cq",
        organization="重庆市统计局",
        list_url="http://tjj.cq.gov.cn/zwxx_233/bmdt/",
        category="部门动态",
        pagination="index_n",
        list_item_selectors=(
            ".news_list li", ".list-content ul li",
            "ul.news_list li", "ul li",
        ),
        list_link_selector="a",
        list_date_selector="span",
        domain_whitelist=("tjj.cq.gov.cn",),
        detail_title_selectors=("h2", "h1", ".article-title", ".title"),
        detail_date_selectors=(".info", ".pubtime", ".article-info"),
        detail_content_selectors=(
            ".TRS_Editor", ".trs_editor_view", ".content",
            ".article-content", "#zoom",
        ),
        extra_categories=[
            # 通知公告 - 政务公开类，含互联网专线租赁、政务新媒体运营等信息化项目公告
            # 证据：重庆首页 [查看更多](http://tjj.cq.gov.cn/zwxx_233/tzgg/wap.html)
            # 详情样本: /zwxx_233/tzgg/202607/t20260701_15789233_wap.html
            ("http://tjj.cq.gov.cn/zwxx_233/tzgg/", "通知公告"),
        ],
        evidence="list: WebSearch /zwxx_233/bmdt/ | detail: /zwxx_233/bmdt/202208/t20220808_10984495.html | extra_categories: 首页导航验证 | 2026-07-17",
    ))

    # ==================== 副省级 / 重点城市（9 个）====================
    # 10. 广州 - 证据：WebSearch 验证 /zzfwzq/gzdt/ + WebFetch 详情样本
    #     详情样本: /zzfwzq/gzdt/content/post_10256560.html
    #     标题在 H3；日期: "发布时间：2025-05-09来源：本网"
    #     正文在 .TRS_Editor / .content / .zw
    sites.append(SiteConfig(
        site_id="stats_gz",
        organization="广州市统计局",
        list_url="http://tjj.gz.gov.cn/zzfwzq/gzdt/",
        category="工作动态",
        pagination="index_n",
        list_item_selectors=(
            ".news_list li", ".list-content ul li",
            "ul.news_list li", "ul li",
        ),
        list_link_selector="a",
        list_date_selector="span",
        domain_whitelist=("tjj.gz.gov.cn",),
        detail_title_selectors=("h3", "h1", ".article-title", ".title"),
        detail_date_selectors=(".info", ".pubtime", ".article-info"),
        # 广州政务 CMS 正文容器：#zoomcon（div.zw#zoomcon）
        # 证据：WebFetch 详情样本 /news_newtjdt/tpxw/content/post_10900909.html
        # 正文直接父是 div.zw#zoomcon
        detail_content_selectors=(
            "#zoomcon", ".zw",
            ".TRS_Editor", ".trs_editor_view", ".content",
            ".article-content", "#zoom",
        ),
        extra_categories=[
            # 通知公告 - 政务公开类，常含统计信息化项目采购、系统建设通知
            # 证据：广州首页 [通知公告](http://tjj.gz.gov.cn/open_newzwgk/tzgg/index.html)
            ("http://tjj.gz.gov.cn/open_newzwgk/tzgg/", "通知公告"),
            # 图片新闻 - 新闻中心类
            # 证据：广州首页 [图片新闻](http://tjj.gz.gov.cn/news_newtjdt/tpxw/) 路径含 tpxw
            ("http://tjj.gz.gov.cn/news_newtjdt/tpxw/", "图片新闻"),
        ],
        evidence="list: WebSearch /zzfwzq/gzdt/ | detail: /zzfwzq/gzdt/content/post_10256560.html | extra_categories: 首页导航验证 | 2026-07-17",
    ))

    # 11. 杭州 - 证据：WebSearch 验证 col1651400 + WebFetch 详情样本
    #     详情样本: /col/col1651400/art/2026/art_a92f0548905f429f9ed110de09dd7d24.html
    #     标题在 H2/H1；日期: "发布日期： 2026-02-28 10:04"
    #     正文在 .TRS_Editor / #zoom / .content
    sites.append(SiteConfig(
        site_id="stats_hz",
        organization="杭州市统计局",
        list_url="http://tjj.hangzhou.gov.cn/col/col1651400/index.html",
        category="工作动态",
        pagination="index_n",
        list_item_selectors=(
            ".news_list li", ".list-content ul li",
            "ul.news_list li", "ul li",
        ),
        list_link_selector="a",
        list_date_selector="span",
        domain_whitelist=("tjj.hangzhou.gov.cn",),
        detail_title_selectors=("h2", "h1", ".article-title", ".title"),
        detail_date_selectors=(".info", ".pubtime", ".article-info"),
        detail_content_selectors=(
            ".TRS_Editor", ".trs_editor_view", "#zoom",
            ".content", ".article-content",
        ),
        extra_categories=[
            # 区县动态 - 各区县统计局动态（动态要闻类）
            # 证据：杭州首页 [区县动态[更多>>]](https://tjj.hangzhou.gov.cn/col/col1652150/index.html)
            ("https://tjj.hangzhou.gov.cn/col/col1652150/index.html", "区县动态"),
            # 通知公告 - 政务公开类
            # 证据：杭州首页 [通知公告[更多>>]](https://tjj.hangzhou.gov.cn/col/col1651600/index.html)
            ("https://tjj.hangzhou.gov.cn/col/col1651600/index.html", "通知公告"),
        ],
        evidence="list: WebSearch col1651400 | detail: /col/col1651400/art/2026/art_a92f0548905f429f9ed110de09dd7d24.html | extra_categories: 首页导航验证 | 2026-07-17",
    ))

    # 12. 南京 - 证据：WebSearch 验证 /gzdt/ + WebFetch 详情样本
    #     详情样本: /gzdt/202507/t20250702_5598568.html
    #     标题在 H1（"缅怀革命先烈..."）；日期: "责任编辑：市统计局 发布时间：2025-07-02 10:23"
    #     正文在 .TRS_Editor / .content / .article-content
    sites.append(SiteConfig(
        site_id="stats_nj",
        organization="南京市统计局",
        list_url="https://tjj.nanjing.gov.cn/gzdt/",
        category="工作动态",
        pagination="index_n",
        list_item_selectors=(
            ".news_list li", ".list-content ul li",
            "ul.news_list li", "ul li",
        ),
        list_link_selector="a",
        list_date_selector="span",
        domain_whitelist=("tjj.nanjing.gov.cn",),
        detail_title_selectors=("h1", ".article-title", ".title"),
        detail_date_selectors=(".info", ".pubtime", ".article-info"),
        detail_content_selectors=(
            ".TRS_Editor", ".trs_editor_view", ".content",
            ".article-content", "#zoom",
        ),
        extra_categories=[
            # 通知公告 - 政务公开类，单页式入口（id=xxgk_228），HTML 在响应中直接渲染
            # 证据：南京首页 [通知公告[更多>>]](http://tjj.nanjing.gov.cn/njstjj/?id=xxgk_228)
            # 分页：待勘探（首页未见独立分页 URL，可能是单页式滚动加载）
            ("http://tjj.nanjing.gov.cn/njstjj/?id=xxgk_228", "通知公告"),
        ],
        evidence="list: WebSearch /gzdt/ | detail: /gzdt/202507/t20250702_5598568.html | extra_categories: 首页导航验证（分页待勘探）| 2026-07-17",
    ))

    # 13. 成都 - 证据：WebFetch 首页验证 cdstats.chengdu.gov.cn/cdstjj/c154737/list.shtml
    #     工作动态列表入口: /cdstjj/c154737/list.shtml
    #     详情样本: /cdstjj/c154737/2026-07/02/content_93fa3b2578df480b936526b678fd4fe6.shtml
    #     标题在 H1；日期: "2026.07.02"（列表项前缀）；正文在 .TRS_Editor / .content
    sites.append(SiteConfig(
        site_id="stats_cd",
        organization="成都市统计局",
        list_url="https://cdstats.chengdu.gov.cn/cdstjj/c154737/list.shtml",
        category="工作动态",
        # 成都分页：与四川同 CMS，按 list.shtml / list_2.shtml 规律用 index_n2
        # 证据：四川 list_2.shtml 验证为 200，成都同 CMS 推断同模式（成都 412 反爬无法直验）
        pagination="index_n2",
        list_item_selectors=(
            ".news_list li", ".list-content ul li",
            "ul.news_list li", "ul li",
        ),
        list_link_selector="a",
        list_date_selector="span",
        domain_whitelist=("cdstats.chengdu.gov.cn", "chengdu.gov.cn"),
        detail_title_selectors=("h1", "h2", ".article-title", ".title"),
        detail_date_selectors=(".info", ".pubtime", ".article-info"),
        detail_content_selectors=(
            ".TRS_Editor", ".trs_editor_view", ".content",
            ".article-content", "#zoom",
        ),
        extra_categories=[
            # 通知公告 - 政务公开类
            # 证据：成都首页 [通知公告[更多>>]](https://cdstats.chengdu.gov.cn/cdstjj/c154738/list.shtml)
            ("https://cdstats.chengdu.gov.cn/cdstjj/c154738/list.shtml", "通知公告"),
        ],
        evidence="list: WebFetch 首页 c154737/list.shtml | detail: /cdstjj/c154737/2026-07/02/content_93fa3b2578df480b936526b678fd4fe6.shtml | extra_categories: 首页导航验证 | 2026-07-17",
    ))

    # 14. 武汉 - 证据：WebSearch 验证 /xwzx/sjyw/ + WebFetch 详情样本
    #     详情样本: /xwzx/sjyw/202509/t20250925_2652497.shtml
    #     标题在 H2（"## 湖北省第十六届..."）；日期: "发布日期：2025-09-30 08:56:00"
    #     正文在 .TRS_Editor / .content / .article-content
    sites.append(SiteConfig(
        site_id="stats_wh",
        organization="武汉市统计局",
        list_url="https://tjj.wuhan.gov.cn/xwzx/sjyw/",
        category="统计要闻",
        pagination="index_n",
        # 武汉用 .shtml 而非 .html：index.shtml / index_1.shtml / index_2.shtml
        # 证据：WebFetch /xwzx/sjyw/index.html → 404，/xwzx/sjyw/index.shtml → 200
        index_file="index.shtml",
        list_item_selectors=(
            ".news-list-content li", ".news_list li", ".list-content ul li",
            "ul.news_list li", "ul li",
        ),
        list_link_selector="a",
        list_date_selector="span",
        domain_whitelist=("tjj.wuhan.gov.cn",),
        detail_title_selectors=("h2", "h1", ".article-title", ".title"),
        detail_date_selectors=(".info", ".pubtime", ".article-info"),
        # 武汉政务 CMS 正文容器：#content（div.inside_news_p#content）
        # 证据：WebFetch 详情样本 /xwzx/sjyw/202607/t20260702_2815989.shtml
        # 正文直接父是 div.trs_editor_view，其父是 div.inside_news_p#content
        # 不要用 #inside-content（含发布日期等元数据）
        detail_content_selectors=(
            "#content", ".inside_news_p",
            ".TRS_Editor", ".trs_editor_view", ".content",
            ".article-content", "#zoom",
        ),
        extra_categories=[
            # 区级动态 - 各区统计局动态（动态要闻类）
            # 证据：武汉首页 [区级动态](https://tjj.wuhan.gov.cn/xwzx/qjdt/) tab
            ("https://tjj.wuhan.gov.cn/xwzx/qjdt/", "区级动态"),
            # 通知公告 - 政务公开类
            # 证据：武汉首页 [通知公告](https://tjj.wuhan.gov.cn/xwzx/tzgg/) tab
            ("https://tjj.wuhan.gov.cn/xwzx/tzgg/", "通知公告"),
            # 图片新闻 - 新闻中心类
            # 证据：武汉首页 [图片新闻](https://tjj.wuhan.gov.cn/xwzx/tpxw/) tab
            ("https://tjj.wuhan.gov.cn/xwzx/tpxw/", "图片新闻"),
        ],
        evidence="list: WebSearch /xwzx/sjyw/ | detail: /xwzx/sjyw/202509/t20250925_2652497.shtml | extra_categories: 首页导航验证 | 2026-07-17",
    ))

    # 15. 青岛 - 证据：WebSearch 验证 qdtj.qingdao.gov.cn/tongjigz/tongjiju_tjyw/
    #     + WebFetch 详情样本: /tongjigz/tongjiju_tjyw/202506/t20250609_9638896.shtml
    #     标题在 H1（"青岛市召开2025年全市统计法治工作会议"）
    #     日期: "发布日期： 2025-06-06"
    #     正文在 .TRS_Editor / .content / .article-content
    #     extra_categories：WebSearch + WebFetch 验证 /tongjigz/tjj_tzgg/ 是独立通知公告栏目（24 页分页）
    sites.append(SiteConfig(
        site_id="stats_qd",
        organization="青岛市统计局",
        list_url="http://qdtj.qingdao.gov.cn/tongjigz/tongjiju_tjyw/",
        category="统计要闻",
        pagination="index_n",
        list_item_selectors=(
            ".news_list li", ".list-content ul li",
            "ul.news_list li", "ul li",
        ),
        list_link_selector="a",
        list_date_selector="span",
        domain_whitelist=("qdtj.qingdao.gov.cn", "qingdao.gov.cn"),
        detail_title_selectors=("h1", "h2", ".article-title", ".title"),
        detail_date_selectors=(".info", ".pubtime", ".article-info"),
        detail_content_selectors=(
            ".TRS_Editor", ".trs_editor_view", ".content",
            ".article-content", "#zoom",
        ),
        extra_categories=[
            # 通知公告 - 政务公开类（独立栏目，24 页分页，列表入口 /tongjigz/tjj_tzgg/）
            # 证据：WebFetch http://qdtj.qingdao.gov.cn/tongjigz/tjj_tzgg/ 返回列表页（10 条/页，含 2026/2025 年通知公告）
            # 样本: /tongjigz/tjj_tzgg/202604/t20260415_10563758.shtml（2026 年统计专业技术资格考试通知）
            ("http://qdtj.qingdao.gov.cn/tongjigz/tjj_tzgg/", "通知公告"),
        ],
        evidence="list: WebSearch qdtj.qingdao.gov.cn/tongjigz/tongjiju_tjyw/ | detail: /tongjigz/tongjiju_tjyw/202506/t20250609_9638896.shtml | extra_categories: WebFetch /tongjigz/tjj_tzgg/ 验证 | 2026-07-17",
    ))

    # 16. 厦门 - 证据：WebSearch 验证 /zwgk/gzdt/ + WebFetch 详情样本
    #     详情样本: /zwgk/gzdt/202512/t20251212_2971480.htm
    #     标题在 H1（"# 厦门市统计局召开劳动工资统计工作会"）
    #     日期: "发布时间： 2025-12-12 08:30"
    #     正文在 .TRS_Editor / .content / .article-content
    #     注意：厦门用 .htm 后缀，分页是 index_N.htm
    sites.append(SiteConfig(
        site_id="stats_xm",
        organization="厦门市统计局",
        list_url="https://tjj.xm.gov.cn/zwgk/gzdt/",
        category="统计工作",
        pagination="index_n",
        index_file="index.htm",
        list_item_selectors=(
            ".news_list li", ".list-content ul li",
            "ul.news_list li", "ul li",
        ),
        list_link_selector="a",
        list_date_selector="span",
        domain_whitelist=("tjj.xm.gov.cn",),
        detail_title_selectors=("h1", "h2", ".article-title", ".title"),
        detail_date_selectors=(".info", ".pubtime", ".article-info"),
        detail_content_selectors=(
            ".TRS_Editor", ".trs_editor_view", ".content",
            ".article-content", "#zoom",
        ),
        extra_categories=[
            # 图片新闻 - 新闻中心类
            # 证据：厦门首页 [统计工作[更多>>]](http://tjj.xm.gov.cn/zwgk/gzdt/) 旁有 [图片新闻](http://tjj.xm.gov.cn/zwgk/tpxw/)
            ("http://tjj.xm.gov.cn/zwgk/tpxw/", "图片新闻"),
            # 业务通知 - 政务公开类（厦门叫"业务通知"，等价于通知公告）
            # 证据：厦门首页 [业务通知](http://tjj.xm.gov.cn/zwgk/ywtz/)
            ("http://tjj.xm.gov.cn/zwgk/ywtz/", "业务通知"),
        ],
        evidence="list: WebSearch /zwgk/gzdt/ | detail: /zwgk/gzdt/202512/t20251212_2971480.htm | extra_categories: 首页导航验证 | 2026-07-17",
    ))

    # 17. 宁波 - 证据：WebSearch 验证 col1229629629 + WebFetch 详情样本
    #     详情样本: /col/col1229629629/art/2026/art_b7a9cdc8b745fedf07928edaf613c652.html
    #     标题在 H1（"# 市统计局召开2026年全市统计工作会议"）
    #     日期: "2026-03-04"（标题下方独立段落）
    #     正文在 .TRS_Editor / #zoom / .content
    sites.append(SiteConfig(
        site_id="stats_nb",
        organization="宁波市统计局",
        list_url="http://tjj.ningbo.gov.cn/col/col1229629629/index.html",
        category="工作动态",
        pagination="index_n",
        list_item_selectors=(
            ".news_list li", ".list-content ul li",
            "ul.news_list li", "ul li",
        ),
        list_link_selector="a",
        list_date_selector="span",
        domain_whitelist=("tjj.ningbo.gov.cn",),
        detail_title_selectors=("h1", "h2", ".article-title", ".title"),
        detail_date_selectors=(".info", ".pubtime", ".article-info"),
        detail_content_selectors=(
            ".TRS_Editor", ".trs_editor_view", "#zoom",
            ".content", ".article-content",
        ),
        extra_categories=[
            # 通知公告 - 政务公开类
            # 证据：宁波首页 [通知公告](http://tjj.ningbo.gov.cn/col/col1229724514/index.html)
            ("http://tjj.ningbo.gov.cn/col/col1229724514/index.html", "通知公告"),
        ],
        evidence="list: WebSearch col1229629629 | detail: /col/col1229629629/art/2026/art_b7a9cdc8b745fedf07928edaf613c652.html | extra_categories: 首页导航验证 | 2026-07-17",
    ))

    # 18. 苏州 - 证据：WebSearch 验证 /sztjj/gzdt/list.shtml + WebFetch 详情样本
    #     详情样本: /sztjj/gzdt/202512/4a87eeec955f4bf68856ff4275f2ffac.shtml
    #     标题在 H2（"苏州局召开全市统计信息系统建设工作会议"）
    #     日期: "来源： 苏州市统计局 发布日期: 2025-12-01 11:00"
    #     正文在 .TRS_Editor / .content / .article-content
    #     extra_categories：苏州首页 WebFetch 验证只有 4 个主栏目：
    #       - 工作动态（主栏目，已配）
    #       - 政声传递（上级政策转发，含国家统计局统计信息化政策文件 → 强关联，可补充采集）
    #       - 数据发布与解读（经济数据，按 SKILL.md 铁律 5 弱关联排除）
    #       - 热点问答（问答类，非动态栏目）
    #     故仅补「政声传递」1 个栏目（依赖 KeywordMatcher 自动过滤掉非统计信息化类转发）
    sites.append(SiteConfig(
        site_id="stats_sz",
        organization="苏州市统计局",
        list_url="http://tjj.suzhou.gov.cn/sztjj/gzdt/list.shtml",
        category="工作动态",
        pagination="index_n",
        list_item_selectors=(
            ".news_list li", ".list-content ul li",
            "ul.news_list li", "ul li",
        ),
        list_link_selector="a",
        list_date_selector="span",
        domain_whitelist=("tjj.suzhou.gov.cn",),
        detail_title_selectors=("h2", "h1", ".article-title", ".title"),
        detail_date_selectors=(".info", ".pubtime", ".article-info"),
        detail_content_selectors=(
            ".TRS_Editor", ".trs_editor_view", ".content",
            ".article-content", "#zoom",
        ),
        extra_categories=[
            # 政声传递 - 上级政策转发类（含国家统计局统计信息化政策文件 → 强关联）
            # 证据：WebFetch http://tjj.suzhou.gov.cn/ 首页导航 [政声传递](http://tjj.suzhou.gov.cn/sztjj/zwgg/zscd_list.shtml)
            # 注意：本栏目多为上级政策转发，依赖 KeywordMatcher 自动过滤非统计信息化类内容
            ("http://tjj.suzhou.gov.cn/sztjj/zwgg/zscd_list.shtml", "政声传递"),
        ],
        evidence="list: WebSearch /sztjj/gzdt/list.shtml | detail: /sztjj/gzdt/202512/4a87eeec955f4bf68856ff4275f2ffac.shtml | extra_categories: WebFetch 首页导航验证（仅政声传递合规） | 2026-07-17",
    ))

    # ---- Java 工程多出的站点（SKILL.md 19 个之外，但 Java 已接入）----
    # 以下 5 个站点的配置完全对齐 sz-statistics-news-collector Java 工程的
    # 对应 ListSpider 实现，作为 baseline 扩展包，方便技能在需要时回退使用。

    # 1) 福建省统计局 - POST JSON API（对应 FjStatisticsListSpider）
    #    API: https://www.fujian.gov.cn/fjdzapp/search
    #    POST body: channelid=229105, classsql=chnlid=3504, page=N, prepage=15
    #    JSON 返回: { data: [{doctitle, docpuburl, docreltime}], pageCount: N }
    #    extra_categories：福建首页 WebFetch 验证 [市县动态](/xwdt/sxdt/) 是独立静态 HTML 栏目，
    #    与主栏目的 JSON API 不同源，需用 3 元组切换 list_strategy=static + pagination=index_n + index_file=index.htm。
    #    证据：WebFetch https://tjj.fujian.gov.cn/xwdt/sxdt/ 返回静态列表页（含 2026/2025 年市县动态）。
    sites.append(SiteConfig(
        site_id="stats_fj",
        organization="福建省统计局",
        list_url="https://www.fujian.gov.cn/fjdzapp/search",
        category="统计要闻",
        list_strategy="json_api",
        api_method="POST",
        pagination="page_param",
        page_param_name="page",
        api_base_uri="https://tjj.fujian.gov.cn/",
        api_item_fields={
            "title": "doctitle",
            "url": "docpuburl",
            "date": "docreltime",
        },
        api_page_count_path="pageCount",
        api_post_data={
            "channelid": "229105",
            "classsql": "chnlid=3504",
            "sortfield": "-docorderpri,-docreltime",
            "prepage": "15",
            "classcol": "publishyear",
            "classnum": "100",
            "classsort": "0",
            "cache": "true",
        },
        extra_headers={
            "Origin": "https://www.fujian.gov.cn",
            "X-Requested-With": "XMLHttpRequest",
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Accept-Language": "zh-CN,zh;q=0.9",
        },
        domain_whitelist=("fujian.gov.cn", "tjj.fujian.gov.cn"),
        # 福建详情页选择器（市县动态静态页用）
        detail_title_selectors=("h1", "h2", ".article-title", ".title"),
        detail_date_selectors=(".info", ".pubtime", ".article-info"),
        detail_content_selectors=(
            ".TRS_Editor", ".trs_editor_view", "#zoom",
            ".content", ".article-content",
        ),
        extra_categories=[
            # 市县动态 - 动态要闻类（静态 HTML，需从 JSON API 切到 static 策略）
            # 证据：WebFetch https://tjj.fujian.gov.cn/xwdt/sxdt/ 返回静态列表页
            # 样本: /xwdt/sxdt/202606/t20260604_7156740.htm（2026-06-03 鲤城区统计局推进统计改革）
            # 列表结构: - [标题](url)  日期（与浙江/宁波静态列表一致，用 ul li 通用选择器）
            # 分页: index.htm / index_1.htm（福建用 .htm 后缀）
            ("https://tjj.fujian.gov.cn/xwdt/sxdt/", "市县动态", {
                "list_strategy": "static",
                "pagination": "index_n",
                "index_file": "index.htm",
                "list_item_selectors": (
                    ".news_list li", ".list-content ul li",
                    "ul.news_list li", "ul li",
                ),
                "list_link_selector": "a",
                "list_date_selector": "span",
            }),
        ],
        evidence="list+detail: Java FjStatisticsListSpider（POST JSON API） | extra_categories: WebFetch /xwdt/sxdt/ 验证（静态 HTML，3 元组切 static 策略） | 2026-07-17",
    ))

    # 2) 河南省统计局 - 静态 HTML（对应 HenanStatisticsListSpider）
    #    list_url: https://tjj.henan.gov.cn/zwxx/sjdt/
    #    选择器: div.newsList.fr ul li / .newsList ul li
    #    日期: span.date, 格式 yyyy-MM-dd
    #    分页: index.html / index_1.html（index_n 模式，pageNo-1）
    #    HTTPS→HTTP 降级容错
    sites.append(SiteConfig(
        site_id="stats_henan",
        organization="河南省统计局",
        list_url="https://tjj.henan.gov.cn/zwxx/sjdt/",
        category="统计动态",
        pagination="index_n",
        list_item_selectors=(
            "div.newsList.fr ul li",
            ".newsList ul li",
            "ul.news_list li",
            "ul li",
        ),
        list_link_selector="a",
        list_date_selector="span.date, span",
        domain_whitelist=("tjj.henan.gov.cn", "henan.gov.cn"),
        ssl_downgrade=True,
        extra_categories=[
            # 通知公告 - 政务公开类
            # 证据：河南首页 [新闻[更多>]](https://tjj.henan.gov.cn/zwxx/) 下有 [通知公告](https://tjj.henan.gov.cn/zwxx/tzgg/)
            ("https://tjj.henan.gov.cn/zwxx/tzgg/", "通知公告"),
        ],
        evidence="list+detail: Java HenanStatisticsListSpider | extra_categories: 首页导航验证 | 2026-07-17",
    ))

    # 3) 深圳市统计局 - 静态 HTML（对应 SzStatisticsListSpider）
    #    list_url: http://tjj.sz.gov.cn/zwgk/zfxxgkml/qt/gzdt/
    #    选择器: ul.column-article li > p.article-title / a / p.article-time
    #    分页: index.html / index_2.html（index_n2 模式，i+1）
    #    详情页 https → http 降级
    sites.append(SiteConfig(
        site_id="stats_sz_statistics",
        organization="深圳市统计局",
        list_url="http://tjj.sz.gov.cn/zwgk/zfxxgkml/qt/gzdt/",
        category="工作动态",
        pagination="index_n2",
        list_item_selectors=(
            "ul.column-article li",
            ".news_list li",
            "ul li",
        ),
        list_link_selector="a",
        list_title_attr="title",
        list_date_selector="p.article-time, span",
        domain_whitelist=("tjj.sz.gov.cn",),
        ssl_downgrade=True,
        extra_headers={"Referer": "http://tjj.sz.gov.cn/"},
        detail_title_selectors=(".article-title", "p.article-title", "h1", "h2"),
        detail_date_selectors=("p.article-time", ".info", ".pubtime"),
        detail_content_selectors=(
            ".TRS_Editor", ".trs_editor_view", ".content",
            ".article-content", "#zoom",
        ),
        extra_categories=[
            # 通知公告 - 政务公开类
            # 证据：深圳统计首页 [【通知公告】2023年深圳市城镇单位就业人员年平均工资数据公报](https://tjj.sz.gov.cn/zwgk/zfxxgkml/qt/tzgg/content/post_11429242.html)
            ("http://tjj.sz.gov.cn/zwgk/zfxxgkml/qt/tzgg/", "通知公告"),
        ],
        evidence="list+detail: Java SzStatisticsListSpider | extra_categories: 首页导航验证 | 2026-07-17",
    ))

    # 4) 深圳市发展和改革委员会 - 静态 HTML（对应 SzFgwListSpider）
    #    list_url: http://fgw.sz.gov.cn/zwgk/qt/gzdt/
    #    分页: index.html / index_2.html（index_n2 模式）
    sites.append(SiteConfig(
        site_id="sz_fgw",
        organization="深圳市发展和改革委员会",
        list_url="http://fgw.sz.gov.cn/zwgk/qt/gzdt/",
        category="工作动态",
        pagination="index_n2",
        list_item_selectors=(
            "ul.column-article li",
            ".news_list li",
            "ul li",
        ),
        list_link_selector="a",
        list_date_selector="p.article-time, span",
        domain_whitelist=("fgw.sz.gov.cn",),
        ssl_downgrade=True,
        extra_headers={"Referer": "http://fgw.sz.gov.cn/"},
        detail_title_selectors=(".article-title", "p.article-title", "h1", "h2"),
        detail_date_selectors=("p.article-time", ".info", ".pubtime"),
        detail_content_selectors=(
            ".TRS_Editor", ".trs_editor_view", ".content",
            ".article-content", "#zoom",
        ),
        extra_categories=[
            # 通知公告 - 政务公开类
            # 证据：深圳发改首页 [+More](https://fgw.sz.gov.cn/zwgk/qt/tzgg/index.html)
            ("http://fgw.sz.gov.cn/zwgk/qt/tzgg/", "通知公告"),
        ],
        evidence="list+detail: Java SzFgwListSpider | extra_categories: 首页导航验证 | 2026-07-17",
    ))

    # 5) 深圳市工业和信息化局 - 静态 HTML（对应 SzGxjListSpider）
    #    list_url: http://gxj.sz.gov.cn/xxgk/xxgkml/qt/gzdt/
    #    分页: index.html / index_2.html（index_n2 模式）
    sites.append(SiteConfig(
        site_id="sz_gxj",
        organization="深圳市工业和信息化局",
        list_url="http://gxj.sz.gov.cn/xxgk/xxgkml/qt/gzdt/",
        category="工作动态",
        pagination="index_n2",
        list_item_selectors=(
            "ul.column-article li",
            ".news_list li",
            "ul li",
        ),
        list_link_selector="a",
        list_date_selector="p.article-time, span",
        domain_whitelist=("gxj.sz.gov.cn",),
        ssl_downgrade=True,
        extra_headers={"Referer": "http://gxj.sz.gov.cn/"},
        detail_title_selectors=(".article-title", "p.article-title", "h1", "h2"),
        detail_date_selectors=("p.article-time", ".info", ".pubtime"),
        detail_content_selectors=(
            ".TRS_Editor", ".trs_editor_view", ".content",
            ".article-content", "#zoom",
        ),
        extra_categories=[
            # 通知公告 - 政务公开类
            # 证据：深圳工信首页 [通知公告](https://gxj.sz.gov.cn/xxgk/xxgkml/qt/tzgg)
            ("http://gxj.sz.gov.cn/xxgk/xxgkml/qt/tzgg/", "通知公告"),
        ],
        evidence="list+detail: Java SzGxjListSpider | extra_categories: 首页导航验证 | 2026-07-17",
    ))

    # 公众号名（用于搜索引擎检索）
    wechat_map = {
        "stats_national": "统计微讯",
        "stats_gd": "广东统计",
        "stats_zj": "浙江统计",
        "stats_js": "江苏统计",
        "stats_sd": "山东统计",
        "stats_sc": "四川统计",
        "stats_bj": "北京统计",
        "stats_sh": "上海统计",
        "stats_tj": "天津统计",
        "stats_cq": "重庆统计",
        "stats_gz": "广州统计",
        "stats_hz": "杭州统计",
        "stats_nj": "南京统计",
        "stats_cd": "成都统计",
        "stats_wh": "武汉统计",
        "stats_qd": "青岛统计",
        "stats_xm": "厦门统计",
        "stats_nb": "宁波统计",
        "stats_sz": "苏州统计",
        # Java 工程扩展站点
        "stats_fj": "福建统计",
        "stats_henan": "河南统计",
        "stats_sz_statistics": "深圳统计",
        "sz_fgw": "深圳发改委",
        "sz_gxj": "深圳工信",
    }
    for s in sites:
        s.wechat_account = wechat_map.get(s.site_id)

    return sites


# ============================================================================
# 4. 全局 SSL 信任（对应 Java 端 trustAllHttpsCertificates）
# ============================================================================

def trust_all_ssl() -> None:
    """全局禁用 SSL 证书校验（政务站点自签证书常见）。

    注意：仅用于内部采集 baseline，生产环境请按需收紧。
    """
    try:
        ssl_ctx = ssl.create_default_context()
        ssl_ctx.check_hostname = False
        ssl_ctx.verify_mode = ssl.CERT_NONE
        # requests 通过 session.verify = False 控制，这里只设置环境变量
        os.environ.setdefault("PYTHONHTTPSVERIFY", "0")
        # urllib3 抑制警告
        try:
            import urllib3
            urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
        except Exception:
            pass
    except Exception as exc:
        logging.warning("SSL 信任配置失败: %s", exc)


# ============================================================================
# 5. HTTP 客户端：重试、UA 池、编码探测
# ============================================================================

class HttpClient:
    """带重试、随机 UA、编码探测的 HTTP 客户端。

    与 Java 端 Jsoup.connect() 链式调用对应：
        timeout / userAgent / header / followRedirects / get / execute
    """

    def __init__(
        self,
        timeout: int = DEFAULT_TIMEOUT,
        retry: int = DEFAULT_RETRY,
        backoff_ms: int = 1500,
    ) -> None:
        self.timeout = timeout
        self.retry = retry
        self.backoff_ms = backoff_ms
        self.session = requests.Session()
        self.session.verify = False
        self.session.headers.update({
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,"
                      "image/webp,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Connection": "keep-alive",
            "Cache-Control": "max-age=0",
        })
        self._lock = threading.Lock()

    def _pick_ua(self) -> str:
        return random.choice(USER_AGENT_POOL)

    def _apply_headers(
        self,
        headers: Optional[Dict[str, str]],
        referer: Optional[str],
    ) -> Dict[str, str]:
        merged: Dict[str, str] = {"User-Agent": self._pick_ua()}
        if referer:
            merged["Referer"] = referer
        if headers:
            merged.update(headers)
        return merged

    def get(
        self,
        url: str,
        *,
        headers: Optional[Dict[str, str]] = None,
        params: Optional[Dict[str, Any]] = None,
        referer: Optional[str] = None,
        allow_redirects: bool = True,
    ) -> Optional[requests.Response]:
        """带重试的 GET。失败返回 None。"""
        last_exc: Optional[Exception] = None
        for attempt in range(1, self.retry + 1):
            try:
                resp = self.session.get(
                    url,
                    params=params,
                    headers=self._apply_headers(headers, referer),
                    timeout=self.timeout,
                    allow_redirects=allow_redirects,
                )
                if resp.status_code in (200, 301, 302):
                    if resp.status_code in (301, 302) and not allow_redirects:
                        return resp
                    return resp
                if resp.status_code in (404, 410):
                    # 404/410 提升到 WARNING：分页 URL 错误（如 .html vs .shtml、
                    # index_n vs index_n2）会导致整站 0 命中且原本静默无告警
                    logging.warning(
                        "HTTP %s on %s（检查 list_url/index_file/pagination 配置）",
                        resp.status_code, url,
                    )
                    return None
                logging.warning(
                    "HTTP %s on %s (attempt %d/%d)",
                    resp.status_code, url, attempt, self.retry,
                )
            except requests.RequestException as exc:
                last_exc = exc
                logging.warning(
                    "请求异常 %s (attempt %d/%d): %s",
                    url, attempt, self.retry, exc,
                )
            # 指数退避
            sleep_ms = self.backoff_ms * (2 ** (attempt - 1))
            time.sleep(sleep_ms / 1000.0)
        if last_exc:
            logging.error("请求最终失败: %s | %s", url, last_exc)
        return None

    def get_text(
        self,
        url: str,
        *,
        headers: Optional[Dict[str, str]] = None,
        params: Optional[Dict[str, Any]] = None,
        referer: Optional[str] = None,
        encoding_override: Optional[str] = None,
    ) -> Optional[str]:
        """GET 并返回解码后的文本（自动探测编码）。"""
        resp = self.get(url, headers=headers, params=params, referer=referer)
        if resp is None:
            return None
        # 编码探测：政务站点常用 gb2312 / gbk
        if encoding_override:
            resp.encoding = encoding_override
        else:
            # requests 的 apparent_encoding 用 chardet，但对 gb2312 偶尔误判
            apparent = resp.apparent_encoding
            if apparent:
                # 修正常见误判
                apparent = apparent.upper().replace("GB2312", "GBK")
                resp.encoding = apparent
            elif resp.encoding == "ISO-8859-1":
                # chardet 探测失败 + 无 charset header → requests 默认 ISO-8859-1
                # 政务站点几乎不会用 ISO-8859-1，fallback 到 utf-8 避免中文乱码
                resp.encoding = "utf-8"
            else:
                # apparent_encoding 为 None 且 resp.encoding 非 ISO-8859-1
                # （可能是 None 或其他异常值）→ fallback 到 utf-8
                resp.encoding = resp.encoding or "utf-8"
        return resp.text

    def get_json(
        self,
        url: str,
        *,
        headers: Optional[Dict[str, str]] = None,
        params: Optional[Dict[str, Any]] = None,
        referer: Optional[str] = None,
    ) -> Optional[Any]:
        resp = self.get(url, headers=headers, params=params, referer=referer)
        if resp is None:
            return None
        try:
            return resp.json()
        except ValueError as exc:
            logging.warning("JSON 解析失败 %s: %s", url, exc)
            return None


# ============================================================================
# 6. 工具函数：URL 拼接、日期解析、文本清洗
# ============================================================================

def absolute_url(base: str, href: str) -> str:
    """相对 URL → 绝对 URL。"""
    if not href:
        return ""
    href = href.strip()
    if href.startswith(("http://", "https://")):
        return href
    if href.startswith("//"):
        # 协议选择：base 为 https → https，否则默认 http
        # base 为 None/空时（防御性），政务站点默认 https 更安全
        protocol = "https" if (base and base.startswith("https")) else "http"
        return f"{protocol}:{href}"
    if not base:
        # base 为空且 href 非绝对 URL → 无法拼成有效 URL，返回空
        # 避免 urljoin("", "/path") 返回 "/path" 被当作有效 URL 请求
        return ""
    return urllib.parse.urljoin(base, href)


def _timestamp_to_datetime(ts: float) -> Optional[datetime]:
    """Unix 时间戳转 datetime，自动识别秒级（10 位）与毫秒级（13 位）。

    政务 JSON API 常用毫秒级时间戳（如福建 docreltime）。
    合理范围：2000-01-01 ~ 2100-01-01，避免把电话号码等长数字误判为时间戳。
    """
    try:
        ts_float = float(ts)
    except (TypeError, ValueError):
        return None
    # 13 位毫秒级 → 转秒
    if ts_float > 1e12:
        ts_float = ts_float / 1000.0
    # 合理范围校验：2000-01-01 (946684800) ~ 2100-01-01 (4102444800)
    if 946684800 <= ts_float <= 4102444800:
        try:
            return datetime.fromtimestamp(ts_float)
        except (OSError, ValueError):
            return None
    return None


def parse_date(text: Any) -> Optional[datetime]:
    """多格式日期解析（与 Java 端 parseDate 对应）。

    优先级：
        1. Unix 时间戳（秒级/毫秒级）- 福建等 JSON API 站点常用
        2. 完整格式（strptime）- 保留时间信息
        3. 正则提取 - 兜底，仅提取日期部分（时间为 00:00:00）
    """
    if not text:
        return None
    # 数字类型 → 直接按时间戳处理
    if isinstance(text, (int, float)):
        return _timestamp_to_datetime(text)
    text = str(text).strip()
    # 纯数字字符串 → 尝试按时间戳处理（福建 docreltime 等）
    if re.fullmatch(r"\d{10,13}", text):
        ts = int(text)
        dt = _timestamp_to_datetime(ts)
        if dt:
            return dt
    # 清理尾部 Z/时区标识（如 2024-01-15T10:30:00Z → 2024-01-15T10:30:00）
    # 微信公众号 meta 和部分政务站点用 ISO 8601 带 Z 格式
    text_for_fmt = re.sub(r"[Zz]$|\+00:?00$", "", text)
    # 先尝试完整格式（保留时间信息）
    # 注意：带时间的格式放前面，避免被纯日期格式先匹配导致时间丢失
    for fmt in (
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M:%S.%f",
        "%Y/%m/%d %H:%M:%S",
        "%Y年%m月%d日 %H:%M:%S",
        "%Y年%m月%d日 %H:%M",
        "%Y.%m.%d",
        "%Y-%m-%d",
        "%Y/%m/%d",
    ):
        try:
            return datetime.strptime(text_for_fmt, fmt)
        except ValueError:
            continue
    # 兜底：正则提取 yyyy-mm-dd / yyyy/mm/dd / yyyy年mm月dd日
    # 注意：日/月 alternation 必须把 2 位匹配项（[12]\d|3[01]）放在 0?[1-9] 前面，
    # 否则 "17" 会被 0?[1-9] 先匹配成 "1"，导致日期 17 → 1（月份同理 12 → 1）。
    m = re.search(
        r"(20\d{2})[-年/]"
        r"(1[0-2]|0?[1-9])[-月/]"
        r"(3[01]|[12]\d|0?[1-9])",
        text,
    )
    if m:
        try:
            return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            pass
    return None


def clean_text(text: str) -> str:
    """清洗正文：去多余空白、去责任编辑、去零宽字符。

    注意：保留 ``\\n`` 换行符，仅折叠其他空白（空格/制表符/回车）为单个空格。
    这样 ``html_to_plain`` 返回的段落换行能被 ``SummaryGenerator`` 用作分句符。
    """
    if not text:
        return ""
    # 去零宽字符
    text = re.sub(r"[\u200b-\u200f\ufeff]", "", text)
    # 折叠非换行空白为单个空格（保留 \n 作为段落分隔符）
    text = re.sub(r"[^\S\n]+", " ", text)
    # 去掉换行符前后的空白（如 "\n\t段落" → "\n段落"）
    text = re.sub(r" *\n *", "\n", text)
    # 折叠连续换行为单个换行（多段落间不产生空行）
    text = re.sub(r"\n+", "\n", text)
    text = text.strip()
    # 去责任编辑
    text = re.sub(r"\[?责任编辑[:：]?[^\]】]*[\]】]?", "", text)
    text = re.sub(r"责任编辑[:：]?.*$", "", text)
    return text.strip()


def html_to_plain(html_fragment: str) -> str:
    """HTML 片段 → 纯文本（保留段落换行）。"""
    if not html_fragment:
        return ""
    soup = BeautifulSoup(html_fragment, "lxml")
    # 移除 script/style/noscript
    for tag in soup(["script", "style", "noscript", "iframe"]):
        tag.decompose()
    # 段落换行
    for tag in soup.find_all(["p", "br", "div", "li", "tr"]):
        tag.append("\n")
    return clean_text(soup.get_text())


def extract_first_image_url(html_fragment: str, base_url: str) -> Optional[str]:
    """从 HTML 片段中提取第一张可用图片 URL（作为封面）。"""
    if not html_fragment:
        return None
    soup = BeautifulSoup(html_fragment, "lxml")
    img = soup.find("img")
    if not img:
        return None
    for attr in ("src", "data-src", "data-actualsrc", "data-wxsrc"):
        val = img.get(attr)
        if val:
            return absolute_url(base_url, val)
    return None


def is_attachment_url(url: str) -> bool:
    """判断 URL 是否指向附件（PDF/Word/Excel/RAR 等）。

    与 SKILL.md 铁律一致：附件链接不抓详情，仅作过滤。
    """
    if not url:
        return False
    lower = url.lower().split("?", 1)[0].split("#", 1)[0]
    return bool(re.search(
        r"\.(pdf|doc|docx|xls|xlsx|ppt|pptx|wps|et|dps|zip|rar|7z|gz|tar|mp4|avi|mp3)$",
        lower,
    ))


def is_excluded_by_pattern(title: str, content: str) -> bool:
    """命中排除规则（经济数据发布/人事/党建/会议通知）→ 直接丢弃。"""
    if not title:
        return False
    text = f"{title} {content[:200] if content else ''}"
    # 标题里出现排除关键词即丢
    for pat in EXCLUDE_PATTERNS:
        if pat in title:
            return True
    # 标题+正文前 200 字里同时出现 ≥2 个排除项也丢
    hits = sum(1 for pat in EXCLUDE_PATTERNS if pat in text)
    return hits >= 2


# ============================================================================
# 7. 列表页抓取：三策略 + 多分页规则
# ============================================================================

class ListFetcherFactory:
    """根据 SiteConfig.list_strategy 选取抓取策略。"""

    def __init__(self, http: HttpClient) -> None:
        self.http = http

    # ---- 分页 URL 构造 ----
    def build_page_urls(self, cfg: SiteConfig) -> Iterable[str]:
        """生成各分页 URL（惰性）。"""
        if cfg.pagination == "none":
            yield cfg.list_url
            return

        if cfg.pagination == "page_param":
            for page in range(1, cfg.max_pages + 1):
                params = dict(cfg.extra_query or {})
                params[cfg.page_param_name] = page
                yield cfg.list_url + "?" + urllib.parse.urlencode(params)
            return

        # index_n / index_n2
        # base 提取：list_url 可能是目录（以 / 结尾）或具体文件名（如 list.shtml / index.html）
        # 如果是文件名结尾，需把文件名作为 index_file，base 取所在目录
        # 否则 list.shtml 会被当成目录，拼出 list.shtml/index.html（404）
        parsed = urllib.parse.urlparse(cfg.list_url)
        path = parsed.path
        if path.endswith("/"):
            base_dir = path
            index_file = cfg.index_file or "index.html"
        else:
            # 拆出目录和文件名
            if "/" in path:
                dir_part, file_part = path.rsplit("/", 1)
                # file_part 含 . 视为文件名（如 list.shtml / index.html），
                # 否则视为目录名（如 /gzys 无尾斜杠），拼到 base_dir 保留
                if "." in file_part:
                    base_dir = dir_part + "/"
                    index_file = file_part
                else:
                    base_dir = path + "/"
                    index_file = cfg.index_file or "index.html"
            else:
                base_dir = path + "/"
                index_file = cfg.index_file or "index.html"
        base = f"{parsed.scheme}://{parsed.netloc}{base_dir}"
        if "." in index_file:
            stem, ext = index_file.rsplit(".", 1)
        else:
            stem, ext = index_file, "html"
        for i in range(cfg.max_pages):
            if i == 0:
                yield base + index_file
            else:
                # index_n: 第 2 页是 index_1.html（国家统计局、北京）
                # index_n2: 第 2 页是 index_2.html（上海、四川 list_2.shtml）
                page_num = i + 1 if cfg.pagination == "index_n2" else i
                yield base + f"{stem}_{page_num}.{ext}"

    # ---- 静态 HTML 策略 ----
    def fetch_static(
        self, cfg: SiteConfig, page_url: str,
    ) -> Tuple[Optional[BeautifulSoup], str]:
        """抓静态 HTML 列表，返回 (soup, base_url)。"""
        html = self.http.get_text(
            page_url,
            headers=cfg.extra_headers or None,
            referer=cfg.list_url,
            encoding_override=cfg.encoding_override,
        )
        if not html:
            return None, page_url
        soup = BeautifulSoup(html, "lxml")
        return soup, page_url

    def parse_static_items(
        self, cfg: SiteConfig, soup: BeautifulSoup, base_url: str,
    ) -> List[ArticleListItem]:
        items: List[ArticleListItem] = []
        for sel in cfg.list_item_selectors:
            nodes = soup.select(sel)
            if not nodes:
                continue
            for node in nodes:
                link = node.select_one(cfg.list_link_selector)
                if not link:
                    continue
                href = (link.get("href") or "").strip()
                # 过滤无效 href（必须在 absolute_url 之前判断，否则 #top 会被
                # urljoin 转成 http://host/path#top 导致 startswith("#") 失效）
                if not href or href.startswith(("javascript:", "#", "mailto:", "tel:")):
                    continue
                abs_href = absolute_url(base_url, href)
                if not abs_href:
                    continue
                # 标题：优先 title 属性
                title = (link.get(cfg.list_title_attr) or "").strip()
                if not title:
                    title = link.get_text(strip=True)
                if not title:
                    continue
                # 日期
                date_text = ""
                date_node = node.select_one(cfg.list_date_selector)
                if date_node:
                    date_text = date_node.get_text(strip=True)
                if not date_text:
                    # 兜底：li 内任意匹配 yyyy-mm-dd 的文本
                    m = re.search(r"\d{4}-\d{2}-\d{2}", node.get_text())
                    if m:
                        date_text = m.group()
                items.append(ArticleListItem(
                    title=title,
                    source_url=abs_href,
                    publish_date=parse_date(date_text),
                    category=cfg.category,
                    source_department=cfg.organization,
                ))
            if items:
                break
        return items

    # ---- JSON API 策略（浙江 GET / 福建 POST）----
    def fetch_json_api(
        self, cfg: SiteConfig, page_url: str,
    ) -> Tuple[Optional[BeautifulSoup], str, Optional[List[ArticleListItem]]]:
        """抓 JSON API。

        返回 (soup_or_None, base_url, items_or_None)：
            - 若 cfg.api_item_fields 配置了字段映射 → 直接从 JSON 数组构造
              ArticleListItem，soup 为 None
            - 否则按 cfg.api_json_path 取 HTML 片段，soup 为解析结果，
              items 为 None（外层走 parse_static_items）
        """
        params = dict(cfg.extra_query or {})
        parsed = urllib.parse.urlparse(page_url)
        qs = urllib.parse.parse_qs(parsed.query)
        for k, v in qs.items():
            params[k] = v[0]
        api_url = parsed._replace(query="").geturl()

        if cfg.api_method.upper() == "POST":
            # POST 策略：body 合并顺序 = api_post_data（基础固定参数）
            # → extra_query（栏目级覆盖）→ qs（URL 查询参数，含分页页码）
            # 分页页码必须最后覆盖，否则 api_post_data 里的默认 page 值
            # 会让所有页都请求第 1 页（静默分页失效）
            post_data: Dict[str, str] = {}
            if cfg.api_post_data:
                for k, v in cfg.api_post_data.items():
                    post_data[k] = str(v)
            if cfg.extra_query:
                for k, v in cfg.extra_query.items():
                    post_data[k] = str(v)
            # page_url 里解析出的 page / pageNo 最后覆盖（确保分页生效）
            for k, v in qs.items():
                post_data[k] = v[0]
            data = self._http_post_json(
                api_url,
                headers=cfg.extra_headers or None,
                data=post_data,
                referer=cfg.api_base_uri or cfg.list_url,
            )
        else:
            data = self.http.get_json(
                api_url,
                headers=cfg.extra_headers or None,
                params=params,
                referer=cfg.api_base_uri or cfg.list_url,
            )

        if not data:
            return None, page_url, None

        # 模式 A：直接字段映射（如福建）
        if cfg.api_item_fields:
            items = self._build_items_from_json(cfg, data)
            return None, page_url, items

        # 模式 B：HTML 片段（如浙江）
        html = data
        for key in cfg.api_json_path.split("."):
            if isinstance(html, dict):
                html = html.get(key)
            else:
                html = None
                break
        if not html or not isinstance(html, str):
            return None, page_url, None
        soup = BeautifulSoup(html, "lxml")
        base = cfg.api_base_uri or cfg.list_url
        return soup, base, None

    def _http_post_json(
        self,
        url: str,
        *,
        headers: Optional[Dict[str, str]] = None,
        data: Optional[Dict[str, str]] = None,
        referer: Optional[str] = None,
    ) -> Optional[Any]:
        """POST 表单并解析 JSON（带重试，对应 Java 端 Jsoup.data().method(POST)。"""
        merged_headers = {
            "User-Agent": self.http._pick_ua(),
            "X-Requested-With": "XMLHttpRequest",
            "Accept": "application/json, text/javascript, */*; q=0.01",
        }
        if referer:
            merged_headers["Referer"] = referer
        if headers:
            merged_headers.update(headers)

        last_exc: Optional[Exception] = None
        for attempt in range(1, self.http.retry + 1):
            try:
                resp = self.http.session.post(
                    url,
                    data=data,
                    headers=merged_headers,
                    timeout=self.http.timeout,
                    allow_redirects=True,
                )
                if resp.status_code == 200:
                    try:
                        return resp.json()
                    except ValueError as exc:
                        logging.warning("POST JSON 解析失败 %s: %s", url, exc)
                        return None
                if resp.status_code in (404, 410):
                    # 404/410 提升到 WARNING + 立即返回（不重试），与 GET 行为一致
                    # 分页配置错误（page 参数名错/channelid 错）会导致整站 0 命中且静默
                    logging.warning(
                        "HTTP %s on POST %s（检查 api_post_data/page_param_name/channelid 配置）",
                        resp.status_code, url,
                    )
                    return None
                logging.warning(
                    "HTTP %s on POST %s (attempt %d/%d)",
                    resp.status_code, url, attempt, self.http.retry,
                )
            except requests.RequestException as exc:
                last_exc = exc
                logging.warning(
                    "POST 请求异常 %s (attempt %d/%d): %s",
                    url, attempt, self.http.retry, exc,
                )
            sleep_ms = self.http.backoff_ms * (2 ** (attempt - 1))
            time.sleep(sleep_ms / 1000.0)
        if last_exc:
            logging.error("POST 最终失败: %s | %s", url, last_exc)
        return None

    def _build_items_from_json(
        self, cfg: SiteConfig, payload: Any,
    ) -> List[ArticleListItem]:
        """从 JSON 数组直接构造 ArticleListItem（福建模式）。

        cfg.api_item_fields 必须包含:
            title / url / date 三个 key，对应 JSON item 内的字段名
        cfg.api_page_count_path 可选，用于提取总页数（仅记录日志）
        """
        if not cfg.api_item_fields:
            return []
        # 找数组：优先 data 字段，否则顶层就是数组
        array_node = None
        if isinstance(payload, list):
            array_node = payload
        elif isinstance(payload, dict):
            for key in ("data", "list", "rows", "items"):
                v = payload.get(key)
                if isinstance(v, list):
                    array_node = v
                    break
            if array_node is None:
                # 兜底：找第一个 list 值
                for v in payload.values():
                    if isinstance(v, list):
                        array_node = v
                        break
        if not array_node:
            return []

        # 总页数日志
        if cfg.api_page_count_path and isinstance(payload, dict):
            node: Any = payload
            for key in cfg.api_page_count_path.split("."):
                if isinstance(node, dict):
                    node = node.get(key)
                else:
                    node = None
                    break
            if isinstance(node, (int, str)):
                logging.info(
                    "[%s] API 返回总页数: %s", cfg.site_id, node,
                )

        title_field = cfg.api_item_fields.get("title", "title")
        url_field = cfg.api_item_fields.get("url", "url")
        date_field = cfg.api_item_fields.get("date", "date")

        items: List[ArticleListItem] = []
        for node in array_node:
            if not isinstance(node, dict):
                continue
            title = str(node.get(title_field, "")).strip()
            href = str(node.get(url_field, "")).strip()
            date_raw = node.get(date_field, "")
            if not title or not href:
                continue
            # 福建的 docpuburl 可能是相对 URL
            abs_href = absolute_url(cfg.api_base_uri or cfg.list_url, href)
            items.append(ArticleListItem(
                title=title,
                source_url=abs_href,
                publish_date=parse_date(date_raw),
                category=cfg.category,
                source_department=cfg.organization,
            ))
        return items

    # ---- 正则策略（上海）----
    def fetch_regex(
        self, cfg: SiteConfig, page_url: str,
    ) -> List[ArticleListItem]:
        html = self.http.get_text(
            page_url,
            headers=cfg.extra_headers or None,
            referer=cfg.list_url,
            encoding_override=cfg.encoding_override,
        )
        if not html:
            return []
        # 空 pattern 兜底：避免 re.compile(None) 或空串导致 group() 越界
        pattern_str = getattr(cfg, "regex_pattern", None) or ""
        if not pattern_str:
            logging.warning(
                "[%s] list_strategy=regex 但 regex_pattern 为空，跳过 %s",
                cfg.site_id, page_url,
            )
            return []
        items: List[ArticleListItem] = []
        pattern = re.compile(pattern_str)
        # 预先校验 pattern 至少有 3 个捕获组（避免运行时 IndexError）
        if pattern.groups < 3:
            logging.warning(
                "[%s] regex_pattern 只有 %d 个捕获组（需 ≥3），跳过 %s",
                cfg.site_id, pattern.groups, page_url,
            )
            return []
        for m in pattern.finditer(html):
            href, title, date_str = m.group(1), m.group(2), m.group(3)
            abs_href = absolute_url(page_url, href)
            if not abs_href:
                continue
            items.append(ArticleListItem(
                title=title.strip(),
                source_url=abs_href,
                publish_date=parse_date(date_str),
                category=cfg.category,
                source_department=cfg.organization,
            ))
        return items

    # ---- 统一入口 ----
    def fetch_page(
        self, cfg: SiteConfig, page_url: str,
    ) -> Tuple[List[ArticleListItem], bool]:
        """抓单页，返回 (items, should_stop)。

        should_stop=True 表示此页为空或触发时间边界，外层应停止翻页。
        """
        if cfg.list_strategy == "json_api":
            soup, base, direct_items = self.fetch_json_api(cfg, page_url)
            if direct_items is not None:
                # 福建模式：直接从 JSON 构造
                return direct_items, len(direct_items) == 0
            if soup is None:
                return [], True
            # 浙江模式：解析 HTML 片段
            items = self.parse_static_items(cfg, soup, base)
            return items, len(items) == 0

        if cfg.list_strategy == "regex":
            items = self.fetch_regex(cfg, page_url)
            return items, len(items) == 0

        # static
        soup, base = self.fetch_static(cfg, page_url)
        if soup is None:
            return [], True
        items = self.parse_static_items(cfg, soup, base)
        return items, len(items) == 0

    def fetch_all(
        self,
        cfg: SiteConfig,
        cutoff_date: Optional[date],
        progress_cb: Optional[Callable[[int, int, str], None]] = None,
    ) -> List[ArticleListItem]:
        """抓取整站列表，应用时间窗过滤。

        时间边界处理：列表可能含置顶/跨年混合文章，不能遇一条早于 cutoff 就 return。
        本页继续扫完收集所有合规新文章；只有当本页「全部」早于 cutoff 时才停止翻页。
        """
        all_items: List[ArticleListItem] = []
        seen_urls: set = set()
        consecutive_empty = 0  # 连续空页计数（用于告警选择器/分页配置错误）
        for page_idx, page_url in enumerate(self.build_page_urls(cfg), start=1):
            if progress_cb:
                progress_cb(page_idx, cfg.max_pages, page_url)
            items, should_stop = self.fetch_page(cfg, page_url)
            # 原始 items 数量（去重前），用于判断页面是否真的为空
            raw_count = len(items)
            new_count = 0
            page_total = 0  # 本页「去重 + 域名白名单通过」的条目数
            page_out_of_range = 0  # 本页早于 cutoff 的条数（仅计合规条目）
            for it in items:
                if it.source_url in seen_urls:
                    continue
                seen_urls.add(it.source_url)
                # 附件 URL 过滤（铁律 1：严禁下载附件）
                # 提前过滤可减少无效详情请求，且避免附件 URL（无日期）干扰
                # page_total / page_out_of_range 的翻页停止判断
                if is_attachment_url(it.source_url):
                    continue
                # 域名白名单
                if cfg.domain_whitelist:
                    host = urllib.parse.urlparse(it.source_url).hostname or ""
                    if not any(d in host for d in cfg.domain_whitelist):
                        continue
                # page_total 在域名白名单通过后计数，确保 page_out_of_range == page_total
                # 能准确判断「本页所有合规条目都早于 cutoff → 后续页更老 → 停止翻页」
                page_total += 1
                # 时间窗：早于 cutoff 的条目跳过（但本页继续，防置顶混合）
                if cutoff_date and it.publish_date and \
                        it.publish_date.date() < cutoff_date:
                    page_out_of_range += 1
                    continue
                all_items.append(it)
                new_count += 1
            logging.info(
                "[%s] 第 %d 页新增 %d 条（累计 %d）",
                cfg.site_id, page_idx, new_count, len(all_items),
            )
            # 空页告警：首页空立即告警（大概率配置错误）；后续页连续 2 页空才告警
            if raw_count == 0:
                consecutive_empty += 1
                if page_idx == 1 or consecutive_empty >= 2:
                    logging.warning(
                        "[%s] 第 %d 页 0 条目，请检查 list_item_selectors / "
                        "index_file / pagination 配置（URL: %s）",
                        cfg.site_id, page_idx, page_url,
                    )
            else:
                consecutive_empty = 0
            # 本页全部早于 cutoff → 后续页更老，停止翻页
            if page_total > 0 and page_out_of_range == page_total:
                logging.info(
                    "[%s] 本页 %d 条全部早于 %s，停止翻页",
                    cfg.site_id, page_total, cutoff_date,
                )
                break
            if should_stop:
                break
            # 礼貌延时
            time.sleep(DEFAULT_DELAY_MS / 1000.0)
        return all_items


# ============================================================================
# 8. 详情页解析：通用 + 站点覆盖 + 微信
# ============================================================================

class DetailExtractorBase:
    """详情页解析基类（对应 Java 端 AbstractWebsiteSpiderService）。"""

    def __init__(self, http: HttpClient) -> None:
        self.http = http

    def fetch(
        self, cfg: SiteConfig, item: ArticleListItem,
    ) -> Tuple[str, str, Optional[datetime], Optional[str]]:
        """抓详情，返回 (title, content_text, publish_date, cover_image)。"""
        url = item.source_url
        if not url:
            return "", "", None, None
        # SSL 降级（如国家统计局）
        if cfg.ssl_downgrade and url.startswith("https://"):
            url = url.replace("https://", "http://", 1)
        html = self.http.get_text(
            url,
            headers=cfg.extra_headers or None,
            referer=cfg.list_url,
            encoding_override=cfg.encoding_override,
        )
        if not html:
            return "", "", None, None
        soup = BeautifulSoup(html, "lxml")
        title = self.extract_title(cfg, soup) or item.title
        content_text, content_html, cover = self.extract_content(cfg, soup, url)
        pub = self.extract_publish_date(cfg, soup) or item.publish_date
        return title, content_text, pub, cover

    def extract_title(self, cfg: SiteConfig, soup: BeautifulSoup) -> str:
        for sel in cfg.detail_title_selectors:
            node = soup.select_one(sel)
            if node:
                txt = node.get_text(strip=True)
                if txt:
                    return txt
        return ""

    def extract_publish_date(
        self, cfg: SiteConfig, soup: BeautifulSoup,
    ) -> Optional[datetime]:
        for sel in cfg.detail_date_selectors:
            node = soup.select_one(sel)
            if node:
                dt = parse_date(node.get_text())
                if dt:
                    return dt
        # meta 标签兜底（用 find_all 遍历，避免 CSS 选择器大小写敏感问题）
        # 常见 name/property/itemprop 值，涵盖政务 CMS、Schema.org、Open Graph 等
        meta_date_attrs = (
            "pubdate", "publishdate", "pub_date",
            "article:published_time", "og:published_time",
            "datepublished", "date", "releasedate", "create_date",
            "updated", "lastmodified", "moddate",
        )
        for meta in soup.find_all("meta"):
            # 同时检查 name / property / itemprop 三个属性，值做小写比较
            for attr in ("name", "property", "itemprop", "http-equiv"):
                val = meta.get(attr, "")
                if val and val.lower() in meta_date_attrs:
                    content = meta.get("content", "")
                    dt = parse_date(content)
                    if dt:
                        return dt
                    break  # 此 meta 已检查过，换下一个
        return None

    def extract_content(
        self, cfg: SiteConfig, soup: BeautifulSoup, base_url: str,
    ) -> Tuple[str, str, Optional[str]]:
        """返回 (plain_text, html, cover_image)。"""
        content_node: Optional[Tag] = None
        for sel in cfg.detail_content_selectors:
            node = soup.select_one(sel)
            if node:
                content_node = node
                break
        if not content_node:
            # 兜底：取 article 标签或 body
            content_node = soup.find("article") or soup.body
        if not content_node:
            return "", "", None

        # 移除 script/style/分享/责任编辑
        for sel in ("script", "style", "noscript", "iframe",
                    ".share", ".bshare-custom", ".mhide"):
            for tag in content_node.select(sel):
                tag.decompose()
        # 责任编辑节点：用文本匹配而非 :contains()（后者已 deprecated，未来 bs4 移除）
        for tag in content_node.find_all(
            ["p", "div", "span", "em", "i", "font"]
        ):
            txt = tag.get_text(strip=True)
            if txt.startswith("责任编辑") or "责任编辑：" in txt or "责任编辑:" in txt:
                # 仅当节点文本主要是责任编辑信息时才移除（防误删含该词的长段落）
                if len(txt) < 50:
                    tag.decompose()
        # 元数据表清理：部分政务 CMS（如山东 #zoom）把索引号/主题分类/发布机构
        # 等元数据放在正文容器内的 <table> 里，需移除。判定标准：table 文本短且
        # 含元数据关键词。避免误删正文中的数据表格（数据表通常文本较长）。
        METADATA_KEYWORDS = ("索引号", "主题分类", "发布机构", "公开日期",
                             "文号", "成文日期", "公开方式", "组配分类", "有效性")
        for table in content_node.find_all("table"):
            table_text = table.get_text(strip=True)
            if len(table_text) < 200 and any(
                kw in table_text for kw in METADATA_KEYWORDS
            ):
                table.decompose()

        # 图片绝对化 + 提取封面
        cover: Optional[str] = None
        for img in content_node.find_all("img"):
            for attr in ("src", "data-src", "data-actualsrc"):
                val = img.get(attr)
                if val:
                    abs_val = absolute_url(base_url, val)
                    img["src"] = abs_val
                    if cover is None:
                        cover = abs_val
                    break

        plain = html_to_plain(str(content_node))
        # 截断超长正文（避免内存爆掉）
        if len(plain) > 8000:
            plain = plain[:8000]
        return plain, str(content_node), cover


class WeixinDetailExtractor(DetailExtractorBase):
    """微信公众号详情解析（对应 Java 端 WeixinDetailSpider）。

    特殊处理：
    - 标题：#activity-name / .rich_media_title
    - 正文：#js_content / .rich_media_content
    - 图片懒加载：data-src / data-actualsrc / data-wxsrc → src
    - 背景图转 <img>
    - 日期：#post-date
    """

    def fetch(
        self, cfg: SiteConfig, item: ArticleListItem,
    ) -> Tuple[str, str, Optional[datetime], Optional[str]]:
        url = item.source_url
        html = self.http.get_text(
            url,
            headers={
                "User-Agent": USER_AGENT_POOL[0],
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,"
                          "image/webp,*/*;q=0.8",
            },
            referer="https://mp.weixin.qq.com/",
        )
        if not html:
            return "", "", None, None
        soup = BeautifulSoup(html, "lxml")

        # 标题
        title = ""
        title_node = soup.select_one("#activity-name, .rich_media_title")
        if title_node:
            title = title_node.get_text(strip=True)

        # 正文
        content_text = ""
        cover: Optional[str] = None
        content_node = soup.select_one("#js_content, .rich_media_content")
        if content_node:
            # 移除脚本样式
            for tag in content_node(["script", "style", "noscript"]):
                tag.decompose()
            # 懒加载图片转 src
            for img in content_node.find_all("img"):
                for attr in ("data-src", "data-actualsrc", "data-wxsrc",
                             "data-ks-src", "data-lazy", "data-lazy-src"):
                    val = img.get(attr)
                    if val:
                        if val.startswith("//"):
                            val = "https:" + val
                        img["src"] = val
                        if cover is None:
                            cover = val
                        break
                # 响应式样式
                style = img.get("style", "")
                if "max-width" not in style:
                    img["style"] = (style + ";" if style else "") + \
                        "max-width:100%;height:auto;"
            # 背景图转 <img>
            bg_pattern = re.compile(
                r"background(?:-image)?\s*:\s*url\((?:['\"])?(.*?)(?:['\"])?\)",
                re.IGNORECASE,
            )
            for el in content_node.select("[style]"):
                style = el.get("style", "")
                m = bg_pattern.search(style)
                if m:
                    bg_url = m.group(1).strip()
                    if bg_url.startswith("//"):
                        bg_url = "https:" + bg_url
                    new_img = soup.new_tag(
                        "img", src=bg_url,
                        style="max-width:100%;height:auto;display:block;margin:0 auto;",
                    )
                    if el.get_text(strip=True) == "" and not el.find_all():
                        el.replace_with(new_img)
                    else:
                        el.insert(0, new_img)
            content_text = clean_text(content_node.get_text("\n"))

        # 日期
        pub: Optional[datetime] = None
        date_node = soup.select_one("#post-date, .rich_media_meta_list .rich_media_meta_item")
        if date_node:
            pub = parse_date(date_node.get_text(strip=True))

        return title or item.title, content_text, pub, cover


class DetailExtractorFactory:
    """详情解析工厂（对应 Java 端 WebsiteSpiderFactory）。"""

    def __init__(self, http: HttpClient) -> None:
        self.http = http
        self._generic = DetailExtractorBase(http)
        self._weixin = WeixinDetailExtractor(http)
        self._overrides: Dict[str, DetailExtractorBase] = {}

    def register_override(
        self, domain_keyword: str, extractor: DetailExtractorBase,
    ) -> None:
        self._overrides[domain_keyword] = extractor

    def get_for_url(self, url: str) -> DetailExtractorBase:
        if "mp.weixin.qq.com" in url:
            return self._weixin
        for keyword, extractor in self._overrides.items():
            if keyword in url:
                return extractor
        return self._generic


# ============================================================================
# 9. 关键词匹配 + 关联度打分 + 摘要生成
# ============================================================================

class KeywordMatcher:
    """关键词命中 + 关联度分级（与 SKILL.md 规则一致）。

    注意：排除规则（EXCLUDE_PATTERNS）由 _process_detail 调用
    is_excluded_by_pattern() 在关键词匹配前过滤，本类不重复实现。
    """

    def __init__(self) -> None:
        self.strong = STRONG_KEYWORDS
        self.medium = MEDIUM_KEYWORDS
        self.weak = WEAK_KEYWORDS

    def match(self, title: str, content: str) -> Tuple[List[str], str]:
        """返回 (命中关键词列表, 关联度)。

        关联度（与 SKILL.md 规则一致）：
            '强关联'    - 标题命中强关键词，或正文命中 ≥2 强关键词，
                        或强关联+中等关联关键词叠加（SKILL.md 升级规则）
            '中等关联'  - 正文命中 1 个强关键词，或命中中等关键词
            '弱关联'    - 仅命中弱关键词（不输出）
            ''          - 无命中（不输出）
        """
        if not title and not content:
            return [], ""

        title_hits: List[str] = []
        content_hits: List[str] = []

        for kw in self.strong:
            if kw in title:
                title_hits.append(kw)
            if kw in content:
                content_hits.append(kw)

        medium_hits: List[str] = []
        for kw in self.medium:
            if kw in title or kw in content:
                medium_hits.append(kw)

        all_hits = list(dict.fromkeys(title_hits + content_hits + medium_hits))

        # 关联度判定
        if title_hits:
            return all_hits, "强关联"
        # SKILL.md 升级规则：强关联 + 中等关联叠加 → 强关联
        if content_hits and medium_hits:
            return all_hits, "强关联"
        if len(content_hits) >= 2:
            return all_hits, "强关联"
        if len(content_hits) == 1 or medium_hits:
            return all_hits, "中等关联"

        # 仅弱关键词
        for kw in self.weak:
            if kw in title or kw in content:
                return [kw], "弱关联"
        return all_hits, ""


class SummaryGenerator:
    """生成 ≤200 字摘要。"""

    @staticmethod
    def generate(title: str, content: str, max_len: int = 200) -> str:
        if not content:
            return title[:max_len] if title else ""
        # 优先取第一句完整句子
        sentences = re.split(r"[。！!？?；;\n]", content)
        sentences = [s.strip() for s in sentences if s.strip()]
        if not sentences:
            return content[:max_len]
        summary = sentences[0]
        for s in sentences[1:]:
            if len(summary) + len(s) + 1 > max_len:
                break
            summary += "。" + s
        if len(summary) > max_len:
            summary = summary[:max_len - 1] + "…"
        return summary


# ============================================================================
# 10. 微信公众号检索（搜索引擎兜底）
# ============================================================================

class WechatArticleFinder:
    """通过搜索引擎检索官方公众号文章（baseline 兜底方案）。

    注意：
    - 微信公众号文章直链需要特殊渠道（sogou 微信、第三方 API），
      本 baseline 仅提供「搜索引擎查关键词 → 提取 mp.weixin.qq.com 链接」
      的兜底实现，技能实际使用时可替换为更稳定的 MCP 连接器。
    - 严禁编造链接：仅返回搜索结果中真实出现的 URL。
    """

    SEARCH_ENDPOINTS = (
        "https://www.sogou.com/weixin",
        "https://weixin.sogou.com/weixin",
    )

    def __init__(self, http: HttpClient) -> None:
        self.http = http

    def search(
        self,
        account: str,
        keywords: Iterable[str],
        cutoff_date: date,
    ) -> List[ArticleListItem]:
        """检索某公众号下与关键词相关的文章。

        返回 ArticleListItem 列表（source_url 已是 mp.weixin.qq.com 链接）。
        """
        items: List[ArticleListItem] = []
        seen_urls: set = set()
        for kw in keywords:
            query = f"{account} {kw}"
            for endpoint in self.SEARCH_ENDPOINTS:
                html = self.http.get_text(
                    endpoint,
                    params={"type": "2", "query": query, "ie": "utf8"},
                    referer="https://weixin.sogou.com/",
                )
                if not html:
                    continue
                # 提取 mp.weixin.qq.com 链接
                urls = re.findall(
                    r'https?://mp\.weixin\.qq\.com/s[^\s"\'<>]+',
                    html,
                )
                for raw_u in urls:
                    # HTML 实体还原：搜狗结果页 href 里的 & 通常编码为 &amp;，
                    # 不还原会导致后续 split/tracking 清理失效，且 http 请求带 &amp; 会 404
                    u = raw_u.replace("&amp;", "&")
                    # 清理 tracking 参数（&from= / &scene= / &chksm= 等），
                    # 保留 /s 或 /s?__biz=... 的核心部分，避免同文不同 URL 重复
                    for tracking in ("&from=", "&scene=", "&chksm=", "&sessionid="):
                        u = u.split(tracking, 1)[0]
                    if u in seen_urls:
                        continue
                    seen_urls.add(u)
                    # 解析标题（取相邻的 a 文本）
                    # 正则用原始 raw_u（含 &amp;）匹配 HTML，因为 HTML 里就是 &amp;
                    pattern = re.compile(
                        r'href=["\']' + re.escape(raw_u) + r'["\'][^>]*>([^<]+)</a>',
                    )
                    title_match = pattern.search(html)
                    title = title_match.group(1).strip() if title_match else ""
                    items.append(ArticleListItem(
                        title=title or f"{account} - {kw}",
                        source_url=u,
                        publish_date=None,  # 详情页解析时再补
                        category="公众号",
                        source_department=account,
                    ))
                if items:
                    break  # 此 endpoint 命中就不再换 endpoint
            time.sleep(DEFAULT_DELAY_MS / 1000.0)
        return items


# ============================================================================
# 11. 采集编排器
# ============================================================================

class _DetailFetchError(Exception):
    """详情页抓取失败（404/网络异常，html 为空）。

    用于区分「详情抓取失败」与「详情不合规」（时间窗/排除/关键词不匹配），
    前者计入 SyncResult.total_failed，后者计入 total_skipped。
    """


class CollectorOrchestrator:
    """采集主流程：列表 → 详情 → 关键词 → 输出。"""

    def __init__(
        self,
        sites: Optional[List[SiteConfig]] = None,
        http: Optional[HttpClient] = None,
        concurrency: int = 1,
    ) -> None:
        self.sites = sites or _build_default_sites()
        self.http = http or HttpClient()
        self.list_fetcher = ListFetcherFactory(self.http)
        self.detail_factory = DetailExtractorFactory(self.http)
        self.keyword_matcher = KeywordMatcher()
        self.summary_gen = SummaryGenerator()
        self.wechat_finder = WechatArticleFinder(self.http)
        self.concurrency = max(1, concurrency)
        self._seen_urls_lock = threading.Lock()
        self._seen_urls: set = set()

    def _select_sites(self, site_ids: Optional[List[str]]) -> List[SiteConfig]:
        if not site_ids:
            return self.sites
        return [s for s in self.sites if s.site_id in site_ids]

    def _process_detail(
        self, cfg: SiteConfig, item: ArticleListItem, cutoff_date: date,
    ) -> Optional[ArticleRecord]:
        """抓详情 + 关键词打分 + 时间窗过滤 → ArticleRecord。

        返回 None 的原因由调用方通过 SyncResult.total_failed 统计：
            - 详情页 404/网络失败（html 为空）→ total_failed
            - 详情页选择器全 miss（title 用 item.title 兜底，content 为空）→ total_skipped
            - 时间窗/排除规则/关键词不匹配 → total_skipped
        """
        if is_attachment_url(item.source_url):
            logging.debug("[skip attachment] %s", item.source_url)
            return None
        # 域名白名单二次校验（纵深防御：防止列表阶段漏过的跨站链接）
        if cfg.domain_whitelist:
            host = urllib.parse.urlparse(item.source_url).hostname or ""
            if not any(d in host for d in cfg.domain_whitelist):
                logging.debug("[skip domain not in whitelist] %s", item.source_url)
                return None
        # 去重
        with self._seen_urls_lock:
            if item.source_url in self._seen_urls:
                return None
            self._seen_urls.add(item.source_url)

        extractor = self.detail_factory.get_for_url(item.source_url)
        title, content, pub_date, _cover = extractor.fetch(cfg, item)

        # 详情抓取失败标记：html 为空（404/网络异常）导致 title 也为空
        detail_fetch_failed = not title and not content

        if not title:
            title = item.title
        if not content:
            content = ""
        if not pub_date:
            pub_date = item.publish_date

        # 详情抓取失败 → 返回特殊标记让调用方计入 total_failed
        if detail_fetch_failed:
            raise _DetailFetchError(item.source_url)

        # 时间窗：必须在 [cutoff, today]
        if not pub_date:
            logging.debug("[skip no date] %s", item.source_url)
            return None
        if pub_date.date() < cutoff_date:
            return None
        if pub_date.date() > date.today():
            # 防止站点显示未来日期
            return None

        # 排除规则
        if is_excluded_by_pattern(title, content):
            return None

        # 关键词匹配
        hits, relevance = self.keyword_matcher.match(title, content)
        if relevance not in ("强关联", "中等关联"):
            return None

        # 摘要
        summary = self.summary_gen.generate(title, content)

        return ArticleRecord(
            title=title,
            organization=cfg.organization,
            publish_time=pub_date.strftime("%Y-%m-%d"),
            summary=summary,
            keyword="、".join(hits) if hits else "",
            relevance=relevance,
            link=item.source_url,
        )

    def collect_site(
        self, cfg: SiteConfig, cutoff_date: date,
        include_wechat: bool = False,
    ) -> Tuple[List[ArticleRecord], SyncResult]:
        result = SyncResult()
        records: List[ArticleRecord] = []

        logging.info("=" * 60)
        logging.info("[%s] 开始采集 %s", cfg.site_id, cfg.organization)
        logging.info("=" * 60)

        # ---- 合并主栏目 + 额外栏目（SKILL.md 铁律 1：可采集工作动态/动态要闻/新闻中心/政务公开-工作动态 4 类栏目）----
        # 主栏目固定为 2 元组；额外栏目可能是 2 元组或 3 元组（含 extra_query 覆盖，用于 JSON API 不同 pageId）
        categories: List[Tuple] = (
            [(cfg.list_url, cfg.category)] + list(cfg.extra_categories)
        )
        logging.info(
            "[%s] 共 %d 个栏目待采集: %s",
            cfg.site_id, len(categories),
            " | ".join(entry[1] for entry in categories),
        )

        # 列表项与栏目级 cfg 绑定（详情处理需用栏目级 cat_cfg，否则栏目级覆盖的
        # detail_*_selectors / ssl_downgrade / extra_headers / list_url(referer) 不生效）
        work_items: List[Tuple[ArticleListItem, SiteConfig]] = []
        for cat_idx, cat_entry in enumerate(categories, start=1):
            cat_url = cat_entry[0]
            cat_name = cat_entry[1]
            cat_override = cat_entry[2] if len(cat_entry) >= 3 else None
            # 用 replace 创建临时 cfg 副本，保留所有选择器配置，仅替换 list_url 和 category
            cat_cfg = replace(cfg, list_url=cat_url, category=cat_name)
            # 3 元组覆盖：支持任意 SiteConfig 字段 + extra_query / api_post_data 合并
            # 用于：浙江 {"pageId": "xxx"} 切 JSON API 栏目 / 福建 {"list_strategy": "static"} 切回静态 HTML
            if cat_override:
                field_overrides: Dict[str, Any] = {}
                extra_query_merge: Dict[str, Any] = {}
                api_post_data_merge: Dict[str, Any] = {}
                for k, v in cat_override.items():
                    if k == "extra_query" and isinstance(v, dict):
                        extra_query_merge.update(v)
                    elif k == "api_post_data" and isinstance(v, dict):
                        api_post_data_merge.update(v)
                    elif hasattr(cat_cfg, k):
                        field_overrides[k] = v
                    else:
                        # 不是 SiteConfig 字段 → 视为 extra_query 的子项（兼容浙江 pageId 用法）
                        extra_query_merge[k] = v
                if extra_query_merge:
                    merged_query = dict(cat_cfg.extra_query or {})
                    merged_query.update(extra_query_merge)
                    field_overrides["extra_query"] = merged_query
                if api_post_data_merge:
                    merged_post = dict(cat_cfg.api_post_data or {})
                    merged_post.update(api_post_data_merge)
                    field_overrides["api_post_data"] = merged_post
                if field_overrides:
                    cat_cfg = replace(cat_cfg, **field_overrides)
                logging.info(
                    "[%s] 切换到额外栏目: %s (%s) | 覆盖字段: %s",
                    cfg.site_id, cat_name, cat_url, cat_override,
                )
            elif cat_idx > 1:
                logging.info(
                    "[%s] 切换到额外栏目: %s (%s)",
                    cfg.site_id, cat_name, cat_url,
                )
            try:
                cat_items = self.list_fetcher.fetch_all(cat_cfg, cutoff_date)
            except Exception as exc:
                logging.error(
                    "[%s] 列表抓取异常（栏目 %s）: %s",
                    cfg.site_id, cat_name, exc,
                )
                cat_items = []
            logging.info(
                "[%s] 栏目 %s 列表阶段完成，候选 %d 条",
                cfg.site_id, cat_name, len(cat_items),
            )
            # 绑定栏目级 cat_cfg，供后续详情处理使用
            for it in cat_items:
                work_items.append((it, cat_cfg))

            # 公众号只在主栏目抓完后补充一次（避免重复检索）
            if cat_idx == 1 and include_wechat and cfg.wechat_account:
                try:
                    wx_items = self.wechat_finder.search(
                        cfg.wechat_account, WECHAT_SEARCH_KEYWORDS, cutoff_date,
                    )
                    logging.info(
                        "[%s] 公众号检索补充 %d 条",
                        cfg.site_id, len(wx_items),
                    )
                    # 公众号文章用原始 cfg 处理（WeixinDetailExtractor 自带选择器）
                    for it in wx_items:
                        work_items.append((it, cfg))
                except Exception as exc:
                    logging.warning("[%s] 公众号检索失败: %s", cfg.site_id, exc)

        # 去重（多个栏目可能有相同文章，按 source_url 去重，保留首次出现的 cat_cfg）
        seen_urls = set()
        deduped_items: List[Tuple[ArticleListItem, SiteConfig]] = []
        for it, c_cfg in work_items:
            if it.source_url not in seen_urls:
                seen_urls.add(it.source_url)
                deduped_items.append((it, c_cfg))
        if len(deduped_items) < len(work_items):
            logging.info(
                "[%s] 多栏目去重 %d -> %d",
                cfg.site_id, len(work_items), len(deduped_items),
            )
        work_items = deduped_items

        # ---- 详情 + 打分（使用栏目级 cat_cfg）----
        def _work(item: ArticleListItem, item_cfg: SiteConfig) -> Optional[ArticleRecord]:
            try:
                rec = self._process_detail(item_cfg, item, cutoff_date)
                return rec
            except _DetailFetchError:
                # 透传到外层计入 total_failed（区分「抓取失败」与「不合规跳过」）
                # 必须放在 except Exception 之前，否则会被吞掉
                raise
            except Exception as exc:
                logging.warning(
                    "[%s] 详情处理失败 %s: %s",
                    cfg.site_id, item.source_url, exc,
                )
                return None
            finally:
                time.sleep(DETAIL_DELAY_MS / 1000.0)

        if self.concurrency > 1:
            with ThreadPoolExecutor(max_workers=self.concurrency) as pool:
                futures = {pool.submit(_work, it, c): (it, c) for it, c in work_items}
                for idx, fut in enumerate(as_completed(futures), start=1):
                    try:
                        rec = fut.result()
                    except _DetailFetchError as exc:
                        # 详情页 404/网络失败，与「不合规」区分统计
                        result.total_detail_fetched += 1
                        result.total_failed += 1
                        logging.debug("[detail fetch failed] %s", exc)
                    else:
                        result.total_detail_fetched += 1
                        if rec:
                            records.append(rec)
                            result.total_new += 1
                        else:
                            result.total_skipped += 1
                    if idx % 10 == 0:
                        logging.info(
                            "[%s] 进度 %d/%d（命中 %d）",
                            cfg.site_id, idx, len(work_items), len(records),
                        )
        else:
            for idx, (item, item_cfg) in enumerate(work_items, start=1):
                try:
                    rec = _work(item, item_cfg)
                except _DetailFetchError as exc:
                    result.total_detail_fetched += 1
                    result.total_failed += 1
                    logging.debug("[detail fetch failed] %s", exc)
                else:
                    result.total_detail_fetched += 1
                    if rec:
                        records.append(rec)
                        result.total_new += 1
                    else:
                        result.total_skipped += 1
                if idx % 10 == 0:
                    logging.info(
                        "[%s] 进度 %d/%d（命中 %d）",
                        cfg.site_id, idx, len(work_items), len(records),
                    )

        logging.info("[%s] 采集完成 %s", cfg.site_id, result)
        # 详情失败率告警：抓取 ≥5 条详情但 0 命中，大概率详情页选择器配错或反爬
        # （区分于「列表就有合规文章但详情抓不到」与「列表无合规文章」两种场景）
        if result.total_detail_fetched >= 5 and result.total_new == 0:
            logging.warning(
                "[%s] 详情抓取 %d 条但 0 命中，请检查 detail_*_selectors 配置"
                "或站点反爬（域名白名单: %s）",
                cfg.site_id, result.total_detail_fetched,
                cfg.domain_whitelist or "(无)",
            )
        return records, result

    def collect(
        self,
        days_back: int = 7,
        site_ids: Optional[List[str]] = None,
        include_wechat: bool = False,
    ) -> Tuple[List[ArticleRecord], Dict[str, SyncResult]]:
        # 时间窗：保留 [today - days_back + 1, today]，共 days_back 天（含当天）
        # 例：days_back=7 → 保留 [today-6, today]，共 7 天
        cutoff_date = date.today() - timedelta(days=days_back - 1)

        # 重置详情级去重集合：避免同一进程内多次调用 collect() 时，
        # 上一次的 _seen_urls 让本次所有详情被 short-circuit 成 None（误计入 total_skipped）
        with self._seen_urls_lock:
            self._seen_urls.clear()

        targets = self._select_sites(site_ids)
        all_records: List[ArticleRecord] = []
        all_results: Dict[str, SyncResult] = {}

        for cfg in targets:
            records, res = self.collect_site(cfg, cutoff_date, include_wechat)
            all_records.extend(records)
            all_results[cfg.site_id] = res

        # 全局去重（按 link）
        seen: set = set()
        deduped: List[ArticleRecord] = []
        for r in all_records:
            if r.link in seen:
                continue
            seen.add(r.link)
            deduped.append(r)

        # 排序：关联度优先（强关联在前），同关联度内按时间倒序
        relevance_order = {"强关联": 0, "中等关联": 1}
        def _sort_key(r: ArticleRecord) -> Tuple[int, int]:
            rel = relevance_order.get(r.relevance, 99)
            # publish_time 格式 yyyy-mm-dd，转成 yyyymmdd 整数便于倒序；
            # 防御格式异常（空串/非零填充日期）导致 ValueError
            try:
                ts = int(r.publish_time.replace("-", "") or "0")
            except (ValueError, AttributeError):
                ts = 0
            return (rel, -ts)
        deduped.sort(key=_sort_key)

        return deduped, all_results


# ============================================================================
# 12. 输出格式化
# ============================================================================

class OutputFormatter:
    """TXT + JSON 双格式输出（严格按 SKILL.md 要求）。"""

    @staticmethod
    def to_txt(records: List[ArticleRecord]) -> str:
        if not records:
            return "本次采集周期内无匹配文章。"
        blocks: List[str] = []
        for r in records:
            blocks.append(
                f"标题：{r.title}\n"
                f"单位：{r.organization}\n"
                f"时间：{r.publish_time}\n"
                f"总结：{r.summary}\n"
                f"关键词：{r.keyword}\n"
                f"关联度：{r.relevance}\n"
                f"链接：{r.link}\n"
                f"---"
            )
        return "\n".join(blocks) + "\n"

    @staticmethod
    def to_json(records: List[ArticleRecord]) -> str:
        if not records:
            return "[]"
        return json.dumps(
            [asdict(r) for r in records],
            ensure_ascii=False,
            indent=2,
        )

    @staticmethod
    def write_files(
        records: List[ArticleRecord], output_dir: str,
    ) -> Tuple[str, str]:
        os.makedirs(output_dir, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        txt_path = os.path.join(output_dir, f"informatization_news_{stamp}.txt")
        json_path = os.path.join(output_dir, f"informatization_news_{stamp}.json")
        with open(txt_path, "w", encoding="utf-8") as f:
            f.write(OutputFormatter.to_txt(records))
        with open(json_path, "w", encoding="utf-8") as f:
            f.write(OutputFormatter.to_json(records))
        return txt_path, json_path


# ============================================================================
# 13. CLI 入口
# ============================================================================

def _setup_logging(verbose: bool) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="baseline_collector",
        description="统计信息化动态采集器 - Baseline 参考实现",
    )
    p.add_argument(
        "--days-back", type=int, default=7,
        help="时间窗口（天，默认 7）",
    )
    p.add_argument(
        "--sites", type=str, default="",
        help="站点 ID 列表（逗号分隔），留空 = 全部 24 个（19 SKILL + 5 Java 扩展）",
    )
    p.add_argument(
        "--list-sites", action="store_true",
        help="列出全部站点 ID 后退出",
    )
    p.add_argument(
        "--include-wechat", action="store_true",
        help="同时检索官方微信公众号文章",
    )
    p.add_argument(
        "--concurrency", type=int, default=1,
        help="详情页并发数（默认 1，建议 ≤4）",
    )
    p.add_argument(
        "--output-dir", type=str, default="./output",
        help="输出目录（默认 ./output）",
    )
    p.add_argument(
        "--stdout", action="store_true",
        help="同时打印 TXT/JSON 到标准输出",
    )
    p.add_argument(
        "--json-only", action="store_true",
        help="仅输出 JSON（覆盖 --stdout 的 TXT 部分）",
    )
    p.add_argument(
        "--timeout", type=int, default=DEFAULT_TIMEOUT,
        help=f"HTTP 超时秒数（默认 {DEFAULT_TIMEOUT}）",
    )
    p.add_argument(
        "--retry", type=int, default=DEFAULT_RETRY,
        help=f"HTTP 重试次数（默认 {DEFAULT_RETRY}）",
    )
    p.add_argument(
        "--verbose", action="store_true",
        help="调试日志",
    )
    return p.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    _setup_logging(args.verbose)

    # 全局 SSL 信任
    trust_all_ssl()

    sites = _build_default_sites()
    if args.list_sites:
        print(f"共 {len(sites)} 个站点配置")
        print("-" * 100)
        for s in sites:
            cat_names = [s.category] + [entry[1] for entry in s.extra_categories]
            print(
                f"{s.site_id}\t{s.organization}\t"
                f"栏目数={len(cat_names)}\t"
                f"栏目={','.join(cat_names)}\t"
                f"{s.list_url}"
            )
        print("-" * 100)
        total_cats = sum(1 + len(s.extra_categories) for s in sites)
        print(f"合计：{len(sites)} 个站点，{total_cats} 个栏目（平均 {total_cats/len(sites):.1f} 个/站点）")
        return 0

    site_ids = [x.strip() for x in args.sites.split(",") if x.strip()] or None
    if site_ids:
        unknown = [x for x in site_ids if not any(s.site_id == x for s in sites)]
        if unknown:
            logging.error("未知站点 ID: %s", unknown)
            return 2

    orch = CollectorOrchestrator(
        sites=sites,
        http=HttpClient(timeout=args.timeout, retry=args.retry),
        concurrency=args.concurrency,
    )

    records, results = orch.collect(
        days_back=args.days_back,
        site_ids=site_ids,
        include_wechat=args.include_wechat,
    )

    # 落盘
    txt_path, json_path = OutputFormatter.write_files(records, args.output_dir)
    logging.info("输出 TXT: %s", txt_path)
    logging.info("输出 JSON: %s", json_path)

    # 打印汇总
    print("\n========== 采集汇总 ==========")
    for sid, res in results.items():
        print(f"  {sid}: {res}")
    print(f"  总命中: {len(records)} 条")

    if args.stdout:
        if not args.json_only:
            print("\n========== TXT 输出 ==========")
            print(OutputFormatter.to_txt(records))
        print("\n========== JSON 输出 ==========")
        print(OutputFormatter.to_json(records))

    return 0


if __name__ == "__main__":
    sys.exit(main())
