#!/usr/bin/env python3
"""Weekly scorecard for Bob's opt-in eval harness JSONL.

Python 3 standard library only. Observe-only: never talks to Minecraft,
never prints raw prompts, replies, chat, player names (except Bob),
coordinates of other players, webhook URLs, or secrets.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import stat
import sys
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

SAFE_CMD = re.compile(r"^![A-Za-z0-9_]{1,40}$")
ISO_TS = re.compile(r"^\d{4}-\d{2}-\d{2}T")
RATE_LIMIT = re.compile(r"\b429\b|rate[\s_-]?limit|quota", re.I)
DEATH = re.compile(r"\b(died|death|respawned|respawn)\b", re.I)
PARAM_ERR = re.compile(r"\bparam\b|\bargs?\b|invalid (block|item|block or item) type", re.I)
NUM = re.compile(r"-?\d+(?:\.\d+)?")
URL = re.compile(r"https?://\S+", re.I)
SECRET = re.compile(r"\b(?:sk|pk|rk)-[A-Za-z0-9]{8,}\b|Bearer\s+\S+", re.I)
DISCORD_LIMIT = 1900
SKIP_SCAN_KEYS = frozenset({"text", "prompt", "note", "world"})

EXIT_OK = 0
EXIT_EMPTY = 1
EXIT_DISCORD = 2


def utcnow():
    return datetime.now(timezone.utc)


def parse_iso(value):
    if value is None or value == "":
        return None
    text = str(value).strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def parse_args(argv=None):
    home = Path.home()
    p = argparse.ArgumentParser(description="Weekly Bob eval-harness scorecard")
    p.add_argument("--log", default=os.environ.get("BOB_EVAL_HARNESS_LOG", ""),
                   help="Absolute JSONL path (default BOB_EVAL_HARNESS_LOG)")
    p.add_argument("--days", type=int, default=7, help="Window length if --since omitted")
    p.add_argument("--since", default="", help="ISO start (inclusive)")
    p.add_argument("--until", default="", help="ISO end (inclusive)")
    p.add_argument("--outdir", default=str(home / "BobRuntime" / "logs" / "scorecards"),
                   help="Directory for markdown and JSON (default ~/BobRuntime/logs/scorecards)")
    p.add_argument("--webhook-file", default="",
                   help="Mode-0600 file containing a Discord webhook URL")
    p.add_argument("--no-discord", action="store_true", help="Do not POST to Discord")
    p.add_argument("--dry-run", action="store_true", help="Print markdown to stdout only")
    return p.parse_args(argv)


def sanitize_cmd(name):
    text = str(name or "").strip()
    return text if SAFE_CMD.match(text) else "unknown"


def coarse_text(value, limit=80):
    text = str(value or "")
    text = URL.sub("[url]", text)
    text = SECRET.sub("[redacted]", text)
    text = NUM.sub("#", text)
    text = re.sub(r"[\x00-\x1f]+", " ", text).strip()
    if len(text) > limit:
        text = text[:limit] + "…"
    return text


def safe_label(value, limit=40):
    text = str(value or "unknown")
    text = URL.sub("[url]", text)
    text = SECRET.sub("[redacted]", text)
    text = re.sub(r"[\x00-\x1f]+", " ", text).strip() or "unknown"
    return text[:limit]


def event_ts(event):
    return parse_iso(event.get("ts"))


def sibling_logs(path: Path):
    found = []
    if path.is_file() and not path.is_symlink():
        found.append(path)
    parent = path.parent
    if not parent.is_dir():
        return found
    name = path.name
    stem = path.stem
    candidates = [Path(str(path) + f".{i}") for i in range(1, 5)]
    try:
        for child in parent.iterdir():
            if child.is_symlink() or not child.is_file():
                continue
            n = child.name
            if n == name or n.startswith(name + ".") or n.startswith(stem + ".") and "jsonl" in n:
                candidates.append(child)
    except OSError:
        pass
    seen = set()
    out = []
    for item in candidates:
        try:
            if item.is_symlink() or not item.is_file():
                continue
            key = item.resolve()
        except OSError:
            continue
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out


def iter_records(paths):
    malformed = 0
    files_read = 0
    for path in paths:
        try:
            with path.open("r", encoding="utf-8", errors="replace") as fh:
                files_read += 1
                for raw in fh:
                    line = raw.strip()
                    if not line:
                        continue
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        malformed += 1
                        continue
                    if not isinstance(event, dict) or not event.get("type"):
                        malformed += 1
                        continue
                    yield event, None
        except OSError:
            malformed += 1
    yield None, {"malformed": malformed, "files_read": files_read}


def in_window(event, since, until):
    ts = event_ts(event)
    if ts is None:
        return False
    if since and ts < since:
        return False
    if until and ts > until:
        return False
    return True


def percentile(values, p):
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return int(round(ordered[0]))
    rank = (len(ordered) - 1) * (p / 100.0)
    lo = int(rank)
    hi = min(lo + 1, len(ordered) - 1)
    frac = rank - lo
    return int(round(ordered[lo] * (1 - frac) + ordered[hi] * frac))


def looks_rate_limit(event):
    for key, value in event.items():
        if key in SKIP_SCAN_KEYS or not isinstance(value, str):
            continue
        if RATE_LIMIT.search(value):
            return True
    return False


def looks_death(event):
    kind = event.get("type")
    fields = []
    if kind == "history_append":
        fields = [event.get("kind"), event.get("role")]
    elif kind == "turn_end":
        fields = [event.get("reason")]
    elif kind == "task_event":
        fields = [event.get("event_type"), event.get("label"), event.get("reason"), event.get("state")]
    elif kind == "exec_end":
        fields = [event.get("result_summary")]
    elif kind == "goal_change":
        fields = [event.get("reason")]
    return any(isinstance(x, str) and DEATH.search(x) for x in fields)


def chat_mode(event):
    lane = str(event.get("lane") or "")
    if lane and lane != "conversation":
        return None
    model = str(event.get("model") or "").lower()
    backend = str(event.get("backend") or "").lower()
    blob = model + " " + backend
    if "lite" in blob:
        return "lite"
    if "andy-4.2" in blob or "andy_pool" in blob or "lmstudio" in blob:
        return "full"
    return "unknown"


def parse_bucket(event):
    has_command = bool(event.get("has_command"))
    exists = event.get("exists") is True
    parse_ok = event.get("parse_ok") is not False
    error = str(event.get("error") or "")
    if not has_command:
        return "no_command"
    if PARAM_ERR.search(error):
        return "bad_param"
    if not parse_ok or exists is False:
        return "parse_error"
    if exists and parse_ok:
        return "valid_command"
    return "parse_error"


def action_outcome(event):
    if event.get("timedout"):
        return "timeout"
    if event.get("interrupted"):
        return "interrupted"
    if event.get("threw"):
        return "failed"
    state = str(event.get("task_state") or "").lower()
    if state in ("failed", "cancelled", "uncertain"):
        return "failed" if state == "failed" else state
    return "succeeded"


def analyze(events, malformed, files_read, since, until, log_names):
    runs = set()
    turns = set()
    models = defaultdict(lambda: {"n": 0, "lat": [], "errors": 0, "empty": 0, "rate_limit": 0})
    parse_counts = Counter()
    invalid_cmds = Counter()
    invalid_params = Counter()
    guards = Counter()
    exec_by_cmd = defaultdict(Counter)
    exec_totals = Counter()
    goal_verdicts = Counter()
    goal_sources = Counter()
    goal_changes = Counter()
    failures = Counter()
    deaths = 0
    modes = Counter()
    missing_ts = 0
    cmd_by_id = {}

    for event in events:
        if event_ts(event) is None:
            missing_ts += 1
        rid = event.get("run_id")
        if isinstance(rid, str) and rid:
            runs.add(rid)
        tid = event.get("turn_id")
        if isinstance(tid, str) and tid:
            turns.add(tid)
        cid = event.get("command_id")
        if isinstance(cid, str) and cid and event.get("command_name"):
            cmd_by_id[cid] = sanitize_cmd(event.get("command_name"))
        kind = event.get("type")

        if kind == "model_response":
            lane = safe_label(event.get("lane") or "unknown", 40)
            model = safe_label(event.get("model") or event.get("backend") or "unknown", 40)
            key = (lane, model)
            row = models[key]
            row["n"] += 1
            if isinstance(event.get("latency_ms"), (int, float)):
                row["lat"].append(float(event["latency_ms"]))
            if event.get("is_model_error"):
                row["errors"] += 1
            if event.get("empty"):
                row["empty"] += 1
            if looks_rate_limit(event):
                row["rate_limit"] += 1
            mode = chat_mode(event)
            if mode:
                modes[mode] += 1

        elif kind == "parse":
            bucket = parse_bucket(event)
            parse_counts[bucket] += 1
            cmd = sanitize_cmd(event.get("command_name"))
            if bucket in ("parse_error", "bad_param") and event.get("has_command"):
                invalid_cmds[cmd] += 1
            if bucket == "bad_param":
                invalid_params[coarse_text(event.get("error") or "bad param", 60)] += 1

        elif kind == "guard":
            g = str(event.get("kind") or "unknown")
            if g == "failure":
                g = "failures"
            guards[g] += 1
            if g in ("repeat", "survival", "stuck", "failures", "collect"):
                failures[f"guard:{g}"] += 1

        elif kind == "exec_end":
            cmd = sanitize_cmd(event.get("command_name") or cmd_by_id.get(event.get("command_id")))
            outcome = action_outcome(event)
            exec_by_cmd[cmd][outcome] += 1
            exec_totals[outcome] += 1
            if outcome in ("failed", "timeout", "interrupted"):
                failures[f"{cmd}|{outcome}|{coarse_text(event.get('result_summary'), 50)}"] += 1
            elif "could not" in str(event.get("result_summary") or "").lower():
                failures[f"{cmd}|returned|{coarse_text(event.get('result_summary'), 50)}"] += 1

        elif kind == "goal_check":
            goal_verdicts[coarse_text(event.get("verdict") or "unknown", 40)] += 1
            goal_sources[coarse_text(event.get("verdict_source") or "unknown", 40)] += 1

        elif kind == "goal_change":
            goal_changes[coarse_text(event.get("reason") or "change", 40)] += 1

        if looks_death(event):
            deaths += 1

    model_rows = []
    for (lane, model), row in sorted(models.items(), key=lambda kv: (-kv[1]["n"], kv[0])):
        model_rows.append({
            "lane": lane,
            "model": model,
            "n": row["n"],
            "p50_ms": percentile(row["lat"], 50),
            "p95_ms": percentile(row["lat"], 95),
            "errors": row["errors"],
            "rate_limit": row["rate_limit"],
            "empty": row["empty"],
        })

    exec_rows = []
    for cmd, counts in sorted(exec_by_cmd.items(), key=lambda kv: (-sum(kv[1].values()), kv[0])):
        exec_rows.append({
            "command": cmd,
            "succeeded": counts.get("succeeded", 0),
            "failed": counts.get("failed", 0),
            "interrupted": counts.get("interrupted", 0),
            "timeout": counts.get("timeout", 0),
            "cancelled": counts.get("cancelled", 0),
            "uncertain": counts.get("uncertain", 0),
        })

    top_fail = [{"pattern": pat, "n": n} for pat, n in failures.most_common(5)]

    return {
        "window": {
            "since": since.isoformat() if since else None,
            "until": until.isoformat() if until else None,
        },
        "log_files": log_names,
        "files_read": files_read,
        "malformed_lines": malformed,
        "missing_ts": missing_ts,
        "runs": len(runs),
        "restarts": max(0, len(runs) - 1),
        "turns": len(turns),
        "model_calls": model_rows,
        "parse": {
            "valid_command": parse_counts.get("valid_command", 0),
            "no_command": parse_counts.get("no_command", 0),
            "parse_error": parse_counts.get("parse_error", 0),
            "bad_param": parse_counts.get("bad_param", 0),
            "top_invalid_commands": [{"command": c, "n": n} for c, n in invalid_cmds.most_common(8)],
            "top_invalid_params": [{"param": c, "n": n} for c, n in invalid_params.most_common(8)],
        },
        "guards": dict(guards),
        "action_results": {
            "label": "ACTION results. task.finished/succeeded is never proof of goal completion.",
            "totals": dict(exec_totals),
            "by_command": exec_rows,
        },
        "goal_check": {
            "stub_verifier": True,
            "verdicts": dict(goal_verdicts),
            "sources": dict(goal_sources),
        },
        "goal_changes": dict(goal_changes),
        "deaths": deaths,
        "lite_vs_full": dict(modes),
        "top_failure_patterns": top_fail,
    }


def delta_map(current, previous):
    if not previous:
        return None
    keys = ("runs", "restarts", "turns", "deaths")
    out = {}
    for key in keys:
        out[key] = int(current.get(key) or 0) - int(previous.get(key) or 0)
    cur_err = sum(r.get("errors", 0) for r in current.get("model_calls") or [])
    prev_err = sum(r.get("errors", 0) for r in previous.get("model_calls") or [])
    out["model_errors"] = cur_err - prev_err
    cur_g = sum((current.get("guards") or {}).values())
    prev_g = sum((previous.get("guards") or {}).values())
    out["guards"] = cur_g - prev_g
    cur_f = (current.get("action_results") or {}).get("totals", {}).get("failed", 0)
    prev_f = (previous.get("action_results") or {}).get("totals", {}).get("failed", 0)
    out["action_failed"] = int(cur_f or 0) - int(prev_f or 0)
    return out


def find_previous(outdir: Path, stamp: str):
    best = None
    best_name = ""
    if not outdir.is_dir():
        return None
    for path in outdir.glob("scorecard-*.json"):
        if path.name == f"scorecard-{stamp}.json":
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(data, dict):
            continue
        if path.name > best_name:
            best = data
            best_name = path.name
    return best


def fmt_delta(n):
    if n is None:
        return "n/a"
    if n > 0:
        return f"+{n}"
    return str(n)


def render_markdown(summary):
    win = summary["window"]
    lines = [
        "# Bob eval harness weekly scorecard",
        "",
        f"- Window: `{win.get('since') or '?'}` … `{win.get('until') or '?'}`",
        f"- Log files read: {summary['files_read']} ({', '.join(summary.get('log_files') or ['none'])})",
        f"- Malformed or truncated lines: {summary['malformed_lines']}",
        "",
        "## Runs and restarts",
        f"- Distinct `run_id`: **{summary['runs']}**",
        f"- Restarts (run_id after the first): **{summary['restarts']}**",
        f"- Turns: **{summary['turns']}**",
        "",
        "## Model calls",
        "",
        "| lane | model | n | p50 ms | p95 ms | errors | 429/rate-limit | empty |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    if not summary["model_calls"]:
        lines.append("| — | — | 0 | — | — | 0 | 0 | 0 |")
    for row in summary["model_calls"]:
        lines.append(
            f"| {row['lane']} | {row['model']} | {row['n']} | "
            f"{row['p50_ms'] if row['p50_ms'] is not None else '—'} | "
            f"{row['p95_ms'] if row['p95_ms'] is not None else '—'} | "
            f"{row['errors']} | {row['rate_limit']} | {row['empty']} |"
        )
    parse = summary["parse"]
    lines += [
        "",
        "## Parse",
        f"- Valid command: **{parse['valid_command']}**",
        f"- No command: **{parse['no_command']}**",
        f"- Parse error: **{parse['parse_error']}**",
        f"- Bad param: **{parse['bad_param']}**",
        "- Top invalid commands: "
        + (", ".join(f"`{x['command']}` ×{x['n']}" for x in parse["top_invalid_commands"]) or "none"),
        "- Top invalid params: "
        + (", ".join(f"`{x['param']}` ×{x['n']}" for x in parse["top_invalid_params"]) or "none"),
        "",
        "## Guard decisions",
    ]
    if not summary["guards"]:
        lines.append("- none")
    for kind in ("repeat", "survival", "stuck", "failures", "collect", "dropped_by_interrupt"):
        if kind in summary["guards"]:
            lines.append(f"- `{kind}`: **{summary['guards'][kind]}**")
    extra = [k for k in summary["guards"] if k not in {
        "repeat", "survival", "stuck", "failures", "collect", "dropped_by_interrupt"
    }]
    for kind in extra:
        lines.append(f"- `{kind}`: **{summary['guards'][kind]}**")

    lines += [
        "",
        "## Action results (NOT goal completion)",
        "",
        "These counts are **action / exec_end outcomes**. "
        "`task.finished` / `succeeded` is never proof of goal completion.",
        "",
        "| command | succeeded | failed | interrupted | timeout |",
        "| --- | ---: | ---: | ---: | ---: |",
    ]
    rows = summary["action_results"]["by_command"]
    if not rows:
        lines.append("| — | 0 | 0 | 0 | 0 |")
    for row in rows:
        lines.append(
            f"| `{row['command']}` | {row['succeeded']} | {row['failed']} | "
            f"{row['interrupted']} | {row['timeout']} |"
        )
    totals = summary["action_results"]["totals"]
    lines.append(
        f"- Totals: succeeded {totals.get('succeeded', 0)}, failed {totals.get('failed', 0)}, "
        f"interrupted {totals.get('interrupted', 0)}, timeout {totals.get('timeout', 0)}"
    )

    gc = summary["goal_check"]
    lines += [
        "",
        "## Goal checks (stub verifier)",
        "",
        "Verdicts come from the current **world-state stub**, not from `task.finished`.",
        f"- Sources: {', '.join(f'`{k}` ×{v}' for k, v in gc['sources'].items()) or 'none'}",
        f"- Verdicts: {', '.join(f'`{k}` ×{v}' for k, v in gc['verdicts'].items()) or 'none'}",
        "",
        "## Goal changes",
    ]
    if not summary["goal_changes"]:
        lines.append("- none")
    for reason, n in sorted(summary["goal_changes"].items()):
        lines.append(f"- `{reason}`: **{n}**")

    lv = summary["lite_vs_full"]
    lines += [
        "",
        "## Deaths",
        f"- Detectable death-like events: **{summary['deaths']}** "
        "(from event labels/reasons only; 0 if the harness did not record one)",
        "",
        "## Lite vs full (conversation lane)",
        f"- lite: **{lv.get('lite', 0)}**",
        f"- full: **{lv.get('full', 0)}**",
        f"- unknown: **{lv.get('unknown', 0)}**",
        "",
        "## Top 5 recurring failure patterns",
    ]
    if not summary["top_failure_patterns"]:
        lines.append("- none")
    for i, item in enumerate(summary["top_failure_patterns"], 1):
        lines.append(f"{i}. `{item['pattern']}` ×{item['n']}")

    lines += ["", "## Week-over-week"]
    delta = summary.get("week_over_week")
    if not delta:
        lines.append("- No previous `scorecard-*.json` in outdir; deltas skipped.")
    else:
        for key in ("turns", "runs", "restarts", "deaths", "model_errors", "guards", "action_failed"):
            lines.append(f"- {key}: {fmt_delta(delta.get(key))}")
    lines.append("")
    return "\n".join(lines)


def render_discord(summary):
    win = summary["window"]
    parts = [
        "Bob eval scorecard",
        f"Window {win.get('since') or '?'} .. {win.get('until') or '?'}",
        f"runs={summary['runs']} restarts={summary['restarts']} turns={summary['turns']}",
    ]
    for row in summary["model_calls"][:6]:
        parts.append(
            f"model {row['lane']}/{row['model']} n={row['n']} p50={row['p50_ms']} "
            f"err={row['errors']} 429={row['rate_limit']} empty={row['empty']}"
        )
    parse = summary["parse"]
    parts.append(
        f"parse valid={parse['valid_command']} none={parse['no_command']} "
        f"err={parse['parse_error']} param={parse['bad_param']}"
    )
    guards = " ".join(f"{k}={v}" for k, v in summary["guards"].items()) or "none"
    parts.append(f"guards {guards}")
    tot = summary["action_results"]["totals"]
    parts.append(
        f"actions (NOT goal completion) succ={tot.get('succeeded', 0)} "
        f"fail={tot.get('failed', 0)} int={tot.get('interrupted', 0)} to={tot.get('timeout', 0)}"
    )
    parts.append("task.finished/succeeded is never proof of goal completion.")
    gc = summary["goal_check"]["verdicts"]
    parts.append("goal_check stub: " + (", ".join(f"{k}={v}" for k, v in gc.items()) or "none"))
    parts.append(f"deaths={summary['deaths']} lite={summary['lite_vs_full'].get('lite', 0)} "
                 f"full={summary['lite_vs_full'].get('full', 0)}")
    if summary["top_failure_patterns"]:
        top = summary["top_failure_patterns"][0]
        parts.append(f"top fail `{top['pattern']}` x{top['n']}")
    text = "\n".join(parts)
    if "@everyone" in text.lower() or "@here" in text.lower():
        text = text.replace("@everyone", "").replace("@here", "").replace("@Everyone", "")
    return text


def split_messages(text, limit=DISCORD_LIMIT):
    if len(text) <= limit:
        return [text]
    chunks, buf = [], ""
    for line in text.split("\n"):
        add = (line + "\n") if buf else line
        if len(buf) + len(add) + (0 if buf else 0) > limit:
            if buf:
                chunks.append(buf.rstrip())
            buf = line
        else:
            buf = (buf + "\n" + line) if buf else line
    if buf:
        chunks.append(buf.rstrip())
    return chunks


def read_webhook(path_text):
    path = Path(path_text).expanduser()
    if not path.is_file() or path.is_symlink():
        raise RuntimeError("webhook file missing")
    mode = path.stat().st_mode
    if mode & (stat.S_IRWXG | stat.S_IRWXO):
        raise RuntimeError("webhook file must be mode 0600")
    url = path.read_text(encoding="utf-8").strip()
    if not url.startswith("https://"):
        raise RuntimeError("webhook file is not an https URL")
    return url


def post_discord(url, text):
    for chunk in split_messages(text):
        body = json.dumps({
            "content": chunk,
            "allowed_mentions": {"parse": [], "users": [], "roles": [], "replied_user": False},
        }).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=body,
            method="POST",
            headers={"Content-Type": "application/json", "User-Agent": "bob-scorecard"},
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                if getattr(resp, "status", 200) >= 300:
                    raise RuntimeError("discord status")
        except (urllib.error.URLError, TimeoutError, OSError, RuntimeError) as exc:
            raise RuntimeError("Discord post failed") from exc


def write_outputs(outdir: Path, stamp: str, markdown: str, summary: dict):
    outdir.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(outdir, 0o700)
    except OSError:
        pass
    md_path = outdir / f"scorecard-{stamp}.md"
    js_path = outdir / f"scorecard-{stamp}.json"
    md_path.write_text(markdown, encoding="utf-8")
    js_path.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    for path in (md_path, js_path):
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    return md_path, js_path


def empty_summary(since, until, log_names, files_read, malformed, message):
    base = analyze([], malformed, files_read, since, until, log_names)
    base["empty"] = True
    base["message"] = message
    return base


def main(argv=None):
    args = parse_args(argv)
    until = parse_iso(args.until) or utcnow()
    since = parse_iso(args.since) or (until - timedelta(days=max(1, int(args.days or 7))))
    stamp = until.date().isoformat()

    log_arg = str(args.log or "").strip()
    log_path = Path(log_arg).expanduser() if log_arg else None
    log_names = []
    files_read = 0
    malformed = 0
    events = []
    empty_reason = None

    if not log_arg:
        empty_reason = "No log path (set BOB_EVAL_HARNESS_LOG or pass --log)."
    elif not log_path.is_absolute():
        empty_reason = "Log path must be absolute."
    else:
        paths = sibling_logs(log_path)
        log_names = [p.name for p in paths]
        if not paths:
            empty_reason = "Log file not found."
        else:
            meta = None
            for item, info in iter_records(paths):
                if info is not None:
                    meta = info
                    continue
                if in_window(item, since, until):
                    events.append(item)
            files_read = (meta or {}).get("files_read", 0)
            malformed = (meta or {}).get("malformed", 0)
            if not events:
                empty_reason = "No events in the requested window."

    outdir = Path(args.outdir).expanduser()
    previous = None if args.dry_run else find_previous(outdir, stamp)

    if empty_reason:
        summary = empty_summary(since, until, log_names, files_read, malformed, empty_reason)
        markdown = (
            f"# Bob eval harness weekly scorecard\n\n"
            f"- Window: `{since.isoformat()}` … `{until.isoformat()}`\n"
            f"- {empty_reason}\n"
            f"- Malformed or truncated lines: {malformed}\n"
        )
    else:
        summary = analyze(events, malformed, files_read, since, until, log_names)
        summary["week_over_week"] = delta_map(summary, previous)
        markdown = render_markdown(summary)

    if args.dry_run:
        sys.stdout.write(markdown if markdown.endswith("\n") else markdown + "\n")
        return EXIT_EMPTY if empty_reason else EXIT_OK

    write_outputs(outdir, stamp, markdown, summary)

    want_discord = (not args.no_discord) and (
        bool(args.webhook_file) or bool(os.environ.get("BOB_SCORECARD_DISCORD_WEBHOOK"))
    )
    if want_discord:
        try:
            url = None
            if args.webhook_file:
                url = read_webhook(args.webhook_file)
            else:
                raw = str(os.environ.get("BOB_SCORECARD_DISCORD_WEBHOOK") or "").strip()
                if not raw.startswith("https://"):
                    raise RuntimeError("webhook env is not an https URL")
                url = raw
            post_discord(url, render_discord(summary))
        except Exception:
            sys.stderr.write("Discord post failed\n")
            return EXIT_DISCORD

    return EXIT_EMPTY if empty_reason else EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
