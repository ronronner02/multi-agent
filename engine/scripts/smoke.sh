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
  test/team-workspace.test.ts \
  test/team-candidate-launch.test.ts \
  test/managed-attempt-attachment.test.ts \
  test/scope-extension.test.ts \
  test/owner-session.test.ts \
  test/unisolated-launch.test.ts \
  test/team-start.test.ts \
  test/team-result.test.ts \
  --maxWorkers=2

npm run test -w packages/cli -- test/team-start.test.ts test/team-apply.test.ts --maxWorkers=2

# The catalog parity check runs here so a key that interpolates without a declared parameter
# fails CI. Slice A added three such keys and nothing caught it until a later review.
npm run test -w packages/i18n -- --maxWorkers=2

npm run test -w packages/tui -- test/team-controls.test.ts --maxWorkers=2

npm run test -w packages/ui -- src/team/__tests__/decisions.test.tsx src/team/__tests__/new-task.test.tsx src/team/__tests__/result-panel.test.tsx src/team/__tests__/shell.test.tsx src/team/__tests__/overview.test.tsx src/team/__tests__/tasks.test.tsx src/team/__tests__/diff.test.tsx src/team/__tests__/workspace.test.tsx src/team/__tests__/reviews.test.tsx src/team/__tests__/analytics.test.tsx src/team/__tests__/settings.test.tsx --maxWorkers=2