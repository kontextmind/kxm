---
schema: "kxm.doc.v1"
id: "FEAT-USAGE-QUOTA"
type: "feature"
title: "Quota-aware usage, rolling windows, and cost limit tracking"
project: "kxm"
status: "draft"
owner: "kxm"
created: "2026-09-11"
updated: "2026-09-11"
authority: "hypothesis"
confidence: "uncertain"
summary: "Proposed rolling-window quota monitoring, cache-aware cost, and stage budget guardrails."
tags: ["cost", "quota"]
related:
  - implementation-plan.md
  - plan-additional-providers-agy-kimi.md
depends_on: []
blocked_by: []
details:
  delivery_status: "proposed"
---

# Plan: Quota-Aware Usage, Rolling Windows, and Cost Limit Tracking

Task Reference: `task_quota_cost_tracking`  
Status: Draft / Proposed  
Tracking: [`plans/implementation-plan.md`](implementation-plan.md)

**Related plans:** [`implementation-plan.md`](implementation-plan.md) (execution tracker);
[`plan-additional-providers-agy-kimi.md`](plan-additional-providers-agy-kimi.md)
(Antigravity / Kimi quota surfaces).

## 1. Objective

Upgrade KXM's cost and telemetry systems from static $/1M token calculations to real-time, rolling-window rate-limit and quota-aware monitoring. Provide proactive failover before rate limits trigger HTTP 429 errors, distinguish cached vs. uncached token economics, and enforce per-stage and per-run budget guardrails.

---

## 2. Background and Architectural Gap

In KXM today:

- Cost calculation in [`plugins/kxm/src/price-calc.ts`](../plugins/kxm/src/price-calc.ts) and [`prices.ts`](../plugins/kxm/src/prices.ts) computes financial cost using static price formulas:
  $$\text{Cost} = (\text{tokensIn} \times P_{\text{in}}) + (\text{tokensOut} \times P_{\text{out}})$$
- Model selection in [`plugins/kxm/src/routing.ts`](../plugins/kxm/src/routing.ts) prioritizes models based on historical quality and recorded run costs.
- **The Gap:** In production AI engineering, agent halts rarely occur because an API balance hit zero. They happen because an agent hit a **rolling rate-limit window**:
  - Anthropic: 5-hour rolling token windows, 7-day limits, per-model caps.
  - OpenAI Codex: rolling 5-hour utilization fractions and weekly credit pools.
  - Google Antigravity: shared project quota groups with daily/hourly resets.
  - Moonshot Kimi: 5-hour Coding Plan request allowances.
- When an orchestrator is blind to rolling quota utilization, it dispatches expensive tasks into nearly-exhausted quotas, triggering hard 429 failures midway through execution.

---

## 3. Reference Architecture from Evaluated Repositories

### A. `@latentminds/pi-quotas` (`~/.pi/agent/npm/node_modules/@latentminds/pi-quotas`)

- **Direct Quota Query Engine:** Polls provider subscription/usage endpoints directly using credentials stored in `~/.pi/agent/auth.json`.
- **Supported Provider Quotas:** Anthropic, OpenAI Codex, GitHub Copilot, OpenRouter, Grok, Kimi Code, Google Antigravity, and Ollama Cloud.
- **Window Metrics:** Captures rolling 5-hour and 7-day utilization percentages, remaining requests/tokens, and exact reset epoch timestamps.
- **Warning Escalation:** Proactively flags utilization pace (`green` $\to$ `amber` $\to$ `red` $\to$ `critical`).

### B. `pi-antigravity` ([github.com/kontextmind/pi-antigravity](https://github.com/kontextmind/pi-antigravity))

- `/antigravity.usage` monitors Google Cloud Code shared quota groups, remaining quota fractions, and reset schedules.

### C. `pix-models` ([pix-mono/packages/pix-models](https://github.com/kontextmind/pix-mono/tree/main/packages/pix-models))

- Tracks context window size, per-M-token rates, cache read discounts, and coding benchmark rankings.
- Emphasizes that prompt caching yields 80–90% cost reductions on multi-turn conversations; tracking `cacheReadTokens` separately from `tokensIn` is necessary for accurate financial visibility.

---

## 4. Proposed Changes in KXM

```mermaid
flowchart TD
    Task[Workflow Task Assignment] --> QuotaCheck[Check Provider Quota Headroom]
    QuotaCheck -->|Utilization < 85%| Dispatch[Dispatch to Preferred Model]
    QuotaCheck -->|Utilization >= 85% (Amber/Red)| Failover[Predictive Failover to Next Authenticated Model]
    Dispatch --> Run[Execute Model Turn]
    Run --> UsageCapture[Capture Detailed Usage: In/Out/CacheRead/CacheWrite]
    UsageCapture --> BudgetGuard{Budget Exceeded?}
    BudgetGuard -->|No| NextTurn[Continue Workflow]
    BudgetGuard -->|Yes| Pause[Pause Stage & Escalate to Operator]
```

### 1. Unified Quota Monitor Module (`plugins/kxm/src/quotas.ts`)

Create a native quota client that interfaces with `@latentminds/pi-quotas` and native provider endpoints:

```typescript
export interface ProviderQuotaStatus {
  provider: string;
  status: "green" | "amber" | "red";
  utilizationPercent: number; // e.g. 78.5%
  windowType: "5h" | "7d" | "daily" | "monthly";
  resetsInSeconds: number;
  remainingTokensOrRequests?: number;
}

export async function getProviderQuota(provider: string): Promise<ProviderQuotaStatus | null>;
```

### 2. Quota-Aware Predictive Routing in `plugins/kxm/src/routing.ts`

Modify `selectBestModel` in `routing.ts`:

- Before assigning a candidate model, query its provider's current quota headroom.
- If `status === "red"` (utilization $\ge 85\%$) or projected turn tokens will exceed remaining allowance before reset, log a predictive warning and select the next highest-ranking authenticated model from an alternate provider.
- Never trigger a 429 when an alternative eligible provider is authenticated and available.

### 3. Cache-Aware Cost Calculation

Update `plugins/kxm/src/price-calc.ts` and `prices.ts`:

- Expand token pricing matrices to include `cacheReadPricePerM` and `cacheWritePricePerM`.
- Formula:
  $$\text{EffectiveCost} = (\text{tokensIn}_{\text{uncached}} \times P_{\text{in}}) + (\text{cacheReadTokens} \times P_{\text{cacheRead}}) + (\text{tokensOut} \times P_{\text{out}})$$

### 4. Stage & Run Budget Guardrails

Add budget constraints to workflow YAML definitions:

```yaml
stages:
  implement:
    budget:
      maxCostUsd: 1.50
      maxTokens: 350000
      actionOnExceed: "pause_and_escalate" # "pause_and_escalate" | "fail_closed"
```

During execution, `vnext-engine.ts` aggregates cumulative token and dollar spend against the stage ceiling, automatically triggering an `audit_escalation` checkpoint if breached.

---

## 5. Execution Stages and Milestones

| Stage | Action | Target Files | Verification Gate |
| :--- | :--- | :--- | :--- |
| **Stage 1** | Implement `quotas.ts` reader module | `plugins/kxm/src/quotas.ts` | Unit tests verify quota parsing for Anthropic, Codex, Antigravity, Kimi |
| **Stage 2** | Integrate quota check into `routing.ts` | [`plugins/kxm/src/routing.ts`](../plugins/kxm/src/routing.ts) | Routing test verifies automatic failover when preferred provider reports `red` |
| **Stage 3** | Update cache token accounting in `price-calc.ts` | [`plugins/kxm/src/price-calc.ts`](../plugins/kxm/src/price-calc.ts) | Tests verify accurate discount calculations with cached tokens |
| **Stage 4** | Enforce workflow budget limits in `vnext-engine.ts` | [`plugins/kxm/src/vnext-engine.ts`](../plugins/kxm/src/vnext-engine.ts) | Test confirms stage pause when simulated spend breaches threshold |

---

## 6. Acceptance Criteria

- `kxm quotas` CLI command displays real-time 5h/7d quota usage and reset times across all logged-in providers.
- When an active provider reaches 90% quota consumption, KXM dispatches new stages to the next eligible model without error.
- Cost accounting in `just observe-cost` correctly credits prompt-caching discounts.
- `npm run verify` passes completely.
