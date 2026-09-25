/**
 * Role Subscription Budget Limits & Rollover Engine.
 *
 * Tracks per-role subscription quotas, metered run spend caps,
 * and executes rollover cascades when limits are exhausted.
 */

export interface RoleBudgetConfig {
  readonly roleId: string;
  readonly type: "subscription" | "metered" | "hybrid";
  readonly runSpendCapUsd?: number | undefined;
  readonly monthlySpendCapUsd?: number | undefined;
  readonly monthlyTokenQuota?: number | undefined;
  readonly rolloverPercent?: number | undefined; // 0 - 100
  readonly onExhausted: "cascade_to_roster" | "borrow_from_pool" | "pause_for_approval" | "fail_closed";
  readonly fallbackModel?: string | undefined;
  readonly fallbackHarness?: string | undefined;
  readonly emergencyPoolLimitUsd?: number | undefined;
}

export interface RoleBudgetState {
  readonly roleId: string;
  readonly currentRunSpendUsd: number;
  readonly currentMonthlySpendUsd: number;
  readonly usedTokens: number;
  readonly rolledOverTokens: number;
  readonly borrowedFromPoolUsd: number;
}

export interface BudgetEvaluationResult {
  readonly status: "ok" | "near_limit" | "exhausted";
  readonly nextAction: "proceed" | "cascade" | "borrow" | "pause" | "fail_closed";
  readonly fallbackModel?: string | undefined;
  readonly fallbackHarness?: string | undefined;
  readonly warning?: string | undefined;
}

/**
 * Evaluate if a role execution can proceed under its budget caps or needs rollover.
 */
export function evaluateRoleBudget(
  config: RoleBudgetConfig,
  state: RoleBudgetState,
  projectedCostUsd = 0,
): BudgetEvaluationResult {
  const projectedRunSpend = state.currentRunSpendUsd + projectedCostUsd;

  // 1. Check run spend cap
  if (config.runSpendCapUsd !== undefined && projectedRunSpend > config.runSpendCapUsd) {
    if (config.onExhausted === "cascade_to_roster" && config.fallbackModel) {
      return {
        status: "exhausted",
        nextAction: "cascade",
        fallbackModel: config.fallbackModel,
        fallbackHarness: config.fallbackHarness ?? "pi",
        warning: `Role "${config.roleId}" reached run spend cap ($${config.runSpendCapUsd.toFixed(2)}); rolling over to ${config.fallbackModel}`,
      };
    }
    if (config.onExhausted === "borrow_from_pool" && (config.emergencyPoolLimitUsd ?? 0) > state.borrowedFromPoolUsd) {
      return {
        status: "exhausted",
        nextAction: "borrow",
        warning: `Role "${config.roleId}" borrowing from project emergency buffer`,
      };
    }
    return {
      status: "exhausted",
      nextAction: config.onExhausted === "pause_for_approval" ? "pause" : "fail_closed",
      warning: `Role "${config.roleId}" exhausted run spend cap ($${config.runSpendCapUsd.toFixed(2)})`,
    };
  }

  // 2. Check monthly spend cap
  if (config.monthlySpendCapUsd !== undefined && (state.currentMonthlySpendUsd + projectedCostUsd) > config.monthlySpendCapUsd) {
    if (config.onExhausted === "cascade_to_roster" && config.fallbackModel) {
      return {
        status: "exhausted",
        nextAction: "cascade",
        fallbackModel: config.fallbackModel,
        fallbackHarness: config.fallbackHarness ?? "pi",
        warning: `Role "${config.roleId}" reached monthly budget limit ($${config.monthlySpendCapUsd.toFixed(2)})`,
      };
    }
    return {
      status: "exhausted",
      nextAction: "pause",
      warning: `Role "${config.roleId}" reached monthly budget cap ($${config.monthlySpendCapUsd.toFixed(2)})`,
    };
  }

  // 3. Near limit alert (>= 85% of budget)
  if (config.runSpendCapUsd && (projectedRunSpend / config.runSpendCapUsd) >= 0.85) {
    return {
      status: "near_limit",
      nextAction: "proceed",
      warning: `Role "${config.roleId}" is at ${Math.round((projectedRunSpend / config.runSpendCapUsd) * 100)}% of run budget`,
    };
  }

  return {
    status: "ok",
    nextAction: "proceed",
  };
}
