# ChatGPT Coding Workflow

DevSpace brings a Codex-style coding-agent loop to ChatGPT and other MCP hosts:
inspect the repo, follow local instructions, make scoped edits, run
verification, and show the user what changed.

## Open One Workspace

ChatGPT should call `open_workspace` once for a project folder:

```json
{
  "path": "~/work/my-project"
}
```

The result includes a `workspace_id`. All later file, search, edit, show-changes,
and shell calls should reuse that same `workspace_id`.

ChatGPT may support automatic checkout recovery through optional host
conversation metadata. This is an OpenAI-host adapter detail, not a standard MCP
conversation field. When that optional context is available, opening the same
checkout project again in the same conversation can continue in the existing
workspace, and the context already provided for that reused checkout is not
repeated. The portable workflow remains the same: keep using the `workspace_id`
returned by `open_workspace` for later operations. Hosts without supported
conversation context receive a normal new workspace and continue with that
explicit `workspace_id` workflow.
The model receives actionable workspace instructions; automatic-reuse
bookkeeping is not a model-facing choice.

Worktree mode is deliberately different: every call creates a new managed
worktree and a new workspace session with complete context, even for the same
path and base ref.

The first successful open of a checkout provides complete instructions and
coding context. A repeated open that reuses the same checkout workspace does
not repeat the model-visible context, but the workspace UI continues to show the
complete details. Every new worktree establishes and returns its own complete
context, even when the same project was already opened in checkout or another
worktree. Opening checkout after a worktree therefore provides the checkout's
own context.

Do not call `open_workspace` again for the same checkout folder unless:

- the `workspace_id` is rejected as unknown
- work moves to a different project folder
- work switches between checkout and worktree mode
- the user asks for a new isolated worktree

## Checkout Mode

Checkout mode is the default. DevSpace opens the actual directory:

```json
{
  "path": "~/work/my-project"
}
```

Use this when the user wants ChatGPT to work in the current checkout.

## Worktree Mode

Use worktree mode for isolated parallel work:

```json
{
  "path": "~/work/my-project",
  "mode": "worktree"
}
```

Managed worktrees are created under:

```text
~/.devspace/worktrees
```

Worktree mode requires a Git repository with at least one commit. It starts from
`HEAD` unless `base_ref` is provided.

Each worktree-mode call creates a new managed worktree and returns a new
`workspace_id`. Reuse that ID for work inside that worktree; call
`open_workspace` in worktree mode again only when another isolated worktree is
actually required.

Uncommitted source checkout changes are not copied into the managed worktree.
DevSpace reports when the source checkout was dirty so the model can decide how
to proceed with the user.

## Project Instructions

When a workspace opens, DevSpace loads root-level instruction files:

- `AGENTS.md`
- `AGENTS.MD`
- `CLAUDE.md`
- `CLAUDE.MD`

Nested instruction files are returned as `available_agents_files`. The model
should read the relevant nested file before working under that directory.

This keeps instructions explicit and inspectable instead of silently injecting
new context during later tool calls.

## Skills

Skills are enabled by default for coding-agent workflows.

DevSpace discovers standard Agent Skills from:

- `~/.agents/skills`
- project `.agents/skills`
- `~/.devspace/skills`

It also keeps compatibility with:

- `skills.agentDir/skills`, defaulting to `~/.codex/skills`
- additional paths from `skills.paths`

When Subagents are enabled, DevSpace synchronizes its bundled workflow to the
managed path `~/.devspace/skills/subagents/SKILL.md`. That copy is refreshed
from the installed DevSpace package and wins over other skills named
`subagents`.

When Subagents are enabled, DevSpace discovers agent profiles
from `~/.devspace/agents/*.md` and project `.devspace/agents/*.md`.
Claude compatibility mode exposes their compact profile catalog through
`open_workspace`. Subagents are an explicit optional feature and are never
used automatically for ChatGPT coding work.

Both tool modes expose `background_task` as a durable ChatGPT-owned task
record. Despite the compatibility name, it does not start Codex, Claude, or any
other model. ChatGPT keeps doing the analysis, edits, verification, and commits
through the normal workspace tools; Runtime only persists the task prompt,
recovery checkpoint, workspace binding, and final result across reconnects.

Example profiles are packaged under `examples/agents/` for users who want
starter templates. Copy or adapt them into one of the active profile directories
before use.

Legacy project paths such as `.pi/skills` can be added to `skills.paths` when needed.

When `open_workspace` returns matching skills, the model should read the
advertised `SKILL.md` before following that skill.

Skill paths may be outside the workspace. DevSpace only permits reading:

- files within advertised skill directories

Set `skills.enabled` to `false` to hide skills from workspace output. Enable
Subagents and choose providers through `devspace init` or the persisted provider
configuration. `subagents.instructions` defaults to `on-demand`. In ChatGPT/Codex
mode the managed `subagents` skill always stays on-demand so the initial
`open_workspace` result remains compact; `preload` applies only to Claude mode.
The skill teaches the minimal
`devspace agents targets`, `devspace agents ls`, `devspace agents run`,
`devspace agents continue`, `devspace agents show`, and `devspace agents wait`
workflow, and should be used only after an explicit user request to delegate.
The catalog
comes from `open_workspace`; `devspace agents ls` lists existing subagent
sessions for that workspace.

## Tool Names

The Claude surface exposes these tool names:

- `open_workspace`
- `read`
- `write`
- `edit`
- `bash`
- `show_changes`

DevSpace uses the Codex-style surface by default. It exposes:

- `open_workspace`
- `read`
- `background_task` (durable ChatGPT-owned task state)
- `apply_patch`
- `exec_command`
- `write_stdin`
- `show_changes`

In this mode, `write`, `edit`, and `bash` are not registered. `exec_command`
returns a process session ID when a command is still running after its bounded
yield window. ChatGPT/Codex calls yield in under a second initially, and a
continuation waits only briefly before returning control to the host. While a
command is still running, Runtime returns a small tail preview of available
process evidence instead of an empty response, so the host can show progress
without copying the full log into conversation state. A running result still
includes a conservative `retry_after_ms`; do not poll faster than that hint or
wrap status checks in shell sleep loops. Cached legacy ChatGPT
`bash` calls use the same short-yield principle so an older host catalog cannot
hold a request open for multi-second validation work.
If that cached five-tool catalog does not expose `background_task`, Runtime also
accepts `@flyto2/task start <complete task>` through the cached `bash` tool and
translates it to the same durable host-task state. ChatGPT must continue the work
itself with the normal workspace tools. Use
`@flyto2/task continue <task_id> <checkpoint>` before an expected reconnect,
`@flyto2/task status <task_id>` after reconnecting, and
`@flyto2/task complete <task_id> <summary>` when finished. Runtime never starts
a secondary model for these commands. Set `tty: true` only for commands that
need a terminal.

To keep long conversations usable, `read` returns at most 240 lines by default
and provides the next offset when a file is longer. Command output is also
bounded to a compact head-and-tail result by default. For non-interactive
commands, Runtime retains the full durable evidence locally. These bounds never
stop the conversation or reject later tool calls.

`background_task` keeps the stored prompt, checkpoint, and final result out of
the conversation by default. Ask for `include_response=true` only when recovery
details are needed; the full values remain in Runtime's durable local state.

Set `tools.mode` to `claude` in `~/.devspace/config.jsonc` to expose `write`,
`edit`, and `bash` instead of the Codex mutation and command tools. Dedicated
MCP tools for `grep`, `glob`, and `ls` are not registered in either mode; use
the configured shell tool with command-line tools such as `rg`, `find`, and
`ls`.

## Show Changes

Flyto2 Runtime exposes `show_changes` in both tool modes as a plain MCP result.
It does not attach widget UI or a full patch to ChatGPT tool responses. This
keeps conversation state small and avoids host-side result-card rendering.

Call `show_changes` exactly once after the final file modification in any turn
that changes files. It records the combined review point and advances the
checkpoint automatically. Reusing a workspace does not change this workflow.

The model-facing result stays compact: Runtime returns the workspace ID, a
Git-backed `review_ref`, and summary text. The full patch remains available
locally through the Git-backed review history instead of being copied into the
conversation.

For local inspection, run `devspace show-changes <review-ref>`. Add `--json` to
include the parsed summary, file list, and patch.

## Shell Use

The shell tool is for commands that belong in a terminal:

- tests
- builds
- git inspection
- package scripts
- environment checks

File writes should go through the edit/write tools rather than shell
redirection, heredocs, `tee`, `sed -i`, or generated scripts.
