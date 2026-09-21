import * as z from "zod/v4";

export const FLYTO2_EXECUTION_PROTOCOL_VERSION = "flyto2.execution.v1" as const;

export const flyto2CapabilitySchema = z.object({
  id: z.string().trim().min(1).max(128),
  revision: z.number().int().positive().default(1),
  risk_level: z.enum(["low", "medium", "high", "dangerous"]).default("medium"),
  approval: z.enum(["none", "policy", "explicit"]).default("policy"),
  evidence: z.array(z.string().trim().min(1).max(128)).default([]),
}).strict();

export type Flyto2Capability = z.infer<typeof flyto2CapabilitySchema>;

export const flyto2RuntimeManifestSchema = z.object({
  schema: z.literal(FLYTO2_EXECUTION_PROTOCOL_VERSION),
  product: z.literal("Flyto2"),
  runtime: z.literal("flyto-runtime"),
  runtime_version: z.string().trim().min(1),
  runtime_id: z.string().trim().min(1),
  display_name: z.string().trim().min(1),
  platform: z.string().trim().min(1),
  roles: z.array(z.string().trim().min(1)).default(["executes_jobs"]),
  capabilities: z.array(flyto2CapabilitySchema),
}).strict();

export type Flyto2RuntimeManifest = z.infer<typeof flyto2RuntimeManifestSchema>;

export const flyto2AssignmentSchema = z.object({
  schema: z.literal(FLYTO2_EXECUTION_PROTOCOL_VERSION),
  assignment_id: z.string().trim().min(1),
  source: z.literal("flyto-cloud"),
  workspace_id: z.string().trim().min(1).optional(),
  trace_id: z.string().trim().min(1).optional(),
  kind: z.enum(["workflow", "task", "command"]),
  objective: z.string().default(""),
  payload: z.record(z.string(), z.unknown()),
  received_at: z.string(),
}).strict();

export type Flyto2Assignment = z.infer<typeof flyto2AssignmentSchema>;

export const flyto2EvidenceRefSchema = z.object({
  kind: z.string().trim().min(1).max(128),
  ref: z.string().trim().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  size: z.number().int().nonnegative().optional(),
}).strict();

export type Flyto2EvidenceRef = z.infer<typeof flyto2EvidenceRefSchema>;

export const flyto2RuntimeEventSchema = z.object({
  schema: z.literal(FLYTO2_EXECUTION_PROTOCOL_VERSION),
  event_id: z.string().trim().min(1),
  runtime_id: z.string().trim().min(1),
  assignment_id: z.string().trim().min(1).optional(),
  type: z.string().trim().min(1).max(128),
  occurred_at: z.string(),
  summary: z.string().max(1200).default(""),
  payload: z.record(z.string(), z.unknown()).default({}),
  evidence: z.array(flyto2EvidenceRefSchema).default([]),
}).strict();

export type Flyto2RuntimeEvent = z.infer<typeof flyto2RuntimeEventSchema>;

export function normalizeCloudJob(
  job: Record<string, unknown>,
  workspaceId?: string,
): Flyto2Assignment {
  const assignmentId = stringField(job, "id") ?? stringField(job, "job_id");
  if (!assignmentId) throw new Error("Cloud job is missing id.");

  const kind = inferAssignmentKind(job);
  return flyto2AssignmentSchema.parse({
    schema: FLYTO2_EXECUTION_PROTOCOL_VERSION,
    assignment_id: assignmentId,
    source: "flyto-cloud",
    workspace_id: workspaceId || undefined,
    trace_id: stringField(job, "trace_id") ?? stringField(job, "traceId"),
    kind,
    objective:
      stringField(job, "objective")
      ?? stringField(job, "template_name")
      ?? stringField(job, "templateName")
      ?? "",
    payload: job,
    received_at: new Date().toISOString(),
  });
}

function inferAssignmentKind(job: Record<string, unknown>): Flyto2Assignment["kind"] {
  if (typeof job.objective === "string" || typeof job.task === "object") return "task";
  if (typeof job.command === "string") return "command";
  return "workflow";
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field : undefined;
}
