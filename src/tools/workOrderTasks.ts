import { z } from "zod";
import { ApiClient } from "../http/apiClient";
import { errorResult, jsonResult } from "../util/mcpResult";

const taskInput = z.object({
  label: z.string().trim().min(1).max(1000),
  taskType: z.literal("SUBTASK").default("SUBTASK"),
  options: z.array(z.string()).length(0).default([]),
  notes: z.string().max(20000).optional(),
});
export const addWorkOrderTasksShape = {
  workOrderId: z.number().int().positive(),
  tasks: z.array(taskInput).min(1).max(100).refine(
    (items) => new Set(items.map((item) => item.label)).size === items.length,
    "Task labels must be unique",
  ),
};
export const getWorkOrderTasksShape = { workOrderId: z.number().int().positive() };

type Ref = { id: number } | null;
type TaskBase = {
  label: string; taskType: string; options?: { label: string }[];
  user?: Ref; asset?: Ref; meter?: Ref;
};
type Task = { id: number; taskBase: TaskBase; notes?: string | null; value?: string | null };
type Input = z.infer<typeof taskInput>;

function isSame(task: Task, input: Input): boolean {
  const b = task.taskBase;
  return b.label === input.label && b.taskType === input.taskType &&
    !b.user && !b.asset && !b.meter && !(b.options?.length);
}

export async function getWorkOrderTasks(api: ApiClient, args: { workOrderId: number }) {
  try {
    const tasks = await api.get<Task[]>(`/tasks/work-order/${args.workOrderId}`);
    return jsonResult({ workOrderId: args.workOrderId, tasks });
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

/** Atlas PATCH replaces the full list. Preserve every existing base, including refs/options. */
export async function addWorkOrderTasks(api: ApiClient, args: { workOrderId: number; tasks: Input[] }) {
  try {
    const path = `/tasks/work-order/${args.workOrderId}`;
    const existing = await api.get<Task[]>(path);
    const missing = args.tasks.filter((input) => !existing.some((task) => isSame(task, input)));
    if (missing.length) {
      const bases = existing.map(({ taskBase: b }) => ({
        label: b.label, taskType: b.taskType,
        options: (b.options ?? []).map((o) => o.label),
        user: b.user ? { id: b.user.id } : null,
        asset: b.asset ? { id: b.asset.id } : null,
        meter: b.meter ? { id: b.meter.id } : null,
      }));
      await api.patch(path, [...bases, ...missing.map(({ label, taskType, options }) => ({ label, taskType, options }))]);
    }
    const saved = await api.get<Task[]>(path);
    for (const input of args.tasks) {
      const task = saved.find((t) => isSame(t, input));
      if (!task) throw new Error(`Task registration verification failed: ${input.label}`);
      if (input.notes) {
        const current = await api.get<Task>(`/tasks/${task.id}`);
        if (!current.notes?.includes(input.notes)) {
          // Atlas's mapper resets omitted value to null: send the current value with notes.
          const notes = [current.notes, input.notes].filter(Boolean).join("\n\n");
          await api.patch(`/tasks/${task.id}`, { notes, value: current.value ?? null });
        }
      }
    }
    const verified = await api.get<Task[]>(path);
    if (!args.tasks.every((input) => verified.some((task) =>
      isSame(task, input) && (!input.notes || task.notes?.includes(input.notes))))) {
      throw new Error("Task notes verification failed");
    }
    return jsonResult({ workOrderId: args.workOrderId, verified: true, tasks: verified });
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}
