// Modified by surplus96 for atlas-mcp-copilot; notice added 2026-10-07.
// Changes: Register work-order task creation and retrieval tools.
// Based on https://github.com/GabrielGB1999/Atlas-MCP; Apache-2.0.

import { addWorkOrderTasks, addWorkOrderTasksShape, getWorkOrderTasks, getWorkOrderTasksShape } from "./tools/workOrderTasks";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ApiClient } from "./http/apiClient";
import { Logger } from "./util/logger";

import { listWorkOrders, listWorkOrdersShape } from "./tools/listWorkOrders";
import { getWorkOrder, getWorkOrderShape } from "./tools/getWorkOrder";
import { createWorkOrder, createWorkOrderShape } from "./tools/createWorkOrder";
import { updateWorkOrder, updateWorkOrderShape } from "./tools/updateWorkOrder";
import { changeWorkOrderStatus, changeWorkOrderStatusShape } from "./tools/changeWorkOrderStatus";
import { assignWorkOrder, assignWorkOrderShape } from "./tools/assignWorkOrder";
import { generateWeeklyWorkOrderReport, weeklyReportShape } from "./tools/weeklyReport";
import { getAsset, getAssetShape } from "./tools/getAsset";
import { listAssets, listAssetsShape } from "./tools/listAssets";

const SERVER_INSTRUCTIONS = `
This server exposes Atlas CMMS the way its human users see it in the web app, not the way the
underlying database models it. Two conventions apply across every tool here:

1. "id" is the work order/asset's display code (work orders: "WO000042"; assets: "A000012"),
   matching what's printed in the frontend's own "Id" column — never a raw database number. When
   you tell a human "work order WO000042" or "asset A000012", that's the "id" field. Some tools
   also return a numeric
   "workOrderId"/"assetId" alongside it — that's an internal handle for this MCP's own follow-up
   calls (update-work-order, change-work-order-status, get-asset, ...); never surface it to a
   human as "the ID".
2. "primaryWorker" is the single main/responsible worker on a work order or asset (the frontend's
   own "Primary Worker" field). "assignedTo" is the separate list of other/additional workers. If
   a person asks "who is working on this" or "who's assigned to this", answer with primaryWorker
   first — it is not just one more name in assignedTo.
`.trim();

export function createServer(apiClient: ApiClient, logger: Logger): McpServer {
  const server = new McpServer({ name: "atlas-mcp", version: "0.1.0" }, { instructions: SERVER_INSTRUCTIONS });

  server.tool(
    "list-work-orders",
    "List work orders with optional filtering by status, priority, assignee, location, or team, plus pagination.",
    listWorkOrdersShape,
    async (args) => listWorkOrders(apiClient, args),
  );

  server.tool(
    "get-work-order",
    "Retrieve full details of a single work order by its numeric workOrderId. Returns the " +
      "human-facing display id (e.g. \"WO000042\"), the primaryWorker (main/responsible worker — " +
      "answer with this when asked who is working on it) separately from the assignedTo list of " +
      "other workers, and the work order's discrepancies.",
    getWorkOrderShape,
    async (args) => getWorkOrder(apiClient, args),
  );

  server.tool(
    "create-work-order",
    "Create a new work order.",
    createWorkOrderShape,
    async (args) => createWorkOrder(apiClient, args),
  );

  server.tool(
    "update-work-order",
    "Update fields on an existing work order. Only the fields you pass are changed.",
    updateWorkOrderShape,
    async (args) => updateWorkOrder(apiClient, args),
  );

  server.tool(
    "change-work-order-status",
    "Change a work order's status, optionally attaching completion feedback or a signature. " +
      "Note: who completed it and when are set by the API itself, not by this call.",
    changeWorkOrderStatusShape,
    async (args) => changeWorkOrderStatus(apiClient, args),
  );

  server.tool(
    "assign-work-order",
    "Assign (or unassign) users on a work order, optionally setting primaryUserId — the " +
      "main/responsible worker (the frontend's \"Primary Worker\"), distinct from the other " +
      "workers in userIds.",
    assignWorkOrderShape,
    async (args) => assignWorkOrder(apiClient, args),
  );

  server.tool(
    "generate-weekly-work-order-report",
    "Generate an executive summary of work orders due within a given week (by dueDate).",
    weeklyReportShape,
    async (args) => generateWeeklyWorkOrderReport(apiClient, logger, args),
  );

  server.tool(
    "get-asset",
    "Retrieve full details of a single asset by ID, for consultation (read-only) — " +
      "name, status, location, hierarchy, assigned users/teams, warranty, parts, etc.",
    getAssetShape,
    async (args) => getAsset(apiClient, args),
  );

  server.tool(
    "list-assets",
    "List assets with optional filtering by name, location, category, or archived state, plus pagination. " +
      "Read-only, for consultation.",
    listAssetsShape,
    async (args) => listAssets(apiClient, args),
  );

  server.tool(
    "add-work-order-tasks",
    "Add procedure tasks, preserving existing tasks and operator notes. Repeating identical labels is safe. Does not consume inventory.",
    addWorkOrderTasksShape,
    async (args) => addWorkOrderTasks(apiClient, args),
  );
  server.tool(
    "get-work-order-tasks",
    "Read procedure tasks, their notes and recorded results for a work order.",
    getWorkOrderTasksShape,
    async (args) => getWorkOrderTasks(apiClient, args),
  );
  return server;
}
