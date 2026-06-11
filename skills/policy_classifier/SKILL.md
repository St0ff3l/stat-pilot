---
name: "policy_classifier"
description: "Classify a government article into clear policy themes and risk-free operational labels."
---

# Policy Classifier

Classify a government article into a few stable labels.

## Labeling dimensions

- Theme: investment, talent, industry, education, housing, transport, health, market regulation, public notice, or other
- Actionability: high, medium, low
- Audience: enterprise, citizen, institution, or mixed

## Rules

- Output a compact JSON-like block in plain text.
- Use only evidence from the input article.
- Keep labels simple and reusable across many sources.
