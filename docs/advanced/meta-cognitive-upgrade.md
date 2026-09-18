# Meta-Cognitive Upgrade: SARSI + Curator + Meta^n + MEA + PARC

## Overview

Five interlocking meta-cognitive subsystems that upgrade the Symbiote runtime from a sophisticated **reactive executor** into a **self-improving system** that gets better at routing with every interaction.

## Architecture

```
                    ┌─────────────────────────────────────────┐
                    │           SARSI Self-Model               │
                    │  (identity, goals, routing rules,        │
                    │   confidence scores, rule history)        │
                    │  Persists to .symbiote/sarsi-model.json  │
                    └──────────┬──────────────┬───────────────┘
                               │              │
                    ┌──────────▼──────┐ ┌────▼──────────────┐
     Interaction ──►│   PARC Planning  │ │   MEA Audit Gate   │
                    │  (route message) │ │  (verify response) │
                    └──────────┬──────┘ └────┬──────────────┘
                               │              │
                    ┌──────────▼──────┐ ┌────▼──────────────┐
                    │  PARC Assessment│ │   Curator          │
                    │  (score routing) │ │  (propose rules)   │
                    └──────────┬──────┘ └────┬──────────────┘
                               │              │
                               └──────┬───────┘
                                      │
                            ┌─────────▼─────────┐
                            │   Meta^n          │
                            │ (commit/rollback  │
                            │  rule changes)     │
                            └─────────┬─────────┘
                                      │
                            ┌─────────▼─────────┐
                            │   SARSI Model      │
                            │  (updated rules)   │
                            └───────────────────┘
```

## Modules

### 1. SARSI (`src/sarsi/`) — Self-Aware Routing Self-Identity
- **model.ts** (347 lines) — SarsiModel interface, SarsiStore with atomic disk persistence, backup, rollback
- **loader.ts** (127 lines) — Boot init, task classification, provider routing, outcome recording
- **index.ts** — Public API

**Key features:**
- Machine-readable identity + goals persist across restarts
- Provider/channel/tool routing rules with confidence scores
- Rule change history with rollback support
- `toSystemPrompt()` — injects self-model into the LLM system prompt
- Atomic writes (write → backup → replace)

### 2. Curator (`src/curator/`) — Background Review
- **curator.ts** (315 lines) — InteractionRecord, RuleProposal, Curator class
- **index.ts** — Public API

**Key features:**
- Reviews completed interactions asynchronously (non-blocking via `setImmediate`)
- Generates rule proposals based on provider performance, token efficiency, latency, tool success
- **Active-update bias** — prefers updating stale rules over preserving them
- Threshold-based proposal application (only applies proposals with confidence ≥ 0.5)

### 3. Meta^n (`src/meta/`) — Recursive Self-Improvement
- **meta.ts** (258 lines) — MetaN class with evaluation cycle
- **index.ts** — Public API

**Key features:**
- Takes Curator's proposed rule updates and evaluates them
- Compares before/after metrics (routing accuracy, tool success, latency, token cost)
- Three decisions: **commit** (improvement > +0.02), **rollback** (degradation < -0.03), **hold** (marginal)
- Background loop runs every 5 minutes + on-demand every 10 interactions
- Recursive: uses the system's own routing to evaluate whether routing improved

### 4. MEA (`src/agent/mea.ts`) — Monitor → Execute → Audit
- **mea.ts** (173 lines) — Lightweight audit gate + stats tracker

**Key features:**
- NOT a new module — a gate function called from the runner
- Checks: tool errors, empty responses, keyword coverage, timeout
- Returns pass/fail with confidence score and retry recommendation
- MeaStats tracks pass/fail rates and failure modes

### 5. PARC (`src/orchestrator/parc.ts`) — Parallel Routing Agents
- **parc.ts** (223 lines) — Plan/Assess/Pipeline
- **integration.ts** (134 lines) — Glue layer connecting all 5 subsystems

**Key features:**
- Extends the existing orchestrator (not a parallel system)
- Planning node: classifies task + routes to optimal provider
- Assessment node: scores routing quality, feeds back to SARSI + Curator + Meta^n
- `parcPipeline()` — convenience function wrapping the full flow

## Integration Points

### Boot (`unified-daemon.ts`)
```typescript
initSarsi();        // Load self-model
startMetaLoop();    // Start background self-improvement
// ... on shutdown ...
stopMetaLoop();     // Stop Meta^n loop
shutdownSarsi();    // Flush SARSI state
```

### System Prompt (`system-prompt.ts`)
```typescript
// SARSI self-model injected into system prompt
addSection('SARSI Self-Model', getSarsiPrompt());
```

### Runner Flow
```typescript
// 1. Before LLM call — plan routing
const decision = preRoute(userMessage, channel, contextLength);

// 2. Run agent (existing behavior)

// 3. After agent returns — MEA audit gate
const { audit, shouldDeliver } = auditGate(userMessage, decision.taskType, result);

// 4. After delivery — learn from outcome (async, non-blocking)
postDeliver(decision, { channel, userMessage, contextLength }, result, userSatisfied);
```

## Sizing

| Metric | Before | After | Delta |
|---|---|---|---|
| TypeScript files | 96 | 106 | +10 |
| Total LOC | 22,244 | 23,864 | +1,620 |
| New modules | — | 3 (sarsi, curator, meta) | +3 |
| New files in existing modules | — | 3 (mea, parc, integration) | +3 |

## File Manifest

```
src/sarsi/
  model.ts        — 347 lines (SarsiModel, SarsiStore, defaults, validation)
  loader.ts       — 127 lines (boot, classify, route, record, shutdown)
  index.ts        — 3 lines (public API)

src/curator/
  curator.ts      — 315 lines (review, propose, apply, active-update bias)
  index.ts        — 2 lines (public API)

src/meta/
  meta.ts         — 258 lines (evaluate, commit/rollback/hold, background loop)
  index.ts        — 2 lines (public API)

src/agent/
  mea.ts          — 173 lines (audit gate, keyword extraction, stats)

src/orchestrator/
  parc.ts         — 223 lines (plan/assess/pipeline)
  integration.ts  — 134 lines (preRoute, auditGate, postDeliver, re-exports)
```

## Persistence

- SARSI model: `.symbiote/sarsi-model.json` (atomic writes + `.bak` backup)
- Rule history: Last 500 changes retained in the model
- Meta^n evaluations: Last 200 retained in memory

## Safety

- All rule changes are **versioned and rollback-able**
- Meta^n validates each change before committing
- Curator runs **asynchronously** — never blocks responses
- MEA is a **gate** — can prevent delivery of inadequate responses
- SARSI has **atomic disk persistence** with backup recovery
