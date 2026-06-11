import crypto from "node:crypto";
import * as cheerio from "cheerio";
import type { ArticleRecord, CrawlSourceInput } from "../types.js";

function toAbsoluteUrl(sourceUrl: string, maybeRelative: string): string {
  try {
    return new URL(maybeRelative, sourceUrl).toString();
  } catch {
    return maybeRelative;
  }
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function fallbackSummary(content: string): string {
  return cleanText(content).slice(0, 120) || "No summary available.";
}

async function fetchArticleContent(url: string, selector?: string): Promise<string> {
  try {
    const response = await fetch(url);
    const html = await response.text();
    const $ = cheerio.load(html);
    if (selector) {
      return cleanText($(selector).text());
    }
    return cleanText($("article").text() || $("body").text());
  } catch {
    return "";
  }
}

export async function crawlSource(input: CrawlSourceInput): Promise<ArticleRecord[]> {
  const response = await fetch(input.sourceUrl);
  const html = await response.text();
  const $ = cheerio.load(html);
  const now = new Date().toISOString();
  const maxItems = Math.max(1, Math.min(input.maxItems ?? 10, 30));

  const records = await Promise.all(
    $(input.listItemSelector)
      .slice(0, maxItems)
      .toArray()
      .map(async (element) => {
        const root = $(element);
        const title = cleanText(root.find(input.titleSelector).first().text());
        const href =
          root.find(input.linkSelector).first().attr("href") ??
          root.find(input.titleSelector).first().attr("href") ??
          input.sourceUrl;
        const url = toAbsoluteUrl(input.sourceUrl, href);
        const publishedAtText = input.dateSelector
          ? cleanText(root.find(input.dateSelector).first().text())
          : "";
        const content = await fetchArticleContent(url, input.articleBodySelector);

        const id = crypto
          .createHash("sha1")
          .update(`${input.sourceName}:${url}`)
          .digest("hex");

        const publishedAt = publishedAtText
          ? new Date(publishedAtText).toISOString()
          : now;

        return {
          id,
          title: title || url,
          url,
          sourceName: input.sourceName,
          sourceUrl: input.sourceUrl,
          publishedAt,
          fetchedAt: now,
          summary: fallbackSummary(content || title),
          content: content || title,
          tags: [],
          analysis: null,
        } satisfies ArticleRecord;
      }),
  );

  return records.filter((item) => item.title);
}
