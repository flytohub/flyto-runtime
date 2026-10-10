# Flyto2 Chat Supervisor (macOS, opt in)

`flyto2-runtime supervisor on|off|status` controls an independently signed,
background macOS Accessibility **observer**. It is separate from the MCP server
and works without Flyto2 Cloud. The user's choice persists across login and
Runtime service restarts.

## Install and authorize

Run `flyto2-runtime supervisor on`. This creates an agent in the user's
LaunchAgents directory, builds the dedicated `Flyto2 Chat Supervisor.app`, and
opens System Settings > Privacy & Security > Accessibility. The user must
explicitly enable **Flyto2 Chat Supervisor** there. `on` does *not* grant
permission and `status` reports `permission_required` until macOS grants it.
If macOS loses that authorization after a supervisor binary upgrade, toggle
its Accessibility permission off and on again. Re-running `supervisor on`
with an unchanged binary does **not** re-sign it, preserving existing consent.
The development build currently uses an ad hoc signature when no stable
Apple code-signing identity is available; that identity is not stable across
binary changes and may require renewed consent after upgrades.

Run `flyto2-runtime supervisor status` to see observer state and capability
coverage. Run `flyto2-runtime supervisor off` to stop and disable the observer.

## Current behavior and limits

When enabled and permitted, the observer samples the **visible ChatGPT app
window** every 15 seconds. It reports window presence, title, generic error
indicators, and whether the accessible view appears unchanged. UI contents are
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

If permission is absent, the observer remains `permission_required` instead
of faking success or performing arbitrary screen clicks. The main Runtime
continues serving MCP independently. The LaunchAgent can be stopped via
`supervisor off` at any time.
