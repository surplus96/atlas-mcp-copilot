// Added by surplus96 for atlas-mcp-copilot; notice added 2026-10-07.
// Changes: Cover task validation, repeat calls and preservation of operator data.
// Based on https://github.com/GabrielGB1999/Atlas-MCP; Apache-2.0.

import { addWorkOrderTasks, addWorkOrderTasksShape } from "../src/tools/workOrderTasks";
import { ApiClient } from "../src/http/apiClient";
import { z } from "zod";

it("preserves existing tasks, values and operator notes across retries", async () => {
  const human = { id: 7, taskBase: { label: "Operator inspection", taskType: "MULTIPLE", options: [{ label: "OK" }], user: { id: 3 }, asset: { id: 4 } }, notes: "Operator notes", value: "OK" };
  const input = { label: "[comp1] 01 Check power", taskType: "SUBTASK" as const, options: [], notes: "Evidence" };
  let stored: any[] = [human];
  const api = {
    get: jest.fn(async (path: string) => path === "/tasks/8" ? stored[1] : stored),
    patch: jest.fn(async (path, body) => {
      if (path === "/tasks/work-order/10") {
        expect(body[0]).toEqual({ label: human.taskBase.label, taskType: "MULTIPLE", options: ["OK"], user: { id: 3 }, asset: { id: 4 }, meter: null });
        stored = [human, { id: 8, taskBase: { ...input, options: [] }, notes: "Existing note", value: "COMPLETE" }];
      } else {
        expect(body.value).toBe("COMPLETE");
        stored[1].notes = body.notes;
        stored[1].value = body.value ?? null;
      }
      return stored;
    }),
  };
  const result = await addWorkOrderTasks(api as unknown as ApiClient, { workOrderId: 10, tasks: [input] });
  expect(result.isError).toBeUndefined();
  expect(JSON.parse(result.content[0].text).verified).toBe(true);
  expect(stored[1].notes).toBe("Existing note\n\nEvidence");
  expect(stored[1].value).toBe("COMPLETE");
  const calls = api.patch.mock.calls.length;
  await addWorkOrderTasks(api as unknown as ApiClient, { workOrderId: 10, tasks: [input] });
  expect(api.patch).toHaveBeenCalledTimes(calls);
});

it("rejects duplicate task labels and reports partial note failures", async () => {
  const input = { label: "Check", taskType: "SUBTASK" as const, options: [], notes: "Evidence" };
  expect(z.object(addWorkOrderTasksShape).safeParse({ workOrderId: 10, tasks: [input, input] }).success).toBe(false);
  const api = { get: jest.fn(async (path: string) => path === "/tasks/2" ? { id: 2, value: "OPEN", taskBase: { label: "Check", taskType: "SUBTASK", options: [] } } : [{ id: 2, value: "OPEN", taskBase: { label: "Check", taskType: "SUBTASK", options: [] } }]), patch: jest.fn(async () => { throw new Error("notes failed"); }) };
  const result = await addWorkOrderTasks(api as unknown as ApiClient, { workOrderId: 10, tasks: [input] });
  expect(result.isError).toBe(true);
});
