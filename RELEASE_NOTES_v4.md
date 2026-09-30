# Symbiote v4.0.0 — The Meta-Cognitive Release

**The runtime that thinks about how it thinks.**

v4.0.0 introduces the Meta-Cognitive Layer — a closed-loop self-improvement cycle that lets Symbiote reflect on its own performance, learn from outcomes, and refine its routing rules over time. This is the biggest architectural upgrade since the original runtime: five new subsystems, six new providers, and a fully overhauled documentation set.

---

## 🧠 The Meta-Cognitive Layer

Five subsystems form a closed feedback loop around the core runtime:

### SARSI — Self-Aware Routing & Self-Improvement
A versioned self-model of the system's identity, capabilities, routing rules, and goals. Persists atomically to disk with backup recovery. Injected into the system prompt so the LLM knows its own routing identity every turn.

- Identity, capabilities, routing rules (with confidence scores), goals, performance metrics
- Atomic disk persistence with `.bak` recovery and merge-on-load
- `initSARSI()` boots the self-model at daemon startup

### Curator — Background Review
Periodically reviews recent interactions, identifies patterns (success/failure rates, latency trends, tool usage), and proposes SARSI rule updates. Runs on a configurable interval (default: 5 minutes).

- Proposes rule additions, confidence adjustments, and deprecations
- All proposals flow through Meta^n for validation before applying
- Non-blocking — never affects response latency

### Meta^n — Recursive Self-Improvement
The recursive meta-cognitive loop. Each iteration: collect metrics from SARSI + Curator → generate improvement proposals → validate against safety constraints → commit, roll back, or hold → update the self-model.

### MEA — Meta-Epistemic Audit
Audit gate that evaluates response adequacy before delivery. Can flag responses as inadequate, triggering re-processing with adjusted parameters.

- Evaluates: completeness, accuracy, tool usage efficiency, context adherence
- Returns `{ adequate, score, issues, suggestions }`
- Non-blocking by default — can be made strict for critical paths

### PARC — Parallel Adaptive Routing & Cognition
Pre-routes messages to optimal providers based on task type detection (simple_qa, code_gen, reasoning, creative, tool_use, multi_step). Post-delivers outcomes back to SARSI for learning.

- `preRoute()` — analyzes message → returns `{ provider, model, taskType, confidence, ruleId }`
- `postDeliver()` — feeds outcome (latency, tokens, errors, iterations) back to SARSI metrics + Curator + Meta^n
- All learning is fire-and-forget — never blocks responses

---

## 🔌 Six New Providers (14 total)

| Provider | Auth | Note |
|----------|------|------|
| **OpenRouter** | `OPENROUTER_API_KEY` | Multi-model aggregator |
| **NVIDIA** | `NVIDIA_API_KEY` | NIM-powered models |
| **Qwen** | `QWEN_API_KEY` | Alibaba's Qwen family via DashScope |
| **AIHorde** | Horde key (optional) | Crowdsourced distributed inference |
| **FreeAI** | `FREEAI_API_KEY` | Free-tier multi-model access |
| **OmniRoute** | `OMNIROUTE_API_KEY` | Multi-provider routing layer |

---

## 🛡️ Safety

- All rule changes are versioned + rollback-able
- Meta^n validates each change (commit/rollback/hold) before applying
- SARSI has atomic disk persistence with `.bak` recovery
- MEA gate can flag inadequate responses before delivery
- Everything wrapped in try/catch — the meta-cognitive layer can never break the core runtime

---

## 📚 Documentation Overhaul

- **README** — new Meta-Cognitive Layer section, updated architecture, 14-provider table
- **docs/core/architecture.md** — updated diagrams showing the meta-cognitive feedback loop
- **docs/advanced/meta-cognitive-upgrade.md** — full design document
- **6 new provider docs** — openrouter, nvidia, qwen, aihorde, freeai, omniroute
- **docs/reference/changelog.md** — v3.0.0 entry with full feature breakdown
- Fixed stale version references across the docs

---

## 📊 Stats

| Metric | Value |
|--------|-------|
| Meta-cognitive subsystems | 5 |
| New LOC (meta-cognitive) | ~1,620 |
| LLM providers | 14 |
| Built-in tools | 18+ |
| Channel adapters | Discord, WhatsApp, HTTP |
| Total TypeScript LOC | ~23,900 |
| Compile errors | 0 |

---

## 🚀 Upgrade

```bash
npm install -g symbiote-core@4.0.0
```

Or pull the repo and run `./symbiote.sh`.

---

**Full Changelog:** https://github.com/artifact-opensource/symbiote/compare/v3.0.0...v4.0.0
