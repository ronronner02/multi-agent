#!/usr/bin/env bash
# Focused smoke suite for CI: the team-control surface plus its two clients.
# Each package runs through its own vitest config; the full suite stays out.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

# The tui suite drives a real tmux PTY, and tmux refuses to attach without a TERM
# that supports clear. A headless CI step has none, so pin one.
export TERM=xterm-256color

# daemon-mode.test.ts stays out: its managed-boot case reads the provisioned
# /etc/multi-agent/worker-policy.json, which the MVP does not install. Include it
# again once `workers.isolation: none` lands.
npm run test -w packages/daemon -- \
  test/team-control-auth.test.ts \
  test/team-governance.test.ts \
  test/team-read-model.test.ts \
  test/team-workspace.test.ts \
  test/team-candidate-launch.test.ts \
  test/managed-attempt-attachment.test.ts \
  test/scope-extension.test.ts \
  test/owner-session.test.ts \
  --maxWorkers=2

npm run test -w packages/tui -- test/team-controls.test.ts --maxWorkers=2

npm run test -w packages/ui -- src/team/__tests__/decisions.test.tsx --maxWorkers=2