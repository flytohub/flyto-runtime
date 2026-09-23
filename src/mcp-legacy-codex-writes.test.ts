import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyPatch } from "./apply-patch.js";
import { legacyEditToPatch, legacyWriteToPatch, translateLegacyCodexWrite } from "./mcp-legacy-codex-writes.js";

async function applyEdit(t: test.TestContext, original: string, edits: Array<{ old_text: string; new_text: string }>) {
  const root = await mkdtemp(join(tmpdir(), "legacy-codex-edit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "file.txt"), original);
  await applyPatch(root, legacyEditToPatch({ path: "file.txt", edits }, original));
  return readFile(join(root, "file.txt"), "utf8");
}

test("partial-line edits are widened to whole lines and apply exactly", async (t) => {
  assert.equal(
    await applyEdit(t, "const a = 1;\nconst b = foo(1);\nconst c = 3;\n", [{ old_text: "foo(1)", new_text: "bar(2)" }]),
    "const a = 1;\nconst b = bar(2);\nconst c = 3;\n",
  );
});

test("several edits on one line and across lines apply in one patch", async (t) => {
  assert.equal(
    await applyEdit(t, "x = a + b\ny = 1\nz = 2\n", [
      { old_text: "b", new_text: "B" },
      { old_text: "x = a", new_text: "x = A" },
      { old_text: "z = 2", new_text: "z = 20\nw = 3" },
    ]),
    "x = A + B\ny = 1\nz = 20\nw = 3\n",
  );
});

test("deleting whole lines, including the last line, removes them", async (t) => {
  assert.equal(await applyEdit(t, "a\nb\nc\n", [{ old_text: "b\n", new_text: "" }]), "a\nc\n");
  assert.equal(await applyEdit(t, "a\nb\n", [{ old_text: "b\n", new_text: "" }]), "a\n");
});

test("CRLF files keep their line endings", async (t) => {
  assert.equal(await applyEdit(t, "one\r\ntwo\r\n", [{ old_text: "two", new_text: "2" }]), "one\r\n2\r\n");
});

test("edit keeps the Claude-surface contract for missing, ambiguous and overlapping text", () => {
  assert.throws(() => legacyEditToPatch({ path: "f", edits: [{ old_text: "zzz", new_text: "" }] }, "abc\n"), /not found/);
  assert.throws(() => legacyEditToPatch({ path: "f", edits: [{ old_text: "a", new_text: "" }] }, "a\na\n"), /more than once/);
  assert.throws(() => legacyEditToPatch({ path: "f", edits: [
    { old_text: "abc", new_text: "" },
    { old_text: "bcd", new_text: "" },
  ] }, "abcd\n"), /overlap/);
  assert.throws(() => legacyEditToPatch({ path: "f", edits: [{ old_text: "", new_text: "x" }] }, "a\n"), /must not be empty/);
});

test("write overwrites through Add File", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "legacy-codex-write-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "file.txt"), "old\n");
  await applyPatch(root, legacyWriteToPatch({ path: "file.txt", content: "new\nlines\n" }));
  assert.equal(await readFile(join(root, "file.txt"), "utf8"), "new\nlines\n");
  await applyPatch(root, legacyWriteToPatch({ path: "nested/new.txt", content: "" }));
  assert.equal(await readFile(join(root, "nested/new.txt"), "utf8"), "\n");
});

test("translation routes legacy calls to apply_patch and preserves operation_id", async () => {
  const translated = await translateLegacyCodexWrite(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "write", arguments: {
      workspace_id: "ws_a", path: "a.txt", content: "hi", operation_id: "op-1",
    } } },
    async (_id, path) => ({ relativePath: path, absolutePath: `/root/${path}` }),
    async () => "",
  ) as { params: { name: string; arguments: Record<string, unknown> } };
  assert.equal(translated.params.name, "apply_patch");
  assert.deepEqual(translated.params.arguments, {
    workspace_id: "ws_a",
    patch: "*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch",
    operation_id: "op-1",
  });
  const untouched = { method: "tools/call", params: { name: "read", arguments: {} } };
  assert.equal(await translateLegacyCodexWrite(untouched, async () => { throw new Error("unused"); }, async () => ""), untouched);
});
