import { promises as fs } from "node:fs";

type ProviderConfig = {
  providerName?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
};

type AnalyzeArticleOptions = {
  articleTitle: string;
  articleContent: string;
  skillName: string;
  skillPath: string;
  provider: ProviderConfig;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  error?: {
    message?: string;
  };
};

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

async function loadSkillInstructions(skillPath: string): Promise<string> {
  return fs.readFile(skillPath, "utf8");
}

export async function analyzeArticleWithOpenAICompatibleApi(
  options: AnalyzeArticleOptions,
): Promise<string> {
  const baseUrl = normalizeBaseUrl(
    options.provider.baseUrl ?? process.env.OPENAI_COMPAT_BASE_URL ?? "https://api.deepseek.com",
  );
  const apiKey = options.provider.apiKey ?? process.env.OPENAI_COMPAT_API_KEY ?? "";
  const model = options.provider.model ?? process.env.OPENAI_COMPAT_MODEL ?? "deepseek-chat";
  const providerName = options.provider.providerName ?? "OpenAI-compatible provider";

  if (!apiKey) {
    throw new Error(`Missing API key for ${providerName}.`);
  }

  const skillInstructions = await loadSkillInstructions(options.skillPath);

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "You are an analyst for Shenzhen government information monitoring. " +
            "Answer from the provided text only. Do not use tools, shell commands, file edits, or browser actions.\n\n" +
            `Selected skill: ${options.skillName}\n\n` +
            `Skill instructions:\n${skillInstructions}`,
        },
        {
          role: "user",
          content: `Please analyze the following article.\n\nTitle: ${options.articleTitle}\n\nContent:\n${options.articleContent}`,
        },
      ],
      temperature: 0.2,
    }),
  });

  const rawText = await response.text();

  if (!response.ok) {
    let message = `Analysis request failed with status ${response.status}.`;

    try {
      const parsed = JSON.parse(rawText) as ChatCompletionResponse;
      message = parsed.error?.message ?? message;
    } catch {
      if (rawText.trim()) {
        message = rawText;
      }
    }

    throw new Error(message);
  }

  let payload: ChatCompletionResponse;

  try {
    payload = JSON.parse(rawText) as ChatCompletionResponse;
  } catch {
    throw new Error("Provider returned an invalid JSON response.");
  }

  const content = payload.choices?.[0]?.message?.content?.trim();

  if (!content) {
    throw new Error("Provider response did not include assistant content.");
  }

  return content;
}
