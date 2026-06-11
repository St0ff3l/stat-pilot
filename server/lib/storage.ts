import { promises as fs } from "node:fs";
import path from "node:path";
import type { ArticleAnalysis, ArticleRecord, ArticleStore } from "../types.js";

const dataFile = path.resolve(process.cwd(), "data/articles.json");

async function ensureStore(): Promise<ArticleStore> {
  try {
    const raw = await fs.readFile(dataFile, "utf8");
    return JSON.parse(raw) as ArticleStore;
  } catch {
    const initial: ArticleStore = { articles: [] };
    await fs.mkdir(path.dirname(dataFile), { recursive: true });
    await fs.writeFile(dataFile, JSON.stringify(initial, null, 2), "utf8");
    return initial;
  }
}

async function saveStore(store: ArticleStore): Promise<void> {
  await fs.writeFile(dataFile, JSON.stringify(store, null, 2), "utf8");
}

export async function listArticles(): Promise<ArticleRecord[]> {
  const store = await ensureStore();
  return [...store.articles].sort((a, b) =>
    b.publishedAt.localeCompare(a.publishedAt),
  );
}

export async function getArticle(articleId: string): Promise<ArticleRecord | null> {
  const store = await ensureStore();
  return store.articles.find((article) => article.id === articleId) ?? null;
}

export async function upsertArticles(items: ArticleRecord[]): Promise<ArticleRecord[]> {
  const store = await ensureStore();
  const byId = new Map<string, ArticleRecord>(
    store.articles.map((article) => [article.id, article]),
  );

  for (const item of items) {
    const previous = byId.get(item.id);
    byId.set(item.id, {
      ...(previous ?? item),
      ...item,
      analysis: previous?.analysis ?? item.analysis ?? null,
    });
  }

  store.articles = Array.from(byId.values());
  await saveStore(store);

  return listArticles();
}

export async function saveAnalysis(
  articleId: string,
  analysis: ArticleAnalysis,
): Promise<ArticleRecord> {
  const store = await ensureStore();
  const index = store.articles.findIndex((article) => article.id === articleId);

  if (index === -1) {
    throw new Error(`Article not found: ${articleId}`);
  }

  store.articles[index] = {
    ...store.articles[index],
    analysis,
  };

  await saveStore(store);
  return store.articles[index];
}
