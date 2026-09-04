# Adaptive Temperature Modulation (ATM)

ATM dynamically adjusts the LLM's temperature based on task type. Precise tasks get low temperature; creative tasks get high temperature — automatically.

## Temperature Profiles

| Profile | Range | Triggers |
|---------|-------|----------|
| **Precise** | 0.1–0.3 | Code generation, debugging, math, config editing, exact lookups |
| **Balanced** | 0.4–0.6 | General Q&A, summarization, analysis |
| **Creative** | 0.7–0.9 | Writing, brainstorming, naming, design |
| **Exploratory** | 0.9–1.2 | Open-ended exploration, philosophical questions, ideation |

## How It Works

1. Each inbound message is classified by pattern matching against the task content
2. Keywords and patterns map to a temperature profile
3. The profile's temperature overrides the global setting for that turn
4. The original temperature is restored after the turn completes

## Pattern Matching

ATM uses keyword-based detection:

| Keywords | Profile |
|----------|---------|
| `fix`, `debug`, `error`, `bug`, `compile`, `test` | Precise |
| `explain`, `summarize`, `analyze`, `compare` | Balanced |
| `write`, `create`, `design`, `brainstorm`, `name` | Creative |
| `explore`, `imagine`, `what if`, `philosophy` | Exploratory |

## Configuration

Enable and customize ATM in `mach6.json`:

```json
{
  "temperature": 0.5,
  "atm": {
    "enabled": true,
    "profiles": {
      "precise": { "min": 0.1, "max": 0.3 },
      "balanced": { "min": 0.4, "max": 0.6 },
      "creative": { "min": 0.7, "max": 0.9 },
      "exploratory": { "min": 0.9, "max": 1.2 }
    }
  }
}
```

When ATM is disabled, the global `temperature` value is used for all turns.

## Per-Message Override

Override temperature for a specific message:

```
/temperature 0.1
```

This bypasses ATM for the current turn only.
