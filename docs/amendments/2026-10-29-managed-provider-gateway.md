# Managed provider gateway amendment

Date: 2026-10-29
Authority: the owner's instructions of 2026-10-29 to route managed worker model traffic through a
third-party gateway, selecting `ds/claude-opus-5-5` for Claude Code and `gpt-6.1-sol` for Codex.
Source: `docs/plans/2026-10-13-001-feat-multi-agent-team-plan.md`, "Worker Isolation and Source
Transfer", "State, Persistence, and Approval Invariants", U4; `AGENTS.md`.

## Why this needs an amendment

The plan forbids what the owner now wants. "Worker Isolation and Source Transfer" says: *give each
worker identity its own provider sign-in, never place owner, publication or unrelated credentials
in a worker home.* T010's composition rules add: *keep credentials out of argv, logs, immutable
instruction/configuration projections and persisted acceptance artifacts.*

The owner's direction reverses the first rule deliberately. A gateway credential is a business
credential and it does reach a worker process. That is a scope change no card may authorize, so it
is recorded here rather than absorbed into T038.

## Decisions

1. **A provider gateway is a provider, not a sign-in.** A managed launch may satisfy its provider
   prerequisite in either of two ways: the worker home holds its own provider sign-in, or the
   installed gateway configuration names that client and verifies against it. Neither mode is
   inferred from the other. A launch satisfying neither still refuses with
   `managed_provider_signin_required`.

2. **One installed credential file, owned by root, readable only by the daemon group.**
   `/etc/multi-agent/provider-gateway.json`, mode `0640`, `root:ma-control`. It holds the endpoint,
   the pinned model and the bearer token per client. It is machine-local, never committed, never
   printed, and never part of a repository artifact.

3. **No `policy_revision` bump.** The gateway file is a runtime dependency, in the same class as
   `client-lock.json`, which `docs/operations.md` already holds separate from `worker-policy.json`
   for exactly this reason. Changing the endpoint or a key does not change the isolation boundary,
   so it must not force a re-provision and a fresh host preflight. The launch evidence records the
   gateway file's digest instead, so a receipt still names the configuration it ran under.

4. **The credential never enters argv or a projection.** `/proc/<pid>/cmdline` is readable by the
   worker, and projections are hashed into persisted evidence. The launcher — which runs privileged,
   as `root` for the duration of the one permitted sudo rule — reads the gateway file and places the
   token in the client's environment only. The worker's own client config, settings and projection
   carry the endpoint and model at most, never the token.

5. **The sandbox reaches the gateway through its own egress relay.** Measured on 2026-10-29: from
   inside a real managed sandbox, `GET /v1/models` returns 200 with the bearer and 401 without, via
   `127.0.0.1:3128`. `axonhub.neuraforge.me:443` was already in the egress allow-list, so this
   amendment changes no allow-list entry. Direct host egress without the proxy returns 403; only
   the filtered path works, which is the intended one.

6. **Models are pinned in that file, not in the policy.** Claude Code runs `ds/claude-opus-5-5` and
   Codex runs `gpt-6.1-sol`, both confirmed served by the gateway on 2026-10-29. A model change is a
   gateway-file change, not a policy change, and it is recorded in the launch receipt.

## Consequences the owner accepted

- A compromised worker can read the gateway token, because its client must present it. The
  mitigating rule that remains in force is that the token is a model-gateway credential only: it
  grants no repository write, no publication and no control-plane authority, and it is revocable at
  the gateway without touching the host.
- Provider sign-in is no longer the only admission path, so `docs/operations.md` "per-worker
  sign-in evidence" describes one mode among two. The KTD26 worker-sign-in light reports the mode
  the launch actually used.
- Every claim that worker traffic reaches only allow-listed endpoints is unchanged: the gateway
  host is allow-listed, and the reachable set measured from inside the sandbox is still bounded by
  the same filter.

## Unchanged

The product contract, requirements, acceptance examples, the KTD19 channel record, `policy_revision`
5, the isolation policy bytes, the client lock, the live allowance (four native invocations,
150,000 reported tokens, 1,200 seconds, never reset) and the delivery and review grants.