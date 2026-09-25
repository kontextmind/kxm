/**
 * Task Queue & Topological Reordering Engine.
 *
 * Manages upcoming tasks in the execution queue with safety guards:
 * - Detects prerequisite violations when moving a task before its dependencies
 * - Prevents circular dependency cycles
 * - Shifts tasks safely up or down
 */

export interface QueuedTaskItem {
  readonly id: string;
  readonly title: string;
  readonly stageId: string;
  readonly role: string;
  readonly harness: string;
  readonly model: string;
  readonly status: "completed" | "in_flight" | "pending" | "blocked" | "failed";
  readonly dependencies: readonly string[];
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly estimatedDurationSec?: number | undefined;
  readonly estimatedCostUsd?: number | undefined;
}

export interface ReorderResult {
  readonly success: boolean;
  readonly tasks: readonly QueuedTaskItem[];
  readonly warning?: string | undefined;
}

/**
 * Reorder a task in the upcoming queue with dependency validation.
 */
export function reorderQueuedTasks(
  tasks: readonly QueuedTaskItem[],
  fromIndex: number,
  toIndex: number,
): ReorderResult {
  if (
    fromIndex < 0 ||
    fromIndex >= tasks.length ||
    toIndex < 0 ||
    toIndex >= tasks.length ||
    fromIndex === toIndex
  ) {
    return { success: false, tasks, warning: "invalid_indices" };
  }

  const target = tasks[fromIndex]!;

  // Cannot reorder in-flight or completed tasks
  if (target.status === "in_flight" || target.status === "completed") {
    return {
      success: false,
      tasks,
      warning: `cannot move ${target.status} task "${target.id}"`,
    };
  }

  // Create mutable copy and move
  const draft = [...tasks];
  const [removed] = draft.splice(fromIndex, 1);
  draft.splice(toIndex, 0, removed!);

  // Validate dependencies:
  // For every task at index i, none of its dependencies can appear at index j > i.
  const idToIndex = new Map<string, number>();
  for (let i = 0; i < draft.length; i++) {
    idToIndex.set(draft[i]!.id, i);
  }

  for (let i = 0; i < draft.length; i++) {
    const task = draft[i]!;
    for (const depId of task.dependencies) {
      const depIndex = idToIndex.get(depId);
      if (depIndex !== undefined && depIndex > i) {
        return {
          success: false,
          tasks,
          warning: `Prerequisite violation: "${task.id}" depends on "${depId}", which is scheduled later at position ${depIndex + 1}`,
        };
      }
    }
  }

  return {
    success: true,
    tasks: draft,
  };
}
