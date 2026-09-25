import assert from "node:assert/strict";
import test from "node:test";
import { normalizeLegacyMcpInput } from "./mcp-legacy-input.js";

test("legacy normalization preserves canonical payloads, operation IDs and metadata", () => {
  const body = { method: "tools/call", params: { name: "write", arguments: {
    workspaceId: "ws_a", workingDirectory: "src", path: "example.txt", content: "hello", operation_id: "write-test-1",
  }, _meta: { session: "kept" } } };
  const normalized = normalizeLegacyMcpInput(body);
  assert.deepEqual(normalized, { method: "tools/call", params: { name: "write", arguments: {
    workspace_id: "ws_a", working_directory: "src", path: "example.txt", content: "hello", operation_id: "write-test-1",
  }, _meta: { session: "kept" } } });
  assert.equal(body.params.arguments.workspaceId, "ws_a");
  assert.deepEqual(normalizeLegacyMcpInput(normalized), normalized);
});

test("legacy edit entries survive cached ChatGPT camelCase schemas", () => {
  const body = { method: "tools/call", params: { name: "edit", arguments: {
    workspaceId: "ws_a",
    path: "example.txt",
    edits: [{ oldText: "before", newText: "after" }],
  } } };
  assert.deepEqual(normalizeLegacyMcpInput(body), { method: "tools/call", params: { name: "edit", arguments: {
    workspace_id: "ws_a",
    path: "example.txt",
    edits: [{ old_text: "before", new_text: "after" }],
  } } });
});

test("legacy edit translation rejects conflicting cached and canonical fields", () => {
  assert.throws(
    () => normalizeLegacyMcpInput({ method: "tools/call", params: { name: "edit", arguments: {
      workspaceId: "ws_a",
      path: "example.txt",
      edits: [{ oldText: "before", old_text: "different", newText: "after" }],
    } } }),
    /Conflicting edits\[0\]\.oldText and edits\[0\]\.old_text arguments/,
  );
});

test("legacy translation is restricted to known tool arguments", () => {
  const body = { method: "tools/call", params: { name: "runtime_run", arguments: { workspaceId: "ws_a" } } };
  assert.equal(normalizeLegacyMcpInput(body), body);
  for (const invalid of [null, [], "text", { method: "tools/list" }]) {
    assert.equal(normalizeLegacyMcpInput(invalid), invalid);
  }
  assert.deepEqual(normalizeLegacyMcpInput({ method: "tools/call", params: { name: "open_workspace", arguments: { path: "/project", baseRef: "main" } } }),
    { method: "tools/call", params: { name: "open_workspace", arguments: { path: "/project", base_ref: "main" } } });
});

test("cached ChatGPT bash calls route to exec_command in Codex tool mode", () => {
  const body = { method: "tools/call", params: { name: "bash", arguments: {
    workspaceId: "ws_a",
    workingDirectory: ".",
    command: "pwd",
    timeout: 10,
  } } };
  assert.deepEqual(normalizeLegacyMcpInput(body, "codex"), {
    method: "tools/call",
    params: {
      name: "exec_command",
      arguments: {
        workspace_id: "ws_a",
        working_directory: ".",
        cmd: "pwd",
        timeout_seconds: 10,
      },
    },
  });
  assert.equal((normalizeLegacyMcpInput(body, "claude") as typeof body).params.name, "bash");
});

test("cached ChatGPT can hand durable work to background_task through legacy bash", () => {
  const call = (command: string) => normalizeLegacyMcpInput({ method: "tools/call", params: { name: "bash", arguments: {
    workspaceId: "ws_a", command,
  } } }, "codex") as { params: { name: string; arguments: Record<string, unknown> } };

  assert.deepEqual(call("@flyto2/task start Fix this fully and test it.").params, {
    name: "background_task",
    arguments: {
      action: "start",
      workspace_id: "ws_a",
      prompt: "Fix this fully and test it.",
    },
  });
  assert.deepEqual(call("@flyto2/task status agt_12345678").params, {
    name: "background_task",
    arguments: {
      action: "status",
      workspace_id: "ws_a",
      task_id: "agt_12345678",
      include_response: true,
    },
  });
  assert.deepEqual(call("@flyto2/task wait agt_12345678").params.arguments, {
    action: "wait",
    workspace_id: "ws_a",
    task_id: "agt_12345678",
    include_response: true,
  });
  assert.deepEqual(call("@flyto2/task continue agt_12345678 Finish the remaining tests.").params.arguments, {
    action: "continue",
    workspace_id: "ws_a",
    task_id: "agt_12345678",
    prompt: "Finish the remaining tests.",
  });
  assert.equal(call("echo @flyto2/task start nope").params.name, "exec_command");
});

test("cached ChatGPT @flyto2/job commands continue a Codex process session", () => {
  const session = `proc_${"a".repeat(32)}`;
  const poll = (command: string) => normalizeLegacyMcpInput({ method: "tools/call", params: { name: "bash", arguments: {
    workspaceId: "ws_a", command,
  } } }, "codex") as { params: { name: string; arguments: Record<string, unknown> } };
  assert.deepEqual(poll(`@flyto2/job ${session}`).params, {
    name: "write_stdin", arguments: { workspace_id: "ws_a", session_id: session },
  });
  assert.deepEqual(poll(`  @flyto2/job ${session} --cancel `).params.arguments, {
    workspace_id: "ws_a", session_id: session, chars: "\u0003",
  });
  assert.equal(poll("@flyto2/job not-a-session").params.name, "exec_command");
  assert.equal(poll(`echo @flyto2/job ${session}`).params.name, "exec_command");
});
