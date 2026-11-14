#!/usr/bin/env bash
# Focused smoke suite for CI: the team-control surface plus its two clients.
# Each package runs through its own vitest config; the full suite stays out.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

# daemon-mode.test.ts runs here now that `workers.isolation: none` is the default: its
# managed boot no longer needs the provisioned /etc/multi-agent policy.
npm run test -w packages/daemon -- \
  test/source-brand.test.ts \
  test/windows-hide-child-processes.test.ts \
  test/data-paths.test.ts \
  test/mailbox-endpoint.test.ts \
  test/db-upgrades.test.ts \
  test/scenario-daemon-mode.test.ts \
  test/team-control-auth.test.ts \
  test/team-governance.test.ts \
  test/team-read-model.test.ts \
  test/team-events-client.test.ts \
  test/worker-event-notification.test.ts \
  test/display-names.test.ts \
  test/generated-titles.test.ts \
  test/team-workspace.test.ts \
  test/team-candidate-launch.test.ts \
  test/scope-extension.test.ts \
  test/owner-session.test.ts \
  test/team-start.test.ts \
  test/team-setup.test.ts \
  test/team-settings.test.ts \
  test/native-model-choices.test.ts \
  test/team-model-policy.test.ts \
  test/team-souls.test.ts \
  test/team-dependencies.test.ts \
  test/framework-source.test.ts \
  test/framework-invocation.test.ts \
  test/lead-roster.test.ts \
  test/team-lead.test.ts \
  test/lead-chat.test.ts \
  test/team-task-thread.test.ts \
  test/team-prompt-sections.test.ts \
  test/pull-request-delivery.test.ts \
  test/github-source.test.ts \
  test/project-documents.test.ts \
  test/run-growth.test.ts \
  test/review-loop.test.ts \
  test/task-completion.test.ts \
  test/agent-turn.test.ts \
  test/agent-turn-view-telemetry.test.ts \
  test/attempt-telemetry.test.ts \
  test/team-telemetry-routes.test.ts \
  test/attempt-completion.test.ts \
  test/direct-worker-launch.test.ts \
  test/child-process-supervisor.test.ts \
  test/attempt-failure.test.ts \
  test/team-cancellation.test.ts \
  test/team-result.test.ts \
  --maxWorkers=2

npm run test -w packages/cli -- test/team-start.test.ts test/team-setup.test.ts test/team-chat.test.ts test/team-apply.test.ts test/thin-cli.test.ts test/github-command.test.ts test/github-sign-in.test.ts --maxWorkers=2

# The catalog parity check runs here so a key that interpolates without a declared parameter
# fails CI. Slice A added three such keys and nothing caught it until a later review.
npm run test -w packages/i18n -- --maxWorkers=2

npm run test -w packages/ui -- \
  test/team-events.test.tsx test/team-api-source.test.ts \
  src/team/__tests__/shell.test.tsx src/team/__tests__/shell-router.test.tsx \
  src/team/__tests__/overview.test.tsx src/team/__tests__/tasks.test.tsx src/team/__tests__/reviews.test.tsx \
  src/team/__tests__/analytics.test.tsx src/team/__tests__/settings.test.tsx \
  src/team/__tests__/github-gate.test.tsx src/team/__tests__/create-project.test.tsx \
  src/team/__tests__/project-home.test.tsx src/team/__tests__/chat-panel.test.tsx \
  src/team/__tests__/documents.test.tsx \
  src/team/__tests__/souls-workflows.test.tsx \
  src/team/__tests__/background.test.tsx src/team/__tests__/model-settings.test.tsx \
  src/team/__tests__/new-task.test.tsx src/team/__tests__/diff.test.tsx --maxWorkers=2
