#!/usr/bin/env bash
# Focused smoke suite for CI: the team-control surface plus its two clients.
# Each package runs through its own vitest config; the full suite stays out.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

# The tui suite drives a real tmux PTY, and tmux refuses to attach without a TERM
# that supports clear. A headless CI step has none, so pin one.
export TERM=xterm-256color

# daemon-mode.test.ts runs here now that `workers.isolation: none` is the default: its
# managed boot no longer needs the provisioned /etc/multi-agent policy.
npm run test -w packages/daemon -- \
  test/daemon-mode.test.ts \
  test/team-control-auth.test.ts \
  test/team-governance.test.ts \
  test/team-read-model.test.ts \
  test/display-names.test.ts \
  test/team-workspace.test.ts \
  test/team-candidate-launch.test.ts \
  test/managed-attempt-attachment.test.ts \
  test/scope-extension.test.ts \
  test/owner-session.test.ts \
  test/unisolated-launch.test.ts \
  test/default-native-command.test.ts \
  test/seat-pane-launch.test.ts \
  test/unisolated-start-policy.test.ts \
  test/team-start.test.ts \
  test/team-setup.test.ts \
  test/team-lead.test.ts \
  test/lead-chat.test.ts \
  test/run-growth.test.ts \
  test/review-loop.test.ts \
  test/task-completion.test.ts \
  test/agent-turn.test.ts \
  test/agent-turn-view-telemetry.test.ts \
  test/attempt-telemetry.test.ts \
  test/team-telemetry-routes.test.ts \
  test/attempt-completion.test.ts \
  test/direct-worker-launch.test.ts \
  test/attempt-failure.test.ts \
  test/team-cancellation.test.ts \
  test/team-result.test.ts \
  test/user-settings-routes.test.ts \
  --maxWorkers=2

npm run test -w packages/cli -- test/team-start.test.ts test/team-setup.test.ts test/team-chat.test.ts test/team-apply.test.ts test/team-done.test.ts --maxWorkers=2

# The catalog parity check runs here so a key that interpolates without a declared parameter
# fails CI. Slice A added three such keys and nothing caught it until a later review.
npm run test -w packages/i18n -- --maxWorkers=2

npm run test -w packages/ui -- src/team/__tests__/shell.test.tsx src/team/__tests__/teams.test.tsx src/team/__tests__/run-home.test.tsx src/team/__tests__/task-detail.test.tsx src/team/__tests__/new-task.test.tsx src/team/__tests__/diff.test.tsx --maxWorkers=2
