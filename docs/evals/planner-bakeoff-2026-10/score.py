#!/usr/bin/env python3
"""Score the committed planner bake-off, or refuse to invent a new one.

Scoring reads raw plans, blinded judge JSON, and the price catalogs.
It does not call a model.

``--run`` is the regeneration path. It does not run unless the native
``claude`` binary is on PATH and ``claude auth status`` succeeds, or
``ANTHROPIC_API_KEY`` is set. This checkout had neither, so the committed
plans came from Cursor subagents. See the report for that transport.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[2]
RAW = ROOT / "raw"
JUDGE = ROOT / "judge"
PROMPTS = ROOT / "prompts"

TASKS = ("argon", "reviewer", "writer2", "weekly", "wiki", "journal")
MODELS = ("fable", "sonnet")
DIMS = ("correctness", "completeness", "risk", "sequencing", "conciseness")

# Blind labels from random.seed(20261017), shuffled per task.
LABELS = {
    "argon": {"A": "fable", "B": "sonnet"},
    "reviewer": {"A": "sonnet", "B": "fable"},
    "writer2": {"A": "fable", "B": "sonnet"},
    "weekly": {"A": "sonnet", "B": "fable"},
    "wiki": {"A": "sonnet", "B": "fable"},
    "journal": {"A": "fable", "B": "sonnet"},
}

# Checklist over the full raw plan. A hit is a case-insensitive regex.
# This is a scripted cross-check, not the official score. The official
# score is the blinded gpt-5.6-sol judge.
CHECKS: dict[str, list[tuple[str, str]]] = {
    "argon": [
        ("argon high on the roster", r"gemini-4-argon-high|argon-high"),
        ("argon medium on the roster", r"gemini-4-argon-medium|argon-medium"),
        ("argon tried before flash", r"argon-medium[\s\S]{0,80}flash|argon-high[\s\S]{0,120}flash"),
        ("grok stays primary", r"grok-grok-4-7"),
        ("flash medium stays", r"flash-medium|gemini-3-8-flash-medium"),
        ("flash high stays", r"flash-high|gemini-3-8-flash-high"),
        ("no OpenRouter Google route", r"openrouter"),
        ("list price 2 and 10", r"\$2|inputPerMillion: 2|2 / 10|\$2 and \$10"),
        ("sha256 pin", r"sha256"),
        ("planner stays fable", r"claude-fable"),
        ("harness-routing doc", r"harness-routing"),
        ("tracking updated", r"implementation-plan|Tracking"),
    ],
    "reviewer": [
        ("new primary id", r"codex-gpt-6-1-sol"),
        ("5.6 stays last", r"codex-gpt-5-6-sol"),
        ("pi fallback stays", r"pi-qwen3-8-flash"),
        ("pro is an alias", r"alias"),
        ("tier boundary", r"272000"),
        ("sha256 pin", r"sha256"),
        ("arch critic unchanged", r"reviewer-arch"),
        ("native brake", r"openai-codex|openrouter"),
        ("agents table", r"AGENTS\.md"),
        ("harness-run scripts", r"harness-run"),
    ],
    "writer2": [
        ("old route retired", r"retired"),
        ("old price row kept", r"qwen3-coder-plus"),
        ("moonshot refused", r"moonshot|kimi"),
        ("evidence note", r"plans/evidence"),
        ("sha256 pin", r"sha256"),
        ("argon order untouched", r"[Aa]rgon"),
        ("tool gate", r"tool"),
        ("inventory before admit", r"inventory"),
        ("qwen3.7-plus considered", r"qwen3\.7-plus"),
        ("meta not auto-admitted", r"meta|muse"),
    ],
    "weekly": [
        ("workflow file", r"\.github/workflows"),
        ("routes file untouched", r"routes\.yaml"),
        ("auth failure fails closed", r"401|403"),
        ("date and hash together", r"sha256"),
        ("cli-only rows kept", r"CLI-only|pi`, `grok`"),
        ("pr body lists ids", r"added"),
        ("no auto-merge", r"auto-merge|gh pr merge"),
        ("unit tests", r"[Tt]est"),
        ("harness-routing doc", r"harness-routing"),
        ("changelog", r"CHANGELOG"),
    ],
    "wiki": [
        ("under .kxm/knowledge", r"\.kxm/knowledge"),
        ("compile stays off", r"wiki-compile|ingest"),
        ("architecture page", r"architecture"),
        ("glossary link", r"glossary"),
        ("ci pattern", r"CI / required|control-plane"),
        ("runbooks", r"runbook"),
        ("no new npm script", r"npm script"),
        ("doc links", r"docs/README"),
        ("not inside compiler wiki/", r"wiki/"),
        ("no secrets", r"secret"),
    ],
    "journal": [
        ("no new store", r"lands a store|no store|does not land a store|not land a store|No changes to store"),
        ("workflow_not_found locked", r"workflow_not_found"),
        ("no relabel", r"relabel"),
        ("design note", r"design note|runtime-journal"),
        ("no invented version bump", r"version"),
        ("tracking", r"Tracking|implementation-plan"),
        ("no auto-promote", r"auto-promot"),
        ("refusal test", r"[Tt]est"),
    ],
}


def estimate_tokens(text: str) -> int:
    """Ceiling of characters divided by 4. Not a provider tokenizer."""
    return math.ceil(len(text) / 4)


def load_fable_rates() -> tuple[float, float]:
    text = (REPO / ".kxm" / "prices.yaml").read_text()
    match = re.search(
        r"id: anthropic/fable\b.*?inputPerMillion:\s*([0-9.]+)\s*\n\s*outputPerMillion:\s*([0-9.]+)",
        text,
        re.S,
    )
    if not match:
        raise SystemExit("prices.yaml has no anthropic/fable tier")
    return float(match.group(1)), float(match.group(2))


def load_sonnet_rates() -> tuple[float, float, str]:
    text = (REPO / ".kxm" / "prices.yaml").read_text()
    if re.search(r"id: anthropic/claude-sonnet-5\.5\b", text):
        match = re.search(
            r"id: anthropic/claude-sonnet-5\.5\b.*?inputPerMillion:\s*([0-9.]+)\s*\n\s*outputPerMillion:\s*([0-9.]+)",
            text,
            re.S,
        )
        if not match:
            raise SystemExit("sonnet row in prices.yaml has no tier")
        return float(match.group(1)), float(match.group(2)), "prices.yaml"
    inventory = (REPO / ".kxm" / "models" / "inventory.yaml").read_text()
    match = re.search(
        r"id: anthropic/claude-sonnet-5\.5\n(?:.*\n){0,20}?\s*standard:\n\s*inputPerMillion:\s*([0-9.]+)\n\s*outputPerMillion:\s*([0-9.]+)",
        inventory,
    )
    if not match:
        raise SystemExit("inventory.yaml has no anthropic/claude-sonnet-5.5 standard tier")
    return float(match.group(1)), float(match.group(2)), "inventory.yaml"


def cost(tokens_in: int, tokens_out: int, in_rate: float, out_rate: float) -> float:
    return (tokens_in * in_rate + tokens_out * out_rate) / 1_000_000


def prompt_text(task: str) -> str:
    shared = (PROMPTS / "shared.txt").read_text()
    packet = (PROMPTS / f"{task}.txt").read_text()
    return shared + "\n" + packet


def checklist(task: str, text: str) -> tuple[int, int, list[str]]:
    hits = []
    missed = []
    for name, pattern in CHECKS[task]:
        if re.search(pattern, text, re.I):
            hits.append(name)
        else:
            missed.append(name)
    return len(hits), len(CHECKS[task]), missed


def unblind(task: str) -> dict[str, dict]:
    payload = json.loads((JUDGE / f"{task}.json").read_text())
    labels = LABELS[task]
    out = {}
    for label, model in labels.items():
        key = "planA" if label == "A" else "planB"
        scores = payload[key]
        out[model] = {
            "label": label,
            "scores": {dim: scores[dim] for dim in DIMS},
            "total": sum(scores[dim] for dim in DIMS),
        }
    out["winner_label"] = payload["winner"]
    winner = {"A": labels["A"], "B": labels["B"], "tie": "tie"}[payload["winner"]]
    out["winner"] = winner
    out["rationale"] = payload["rationale"]
    return out


def score() -> dict:
    fable_in, fable_out = load_fable_rates()
    sonnet_in, sonnet_out, sonnet_source = load_sonnet_rates()
    rates = {
        "fable": (fable_in, fable_out, "prices.yaml anthropic/fable"),
        "sonnet": (sonnet_in, sonnet_out, sonnet_source + " anthropic/claude-sonnet-5.5"),
    }
    tasks = []
    totals = {model: {"judge": 0, "tokens_in": 0, "tokens_out": 0, "cost": 0.0, "wins": 0} for model in MODELS}
    for task in TASKS:
        judged = unblind(task)
        row = {"task": task, "winner": judged["winner"], "rationale": judged["rationale"], "models": {}}
        for model in MODELS:
            text = (RAW / f"{task}-{model}.txt").read_text()
            prompt = prompt_text(task)
            tokens_in = estimate_tokens(prompt)
            tokens_out = estimate_tokens(text)
            in_rate, out_rate, source = rates[model]
            price = cost(tokens_in, tokens_out, in_rate, out_rate)
            got, total, missed = checklist(task, text)
            entry = {
                "judge": judged[model],
                "words": len(text.split()),
                "tokens_in_estimate": tokens_in,
                "tokens_out_estimate": tokens_out,
                "list_cost_usd": round(price, 6),
                "price_source": source,
                "checklist_hits": got,
                "checklist_total": total,
                "checklist_missed": missed,
            }
            row["models"][model] = entry
            totals[model]["judge"] += judged[model]["total"]
            totals[model]["tokens_in"] += tokens_in
            totals[model]["tokens_out"] += tokens_out
            totals[model]["cost"] += price
        if judged["winner"] in totals:
            totals[judged["winner"]]["wins"] += 1
        tasks.append(row)
    for model in MODELS:
        totals[model]["list_cost_usd"] = round(totals[model]["cost"], 6)
    return {
        "token_method": "ceil(characters/4) on prompts/<task>.txt plus prompts/shared.txt, and on raw/<task>-<model>.txt. Not provider usage.",
        "max_judge_per_task": 25,
        "tasks": tasks,
        "totals": totals,
        "rates": {
            "fable_input": fable_in,
            "fable_output": fable_out,
            "sonnet_input": sonnet_in,
            "sonnet_output": sonnet_out,
            "sonnet_source": sonnet_source,
        },
    }


def credentials_present() -> list[str]:
    missing = []
    if shutil.which("claude") is None:
        missing.append("claude CLI is not on PATH (kxm's planner one-shot spawns claude -p)")
    if not (Path.home() / ".claude").exists() and not (Path.home() / ".config" / "claude").exists():
        missing.append("no ~/.claude or ~/.config/claude auth directory")
    # Names only. Do not print values.
    import os
    if not os.environ.get("ANTHROPIC_API_KEY"):
        missing.append("ANTHROPIC_API_KEY is unset")
    return missing


def run_refused() -> int:
    missing = credentials_present()
    sys.stderr.write(
        "planner bake-off regeneration refused.\n"
        "kxm's planner one-shot is: claude -p --model <model> --effort medium "
        "--output-format json, plus the read-only permission arguments in "
        "plugins/kxm/src/harness.ts (oneShotReadOnlyArgs claude).\n"
        "There is no kxm flag that overrides the planner model without editing "
        ".kxm/roles/planner.yaml and admitting the route. This bake-off must not do that.\n"
        "kxm routing benchmark prints placeholder numbers and does not call a model.\n"
    )
    if missing:
        sys.stderr.write("Missing:\n")
        for item in missing:
            sys.stderr.write(f"- {item}\n")
        sys.stderr.write("Refusing to simulate plans.\n")
        return 2
    sys.stderr.write("Credentials appear present. This script still does not dispatch; use the native claude one-shot with prompts/*.txt.\n")
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", action="store_true", help="attempt a live regeneration; fail closed without credentials")
    parser.add_argument("--score", action="store_true", help="score the committed raw plans")
    args = parser.parse_args(argv)
    if args.run:
        return run_refused()
    payload = score()
    json.dump(payload, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
