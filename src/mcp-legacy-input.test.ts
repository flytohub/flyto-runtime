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

test("legacy translation is restricted to known tool arguments", () => {
  const body = { method: "tools/call", params: { name: "runtime_run", arguments: { workspaceId: "ws_a" } } };
  assert.equal(normalizeLegacyMcpInput(body), body);
  for (const invalid of [null, [], "text", { method: "tools/list" }]) {
    assert.equal(normalizeLegacyMcpInput(invalid), invalid);
  }
  assert.deepEqual(normalizeLegacyMcpInput({ method: "tools/call", params: { name: "open_workspace", arguments: { path: "/project", baseRef: "main" } } }),
    { method: "tools/call", params: { name: "open_workspace", arguments: { path: "/project", base_ref: "main" } } });
});
