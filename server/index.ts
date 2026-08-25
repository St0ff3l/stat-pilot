import express from "express";
import { crawlSource } from "./lib/crawler.js";
import { analyzeArticleWithOpenAICompatibleApi } from "./lib/openai-compatible-analyzer.js";
import { getArticle, listArticles, saveAnalysis, upsertArticles } from "./lib/storage.js";
import { getSkillByName, listLocalSkills } from "./lib/skills.js";
import type { CrawlSourceInput } from "./types.js";

const app = express();
const port = Number(process.env.PORT ?? 8787);

app.use(express.json({ limit: "2mb" }));

app.get("/api/health", async (_req, res) => {
  const skills = await listLocalSkills();
  res.json({
    ok: true,
    service: "stat-pilot",
    localSkillsDetected: skills.length,
  });
});

app.get("/api/articles", async (_req, res) => {
  const articles = await listArticles();
  res.json({ data: articles });
});

app.get("/api/skills", async (_req, res) => {
  const skills = await listLocalSkills();
  res.json({ data: skills });
});

app.post("/api/crawl/run", async (req, res) => {
  try {
    const input = req.body as CrawlSourceInput;

    if (!input.sourceName || !input.sourceUrl || !input.listItemSelector) {
      res.status(400).json({
        error: "sourceName, sourceUrl, and listItemSelector are required.",
      });
      return;
    }

    const items = await crawlSource(input);
    const saved = await upsertArticles(items);

    res.json({
      crawled: items.length,
      data: saved,
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Crawl failed.",
    });
  }
});

app.post("/api/articles/:articleId/analyze", async (req, res) => {
  try {
    const article = await getArticle(req.params.articleId);
    const skillName = String(req.body?.skillName ?? "");
    const provider = {
      providerName: String(req.body?.providerName ?? ""),
      baseUrl: String(req.body?.baseUrl ?? ""),
      apiKey: String(req.body?.apiKey ?? ""),
      model: String(req.body?.model ?? ""),
    };

    if (!article) {
      res.status(404).json({ error: "Article not found." });
      return;
    }

    if (!skillName) {
      res.status(400).json({ error: "skillName is required." });
      return;
    }

    const skill = await getSkillByName(skillName);

    if (!skill) {
      res.status(404).json({ error: `Skill not found: ${skillName}` });
      return;
    }

    const output = await analyzeArticleWithOpenAICompatibleApi({
      articleTitle: article.title,
      articleContent: article.content,
      skillName: skill.name,
      skillPath: skill.path,
      provider,
    });

    const updated = await saveAnalysis(article.id, {
      skillName: skill.name,
      output,
      createdAt: new Date().toISOString(),
    });

    res.json({ data: updated });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Analysis failed.",
    });
  }
});

app.listen(port, () => {
  console.log(`深小统 API listening on http://localhost:${port}`);
});
