# Prompt Engineering

> **Applies to:** writing or tuning LLM prompts and AI features. Not relevant to non-AI code.

## Core Principles

- Be explicit about the task, context, and desired output format upfront.
- One prompt, one goal — don't bundle multiple unrelated tasks into a single prompt.
- Show, don't just tell: include examples (few-shot) when the format or behavior is non-obvious.
- Specify constraints explicitly: length, tone, language, what to avoid.

## Prompt Structure

Preferred order for complex prompts:

1. **Role / context** — who the model is or what it knows
2. **Task** — what it must do, in one sentence
3. **Input** — the data or text to work with
4. **Constraints** — format, length, things to avoid
5. **Output format** — exact structure expected (JSON, markdown, list, etc.)

```
You are a senior copywriter for a glass-design company.
Task: Write a 3-sentence product description for the item below.
Input: [product details]
Constraints: No superlatives, use second-person ("you"), max 60 words.
Output: Plain paragraph, no headers or bullets.
```

## System vs User Messages

- System message: persistent identity, behavioral rules, output format contracts.
- User message: the actual task and input data.
- Never mix identity instructions into user messages — they get overridden easily.

## Few-Shot Examples

- Use 2–3 examples when the output pattern is non-trivial.
- Examples must match the exact format you want back — inconsistent examples produce inconsistent output.
- Order matters: put the most representative example last (recency bias).

## Chaining

- Break multi-step reasoning into sequential prompts — don't ask the model to do 5 things in one shot.
- Pass only the relevant output of step N into step N+1; don't carry the full history.
- For classification → extraction → rewrite pipelines: validate the output of each step before moving on.

## Temperature & Sampling

| Use case | Temperature |
|---|---|
| Data extraction, classification | 0 – 0.2 |
| Copywriting, product descriptions | 0.5 – 0.8 |
| Brainstorming, ideation | 0.9 – 1.2 |

- Keep temperature at 0 for anything that must be deterministic (structured data, code).
- Don't raise temperature to "fix" bad prompts — fix the prompt first.

## Variables in Prompts

- Mark dynamic inputs clearly: `{{product_name}}`, `{{user_input}}`.
- Sanitize user-supplied content before interpolating — prevent prompt injection.
- Never concatenate raw user input directly into a system message.

## Evaluation

- Write an eval set (10–20 examples) before iterating on a production prompt.
- A prompt change that improves one case may regress another — always test the full set.
- Log prompt + input + output in production for offline analysis.

## Common Mistakes

- **Under-specifying format**: "Give me a list" is ambiguous — say "numbered list, one item per line".
- **Over-prompting**: Adding 10 rules bloats the prompt and the model starts ignoring some.
- **Vague negatives**: "Don't be too formal" — say "Use casual tone, as if texting a colleague".
- **No grounding**: Asking for facts without providing source material leads to hallucinations.
- **Changing two things at once**: When iterating, change one variable per test so you know what worked.
