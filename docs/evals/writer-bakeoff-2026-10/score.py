#!/usr/bin/env python3
"""Reprint the OpenRouter price snapshot, or refuse to invent a score.

The October 2026 writer bake-off did not call a model. ``--score`` exits 2
until every raw arm exists. ``--run`` exits 2 until ``OPENROUTER_API_KEY``
is set, and it still does not call OpenRouter.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PRICES = ROOT / "prices.json"
TASKS = ROOT / "tasks.json"
RAW = ROOT / "raw"

MODELS = ("beam", "mercury", "qwen")
IDS = {
    "beam": "reflection/beam-1.0-501b-a23b",
    "mercury": "inception/mercury-3",
    "qwen": "qwen/qwen3.7-plus",
}


def per_million(per_token: str) -> str:
    """OpenRouter pricing fields are USD per token. Keep decimal exact."""
    value = Decimal(per_token) * Decimal(1_000_000)
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def load_json(path: Path) -> dict:
    payload = json.loads(path.read_text())
    if not isinstance(payload, dict):
        raise SystemExit(f"{path.name} must be a JSON object")
    return payload


def price_rows(snapshot: dict) -> list[dict]:
    by_id = {row["id"]: row for row in snapshot["models"]}
    missing = [model_id for model_id in IDS.values() if model_id not in by_id]
    if missing:
        raise SystemExit(f"prices.json is missing {', '.join(missing)}")
    rows = []
    for label, model_id in IDS.items():
        pricing = by_id[model_id]["pricing"]
        row = {
            "label": label,
            "id": model_id,
            "input_per_million": per_million(pricing["prompt"]),
            "output_per_million": per_million(pricing["completion"]),
            "cache_read_per_million": per_million(pricing["input_cache_read"])
            if pricing.get("input_cache_read")
            else None,
            "cache_write_per_million": per_million(pricing["input_cache_write"])
            if pricing.get("input_cache_write")
            else None,
        }
        rows.append(row)
    return rows


def print_prices() -> int:
    snapshot = load_json(PRICES)
    tasks = load_json(TASKS)
    if tasks.get("dispatch") != "not_sent":
        raise SystemExit("tasks.json dispatch must stay not_sent until a real run lands raw arms")
    for task in tasks["tasks"]:
        for field in ("landed", "parent"):
            value = task[field]
            if len(value) != 40 or any(char not in "0123456789abcdef" for char in value):
                raise SystemExit(f"{task['id']} {field} is not a 40-character sha")
    print(f"fetched_at {snapshot['fetched_at']}")
    print(f"source {snapshot['source']}")
    for row in price_rows(snapshot):
        cache = row["cache_read_per_million"]
        write = row["cache_write_per_million"]
        print(
            f"{row['label']}\t{row['id']}\t"
            f"input {row['input_per_million']}\t"
            f"output {row['output_per_million']}\t"
            f"cache_read {cache if cache is not None else 'none'}\t"
            f"cache_write {write if write is not None else 'none'}"
        )
    qwen = next(row for row in snapshot["models"] if row["id"] == IDS["qwen"])
    overrides = (qwen.get("pricing") or {}).get("overrides") or []
    for override in overrides:
        print(
            "qwen_override\t"
            f"min_prompt_tokens {override['min_prompt_tokens']}\t"
            f"input {per_million(override['prompt'])}\t"
            f"output {per_million(override['completion'])}\t"
            f"cache_read {per_million(override['input_cache_read'])}\t"
            f"cache_write {per_million(override['input_cache_write'])}"
        )
    for model_id, endpoints in snapshot["endpoints"].items():
        for endpoint in endpoints:
            pricing = endpoint["pricing"]
            print(
                f"endpoint\t{model_id}\t{endpoint['provider']}\t{endpoint['tag']}\t"
                f"tools {str(endpoint['tools']).lower()}\t"
                f"input {per_million(pricing['prompt'])}\t"
                f"output {per_million(pricing['completion'])}"
            )
    return 0


def score_refused() -> int:
    present = sorted(path.name for path in RAW.glob("*")) if RAW.exists() else []
    sys.stderr.write(
        "writer bake-off scoring refused.\n"
        "No model was called. Missing raw arms are not zeros and not a tie.\n"
        "Expected raw/<task>-<model>.txt for each task in tasks.json and each of "
        + ", ".join(MODELS)
        + ".\n"
    )
    if present:
        sys.stderr.write(f"Found: {', '.join(present)}\n")
    else:
        sys.stderr.write("raw/ is empty.\n")
    return 2


def run_refused() -> int:
    sys.stderr.write(
        "writer bake-off regeneration refused.\n"
        "The intended call is OpenRouter chat completions for "
        "reflection/beam-1.0-501b-a23b, inception/mercury-3, and qwen/qwen3.7-plus.\n"
        "This script does not send that call.\n"
    )
    if not os.environ.get("OPENROUTER_API_KEY"):
        sys.stderr.write("Missing:\n- OPENROUTER_API_KEY is unset\n")
        sys.stderr.write(
            "Cursor subagents are not a substitute: the catalog for this run had no slug for those three ids.\n"
        )
        return 2
    sys.stderr.write("OPENROUTER_API_KEY is set. This script still does not dispatch.\n")
    return 2


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", action="store_true", help="refuse a live regeneration without a key")
    parser.add_argument("--score", action="store_true", help="score committed raw arms, or refuse")
    parser.add_argument("--prices", action="store_true", help="print the committed OpenRouter snapshot")
    args = parser.parse_args(argv)
    if args.prices:
        return print_prices()
    if args.run:
        return run_refused()
    return score_refused()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
