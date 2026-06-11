export type SkillSummary = {
  name: string;
  description: string;
  path: string;
};

export type ArticleAnalysis = {
  skillName: string;
  output: string;
  createdAt: string;
};

export type ArticleRecord = {
  id: string;
  title: string;
  url: string;
  sourceName: string;
  sourceUrl: string;
  publishedAt: string;
  fetchedAt: string;
  summary: string;
  content: string;
  tags: string[];
  analysis: ArticleAnalysis | null;
};

export type ArticleStore = {
  articles: ArticleRecord[];
};

export type CrawlSourceInput = {
  sourceName: string;
  sourceUrl: string;
  listItemSelector: string;
  titleSelector: string;
  linkSelector: string;
  dateSelector?: string;
  articleBodySelector?: string;
  maxItems?: number;
};
