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


test("cached ChatGPT write and edit calls route to apply_patch in Codex tool mode", () => {
  const write = normalizeLegacyMcpInput({
    method: "tools/call",
    params: {
      name: "write",
      arguments: {
        workspaceId: "ws_a",
        path: "note.txt",
        content: "before\n",
      },
    },
  }, "codex") as { params: { name: string; arguments: { workspace_id: string; patch: string } } };
  assert.equal(write.params.name, "apply_patch");
  assert.equal(write.params.arguments.workspace_id, "ws_a");
  assert.equal(
    write.params.arguments.patch,
    "*** Begin Patch\n*** Add File: note.txt\n+before\n*** End Patch",
  );

  const edit = normalizeLegacyMcpInput({
    method: "tools/call",
    params: {
      name: "edit",
      arguments: {
        workspaceId: "ws_a",
        path: "note.txt",
        edits: [{ oldText: "before", newText: "after" }],
      },
    },
  }, "codex") as { params: { name: string; arguments: { workspace_id: string; patch: string } } };
  assert.equal(edit.params.name, "apply_patch");
  assert.equal(edit.params.arguments.workspace_id, "ws_a");
  assert.equal(
    edit.params.arguments.patch,
    "*** Begin Patch\n*** Update File: note.txt\n@@\n-before\n+after\n*** End Patch",
  );
});

test("cached ChatGPT write preserves an intentionally missing final newline", () => {
  const write = normalizeLegacyMcpInput({
    method: "tools/call",
    params: {
      name: "write",
      arguments: {
        workspaceId: "ws_a",
        path: "note.txt",
        content: "no-final-newline",
      },
    },
  }, "codex") as { params: { arguments: { patch: string } } };
  assert.match(write.params.arguments.patch, /\\ No newline at end of file/);
});
