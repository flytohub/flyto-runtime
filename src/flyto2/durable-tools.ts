import * as z from "zod/v4";
import type { McpRegistrationTarget } from "../mcp-modern-server.js";
import {
  DurableOperationStore,
  runDurableOperation,
} from "./durable-operations.js";

const ALWAYS_DURABLE_TOOLS = new Set(["open_workspace"]);

export interface DurableToolCompletion {
  tool: string;
  input: Record<string, unknown>;
  result: unknown;
}

export interface DurableToolHandlerOptions {
  onCompleted?: (completion: DurableToolCompletion) => void | Promise<void>;
}

export function withDurableToolHandlers(
  server: McpRegistrationTarget,
  store: DurableOperationStore,
  options: DurableToolHandlerOptions = {},
): McpRegistrationTarget {
  return {
    registerTool: ((...args: unknown[]) => {
      const [name, rawDefinition] = args as [string, Record<string, unknown>, ...unknown[]];
      const handler = args.at(-1) as (input: unknown, extra: unknown) => unknown;
      const definition = rawDefinition ?? {};

      if (!shouldJournalTool(name, definition)) {
        return (server.registerTool as (...callArgs: unknown[]) => unknown)(...args);
      }

      const inputSchema = {
        ...asRecord(definition.inputSchema),
        operation_id: z
          .string()
          .min(8)
          .max(128)
          .regex(/^[A-Za-z0-9._:-]+$/)
          .optional()
          .describe(
            "Stable idempotency key for this side-effecting operation. Reuse the same operation_id only when retrying the exact same call after a lost or uncertain response.",
          ),
      };

      const wrappedDefinition = { ...definition, inputSchema };
      return (server.registerTool as (...callArgs: unknown[]) => unknown)(
        name,
        wrappedDefinition,
        async (input: unknown, extra: unknown) => {
          const { operation_id, ...toolInput } = asRecord(input);
          const operationId = typeof operation_id === "string" ? operation_id : undefined;
          const result = await runDurableOperation(
            store,
            {
              tool: name,
              operationId,
              payload: toolInput,
            },
            () => Promise.resolve(handler(toolInput, extra)),
          );
          if (!result.replayed) {
            await options.onCompleted?.({
              tool: name,
              input: toolInput,
              result: result.value,
            });
          }
          return result.value;
        },
      );
    }) as McpRegistrationTarget["registerTool"],
    registerResource: server.registerResource.bind(server),
  };
}

function shouldJournalTool(name: string, definition: Record<string, unknown>): boolean {
  if (ALWAYS_DURABLE_TOOLS.has(name)) return true;
  const annotations = asRecord(definition.annotations);
  return annotations.readOnlyHint === false;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
