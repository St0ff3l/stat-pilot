import { promises as fs } from "node:fs";
import path from "node:path";
import type { SkillSummary } from "../types.js";

const defaultSkillRoot = path.resolve(process.cwd(), "skills");

export async function listLocalSkills(skillRoot = defaultSkillRoot): Promise<SkillSummary[]> {
  const entries = await fs.readdir(skillRoot, { withFileTypes: true }).catch(() => []);
  const localSkills: SkillSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name === ".DS_Store" || entry.name.startsWith("._")) {
      continue;
    }

    const skillFile = path.join(skillRoot, entry.name, "SKILL.md");
    const content = await fs.readFile(skillFile, "utf8").catch(() => "");
    const descriptionLine = content
      .split("\n")
      .find((line) => line.trim().startsWith("description:"));
    const displayNameLine = content
      .split("\n")
      .find((line) => line.trim().startsWith("display_name:"));

    const displayName = displayNameLine
      ? displayNameLine.replace("display_name:", "").trim().replace(/^["']|["']$/g, "")
      : undefined;

    localSkills.push({
      name: entry.name,
      ...(displayName ? { displayName } : {}),
      description: descriptionLine
        ? descriptionLine.replace("description:", "").trim().replace(/^"|"$/g, "")
        : "Local project skill",
      path: skillFile,
    });
  }

  return localSkills;
}

export async function getSkillByName(
  skillName: string,
  skillRoot = defaultSkillRoot,
): Promise<SkillSummary | null> {
  const skills = await listLocalSkills(skillRoot);
  return skills.find((skill) => skill.name === skillName) ?? null;
}
