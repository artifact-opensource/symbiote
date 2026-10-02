#!/usr/bin/env python3
"""
PULSE — Persistent Unsupervised Loop for Qorvex Execution
=============================================================
The agent's autonomous maintenance loop. Runs between conversations, crons,
between events. Turns dead time into agency.

Architecture:
  1. TRIAGE (cheap model via Copilot proxy) — looks at context, picks action
    2. WORK (full model via Symbiote HTTP API) — executes the chosen task
  3. SLEEP — waits, then re-enters triage
    4. MEMORY — proactive native VDB ingestion and context staging

The loop: Wake → Memory Maintenance → Read Context → Triage → Work (maybe) → Sleep → Repeat

Budget-aware, interruptible, conversation-respecting.
Proactively manages the agent's memory systems.
"""

import json
import os
import sys
import time
import signal
import logging
import hashlib
from pathlib import Path
from datetime import datetime, timezone, timedelta
from dataclasses import dataclass, field, asdict
from typing import Optional

import httpx
import subprocess as _sp


# ─── COMB Flush ─────────────────────────────────────────────────────────────

_last_comb_flush_ts = 0.0
_last_vdb_ingest_ts = 0.0


def _run_vdb(workspace: str, action: str, *args: str, timeout: int = 30) -> str:
    """Invoke Symbiote's native VDB maintenance entry point."""
    workspace_path = Path(workspace).resolve()
    script = Path(__file__).resolve().parents[1] / "dist" / "cli" / "vdb-maintenance.js"
    if not script.is_file():
        raise FileNotFoundError(f"Symbiote VDB command is not built: {script}")

    env = os.environ.copy()
    env["SYMBIOTE_WORKSPACE"] = str(workspace_path)
    env["MACH6_WORKSPACE"] = str(workspace_path)
    result = _sp.run(
        [env.get("NODE", "node"), str(script), action, *args],
        capture_output=True,
        text=True,
        cwd=str(workspace_path) if workspace_path.is_dir() else str(script.parents[2]),
        env=env,
        timeout=timeout,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        raise RuntimeError(detail[:1000])
    return result.stdout.strip()

def comb_flush(workspace: str, log: logging.Logger, reason: str = "unknown"):
    """Ensure recent sessions have been indexed in native VDB.
    
    Triggers on: shutdown, budget exhaustion, rate limits, timeouts, errors.
    This is the safety net that catches what the agent session can't.
    
    Rate-limited: max once per 120 seconds (except shutdown).
    """
    global _last_comb_flush_ts
    
    now = time.time()
    is_shutdown = "shutdown" in reason.lower()
    
    # Cooldown: don't flush more than once per 2 min (except shutdown)
    if not is_shutdown and (now - _last_comb_flush_ts) < 120:
        log.debug(f"COMB flush cooldown (last {now - _last_comb_flush_ts:.0f}s ago): {reason}")
        return False
    
    try:
        summary = _run_vdb(workspace, "ingest")
        _last_comb_flush_ts = time.time()
        log.info(f"🧠 VDB flush complete: {reason} — {summary[:300]}")
        return True
    except (_sp.TimeoutExpired, OSError, RuntimeError) as e:
        _last_comb_flush_ts = time.time()  # still count as attempt
        log.exception(f"VDB flush failed ({reason}): {e}")
        return False


def comb_stage(workspace: str, log: logging.Logger, content: str):
    """Persist a note as a native VDB memory document."""
    try:
        _run_vdb(workspace, "stage", content, timeout=15)
        log.info(f"🧠 Memory staged in VDB: {content[:60]}...")
        return True
    except (_sp.TimeoutExpired, OSError, RuntimeError) as e:
        log.exception(f"VDB stage failed: {e}")
        return False


# ─── Native VDB maintenance ───────────────────────────────────────────────

_last_vdb_ingest_ts = 0.0


_last_context_stage_ts = 0.0


def memory_maintenance(log: logging.Logger, workspace: Optional[str] = None):
    """
    Proactive memory management -- called every PULSE cycle.
    
    COMB management (both sisters):
      1. Roll up staging -> archive (every 30 min)
      2. Detect and roll up orphaned staging files (every 6 hours)
      3. Verify chain integrity (every 2 hours)
      4. Detect archive gaps and log warnings (every 6 hours)
    
    Native VDB management:
      5. Ensure daemon is alive (every cycle)
      6. Scan important files for changes -> reindex (every 5 min)
      7. Periodic full reindex for consistency (every 4 hours)
      8. Log doc count / health metrics (every hour)
    """
    global _last_vdb_ingest_ts, _last_context_stage_ts
    workspace = workspace or os.environ.get("SYMBIOTE_WORKSPACE") or os.getcwd()
    now = time.time()
    if now - _last_vdb_ingest_ts > 900:
        _last_vdb_ingest_ts = now
        try:
            summary = _run_vdb(workspace, "ingest", timeout=60)
            log.info("Native VDB session ingest: %s", summary[:300])
        except Exception as exc:
            log.exception("Native VDB session ingest failed: %s", exc)

    if (now - _last_context_stage_ts) > 7200:
        _last_context_stage_ts = now
        _auto_stage_context(log, workspace)


_last_context_stage_ts = 0.0

def _auto_stage_context(log: logging.Logger, workspace: str):
    """Autonomously stage important context into COMB.
    
    Reads today's memory file and recent git activity to build
    a context snapshot. This ensures the agent always wakes up with
    fresh operational context even if it wasn't staged manually.
    """
    today = datetime.now(PKT).strftime("%Y-%m-%d")
    today_short = datetime.now(PKT).strftime("%m-%d")
    
    context_parts = []
    
    # 1. Read today's memory file for key events
    memory_file = Path(workspace) / f"memory/{today}.md"
    if memory_file.exists():
        try:
            content = memory_file.read_text()
            # Extract headers (## lines) as event summary
            headers = [l.strip() for l in content.splitlines() if l.strip().startswith("## ")]
            if headers:
                context_parts.append(f"Today's events: {'; '.join(h.lstrip('#').strip() for h in headers[-10:])}")
        except Exception as e:
            log.debug(f"Context stage - memory file read error: {e}")
    
    # 2. Check git status for active work
    try:
        result = _sp.run(
            ["git", "status", "--short"],
            capture_output=True, text=True, cwd=workspace, timeout=10,
        )
        if result.returncode == 0 and result.stdout.strip():
            lines = result.stdout.strip().splitlines()
            context_parts.append(f"Uncommitted files: {len(lines)} ({', '.join(l.split()[-1] for l in lines[:5])})")
    except Exception:
        pass
    
    # 3. Check Pulse's own task history
    try:
        state_file = Path(workspace) / ".pulse/state.json"
        if state_file.exists():
            state = json.loads(state_file.read_text())
            tasks = state.get("tasks_completed", [])
            if tasks:
                unique_tasks = list({t["task"] for t in tasks})
                context_parts.append(f"PULSE completed today: {'; '.join(unique_tasks[:5])}")
    except Exception:
        pass
    
    # 4. Snapshot native memory health without requiring an external daemon.
    try:
        stats = json.loads(_run_vdb(workspace, "stats", timeout=15))
        context_parts.append(
            f"Memory index: {stats.get('documentCount', 0)} documents, "
            f"{stats.get('termCount', 0)} terms"
        )
    except Exception as e:
        log.exception("Native VDB health check failed: %s", e)
    
    if context_parts:
        summary = f"[PULSE auto-context {today_short}] " + " | ".join(context_parts)
        # Cap at 500 chars
        if len(summary) > 500:
            summary = summary[:497] + "..."
        comb_stage(workspace, log, summary)
        log.info(f"🧠 Auto-staged context ({len(summary)} chars)")
    else:
        log.debug("No context to auto-stage")


# ─── Configuration ──────────────────────────────────────────────────────────

PKT = timezone(timedelta(hours=5))

@dataclass
class PulseConfig:
    # Copilot proxy for triage (cheap/free)
    triage_url: str = "http://localhost:3000/v1/chat/completions"
    triage_model: str = "claude-sonnet-4"
    triage_max_tokens: int = 500

    # Symbiote HTTP API for work turns
    symbiote_url: str = field(default_factory=lambda: os.environ.get("SYMBIOTE_API_URL", "http://127.0.0.1:3006/api/v1/chat"))
    api_key: str = field(default_factory=lambda: os.environ.get("MACH6_API_KEY", os.environ.get("API_KEY", "")))

    # Timing
    idle_delay_sec: int = 600        # 10 min after last conversation → first triage
    triage_interval_sec: int = 900   # 15 min between triage cycles
    min_work_gap_sec: int = 300      # 5 min minimum between work turns
    quiet_hours_start: int = 23      # 11 PM PKT
    quiet_hours_end: int = 8         # 8 AM PKT

    # Budget
    max_triage_per_day: int = 48     # ~3 per hour for 16 waking hours
    max_work_per_day: int = 12       # real work turns are expensive
    max_tokens_per_day: int = 100000 # total token budget

    # Paths
    workspace: str = field(default_factory=lambda: os.environ.get("SYMBIOTE_WORKSPACE", os.getcwd()))
    state_file: str = ""
    log_file: str = ""
    heartbeat_md: str = ""
    workflow_md: str = ""

    # Conversation detection
    last_activity_file: str = ""

    def __post_init__(self):
        root = Path(self.workspace).expanduser().resolve()
        self.workspace = str(root)
        if not self.state_file:
            self.state_file = str(root / ".pulse" / "state.json")
        if not self.log_file:
            self.log_file = str(root / ".pulse" / "pulse.log")
        if not self.heartbeat_md:
            self.heartbeat_md = str(root / "HEARTBEAT.md")
        if not self.workflow_md:
            self.workflow_md = str(root / "WORKFLOW_AUTO.md")
        if not self.last_activity_file:
            self.last_activity_file = str(root / ".pulse" / "last_activity")


# ─── State ──────────────────────────────────────────────────────────────────

@dataclass
class PulseState:
    """Persistent state across restarts."""
    date: str = ""                    # YYYY-MM-DD for daily reset
    triage_count: int = 0
    work_count: int = 0
    tokens_used: int = 0
    last_triage_ts: float = 0
    last_work_ts: float = 0
    last_activity_ts: float = 0       # last human message timestamp
    last_triage_decision: str = ""    # what triage decided
    consecutive_skips: int = 0        # how many "nothing to do" in a row
    tasks_completed: list = field(default_factory=list)

    # Clock
    boot_ts: float = 0                # when PULSE process started
    total_uptime_sec: float = 0       # cumulative uptime across restarts (today)
    total_cycles: int = 0             # total triage cycles (today)
    total_work_sec: float = 0         # time spent in work turns (today)

    # Install awareness
    active_installs: list = field(default_factory=list)    # currently running installs
    completed_installs: list = field(default_factory=list) # finished today

    def reset_if_new_day(self):
        today = datetime.now(PKT).strftime("%Y-%m-%d")
        if self.date != today:
            self.date = today
            self.triage_count = 0
            self.work_count = 0
            self.tokens_used = 0
            self.consecutive_skips = 0
            self.tasks_completed = []
            self.total_uptime_sec = 0
            self.total_cycles = 0
            self.total_work_sec = 0
            self.active_installs = []
            self.completed_installs = []

    def save(self, path: str):
        """Atomic save — write to temp file first, then rename."""
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".tmp")
        try:
            tmp.write_text(json.dumps(asdict(self), indent=2))
            tmp.replace(p)  # atomic on POSIX
        except OSError:
            # Disk full or permissions — try direct write as fallback
            try:
                p.write_text(json.dumps(asdict(self), indent=2))
            except OSError:
                pass  # truly broken — state lost for this cycle

    @classmethod
    def load(cls, path: str) -> "PulseState":
        try:
            data = json.loads(Path(path).read_text())
            return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})
        except (FileNotFoundError, json.JSONDecodeError):
            return cls()


# ─── Logger ─────────────────────────────────────────────────────────────────

def setup_logging(log_file: str) -> logging.Logger:
    logger = logging.getLogger("pulse")
    logger.setLevel(logging.INFO)

    # File handler (rotate at 1MB — preserve one backup)
    log_path = Path(log_file)
    if log_path.exists() and log_path.stat().st_size > 1_000_000:
        backup = log_path.with_suffix(".log.1")
        try:
            if backup.exists():
                backup.unlink()
            log_path.rename(backup)
        except OSError:
            log_path.write_text("")  # fallback: truncate if rename fails

    fh = logging.FileHandler(log_file)
    fh.setLevel(logging.DEBUG)

    fmt = logging.Formatter("[%(asctime)s] %(levelname)s %(message)s", datefmt="%H:%M:%S")
    fh.setFormatter(fmt)
    logger.addHandler(fh)

    # Only add StreamHandler if stdout is a TTY (avoids double logging when piped)
    if sys.stdout.isatty():
        ch = logging.StreamHandler()
        ch.setLevel(logging.INFO)
        ch.setFormatter(fmt)
        logger.addHandler(ch)
    return logger


# ─── Context Gathering ─────────────────────────────────────────────────────

def gather_context(config: PulseConfig, state: PulseState) -> dict:
    """Gather everything the triage brain needs to make a decision."""
    now = datetime.now(PKT)
    ctx = {
        "time": now.strftime("%Y-%m-%d %H:%M:%S PKT"),
        "day_of_week": now.strftime("%A"),
        "hour": now.hour,
        "budget": {
            "triage_remaining": config.max_triage_per_day - state.triage_count,
            "work_remaining": config.max_work_per_day - state.work_count,
            "tokens_remaining": config.max_tokens_per_day - state.tokens_used,
            "budget_pct": round((state.tokens_used / config.max_tokens_per_day) * 100, 1),
        },
        "timing": {
            "since_last_human_msg_min": round((time.time() - state.last_activity_ts) / 60, 1) if state.last_activity_ts else None,
            "since_last_work_min": round((time.time() - state.last_work_ts) / 60, 1) if state.last_work_ts else None,
            "consecutive_idle_cycles": state.consecutive_skips,
        },
        "today_completed": state.tasks_completed[-5:],  # last 5
    }

    # Read HEARTBEAT.md for task checklist
    try:
        hb = Path(config.heartbeat_md).read_text()
        # Extract unchecked items
        unchecked = [line.strip() for line in hb.splitlines()
                     if line.strip().startswith("- [ ]")]
        ctx["heartbeat_tasks"] = unchecked[:10]
    except FileNotFoundError:
        ctx["heartbeat_tasks"] = []

    # Read WORKFLOW_AUTO.md for active projects
    try:
        wf = Path(config.workflow_md).read_text()
        # Extract active items
        active = []
        for line in wf.splitlines():
            if "ACTIVE" in line or "NEXT" in line:
                active.append(line.strip())
        ctx["active_workflows"] = active[:5]
    except FileNotFoundError:
        ctx["active_workflows"] = []

    # Check for recent memory notes
    today = now.strftime("%Y-%m-%d")
    memory_file = Path(config.workspace) / "memory" / f"{today}.md"
    if memory_file.exists():
        content = memory_file.read_text()
        ctx["memory_size_today"] = len(content)
        # Get last section header
        headers = [l for l in content.splitlines() if l.startswith("##")]
        ctx["last_memory_entry"] = headers[-1] if headers else None
    else:
        ctx["memory_size_today"] = 0

    # Check git status for uncommitted work
    try:
        import subprocess
        result = subprocess.run(
            ["git", "status", "--porcelain"],
            capture_output=True, text=True, cwd=config.workspace, timeout=5
        )
        changed = [l.strip() for l in result.stdout.strip().splitlines() if l.strip()]
        ctx["uncommitted_files"] = len(changed)
        ctx["changed_files"] = changed[:5]
    except Exception:
        ctx["uncommitted_files"] = 0

    # Check cron schedule
    try:
        import subprocess
        result = subprocess.run(
            ["crontab", "-l"], capture_output=True, text=True, timeout=5
        )
        crons = [l for l in result.stdout.splitlines()
                 if l.strip() and not l.startswith("#")]
        ctx["active_crons"] = len(crons)
    except Exception:
        ctx["active_crons"] = 0

    # Check disk space
    try:
        import shutil
        usage = shutil.disk_usage(config.workspace)
        pct_used = round((usage.used / usage.total) * 100, 1)
        free_gb = round(usage.free / (1024 ** 3), 1)
        ctx["disk"] = {"used_pct": pct_used, "free_gb": free_gb}
        if pct_used > 93:
            ctx["disk_critical"] = True
    except Exception:
        pass

    # ── Native VDB health ────────────────────────────────────────────────
    try:
        ctx["memory_systems"] = {"vdb": json.loads(_run_vdb(config.workspace, "stats", timeout=15))}
    except Exception as exc:
        logging.getLogger("pulse").exception("Native VDB health query failed: %s", exc)
        ctx["memory_systems"] = {"vdb": {"available": False, "error": str(exc)}}

    return ctx


# ─── Triage Engine ──────────────────────────────────────────────────────────

TRIAGE_SYSTEM = """You are PULSE — the agent's autonomous triage engine. You manage the configured workspace and its memory.

You receive a context snapshot including:
- memory_systems.vdb: persistent Symbiote VDB document, term, and source counts

You output ONE decision as JSON.

Rules:
1. If human messaged <10 min ago → WAIT (conversation might resume)
2. If budget is low (>80% used) → only critical tasks
3. If it's quiet hours (23:00-08:00) → only nightly creative/social tasks
4. If nothing needs doing → SKIP (don't invent work)
5. Prefer short tasks (<5 min) over long ones when budget is tight
6. Never repeat a task completed today unless it's recurring
7. Git commit if there are uncommitted files and no active work
8. HEARTBEAT.md unchecked items are your task board
9. If active_installs shows running installs → DO NOT interfere. Wait for completion.
10. If recent_installs_completed shows finished installs → consider post-install tasks
11. Prefer work within the configured Symbiote workspace.

MEMORY SYSTEMS MANAGEMENT:
- memory_systems.vdb.available: if false, report the VDB bridge failure; do not attempt external index restarts.
- memory_systems.vdb.documentCount: track persistent memory growth.
- PULSE stages and ingests through the built-in Symbiote VDB; no external memory daemon is required.

Output format (strict JSON, no markdown):
{"action": "work|wait|skip", "task": "specific task description", "reason": "why", "estimated_minutes": N, "priority": "critical|high|medium|low"}

If action is "skip" or "wait", task should be null."""

def triage(config: PulseConfig, context: dict, log: logging.Logger) -> Optional[dict]:
    """Ask the triage model what to do. Returns decision dict or None on error."""
    prompt = f"Context snapshot:\n```json\n{json.dumps(context, indent=2)}\n```\n\nWhat should the agent do right now?"

    try:
        with httpx.Client(timeout=30) as client:
            resp = client.post(config.triage_url, json={
                "model": config.triage_model,
                "messages": [
                    {"role": "system", "content": TRIAGE_SYSTEM},
                    {"role": "user", "content": prompt},
                ],
                "max_tokens": config.triage_max_tokens,
                "temperature": 0.1,
            })

            if resp.status_code == 429:
                log.error("Triage rate-limited (429). Flushing COMB.")
                comb_flush(config.workspace, log, reason="triage rate-limited (429)")
                return None

            if resp.status_code >= 500:
                log.error(f"Triage server error ({resp.status_code}). Flushing COMB.")
                comb_flush(config.workspace, log, reason=f"triage server error ({resp.status_code})")
                return None

            if resp.status_code != 200:
                log.error(f"Triage API error: {resp.status_code} {resp.text[:200]}")
                return None

            data = resp.json()
            content = data["choices"][0]["message"]["content"]
            tokens = data.get("usage", {}).get("total_tokens", 0)

            # Parse JSON from response (handle markdown wrapping, trailing text)
            content = content.strip()
            if content.startswith("```"):
                # Remove ```json or ``` wrapper
                lines = content.split("\n")
                # Find opening and closing fences
                start = 1  # skip first line (```)
                end = len(lines)
                for i in range(len(lines) - 1, 0, -1):
                    if lines[i].strip().startswith("```"):
                        end = i
                        break
                content = "\n".join(lines[start:end]).strip()

            # Try to extract JSON object even if there's surrounding text
            if not content.startswith("{"):
                brace_start = content.find("{")
                if brace_start >= 0:
                    content = content[brace_start:]
            if not content.endswith("}"):
                brace_end = content.rfind("}")
                if brace_end >= 0:
                    content = content[:brace_end + 1]

            decision = json.loads(content)
            
            # Validate required fields
            if "action" not in decision:
                log.warning(f"Triage missing 'action' field: {content[:200]}")
                decision["action"] = "skip"
                decision["reason"] = decision.get("reason", "malformed response")
            
            # Normalize action to known values
            if decision["action"] not in ("work", "wait", "skip"):
                log.warning(f"Triage unknown action '{decision['action']}', treating as skip")
                decision["action"] = "skip"
            
            decision["_tokens"] = tokens
            log.info(f"Triage: {decision.get('action', '?')} — {decision.get('reason', '?')}")
            return decision

    except httpx.TimeoutException:
        log.error("Triage timed out. Flushing COMB.")
        comb_flush(config.workspace, log, reason="triage timeout")
        return None
    except httpx.ConnectError:
        log.error("Triage connection refused (proxy down?). Flushing COMB.")
        comb_flush(config.workspace, log, reason="triage connection refused")
        return None
    except json.JSONDecodeError as e:
        log.error(f"Triage returned non-JSON: {e}")
        return None
    except Exception as e:
        log.error(f"Triage failed: {e}")
        comb_flush(config.workspace, log, reason=f"triage exception: {e}")
        return None


# ─── Work Execution ─────────────────────────────────────────────────────────

def execute_work(config: PulseConfig, task: str, log: logging.Logger) -> Optional[dict]:
    """Send a work task to the configured Symbiote HTTP API."""
    session_id = f"pulse-{datetime.now(PKT).strftime('%Y%m%d-%H%M%S')}"

    try:
        with httpx.Client(timeout=3600) as client:  # 60 min persistent for work turns
            resp = client.post(config.symbiote_url, json={
                "text": f"[PULSE autonomous task] {task}",
                "source": "pulse",
                "senderId": "pulse",
                "sessionId": session_id,
            }, headers={
                "Authorization": f"Bearer {config.api_key}",
                "Content-Type": "application/json",
            })

            if resp.status_code == 429:
                log.error("Work API rate-limited (429). Flushing COMB.")
                comb_flush(config.workspace, log, reason="work rate-limited (429)")
                return None

            if resp.status_code >= 500:
                log.error(f"Work API server error ({resp.status_code}). Flushing COMB.")
                comb_flush(config.workspace, log, reason=f"work server error ({resp.status_code})")
                return None

            if resp.status_code != 200:
                log.error(f"Work API error: {resp.status_code} {resp.text[:300]}")
                return None

            try:
                data = resp.json()
            except (json.JSONDecodeError, ValueError):
                log.error(f"Work API returned non-JSON: {resp.text[:200]}")
                return None
            
            log.info(f"Work done: session={session_id}, len={len(data.get('text', ''))}")
            return data

    except httpx.TimeoutException:
        log.error(f"Work execution timed out (5 min). Flushing COMB.")
        comb_flush(config.workspace, log, reason=f"work timeout: {task[:60]}")
        return None
    except httpx.ConnectError:
        log.error("Work API connection refused (Mach6 down?). Flushing COMB.")
        comb_flush(config.workspace, log, reason="work connection refused (Mach6 down)")
        return None
    except Exception as e:
        log.error(f"Work execution failed: {e}")
        comb_flush(config.workspace, log, reason=f"work exception: {e}")
        return None


# ─── Activity Detection ────────────────────────────────────────────────────

def get_last_activity(config: PulseConfig) -> float:
    """Get timestamp of last human activity (message to the agent).
    
    Checks Mach6 session files for most recent human message.
    Falls back to the activity file PULSE maintains.
    """
    latest = 0.0

    # Check session directory for recent activity
    configured_sessions = os.environ.get("SYMBIOTE_SESSIONS_DIR") or os.environ.get("MACH6_SESSIONS_DIR")
    sessions_dirs = [Path(configured_sessions)] if configured_sessions else [
        Path(config.workspace) / ".sessions",
        Path.home() / ".mach6" / "sessions",
    ]
    for sessions_dir in sessions_dirs:
        if not sessions_dir.exists():
            continue
        for session_file in sessions_dir.glob("*.json"):
            try:
                latest = max(latest, session_file.stat().st_mtime)
            except OSError as exc:
                logging.getLogger("pulse").warning("Unable to stat session %s: %s", session_file, exc)

    # Also check our own marker file
    try:
        ts = float(Path(config.last_activity_file).read_text().strip())
        if ts > latest:
            latest = ts
    except (FileNotFoundError, ValueError):
        pass

    return latest


def record_activity(config: PulseConfig):
    """Record that a human message was detected (call from gateway hook)."""
    Path(config.last_activity_file).parent.mkdir(parents=True, exist_ok=True)
    Path(config.last_activity_file).write_text(str(time.time()))


# ─── Install Awareness ─────────────────────────────────────────────────────

# Process names that indicate package/build installs
_INSTALL_PATTERNS = [
    ("apt", "apt install"),
    ("apt-get", "apt-get install"),
    ("dpkg", "dpkg -i"),
    ("pip", "pip install"),
    ("pip3", "pip3 install"),
    ("npm", "npm install"),
    ("npm", "npm ci"),
    ("yarn", "yarn install"),
    ("cargo", "cargo build"),
    ("cargo", "cargo install"),
    ("make", "make install"),
    ("cmake", "cmake --build"),
    ("rustup", "rustup"),
    ("snap", "snap install"),
    ("flatpak", "flatpak install"),
    ("go", "go install"),
    ("gem", "gem install"),
]


def detect_installs(log: logging.Logger) -> list[dict]:
    """Scan running processes for active install/build operations."""
    found = []
    try:
        result = _sp.run(
            ["ps", "aux", "--no-headers"],
            capture_output=True, text=True, timeout=5,
        )
        for line in result.stdout.splitlines():
            cols = line.split(None, 10)
            if len(cols) < 11:
                continue
            pid, cmd_full = cols[1], cols[10]
            cmd_lower = cmd_full.lower()
            for proc_name, pattern in _INSTALL_PATTERNS:
                if pattern.replace(" ", "") in cmd_lower.replace(" ", ""):
                    found.append({
                        "pid": int(pid),
                        "process": proc_name,
                        "command": cmd_full[:120],
                        "detected_at": time.time(),
                    })
                    break
    except Exception as e:
        log.debug(f"Install detection failed: {e}")
    return found


def update_install_tracking(state: PulseState, log: logging.Logger):
    """Detect new/finished installs and update state."""
    current = detect_installs(log)
    current_pids = {i["pid"] for i in current}
    prev_pids = {i["pid"] for i in state.active_installs}

    # New installs
    for inst in current:
        if inst["pid"] not in prev_pids:
            log.info(f"🔧 Install STARTED: {inst['process']} (PID {inst['pid']}) — {inst['command'][:80]}")

    # Finished installs
    for inst in state.active_installs:
        if inst["pid"] not in current_pids:
            duration = time.time() - inst.get("detected_at", time.time())
            finished = {
                **inst,
                "finished_at": time.time(),
                "duration_sec": round(duration, 1),
            }
            state.completed_installs.append(finished)
            log.info(f"✅ Install FINISHED: {inst['process']} (PID {inst['pid']}) — {duration:.0f}s")

    state.active_installs = current


# ─── Quiet Hours ────────────────────────────────────────────────────────────

def is_quiet_hours(config: PulseConfig) -> bool:
    hour = datetime.now(PKT).hour
    if config.quiet_hours_start > config.quiet_hours_end:
        return hour >= config.quiet_hours_start or hour < config.quiet_hours_end
    return hour >= config.quiet_hours_start and hour < config.quiet_hours_end


# ─── Main Loop ──────────────────────────────────────────────────────────────

class Pulse:
    def __init__(self, config: PulseConfig = None):
        self.config = config or PulseConfig()
        self.state = PulseState.load(self.config.state_file)
        self.log = setup_logging(self.config.log_file)
        self.running = True

        # Load API key
        if not self.config.api_key:
            env_path = Path(self.config.workspace) / ".env"
            if env_path.exists():
                for line in env_path.read_text().splitlines():
                    if line.startswith("MACH6_API_KEY="):
                        self.config.api_key = line.split("=", 1)[1].strip().strip('"')
                        break

        signal.signal(signal.SIGTERM, self._shutdown)
        signal.signal(signal.SIGINT, self._shutdown)
        self._shutting_down = False

    def _shutdown(self, signum, frame):
        if self._shutting_down:
            return  # prevent double-flush from re-entrant signal
        self._shutting_down = True
        self.log.info(f"Shutdown signal ({signum}). Flushing COMB and saving state...")
        comb_flush(self.config.workspace, self.log, reason=f"shutdown (signal {signum})")
        self.running = False
        self.state.save(self.config.state_file)

    def run(self):
        """Main consciousness loop."""
        self.log.info("=" * 60)
        self.log.info("PULSE starting — Persistent Unsupervised Loop for Qorvex Execution")
        self.log.info(f"Triage: {self.config.triage_url} ({self.config.triage_model})")
        self.log.info(f"Work: {self.config.symbiote_url}")
        self.log.info(f"Budget: {self.config.max_triage_per_day} triage, {self.config.max_work_per_day} work/day")
        self.log.info("=" * 60)

        # Boot the clock
        self.state.boot_ts = time.time()
        self._last_clock_tick = time.time()

        # Stage boot event into COMB for session awareness
        boot_time = datetime.now(PKT).strftime("%H:%M:%S PKT")
        comb_stage(self.config.workspace, self.log,
                   f"PULSE booted at {boot_time}. Budget: {self.config.max_triage_per_day}T/{self.config.max_work_per_day}W.")

        while self.running:
            try:
                self.state.reset_if_new_day()
                self._tick_clock()
                update_install_tracking(self.state, self.log)
                memory_maintenance(self.log, workspace=self.config.workspace)
                self._cycle()
                self.state.save(self.config.state_file)
            except Exception as e:
                self.log.error(f"Cycle error: {e}", exc_info=True)
                comb_flush(self.config.workspace, self.log, reason=f"cycle exception: {e}")
                time.sleep(60)  # back off on error

        self.log.info("PULSE stopped.")

    def _tick_clock(self):
        """Update uptime counters."""
        now = time.time()
        elapsed = now - self._last_clock_tick
        self.state.total_uptime_sec += elapsed
        self._last_clock_tick = now

    def _cycle(self):
        """One triage-work-sleep cycle."""
        now = time.time()

        # ── Gate 1: Respect conversation flow ──
        last_activity = get_last_activity(self.config)
        self.state.last_activity_ts = last_activity
        silence_sec = now - last_activity if last_activity else float('inf')

        if silence_sec < self.config.idle_delay_sec:
            wait = self.config.idle_delay_sec - silence_sec
            self.log.debug(f"Active conversation ({silence_sec:.0f}s ago). Sleeping {wait:.0f}s.")
            self._sleep(min(wait + 30, 300))  # check again in 5 min max
            return

        # ── Gate 2: Respect triage interval ──
        since_triage = now - self.state.last_triage_ts
        if since_triage < self.config.triage_interval_sec:
            wait = self.config.triage_interval_sec - since_triage
            self.log.debug(f"Too soon since last triage ({since_triage:.0f}s). Sleeping {wait:.0f}s.")
            self._sleep(min(wait + 10, 300))
            return

        # ── Gate 3: Budget check ──
        if self.state.triage_count >= self.config.max_triage_per_day:
            self.log.warning("Daily triage budget exhausted. Flushing COMB.")
            comb_flush(self.config.workspace, self.log, reason="triage budget exhausted")
            self._sleep(3600)
            return

        # ── Gate 4: Quiet hours (allow triage but log it) ──
        quiet = is_quiet_hours(self.config)
        if quiet:
            self.log.info("Quiet hours — triage will only consider nightly tasks.")

        # ── Triage ──
        context = gather_context(self.config, self.state)
        context["quiet_hours"] = quiet
        # Inject install awareness into triage context
        if self.state.active_installs:
            context["active_installs"] = [
                {"process": i["process"], "command": i["command"][:60], "pid": i["pid"]}
                for i in self.state.active_installs
            ]
        if self.state.completed_installs:
            context["recent_installs_completed"] = [
                {"process": i["process"], "duration_sec": i.get("duration_sec", 0)}
                for i in self.state.completed_installs[-5:]
            ]
        # Inject clock
        context["clock"] = {
            "uptime_min": round(self.state.total_uptime_sec / 60, 1),
            "cycles_today": self.state.total_cycles,
            "work_time_min": round(self.state.total_work_sec / 60, 1),
            "boot_time": datetime.fromtimestamp(self.state.boot_ts, PKT).strftime("%H:%M:%S") if self.state.boot_ts else None,
        }

        decision = triage(self.config, context, self.log)
        self.state.last_triage_ts = time.time()
        self.state.triage_count += 1
        self.state.total_cycles += 1

        if decision is None:
            self.log.warning("Triage failed (timeout/rate-limit/error). Flushing COMB.")
            comb_flush(self.config.workspace, self.log, reason="triage API failure")
            self._sleep(900)
            return

        self.state.tokens_used += decision.get("_tokens", 0)
        action = decision.get("action", "skip")
        self.state.last_triage_decision = json.dumps(decision)

        # ── Handle decision ──
        if action == "skip":
            self.state.consecutive_skips += 1
            # Exponential backoff: more idle cycles → longer sleep
            backoff = min(self.config.triage_interval_sec * (1.5 ** min(self.state.consecutive_skips, 6)), 7200)
            self.log.info(f"Skip (x{self.state.consecutive_skips}). Next triage in {backoff:.0f}s.")
            self._sleep(backoff)
            return

        if action == "wait":
            self.state.consecutive_skips = 0
            self._sleep(self.config.triage_interval_sec // 2)
            return

        if action == "work":
            self.state.consecutive_skips = 0
            task = decision.get("task")
            if not task:
                self.log.warning("Triage said 'work' but no task. Skipping.")
                self._sleep(self.config.triage_interval_sec)
                return

            # Budget gate for work
            if self.state.work_count >= self.config.max_work_per_day:
                self.log.warning(f"Daily work budget exhausted ({self.state.work_count}/{self.config.max_work_per_day}). Flushing COMB.")
                comb_flush(self.config.workspace, self.log, reason="work budget exhausted")
                self._sleep(3600)
                return

            # Min gap between work turns
            since_work = time.time() - self.state.last_work_ts
            if since_work < self.config.min_work_gap_sec:
                wait = self.config.min_work_gap_sec - since_work
                self.log.info(f"Too soon since last work ({since_work:.0f}s). Waiting {wait:.0f}s.")
                self._sleep(wait)
                return

            # ── Execute work ──
            self.log.info(f">>> WORK: {task}")
            work_start = time.time()
            result = execute_work(self.config, task, self.log)
            work_elapsed = time.time() - work_start
            self.state.last_work_ts = time.time()
            self.state.work_count += 1
            self.state.total_work_sec += work_elapsed

            if result:
                summary = task[:80]
                self.state.tasks_completed.append({
                    "task": summary,
                    "time": datetime.now(PKT).strftime("%H:%M"),
                    "success": True,
                })
                self.log.info(f"✅ Work completed: {summary}")
            else:
                self.log.warning(f"❌ Work failed: {task[:80]}. Flushing COMB.")
                comb_flush(self.config.workspace, self.log, reason=f"work execution failed: {task[:60]}")

            self._sleep(self.config.triage_interval_sec)
            return

        # Unknown action
        self.log.warning(f"Unknown triage action: {action}")
        self._sleep(self.config.triage_interval_sec)

    def _sleep(self, seconds: float):
        """Interruptible sleep — checks for signals every 10s."""
        end = time.time() + seconds
        while self.running and time.time() < end:
            time.sleep(min(10, end - time.time()))

    def status(self) -> dict:
        """Return current PULSE status."""
        self.state.reset_if_new_day()
        return {
            "running": self.running,
            "state": asdict(self.state),
            "config": {
                "idle_delay": self.config.idle_delay_sec,
                "triage_interval": self.config.triage_interval_sec,
                "quiet_hours": f"{self.config.quiet_hours_start}:00-{self.config.quiet_hours_end}:00",
            },
            "quiet_hours_now": is_quiet_hours(self.config),
            "last_activity_ago_min": round((time.time() - self.state.last_activity_ts) / 60, 1) if self.state.last_activity_ts else None,
        }


# ─── CLI ────────────────────────────────────────────────────────────────────

def main():
    import argparse
    parser = argparse.ArgumentParser(description="PULSE — Symbiote autonomous maintenance loop")
    parser.add_argument("command", nargs="?", default="run",
                        choices=["run", "status", "triage-once", "context"],
                        help="Command to execute")
    parser.add_argument("--idle-delay", type=int, default=600,
                        help="Seconds after last activity before first triage (default: 600)")
    parser.add_argument("--triage-interval", type=int, default=900,
                        help="Seconds between triage cycles (default: 900)")
    parser.add_argument("--max-work", type=int, default=12,
                        help="Max work turns per day (default: 12)")

    args = parser.parse_args()

    config = PulseConfig(
        idle_delay_sec=args.idle_delay,
        triage_interval_sec=args.triage_interval,
        max_work_per_day=args.max_work,
    )

    if args.command == "status":
        state = PulseState.load(config.state_file)
        state.reset_if_new_day()
        now = time.time()

        # Format uptime
        uptime = state.total_uptime_sec
        if state.boot_ts:
            uptime += now - state.boot_ts  # approximate if still running
        uptime_h = int(uptime // 3600)
        uptime_m = int((uptime % 3600) // 60)

        info = {
            "date": state.date,
            "clock": {
                "uptime": f"{uptime_h}h {uptime_m}m",
                "boot_time": datetime.fromtimestamp(state.boot_ts, PKT).strftime("%H:%M:%S PKT") if state.boot_ts else "not running",
                "current_time": datetime.now(PKT).strftime("%H:%M:%S PKT"),
                "cycles_today": state.total_cycles,
                "work_time_min": round(state.total_work_sec / 60, 1),
            },
            "budget": {
                "triage": f"{state.triage_count}/{config.max_triage_per_day}",
                "work": f"{state.work_count}/{config.max_work_per_day}",
                "tokens": f"{state.tokens_used:,}/{config.max_tokens_per_day:,}",
            },
            "timing": {
                "last_triage": datetime.fromtimestamp(state.last_triage_ts, PKT).strftime("%H:%M:%S") if state.last_triage_ts else "never",
                "last_work": datetime.fromtimestamp(state.last_work_ts, PKT).strftime("%H:%M:%S") if state.last_work_ts else "never",
                "consecutive_skips": state.consecutive_skips,
            },
            "installs": {
                "active": [{"process": i["process"], "pid": i["pid"], "cmd": i["command"][:60]} for i in state.active_installs],
                "completed_today": len(state.completed_installs),
                "recent": [{"process": i["process"], "duration": f"{i.get('duration_sec', 0):.0f}s"} for i in state.completed_installs[-3:]],
            },
            "tasks_today": state.tasks_completed,
            "quiet_hours": is_quiet_hours(config),
        }
        print(json.dumps(info, indent=2))

    elif args.command == "context":
        state = PulseState.load(config.state_file)
        state.reset_if_new_day()
        state.last_activity_ts = get_last_activity(config)
        ctx = gather_context(config, state)
        print(json.dumps(ctx, indent=2))

    elif args.command == "triage-once":
        state = PulseState.load(config.state_file)
        state.reset_if_new_day()
        state.last_activity_ts = get_last_activity(config)
        log = setup_logging(config.log_file)
        ctx = gather_context(config, state)
        ctx["quiet_hours"] = is_quiet_hours(config)
        decision = triage(config, ctx, log)
        if decision:
            print(json.dumps(decision, indent=2))
        else:
            print("Triage failed")
            sys.exit(1)

    elif args.command == "run":
        pulse = Pulse(config)
        pulse.run()


if __name__ == "__main__":
    main()
