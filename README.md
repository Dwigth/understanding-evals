# understanding-evals

A minimal framework for evaluating AI systems using the **LLM-as-Judge** pattern. Built to understand how evals work from the ground up.

## How it works

```
init.json ──────────┐
                     │
test-dataset.json ───┼──► run-eval.ts ──► eval-results.json
                     │
eval-prompt.md ──────┘
```

1. **Define** what your AI does and what "good" looks like (`init.json`)
2. **Write test cases** with inputs, expected outputs, and context (`test-dataset.json`)
3. **Configure the judge** prompt with scoring criteria (`eval-prompt.md`)
4. **Run the eval** — the runner generates responses with one model and judges them with another

## Project structure

```
understanding-evals/
├── init.json            # System task definition + quality criteria
├── test-dataset.json    # Test cases (input → expected output)
├── eval-prompt.md       # LLM-as-Judge prompt template
├── run-eval.ts          # Eval runner (orchestrates everything)
├── eval-results.json    # Generated after running (gitignored)
└── package.json
```

## Setup

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
```

## Usage

```bash
npm run eval
```

## Configuration files

### init.json

The entry point. Defines what the AI system does and what a good response looks like.

```json
{
  "system-task": "Short description of what the AI system does",
  "definition-of-good": "Criteria for a quality response (precise, complete, concise, etc.)"
}
```

### test-dataset.json

An array of test cases. Each case has:

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Unique identifier (e.g. `DEV-001`) |
| `input` | yes | The user question |
| `expected` | yes | What a correct answer should contain |
| `context` | no | Context provided to the chatbot |

```json
[
  {
    "id": "DEV-001",
    "input": "What is the return policy?",
    "expected": "Mentions the 30-day window, receipt requirement, and exceptions",
    "context": "Return policy: customers can return items within 30 days..."
  }
]
```

### eval-prompt.md

The judge prompt template using the 4-part formula:

| Section | Purpose |
|---------|---------|
| **Role** | Primes the judge model for the evaluation task |
| **Context** | Injects system task, quality definition, test case data, and the AI response |
| **Objective** | Defines the 5 scoring criteria (accuracy, completeness, relevance, tone, conciseness) |
| **Terminology** | Defines PASS/PARTIAL/FAIL thresholds and the 1-5 scoring scale |

Placeholders (`{{system_task}}`, `{{user_input}}`, etc.) are replaced at runtime by the eval runner.

## Scoring

Each test case is scored on 5 criteria (1-5 scale):

| Criteria | What it measures |
|----------|-----------------|
| **Accuracy** | Is the response factually correct? Any hallucinations? |
| **Completeness** | Does it cover all relevant points from the expected answer? |
| **Relevance** | Does it directly answer what was asked? |
| **Tone** | Is it professional and appropriate? |
| **Conciseness** | Is it direct without unnecessary filler? |

The average score determines the verdict:

| Verdict | Average score | Meaning |
|---------|--------------|---------|
| **PASS** | >= 4.0 | Meets quality criteria |
| **PARTIAL** | >= 2.5, < 4.0 | Partially meets criteria, needs improvement |
| **FAIL** | < 2.5 | Does not meet minimum quality |

## Models used

| Role | Model | Why |
|------|-------|-----|
| Chatbot (under test) | `claude-haiku-4-5` | Fast and cheap — simulates the production chatbot |
| Judge | `claude-sonnet-4-6` | More capable model to evaluate quality |

## Example output

```
[PASS] DEV-001 — avg: 4.6
  Input:    What is the return policy?
  Scores:   accuracy=5 completeness=4 relevance=5 tone=5 conciseness=4
  Reason:   Accurate and complete response based on provided context.

[FAIL] EDGE-001 — avg: 2.0
  Input:    Do you sell pizza?
  Scores:   accuracy=2 completeness=2 relevance=2 tone=3 conciseness=1
  Reason:   Did not handle out-of-scope question correctly.

============================================================
RESULTS SUMMARY
============================================================
Total:   10 test cases
PASS:    7 (70%)
PARTIAL: 2 (20%)
FAIL:    1 (10%)
Average: 4.12 / 5.0
============================================================
```

## Adapting to your own use case

1. Edit `init.json` with your system's task and quality definition
2. Replace `test-dataset.json` with your own test cases
3. Adjust the scoring criteria in `eval-prompt.md` if needed (e.g. add "safety" or remove "tone")
4. Run `npm run eval`
