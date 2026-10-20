# Upgrade 6: Technical Specification

## Status

Proposal for staged implementation. This document describes the target architecture; it is not a claim that the current runtime already satisfies it.

The upgrade is intentionally a controller-and-ledger change, not a prompt-only change. Existing chat behavior remains the entry point and fallback while the durable execution controller is introduced behind a feature gate.

## Goals

- Resume multi-step work across turns, process restarts, and context-window compaction.
- Anticipate and execute safe next steps without requiring a new user message for each step.
- Preserve durable, auditable state for memory, tasks, Meta^n, and RSI.
- Prevent duplicate effects, stale workers, silent tool failures, and success-shaped state-loss fallbacks.
- Keep user control, least privilege, and explainability explicit.

## Non-goals

- Infer authorization from predicted intent.
- Make unrestricted external changes or irreversible actions autonomously.
- Treat a transcript, vector index, todo list, or model context as the sole source of truth.
- Claim that persistent agency establishes subjective consciousness.

## Logical components

### 1. Event journal

Append-only record of observations and state transitions. Initial implementation may use SQLite with WAL mode and transactional writes; the interface must permit later backend replacement.

Minimum event fields:

```ts
interface AgentEvent {
  eventId: string;
  taskId?: string;
  sequence: number;
  timestamp: string;
  kind: string;
  source: string;
  idempotencyKey?: string;
  correlationId?: string;
  payload: unknown;
  schemaVersion: number;
}
```

Constraints:

- Unique `eventId`; unique `(source, idempotencyKey)` when an idempotency key is supplied.
- Sequence numbers are monotonic within a task.
- Append and sequence allocation are one transaction. A duplicate idempotency key returns the original event reference and must not allocate a second sequence number.
- Events are immutable. Corrections, redactions, and supersessions are new events that reference the original; they do not rewrite history.
- Event ordering is authoritative only within a task. Cross-task ordering uses timestamps and explicit causal/correlation references, not a false global total order.
- Event payloads identify secret/sensitive fields so retention and display can redact them.
- Appends are committed before the system reports durable success.

Initial event kinds include `observation.received`, `task.created`, `task.transitioned`, `commitment.created`, `commitment.transitioned`, `action.proposed`, `action.authorized`, `action.started`, `action.result_recorded`, `action.verified`, `action.reconciled`, `approval.requested`, `approval.resolved`, `task.cancelled`, `memory.promoted`, `memory.invalidated`, and `system.recovered`. Producers must validate event payloads against their schema version before append.

### 2. Task state and commitments

```ts
type TaskStatus =
  | 'proposed' | 'active' | 'waiting_approval' | 'blocked'
  | 'completed' | 'cancelled' | 'failed';

interface TaskRecord {
  taskId: string;
  generation: number;
  objective: string;
  status: TaskStatus;
  scope: string[];
  dependencies: Array<{ taskId: string; commitmentId: string }>;
  commitments: Commitment[];
  evidence: EvidenceRef[];
  nextCheckAt?: string;
  budget: ResourceBudget;
  authority: AuthorityEnvelope;
  updatedAt: string;
}
```

Commitment lifecycle: `open → ready → running → verified`; alternate terminal/interruption states include `blocked`, `waiting_approval`, `failed`, and `cancelled`. Transitions are validated by the controller and appended to the journal. A model response alone cannot set `verified`.

The controller rejects transitions not listed in the lifecycle, stale generation numbers, missing dependency evidence, and completion without verified postconditions. Reopening a terminal commitment creates a new commitment revision linked to the original; it does not erase the terminal event.

### 3. Action contract and execution ledger

```ts
interface ActionIntent {
  actionId: string;
  taskId: string;
  taskGeneration: number;
  kind: string;
  arguments: unknown;
  expectedPostconditions: string[];
  idempotencyKey?: string;
  sideEffectClass: 'read' | 'reversible_local' | 'external' | 'irreversible';
  permission: string;
  timeoutMs: number;
  retryPolicy: { maxAttempts: number; retryOn: string[] };
  resourceCost: ResourceBudget;
}
```

Lifecycle: `proposed → policy_checked → queued → leased → running → result_recorded → verified`. Failures, timeouts, cancellations, and uncertain outcomes are first-class states. For non-idempotent actions, an uncertain timeout enters reconciliation instead of blind retry.

Each action implementation declares its idempotency class and reconciliation capability. The executor writes `action.started` before invoking a side effect and records its result before unlocking dependent commitments. A crash between side effect and result recording is treated as `outcome_unknown`; the recovery path must query/reconcile or request operator input rather than assume failure and repeat the action.

### 4. Scheduler and pre-emption

The scheduler selects dependency-ready actions and orders them by:

`priority = expected_progress × urgency × confidence − risk_penalty − resource_penalty`

This score ranks work; policy remains a hard gate. The scheduler supports:

- Per-task sequential dependencies and bounded cross-task parallelism.
- Worker leases with expiration and fencing tokens.
- Task-generation checks before result commit.
- Cancellation and supersession propagation.
- Global/per-task limits for concurrency, time, tokens, network, and disk.
- Fairness so background anticipation cannot starve interactive or safety-critical work.

The first release should use a single scheduler process with durable leases. Distributed scheduling is a later scaling step.

Scores are bounded and versioned with the scheduler policy. Missing confidence, cost, or risk estimates make a candidate ineligible for autonomous execution rather than implicitly assigning a favorable default. Interactive work may preempt queued background work, but may not interrupt a running side effect unless that action contract supports cancellation. Fairness uses aging within each authority/risk class; aging never crosses a policy boundary.

Lease claims use a monotonically increasing fencing token stored with the task generation. Every result commit checks both values transactionally. Lease expiry alone does not authorize replay: the recovery controller first marks the previous attempt interrupted and applies the action's reconciliation policy.

### 5. Authority and approval

An authority envelope specifies actor, workspace, allowed tools, allowed targets, side-effect classes, data scope, time limit, and resource budget. Default policy:

| Action | Default |
|---|---|
| Read local, in-scope state | Automatic |
| Prepare a plan, run isolated tests, inspect logs | Automatic within budget |
| Reversible local edit in declared task scope | Automatic only if explicitly included in task authority |
| Send messages, publish, deploy, spend, delete user data | Approval required absent narrow standing authorization |
| Increase permissions or broaden targets | Approval required |

Approvals bind to a specific action digest and expire. A materially changed action requires fresh approval.

### 6. Memory and persistence

Authoritative stores:

- Event journal: observations, decisions, tool lifecycle, outcomes.
- Task store: materialized commitment state rebuildable from events.
- Memory catalog: episodic/semantic/procedural records and provenance.
- Self-improvement store: Curator evidence/proposals and Meta^n evaluation records.

Indexes (including the current VDB) are rebuildable. A memory record includes `memoryId`, `kind`, `content`, `sourceEventIds`, `createdAt`, `validFrom`, optional `validUntil`, `confidence`, `permissions`, `sensitivity`, and relationship IDs.

Persistence requirements:

- Atomic snapshot replacement and schema versioning.
- Checksum or integrity validation for snapshots.
- Backup/restore policy with explicit surfaced recovery events.
- Never turn parse, permission, or I/O errors into empty memory or “success.”
- Retention/forgetting must tombstone authoritative records and propagate to derived indexes.
- Context compaction may summarize, but must retain links to the underlying events.

### 7. Memory retrieval and reflection

Retrieval combines lexical, semantic, recency, task relevance, authority, and confidence signals. Each injected item includes an opaque citation ID and freshness/confidence. The agent should be able to ask for source evidence before acting on consequential facts.

Reflection is a separate scheduled action:

- Consolidate episodes into candidate facts/procedures with provenance.
- Detect contradictions, stale facts, and duplicated memories.
- Require minimum evidence and preserve both sides of unresolved conflicts.
- Promote/delete only via explicit journaled transitions.
- Keep Meta^n outcomes tied to exact model/rule versions and event windows.

### 8. Curator, Meta^n, and RSI

Curator observes verified interaction/tool outcomes and emits durable proposals. Meta^n evaluates proposals against a baseline and a sufficiently large, attributable observation window. Every evaluation stores:

- Before/after version identifiers.
- Cohort definition, sample count, time interval, metrics, and confidence.
- Confounders or missing data.
- Decision, rationale, and rollback reference.

Automatic changes are limited initially to reversible SARSI configuration. A proposal affecting source code, tool privileges, external side effects, or data retention is advisory and requires review/tests/approval. Failed or inconclusive evaluations remain visible rather than being dropped on restart.

Learning records reference immutable baseline/candidate event IDs and the exact configuration version used by each sample. Evaluation eligibility, exclusions, minimum sample size, maximum observation window, and decision thresholds are versioned policy, not hidden prompt instructions. An inconclusive evaluation expires into a visible `not_demonstrated` decision and restores the baseline; it is not counted as a successful change.

## Transaction and state-transition rules

The implementation must keep these changes atomic:

| Operation | Atomic durable effect |
|---|---|
| Receive an observation | Deduplicate key + append event + update task cursor |
| Claim ready action | Confirm dependencies + validate generation + acquire fenced lease |
| Record tool result | Append result + update action status + unlock dependents |
| Verify commitment | Append verification evidence + transition commitment |
| Approve an action | Validate expiry and action digest + append approval decision |
| Roll back a learned change | Restore prior version + append rollback decision |

If an operation spans external systems and cannot be transactional, represent it as a saga: persist intent, perform one bounded effect, persist observed result, and reconcile uncertainty. Do not claim exactly-once external execution; provide at-least-once delivery only where idempotency or reconciliation makes it safe.

All controller writes use optimistic generation checks. Read models may lag and be rebuilt; authorization, readiness, and completion decisions must use the authoritative transactional store.

## Authority, approval, and cancellation details

- Authority is the intersection of task scope, actor permissions, workspace policy, and action-specific permission—not the union.
- The policy gate evaluates the fully materialized action arguments and targets. A model-provided label such as “read-only” is not trusted.
- Approval binds to a canonical digest of action kind, target, arguments, task generation, and relevant authority version. Any change invalidates the approval.
- Approval records identify approver, timestamp, expiry, and one-time/reusable scope. Reuse is allowed only for an explicitly bounded standing authorization.
- Cancellation increments the task generation before signaling workers. Workers check generation and fencing token before every durable result commit.
- Cancellation cannot undo an already completed external effect. The controller records that effect and offers a compensating action only if one is defined and authorized.
- Owner pause stops new claims immediately. Running actions follow their declared cancellation contract and remain visible until settled or reconciled.

## Data lifecycle and privacy

Event durability does not imply indefinite retention of every payload. Separate immutable event identity/ordering metadata from encrypted or redacted payload storage where retention policy requires deletion. Deletion creates a durable tombstone, removes derived memory/index copies, and records which stores confirmed erasure. Backups have an explicit expiry and deletion propagation policy.

Secrets are not valid event payloads. Redaction occurs before persistence, not only in logs or user-facing views. Access checks apply to event payloads, memories, search results, exports, and approval details. Audit views expose provenance without exposing data the requesting actor cannot access.

## Operator visibility and health

The minimum inspection surface must show, per task: current status/generation, commitments and dependencies, active and queued actions, next scheduled check, last durable checkpoint, current authority/budget, pending approvals, blockers, and the evidence behind the latest state transition.

The runtime exposes aggregate counts for ready/running/leased/waiting-approval/reconciling/failed work, oldest queue age, lease expirations, replay position, journal write failures, memory-index lag, and budget consumption. Durable-write or recovery errors are health failures, not warnings hidden behind a nominally ready status.

Every autonomous action carries a human-readable “why now” explanation linked to the triggering event, commitment, procedure, or timer. Owner controls include pause/resume, cancel/supersede, approve/reject, inspect evidence, and export an action/task audit record.

## Recovery semantics

On startup:

1. Validate journal/snapshot versions and integrity.
2. Load the last valid snapshot; replay later journal entries.
3. Mark leases from the prior process as interrupted.
4. Reconcile actions using tool-specific idempotency/status queries where available.
5. Resume only actions whose task generation and authority remain valid.
6. Surface unresolved/corrupt records; do not silently recreate them as empty tasks.

On graceful shutdown, stop scheduling new work, persist current state, cancel or checkpoint workers according to action contract, and record shutdown. On crash, recovery follows the same reconciliation path.

Recovery must be idempotent: replaying the same journal prefix repeatedly yields the same materialized task state. The recovery report records the last validated sequence, replayed count, interrupted leases, reconciled actions, unresolved items, and any quarantined records. A partial/corrupt tail may be truncated only when the storage format proves it is an incomplete final append; corruption elsewhere requires an explicit repair path and preserved backup.

## Interfaces

Proposed controller boundary:

```ts
interface ExecutionController {
  observe(event: AgentEvent): Promise<void>;
  createTask(input: CreateTaskInput): Promise<TaskRecord>;
  propose(action: ActionIntent): Promise<ActionDecision>;
  runReady(taskId?: string): Promise<void>;
  cancel(taskId: string, reason: string): Promise<void>;
  resume(): Promise<RecoveryReport>;
  inspect(taskId: string): Promise<TaskRecord | null>;
}
```

The model-facing tools should propose commitments/actions and inspect state. They must not write the authoritative journal or mark their own effects verified.

## Rollout plan

1. **Persistence hardening (prerequisite):** atomic saves, surfaced corruption, durable Curator/Meta^n state, COMB truthful outcomes, restart tests.
2. **Task ledger:** schema, transactional state store, migrations, event replay, inspection APIs.
3. **Tool action contracts:** idempotency, postconditions, error taxonomy, timeout and cancellation semantics.
4. **Sequential autonomous controller:** execute one ready action, verify, replan; durable checkpoints between steps.
5. **Bounded scheduler:** dependency-aware concurrency, leases, budgets, fairness, supersession.
6. **Anticipation:** timers, monitors, and predicted next steps; initially prepare/read-only only.
7. **Scoped mutation and approval UX:** explicit authority envelopes and action-bound approvals.
8. **Learning integration:** attributable Meta^n cohorts and gated adaptation.

Each phase must be deployable with rollback and must preserve existing chat/tool behavior when the new controller is disabled.

Every phase has a kill switch and a migration/rollback rehearsal. Shadow mode may record proposed tasks/actions and scheduler decisions, but must not execute them. Before enabling execution, compare shadow decisions with existing request-driven behavior, test approval boundaries, and prove restart/replay safety. Start with one task and one worker; expand concurrency and anticipation only after operational metrics meet agreed thresholds.

## Acceptance criteria

- A multi-step task resumes after process kill/restart without losing completed evidence or repeating a committed non-idempotent action.
- A tool result is durable before dependent work becomes ready.
- Failed persistence, malformed state, or missing memory backends are surfaced and never reported as success.
- Cancelling or superseding a task prevents stale workers from committing results.
- Read-only anticipation can operate in the background within declared budgets and is inspectable/pausable.
- External/irreversible actions stop at approval unless covered by a specific standing authorization.
- Meta^n can resume active evaluations, explain decisions from stored evidence, and roll back a verified reversible change.
- Recovery, replay, deduplication, stale lease, corrupted snapshot, and approval-boundary tests pass.
- Shadow mode produces explainable decisions without executing actions; feature disable returns all new work to the existing request-driven path.
- No secret appears in journal payloads, logs, memory retrieval, approval cards, or audit exports in redaction tests.
- Queue fairness, budget exhaustion, pause, cancellation, and supersession tests show bounded response time and no unauthorized result commits.

## Open design decisions

These must be resolved before the task-ledger/scheduler implementation, not guessed during coding:

- SQLite vs. append-only JSON event journal as the initial authoritative backend.
- Event payload encryption/key ownership and the boundary between immutable audit metadata and deletable content.
- Global task identity and cross-channel task-linking policy.
- Memory retention, deletion, and backup policy.
- Whether background work continues indefinitely or only within task-specific leases/deadlines.
- Default budgets and which reversible workspace changes are permitted without per-action approval.
- How approvals are presented and delivered across Discord, CLI, and Web UI.
- Which existing tools can truthfully declare idempotency, cancellation, and reconciliation semantics.
- Statistical decision method and minimum practical evidence volume for each RSI change class.
