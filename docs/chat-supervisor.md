# Flyto2 Chat Supervisor (macOS, opt in)

`flyto2-runtime supervisor on|off|status` controls an independently signed,
background macOS Accessibility **observer**. It is separate from the MCP server
and works without Flyto2 Cloud. The user's choice persists across login and
Runtime service restarts.

## Install and authorize

Run `flyto2-runtime supervisor on`. This creates an agent in the user's
LaunchAgents directory, installs the dedicated `/Applications/Flyto2 Chat Supervisor.app`, registers it with LaunchServices, and
opens System Settings > Privacy & Security > Accessibility. The user must
explicitly enable **Flyto2 Chat Supervisor** there. `on` does *not* grant
permission and `status` reports `permission_required` until macOS grants it.
On startup the helper asks macOS for Accessibility consent using the native
system prompt; this does not grant permission automatically. If the newly
installed app does not appear in the Privacy > Accessibility list, click `+`
and select `/Applications/Flyto2 Chat Supervisor.app` (not a hidden Library folder).
If macOS loses that authorization after a supervisor binary upgrade, toggle
its Accessibility permission off and on again. Re-running `supervisor on`
with an unchanged binary does **not** re-sign it, preserving existing consent.
The development build currently uses an ad hoc signature when no stable
Apple code-signing identity is available; that identity is not stable across
binary changes and may require renewed consent after upgrades.

Run `flyto2-runtime supervisor status` to see observer state and capability
coverage. Run `flyto2-runtime supervisor off` to stop and disable the observer.
Status evidence older than 60 seconds (or unexpectedly future-dated) is
`unresponsive`: stale status files never advertise active Accessibility or
error detection. Inspect the LaunchAgent and observer logs before treating
an old observation as a current permission problem.

## Current behavior and limits

When enabled and permitted, the observer samples up to **eight accessible
ChatGPT app windows** every 15 seconds. It reports each window's index, title,
fault state and independent unchanged timer in `observation.windows`. The
top-level `state` and `conversationTitle` remain backward-compatible and now
identify the highest-priority visible fault rather than blindly selecting the
first window. If more than eight windows are exposed, coverage is explicitly
`visible_chatgpt_windows_partial`; unobserved windows are never assumed healthy.
UI contents are
processed locally and **not saved**; only a one-way fingerprint and minimal
status are stored in a user-private JSON file. An unchanged window for five
minutes is a *review signal*, **not** evidence of a frozen model.

An Accessibility window is *not* the same as a ChatGPT task or session. Hidden
conversations, background tabs, ChatGPT's internal context budget, and actual
model progress are not observable through this helper. **Automatic Retry,
Continue, Refresh, ChatGPT conversation creation/deletion, and handoff injection
are deliberately not enabled**: they require a validated, app-specific UI
controller and evidence-backed protection against duplicate side effects.

On apps that don't expose `AXWindows`, WindowServer can independently confirm
that an app window is onscreen. This reports `window_detected_unreadable`, not
`observing` or `error_detected`. WindowServer visibility is not permission to
read screen pixels or infer model progress.

### Recovery signals

`conversation_limit_reached` is reserved for a visible ChatGPT message such as
"你已達到本次對話的長度上限" (or an English equivalent) *together with* the
dedicated **開始新對話 / Start new chat** button. This is **not** a network or
model stall; repeated `Continue` in the capped conversation cannot resolve it.
The safe next step is an evidence-backed handoff to a new conversation with a
descriptive name such as `Flyto2 Engine — SPM Closure [CONT-02]`. Prefer asking
the original chat to summarize before reaching the limit; if it is already
blocked, reconstruct from readable conversation context and verified Runtime,
Git and task evidence. Don't delete or archive the old conversation until the
replacement is verified.

`conversation_limit_needs_review` indicates a possible quoted limit message
without the required UI button evidence; never perform a rollover based only
on quoted text. `connection_interrupted` is a separate recoverable network
signal, and `unchanged_needs_review` is reported only for an unchanged view
that still exposes a Stop control. The structured observation includes a
`stopControlVisible` indicator when accessible. The `supervisor status` command returns a
read-only `recovery` recommendation. None of these indications currently
authorizes UI clicking, automatic chat creation, or repeated tool commands.

`message_send_timeout` distinguishes ChatGPT's red **訊息傳送逾時。請再試一次。**
banner with a specific **重試** button from an ongoing stream disconnect and
from a capped conversation. An exact Retry control is required: if the words
are present but Retry is absent, the state is `message_timeout_needs_review`.
Automatic resend is deliberately disabled until last-action idempotency is
verified; otherwise a retry could repeat a side-effecting tool command.

**Development installs:** changing the Swift helper code changes its ad-hoc
signature and can revoke macOS Accessibility consent. To preserve an already
approved, functioning observer, build and test new detectors before scheduling
a controlled app upgrade. Source changes alone do not upgrade the installed
signed observer or activate its new detection patterns.

If permission is absent, the observer remains `permission_required` instead
of faking success or performing arbitrary screen clicks. The main Runtime
continues serving MCP independently. The LaunchAgent can be stopped via
`supervisor off` at any time.
