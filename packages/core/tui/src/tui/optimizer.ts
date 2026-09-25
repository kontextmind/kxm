/**
 * Plan Optimizer Engine.
 *
 * Analyzes upcoming tasks against dependency graphs, token footprints,
 * and harness/model capabilities to generate concrete proposals for:
 * 1. Concurrency (parallel fanout for independent tasks)
 * 2. Cost (downscaling lightweight tasks to faster/cheaper models)
 * 3. Reordering (failing fast on syntax/lint before heavier passes)
 */

export interface OptimizerTaskInput {
  readonly id: string;
  readonly title: string;
  readonly stageId: string;
  readonly role: string;
  readonly harness: string;
  readonly model: string;
  readonly dependencies: readonly string[];
  readonly estimatedTokens?: number | undefined;
  readonly category?: "implementation" | "test" | "docs" | "lint" | "security" | undefined;
}

export interface OptimizationProposal {
  readonly id: string;
  readonly category: "concurrency" | "cost" | "reorder" | "slice";
  readonly title: string;
  readonly description: string;
  readonly targetTaskIds: readonly string[];
  readonly projectedTimeSavingsSeconds: number;
  readonly projectedCostSavingsPercent: number;
  readonly suggestedModel?: string | undefined;
  readonly suggestedHarness?: string | undefined;
  readonly selected: boolean;
}

export interface OptimizerResult {
  readonly proposals: readonly OptimizationProposal[];
  readonly totalProjectedTimeSavingsSeconds: number;
  readonly totalProjectedCostSavingsPercent: number;
}

/**
 * Analyze a task queue and generate optimization proposals.
 */
export function evaluatePlanOptimizations(tasks: readonly OptimizerTaskInput[]): OptimizerResult {
  const proposals: OptimizationProposal[] = [];

  // 1. Detect Parallel Fanout Opportunities (tasks with no mutual dependencies in the same stage)
  const byStage = new Map<string, OptimizerTaskInput[]>();
  for (const task of tasks) {
    const list = byStage.get(task.stageId) ?? [];
    list.push(task);
    byStage.set(task.stageId, list);
  }

  for (const [stageId, stageTasks] of byStage) {
    if (stageTasks.length >= 2) {
      const independent = stageTasks.filter((t) => t.dependencies.length === 0 || t.dependencies.every((dep) => !stageTasks.some((st) => st.id === dep)));
      if (independent.length >= 2) {
        proposals.push({
          id: `opt_fanout_${stageId}`,
          category: "concurrency",
          title: `Parallelize ${independent.length} tasks in stage "${stageId}"`,
          description: `Tasks [${independent.map((t) => t.id).join(", ")}] have zero mutual dependencies and can execute concurrently via kxm_fanout.`,
          targetTaskIds: independent.map((t) => t.id),
          projectedTimeSavingsSeconds: Math.round(independent.length * 15),
          projectedCostSavingsPercent: 0,
          selected: true,
        });
      }
    }
  }

  // 2. Detect Cost/Model Downscaling Opportunities (Docs or Lint on top-tier frontier models)
  for (const task of tasks) {
    const isFrontier = /claude-3-5-sonnet|claude-3-opus|gpt-4o|gpt-5/i.test(task.model);
    if (isFrontier && (task.category === "docs" || /doc|readme|markdown/i.test(task.title))) {
      proposals.push({
        id: `opt_cost_${task.id}`,
        category: "cost",
        title: `Downscale model for documentation task "${task.title}"`,
        description: `Task "${task.id}" is documentation-focused. Routing to a high-throughput lightweight model saves significant token budget.`,
        targetTaskIds: [task.id],
        projectedTimeSavingsSeconds: 5,
        projectedCostSavingsPercent: 65,
        suggestedHarness: "pi",
        suggestedModel: "qwen/qwen3-coder-plus",
        selected: true,
      });
    } else if (isFrontier && (task.category === "lint" || /lint|format|style/i.test(task.title))) {
      proposals.push({
        id: `opt_lint_${task.id}`,
        category: "cost",
        title: `Downscale model for formatting/lint task "${task.title}"`,
        description: `Task "${task.id}" performs deterministic formatting/linting. Use a fast local/tier-1 helper.`,
        targetTaskIds: [task.id],
        projectedTimeSavingsSeconds: 8,
        projectedCostSavingsPercent: 80,
        suggestedHarness: "pi",
        suggestedModel: "google/gemini-2.5-flash",
        selected: true,
      });
    }
  }

  const totalTimeSavings = proposals.reduce((acc, p) => acc + p.projectedTimeSavingsSeconds, 0);
  const totalCostSavings = proposals.length > 0
    ? Math.round(proposals.reduce((acc, p) => acc + p.projectedCostSavingsPercent, 0) / proposals.length)
    : 0;

  return {
    proposals,
    totalProjectedTimeSavingsSeconds: totalTimeSavings,
    totalProjectedCostSavingsPercent: totalCostSavings,
  };
}

/**
 * Apply selected proposals to the task queue.
 */
export function applyPlanOptimizations<T extends OptimizerTaskInput>(
  tasks: readonly T[],
  proposals: readonly OptimizationProposal[],
): { tasks: T[]; appliedCount: number } {
  const selected = proposals.filter((p) => p.selected);
  if (selected.length === 0) return { tasks: [...tasks], appliedCount: 0 };

  const modelOverrides = new Map<string, { harness?: string; model?: string }>();
  for (const proposal of selected) {
    if (proposal.category === "cost" && proposal.suggestedModel) {
      for (const targetId of proposal.targetTaskIds) {
        modelOverrides.set(targetId, {
          ...(proposal.suggestedHarness ? { harness: proposal.suggestedHarness } : {}),
          model: proposal.suggestedModel,
        });
      }
    }
  }

  const updated = tasks.map((task) => {
    const override = modelOverrides.get(task.id);
    if (!override) return task;
    return {
      ...task,
      ...(override.harness ? { harness: override.harness } : {}),
      ...(override.model ? { model: override.model } : {}),
    };
  });

  return {
    tasks: updated,
    appliedCount: selected.length,
  };
}
