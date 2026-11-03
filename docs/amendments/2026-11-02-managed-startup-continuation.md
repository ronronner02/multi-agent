# Managed startup continuation

The owner approved completing the managed-startup repair and Ink verification on 2026-11-02. Deployment, daemon restart and another live provider-backed demo remain separate.

- Add an owner-only `POST /api/team-control/runs/:runId/tasks/:taskId/continue` operation, exposed as `rig team continue <run-id> --task <task-id>`.
- Require the current run version, active implementation approval, unchanged plan and policy, live task and original admitted occupant. Recheck after asynchronous readiness and before terminal input.
- Continue the same fresh native conversation and attempt. Do not launch a replacement or restore access to legacy identity, queue or seat routes.
- Deliver the assigned task body, scope, outputs and permissions without any owner credential. Keep legacy startup behavior unchanged.
- Continuation depends on the pending attempt retained by the current daemon process. After a restart, report unavailable rather than reconstructing or adopting an unverified native occupant.
