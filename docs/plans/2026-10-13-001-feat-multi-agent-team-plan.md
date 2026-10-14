---
title: Multi-Agent Engineering Team - Plan
type: feat
date: 2026-10-13
deepened: 2026-10-13
topic: multi-agent-team
artifact_contract: spec-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: spec-brainstorm
execution: code
status: active
---

# Multi-Agent Engineering Team - Plan

## Goal Capsule

- **Objective:** Deliver the first local engineering-team milestone: an owner-aligned lead, scoped implementation, independent review, and observable recovery against an approved plan, monitored and controlled from both a local Web UI and the TUI in Chinese or English.
- **Approach:** Extend the owner-selected OpenRig source baseline in `engine/`, using TypeScript / Node.js and its existing daemon, queue, native session adapters, SQLite persistence, React web UI package, and TUI. Rebuild the web presentation against the owner's reference rendering. Compose the pinned engineering framework rather than rebuild it.
- **Authority:** Owner-confirmed product scope governs the plan, including the owner-confirmed product changes recorded in the Planning Contract; this Planning Contract resolves implementation decisions; derived assignments remain subordinate. Runtime records describe observed work, not product acceptance.
- **Decision focus:** Enforced worker/control isolation, plan-bound owner approvals, browser and terminal owner authentication, a single WSL development source, structured peer messages, and verified candidate/reviewer identity.
- **Verification focus:** A separately scoped demo feature, same-task candidate-engine comparison, rejected-action, instruction-provenance, peer-review, cancellation, and restart cases in WSL2 with both supported native clients, plus browser and terminal acceptance of both owner clients in both languages.
- **Largest risk and stop condition:** A worker, web page, or leaked browser credential could reach control credentials, database files, supervisor sockets, an owner shell, or a native permission prompt through an unintended path. The initial WSL isolation probe, browser-session gates, and later real-client adversarial gates must pass before managed work is enabled.
- **Readiness and execution boundary:** Implementation-ready for the local milestone; implementation has not started. Setup/client prerequisites and live-run spending decisions are checked before their affected actions. Distributed operation remains deferred.
- **Delivery ownership:** Execute units in dependency order after the owner selects implementation. That execution owns review, verification and local closeout; commit, push, PR creation, merge, release and deployment require their separate grants.

---

## Product Contract

### Summary

Build a terminal-based engineering team system with a lead that clarifies requirements with the owner, assembles relevant specialists, and coordinates autonomous delivery. All implementation and review work follows an approved plan, with persistent communication, observable execution, and human approval controls.

### Problem Frame

Running several coding CLIs does not establish shared scope, reliable handoffs, consistent interfaces, or evidence of integrated delivery. Terminal scrollback and natural-language progress reports are insufficient for recovering work or distinguishing a finished process from an accepted result.

The project needs coordinated delivery without replacing native coding tools or rebuilding an existing engineering methodology. The initial validation must establish useful teamwork before expanding to a distributed execution platform.

### Key Decisions

- **WSL2 execution first.** Windows hosts the initial Linux environment; the lead, specialists, and coordination services run inside WSL2. This admits tmux-based candidates without requiring native Windows process management. (session-settled: user-directed — chosen over native Windows execution: include Linux and tmux implementations in the initial comparison.)
- **TypeScript / Node.js is the primary stack.** This is an explicit owner constraint for the orchestration product, not a requirement to rewrite every managed project in TypeScript. Runtime versions and permitted supporting components remain planning decisions; Bun-only compatibility does not demonstrate Node.js compatibility.
- **Monitoring with essential controls.** The TUI shows activity and provides approval, rejection, and cancellation controls. Goal submission and detailed discussion remain in the lead's native CLI. (session-settled: user-directed — chosen over monitor-only and full command-center variants: retain useful intervention without replacing the native interfaces.)
- **Plan-governed autonomy.** Approval of an implementation-ready plan authorizes derived task decomposition, scoped specialist execution, and peer review within the agreed limits. Material changes and exhausted limits return to the owner. (session-settled: user-approved — chosen over approval of every routine execution step: permit autonomous delivery within a confirmed contract.)
- **Separate delivery permissions.** Commit, push, pull-request creation, merge, release, and deployment each require the applicable explicit authorization. Plan approval alone does not grant them.
- **Reuse the engineering framework.** Select appropriate capabilities from the full suite rather than impose every workflow on every task. Requirements and plans remain durable when the execution engine changes.
- **Reuse an execution engine before replacing one.** Evaluate existing implementations, then adapt or refactor only the gaps supported by evidence. The initial shortlist is research input, not an approved dependency or fork.
- **Task-specific teams, not fixed departments.** Roles are configurable capabilities. The lead chooses the smallest team that covers the task's deliverables, dependencies, and verification needs; roles are not permanently tied to a model or CLI.

### Actors

- A1. **Project owner:** Supplies objectives and constraints, confirms requirements and the implementation plan, and decides escalated product changes and separately gated operations.
- A2. **Lead:** Acts as requirements partner before approval and delivery coordinator afterward; assembles specialists, manages dependencies, handles blockers, and consolidates acceptance evidence.
- A3. **Product and design specialists:** Contribute requirements analysis, user flows, interaction design, UI specifications, and usability review when the assignment needs them.
- A4. **Architecture and implementation specialists:** Define technical boundaries and implement frontend, backend, client, data, or AI functionality within assigned scope.
- A5. **Verification specialists:** Provide independent code review, automated test development, acceptance testing, and performance checks where relevant.
- A6. **Platform and operations specialists:** Contribute build reproducibility, environment readiness, reliability, security, and authorized delivery work.

These actors describe responsibilities, not six mandatory concurrent sessions. The first milestone uses a separately configured lead, an implementation session, and an independent review session; broader rosters are exercised later.

### Requirements

**Requirements, planning, and alignment**

- R1. The lead must collaborate with the owner to establish scope, exclusions, and acceptance criteria before producing an executable assignment.
- R2. The implementation plan must establish applicable architecture, interface contracts, development standards, stack, database design, build environment, and versioning conventions before broad implementation.
- R3. Work on an existing project must inspect and inherit its established technical foundations unless the approved plan changes them.
- R4. Every implementation assignment must identify its source plan, bounded scope, dependencies, and required evidence; a derived task pack must remain subordinate to that plan.
- R5. Assignments must be checked against the current plan before dispatch and continuation, with stale or scope-changing work returned for reconciliation.

**Team execution and communication**

- R6. The lead must select roles and owners according to the task and keep its own model configuration and session separate from execution members.
- R7. Initial execution must support independent Claude Code and Codex CLI sessions with observable launch, output, exit, permission, and recovery behavior.
- R8. Specialists must exchange direct messages, questions, handoffs, and blockers without requiring the owner to relay them.
- R9. Important messages and decisions must persist with project, task, sender, recipient, time, and related artifact references, including lead broadcasts.
- R10. Dependent work must wait for its prerequisites, and overlapping changes must have explicit ownership or coordinated integration.
- R11. Retries and review-rework cycles must respect agreed limits and surface a blocker when progress requires an owner decision or exceeds those limits.

**Controls and observability**

- R12. The TUI must display team and task state, dependencies, messages, execution logs, review outcomes, errors, and pending decisions from execution events and durable records.
- R13. Actions requiring approval must wait for a recorded decision, and rejection must prevent that action from proceeding.
- R14. Cancellation must stop further dispatch for the affected work and report the observed termination outcome rather than infer success from a UI action.
- R15. Important task state, communication, and evidence must survive a restart; recovery must distinguish an active process, a resumable session, and work requiring a new attempt.
- R16. Available Git change references and test output must be associated with the relevant work; cost and token figures must be labeled unavailable when their underlying data is unreliable.

**Verification and governance**

- R17. Required peer review must be performed in a separate reviewer session against the assigned scope and actual changes, with findings returned to the responsible implementer.
- R18. Final delivery must demonstrate applicable integrated acceptance criteria rather than rely solely on specialist completion messages or process exit codes.
- R19. Workflow invocation must preserve its declared scope, readiness, mutation, and approval boundaries across the supported CLIs.
- R20. The primary stack and reuse constraints in Key Decisions must govern candidate evaluation, including license clarity, runtime compatibility, and maintenance cost.
- R21. Role and task context must exclude unrelated project data and raw credentials, and project changes must remain within the authorized repository and file scope.
- R22. The approved limits must govern autonomous execution, with material scope or architecture changes escalated instead of silently changing the source plan.

### Key Flows

- F1. **Agree on the work and technical foundation.**
  - **Actors:** A1, A2, and relevant A3-A6 specialists.
  - **Steps:** Clarify requirements; establish acceptance; inspect the target project; resolve applicable interfaces, architecture, conventions, environment, and verification strategy; present the implementation plan for owner approval.
  - **Outcome:** A confirmed execution contract or named unresolved questions, not premature implementation.
  - **Covers:** R1-R3, R19, R22.

- F2. **Assemble and execute the team.**
  - **Actors:** A2 and selected A3-A6 specialists.
  - **Steps:** Derive bounded work when useful; assign owners; confirm scope and readiness; launch independent sessions; deliver messages; enforce dependencies and change ownership.
  - **Outcome:** Scoped changes and attributable evidence, with blockers visible to the lead.
  - **Covers:** R4-R12, R16, R21.

- F3. **Review, revise, and accept.**
  - **Actors:** A2, A4, A5, and A1 for escalations.
  - **Steps:** Review actual changes independently; return findings; perform bounded rework; verify integration; consolidate delivered scope, evidence, limitations, and unresolved items.
  - **Outcome:** An evidence-backed delivery report without implying permission to publish or deploy.
  - **Covers:** R11, R16-R19, R22.

- F4. **Intervene or recover.**
  - **Actors:** A1, A2, and affected specialists.
  - **Steps:** Show the pending decision or interruption; apply the authorized response; preserve state; reconcile process and plan state before continuation.
  - **Outcome:** A traceable continuation, cancellation, rejection, or blocker; no silent duplicate execution.
  - **Covers:** R5, R11-R15, R21-R22.

```mermaid
flowchart TB
    owner[Owner and lead clarify requirements] --> foundation[Technical foundation and implementation plan]
    foundation --> approval{Owner approves plan}
    approval -->|Revise| owner
    approval -->|Approve| tasks[Derived assignments and selected specialists]
    tasks --> execution[Native CLI execution and direct collaboration]
    execution --> review[Independent review and integrated verification]
    review -->|Bounded rework| execution
    review -->|Acceptance evidence| delivery[Lead presents delivery and limitations]
    execution -->|Material change or exhausted limit| escalation[Owner decision]
    escalation --> foundation
    records[Persistent events, messages, and evidence] --- execution
    records --- review
    records --> tui[TUI monitoring, approvals, rejection, cancellation]
```

The TUI should distinguish team/task overview, task-linked communication, execution details, and pending decisions. Exact pane layout and navigation remain design decisions; these regions do not turn the TUI into a full task-authoring interface.

### Engineering Framework Integration

The inspected suite contains 38 entrypoints. Integration must preserve their different purposes and invocation gates, not flatten them into 38 interchangeable commands. Availability in a host's generated configuration is not proof of working invocation or equivalent enforcement.

| Capability | Relevant existing components | Intended consumer |
|---|---|---|
| Direction and technology assessment | `spec-strategy`, `spec-ideate`, `spec-pov` | Lead and owner when product direction or adoption needs a decision |
| Requirements | `spec-brainstorm`, `spec-prd` | Lead with owner confirmation; route new-product exploration separately from existing-system requirements |
| Architecture and conventions | `spec-project-rules`, `spec-rule-miner` | Lead, architects, and implementers using current project evidence |
| Planning and decomposition | `spec-plan`, `spec-write-tasks`, `spec-doc-review` | Lead and planning specialists; task packs remain derived and optional |
| Implementation and diagnosis | `spec-work`, `spec-debug`, `spec-simplify-code` | Bounded implementers and diagnosis specialists |
| Design and consistency | `spec-prototype`, `spec-polish`, `spec-app-consistency-audit` | Relevant design and product specialists |
| Verification | `spec-code-review`, `spec-dogfood`, `spec-test-browser`, `spec-test-xcode` | Review and QA specialists with appropriate runtime capabilities |
| Measured improvement | `spec-optimize`, `autoresearch` | Specialists working against a checkable metric or success condition |
| Knowledge and continuity | `spec-compound`, `spec-compound-refresh`, `spec-handoff`, `spec-explain` | Requested knowledge capture, refresh, continuity, or explanation |
| Feedback and product operations | `spec-sweep`, `spec-riffrec-feedback-analysis`, `spec-product-pulse`, `spec-promote` | Applicable feedback and product tasks, not every delivery |
| Delivery and isolation | `spec-lfg`, `spec-resolve-pr-feedback`, `spec-commit`, `spec-commit-push-pr`, `spec-worktree` | Authorized callers preserving each helper's scope and side effects |
| Routing and extension | `using-spec-first`, `spec-runtime-setup`, `spec-write-skill` | Workflow selection, runtime readiness, and project-owned skill maintenance |

The implementation plan owns execution scope. A derived task pack owns the decomposition of that scope. Runtime records own observed execution state. The TUI displays those records; none of these surfaces should independently redefine product acceptance.

The framework's worker-dispatch contract is a host-neutral semantic interface, not a ready-made cross-CLI process scheduler. Adapters must demonstrate capability and preserve caller scope. Report-only review stays report-only; user-invoked and separately authorized workflows retain those gates.

### Scope Boundaries

**First validation milestone**

- One owner, one selected repository, and one bounded real software task in WSL2.
- A separately configured lead with Claude Code and Codex CLI exercising implementation and independent review.
- The approved-plan, assignment, direct-message, review, rework, integrated-verification, and recovery cycle.
- TUI monitoring and essential controls from the confirmed interface decision.
- Evidence of plan freshness, approval rejection, cancellation, and restart behavior, not only a happy-path demonstration.
- Candidate and framework versions recorded so observed results can be reproduced.

**Deferred for later**

- Mac and Linux VPS execution nodes, cross-machine identity, transport, reconnect, and remote process termination.
- Full Pi and DSH integration; identify the intended DSH project before making compatibility commitments.
- Concurrent multi-project operation and broad organizational role presets beyond the initial team.
- Execution coverage for every optional workflow, including Mac-only simulator testing and external feedback integrations.
- Full TUI goal authoring, session administration, and direct specialist command-center controls.

**Outside this product's identity**

- A replacement coding model, a mandatory common agent SDK, or a duplicate requirements-management system.
- A requirement to staff every specialty for every task.
- A requirement to rewrite managed projects in the orchestration product's primary language.
- Default approval of every tool request, unbounded repair loops, or automatic publishing and deployment.

### Acceptance Examples

- AE1. **Requirements before execution.**
  - **Given/When:** A task still has unresolved behavior or acceptance decisions and the owner asks for progress.
  - **Then:** The lead clarifies the missing decisions rather than dispatching speculative implementation.
  - **Covers:** R1, R19, R22.
- AE2. **Approved foundation.**
  - **Given/When:** An existing business application needs a feature spanning frontend and backend.
  - **Then:** The plan references current conventions and defines the relevant shared interface before dependent implementation starts.
  - **Covers:** R2-R3, R10.
- AE3. **Task-specific staffing.**
  - **Given/When:** A backend-only assignment has no user-interface work.
  - **Then:** The lead selects implementation and verification capabilities without requiring an unrelated design or frontend session.
  - **Covers:** R6-R7.
- AE4. **Plan drift.**
  - **Given/When:** The source plan changes after a derived assignment was prepared.
  - **Then:** Affected work stops at the continuation check and returns for reconciliation rather than running from a cached approval or stale task pack.
  - **Covers:** R4-R5, R22.
- AE5. **Direct handoff with a dependency.**
  - **Given/When:** One specialist needs another's interface clarification or prerequisite output.
  - **Then:** The task-linked question and answer persist, the lead can inspect them, and dependent work waits without making the owner relay messages.
  - **Covers:** R8-R12.
- AE6. **Rejected approval.**
  - **Given/When:** An operation outside the run's existing permission scope requests approval and the owner rejects it.
  - **Then:** The operation does not execute, the rejection is recorded, and the task remains blocked or continues only through already permitted work.
  - **Covers:** R13, R19, R21-R22.
- AE7. **Cancellation.**
  - **Given/When:** The owner requests cancellation while an implementation session is active.
  - **Then:** No new dependent work is dispatched, termination is requested, and the TUI distinguishes confirmed termination from an unresolved process state.
  - **Covers:** R10, R12, R14.
- AE8. **Restart recovery.**
  - **Given/When:** The terminal or coordination service restarts during a task.
  - **Then:** History and evidence remain available, the system reconciles the existing process and session, and continuation does not silently repeat completed side effects.
  - **Covers:** R5, R9, R15.
- AE9. **Independent review and bounded rework.**
  - **Given/When:** A reviewer finds a defect in the implementation or repeated repair attempts make no progress.
  - **Then:** Findings return to the implementer, the review stays attributable, and exhaustion of the agreed limit produces a visible blocker instead of endless retries.
  - **Covers:** R11, R17, R22.
- AE10. **Integrated acceptance.**
  - **Given/When:** Individual agent tasks report success but an integrated acceptance check fails.
  - **Then:** The lead reports delivery as incomplete and preserves the failing evidence instead of treating process success as acceptance.
  - **Covers:** R12, R16, R18.
- AE11. **Separate publishing authority.**
  - **Given/When:** Implementation and review finish without permission to push, merge, or deploy.
  - **Then:** The lead presents local results and the pending delivery decision without performing those operations.
  - **Covers:** R19, R22.
- AE12. **Evidence gaps and incompatible candidates.**
  - **Given/When:** A candidate advertises TypeScript or CLI support but only demonstrates Bun execution, or a CLI supplies no reliable usage metrics.
  - **Then:** Node.js and native-session compatibility remain unverified, and unavailable metrics remain unknown rather than inferred.
  - **Covers:** R7, R16, R20.
- AE13. **Scoped context and repository ownership.**
  - **Given/When:** Specialists receive different assignments while unrelated local work or credentials exist.
  - **Then:** Each assignment identifies its permitted repository and changes, shared messages exclude secrets, and unrelated work remains untouched.
  - **Covers:** R4, R10, R21.

### Success Criteria

- The first milestone demonstrates F1-F4 and the applicable acceptance examples on one recorded task, with evidence tied to the observed software revisions.
- The owner is not required to relay routine specialist communication; interventions remain attributable to requirements, approvals, material changes, or blockers.
- The delivery report distinguishes implemented, reviewed, integration-verified, and accepted outcomes.
- The candidate comparison records adaptation work, human interventions, failures, recovery behavior, and available time/cost measurements under the same bounded task.
- No numerical performance improvement or productivity claim is made without a measured baseline. Runtime and cost limits are set in the implementation plan before autonomous trials.

### Dependencies / Assumptions

- WSL2 has been selected, not installed or verified by this requirements artifact. Distribution, filesystem placement, terminal behavior, and installed CLI versions require environment inspection.
- Claude Code and Codex require usable WSL-local installations, authentication, and model access. Existing Windows configuration is not assumed to transfer automatically.
- The primary-stack constraint favors TypeScript / Node.js for maintained product logic. Reusing a non-Node process through a narrow boundary is a possibility to evaluate, not an approved exception or an instruction to rewrite upstream software.
- The lead's model/provider and each specialist's runtime are configurable; exact selections and credentials are absent from this document.
- Repository and license evidence is revision-bound. A README, release asset, or generated workflow file does not prove runtime behavior or enforcement parity.
- Source snapshots below were inspected during this conversation. No candidate install, build, execution, WSL verification, or independent runtime review has been performed.

### Outstanding Questions

**Resolve Before Planning**

None. The owner confirmed the product scope and then specified the primary stack. The following questions belong to feasibility and implementation planning, not to a new product-scope approval cycle.

**Deferred to Planning**

- Re-screen existing implementations for the combined WSL2 and TypeScript / Node.js constraints. Determine the smallest maintainable integration or fork and obtain approval for any material non-Node engine dependency.
- Define the first bounded software task, required evidence, concurrency, timeout, retry/review limits, and resource or cost budgets before execution.
- Verify WSL2 distribution and CLI readiness; decide canonical repository placement without moving or replacing the current workspace implicitly.
- Select the Node.js version, package manager, TUI library, persistence mechanism, process/session adapter boundaries, and event model from current evidence.
- Define approval granularity, pending-approval recovery, cancellation escalation, and treatment of uncertain side effects after a crash.
- Define per-task change ownership, isolation, branch/worktree integration, and the separate Git delivery permissions for the first trial.
- Select and pin the framework revision and confirm actual discovery, invocation, output, and approval behavior in the selected CLI versions.
- Identify the intended Pi and DSH variants before extending their compatibility assessment beyond the initial milestone.

The next planning decision is the reuse boundary under the primary-stack constraint. Existing research established several non-Node engines and a Bun-based TypeScript candidate; it did not establish a Node.js-compatible winner. The outcome updates Dependencies / Assumptions and the future technical plan without changing the approved product behavior.

### Sources / Research

**Owner inputs and precedence**

- The original requirements were supplied in `multiagent.md`, dated 2026-10-13. The English source is preserved at [docs/references/multiagent-source.en.md](../references/multiagent-source.en.md).
- The owner supplied an organizational diagram and clarified task-specific teams, the lead's delivery responsibility, and technical foundations before development.
- Later confirmations establish WSL2, essential TUI controls, plan-governed autonomy, reuse-first development, full-suite integration, and the TypeScript / Node.js primary stack. These decisions supersede conflicting provisional selections in the source translation.
- The preserved translation is historical input, not a second active requirements contract. Its SHA-256 is `A2BFA630CDF938D3D7DDB5CC72704F8CC60DB43956A45A400658DE868554851C`.

**Framework snapshot**

The inspected upstream revision is `74655dc86b1270bb52239e0f8bc9517de7a7071c` of `leo-kuang-ai/spec-first`.

- [Runtime capability catalog](https://github.com/leo-kuang-ai/spec-first/blob/74655dc86b1270bb52239e0f8bc9517de7a7071c/docs/catalog/runtime-capabilities.md): 38 bundled entrypoints, host delivery surfaces, and explicit readiness limitations.
- [Task decomposition contract](https://github.com/leo-kuang-ai/spec-first/blob/74655dc86b1270bb52239e0f8bc9517de7a7071c/skills/spec-write-tasks/SKILL.md): derived task packs, plan identity and freshness, scope ownership, and separation from progress or approval state.
- [Execution contract](https://github.com/leo-kuang-ai/spec-first/blob/74655dc86b1270bb52239e0f8bc9517de7a7071c/skills/spec-work/SKILL.md): readiness, scoped implementation, drift checks, review, and authorization-aware closeout.
- [Review contract](https://github.com/leo-kuang-ai/spec-first/blob/74655dc86b1270bb52239e0f8bc9517de7a7071c/skills/spec-code-review/SKILL.md): bounded task/branch review and report-only structured agent output.
- [Worker-dispatch contract](https://github.com/leo-kuang-ai/spec-first/blob/74655dc86b1270bb52239e0f8bc9517de7a7071c/docs/contracts/workflows/worker-dispatch-capability.md): host-neutral request and outcome semantics, not a concrete process scheduler.

**Candidate evidence, not adoption decisions**

| Candidate and inspected revision | Evidence and possible reuse | Primary unresolved fit |
|---|---|---|
| [CLI Agent Orchestrator](https://github.com/awslabs/cli-agent-orchestrator/tree/295b899628b4d7e97209fcfdbeeeca39ad1f44d3) | Apache-2.0; native CLI supervisor/worker coordination and tmux; `pyproject.toml` and `tui/Cargo.toml` identify Python and Rust | WSL2-compatible direction, but a non-Node execution-engine dependency needs evaluation |
| [multiagents](https://github.com/zetbrush/multiagents/tree/03fcf6e875804a21650ed4e45eb9b6624460f7fb) | TypeScript, broker, and TUI; `package.json` requires Bun and declares MIT | Node.js compatibility unverified; no license file in the inspected tree; `orchestrator/codex-driver.ts` automatically accepts approval requests |
| [Squad](https://github.com/mco-org/squad/tree/8146bcc1c38c439aedaf3ff44548c830654c8621) | MIT; Rust/SQLite messaging, roles, tasks, and JSON output | Coordination component rather than a complete TUI/session supervisor; non-Node integration and runtime behavior unverified |
| [Runner](https://github.com/yicheng47/runner/tree/ea5dc0e6212338c9daf399b5d2296338c4a7c758) | MIT; Rust daemon separates native sessions and persistence from its desktop client | Linux/WSL2 support is not established by the inspected Windows/macOS documentation; no Node.js engine or terminal-dashboard fit demonstrated |
| [AgentsCommander](https://github.com/mblua/AgentsCommander/tree/d823839320cc397a5b52f1cf4e52ba2c37885084) | MIT; native terminals, teams, and file-based coordination | Rust/Tauri coupling in `src-tauri/src/commands/pty.rs`; a TypeScript frontend is not a Node.js orchestration engine |
| [Agent Orchestrator](https://github.com/OrchestratorInc/agent-orchestrator/tree/4a499e8d5e4678d5e3ee098bd797c608291b73d5) | Apache-2.0; broad native CLI adapters and dedicated runtime components | Go backend and application-owned workflow; evaluate integration cost and competing task authority |
| [Agent Dashboard](https://github.com/dustinblack/agent-dashboard/tree/7b2559f25981401a31f1842c3454300f948d4a9f) | Apache-2.0; multi-host sessions and an experimental Textual TUI documented in `docs/tui.md` | Python runtime and broader deployment topology; specialist-team semantics and Node.js boundary remain unverified |

Additional screening covered Agency at `b62e995aac7d4204166831b3f4c212181771ead9` (AGPL-3.0), AgentPipe at `26059b746b42db5db2e012b9aec0106d4dabc07f` (MIT; inspected noninteractive Codex adapter bypasses approvals and sandboxing), MCP Agent Mail Rust at `38c9d8a8d4e19ee42534facffeb9b2922310712c` (nonstandard restrictive license rider), and AgentMonitor at `38e2085f112b6725ebfe9f486577c51f9d624f9a` (README license claim without a license file in the inspected tree). None is an approved dependency.

**Freshness and limitations:** The 2026-10-13 research is a bounded source/documentation screen, not an exhaustive market survey or runtime acceptance result. Default-branch snapshots may differ from releases. Recheck licenses, manifests, adapters, and workflow contracts when selecting a different revision. Revalidate runtime behavior when CLI versions, host configuration, process adapters, permissions, or persistence change. The new Node.js constraint requires a refreshed fit assessment even where earlier WSL2 research was favorable.
## Planning Contract

Product Contract unchanged (byte-preserved upstream source slice)

### Authority and Planning Baseline

The owner confirmed the OpenRig implementation direction and subsequently requested the reviewed corrections: enforce worker/control isolation, use safe structured messaging, retain candidate comparison, separate the demo repository, and establish one authoritative WSL checkout. These decisions authorize this document revision, not source import, OS provisioning, live trials, or publication.

`target_repo` is `ronronner02/multi-agent` for engine development, harnesses, and project documents. U8 additionally owns the local-only `work-board` demo repository; its paths are explicitly labeled relative to that repository. No remote demo repository is created by this plan. The original Product Contract remains authoritative and byte-preserved; its historical planning questions are resolved below, but its candidate-comparison success criterion is retained. Its source slice has SHA-256 `0cea6c37dd387cc0c6ed896e54e82bae4211ef9e8342673abeebd9b110dc969c`.

The first release slice is the local validation milestone, not the complete distributed product. Document readiness permits implementation to start after the owner selects execution; it does not assert that WSL tools, provider authentication, or the resulting application are ready.

### Owner-Confirmed Product Changes

On 2026-10-13 the project owner (actor A1) directed the following product changes and chose to record them here rather than reopen the requirements workflow. The Product Contract text stays byte-preserved; where an entry below conflicts with it, the entry governs this milestone. Each entry names the original statement, the decision, its consequence, and the risk the owner accepted.

| ID | Original Product Contract statement | Owner decision | Consequence and accepted risk |
|---|---|---|---|
| PC1 | Key Decision "Monitoring with essential controls" and R12 name the TUI as the monitoring and control surface | Ship a local Web UI and the TUI. Both satisfy R12-R14, and both are owner control clients. | Adds a browser authentication surface (KTD14) and a second client to keep consistent. Accepted for usability and later phone access. |
| PC2 | No language requirement | Bundle Simplified Chinese and English, switchable at runtime in both clients. Chinese is the default. Only interface text is translated; agent messages, logs, evidence and identifiers display as written. | Every new interface string needs both catalog entries. Agent output is not translated. |
| PC3 | Interface regions are listed, but layout is a design decision | `docs/Rendering.png` is the visual and layout benchmark for the Web UI and the information benchmark for the TUI. The generated images under `docs/design/mockups/` are not benchmarks. | Reference elements that conflict with other decisions are adapted as recorded in "Web UI and TUI Experience". |
| PC4 | Goal submission and detailed discussion remain in the lead's native CLI | Unchanged: no Lead chat box in either client. The owner reaches the Lead's native session through an owner-only session view (KTD16). | The reference image's input box is removed. |
| PC5 | Scope Boundaries defer "Full TUI goal authoring, session administration, and direct specialist command-center controls"; the TUI is "not a full task-authoring interface" | Add a read-only workspace browser, a read-only knowledge view, bounded task editing (KTD17), and an interactive owner terminal (KTD16) in this milestone. Goal authoring and session administration stay deferred. | Task editing must not bypass plan authority. The owner terminal is a code-execution surface, so it is local-only and isolated from agents and the daemon. Accepted with those limits. |
| PC6 | Remote nodes are deferred; phone access is not mentioned | Plan for owner monitoring and control from a phone through a domain in a later milestone. This milestone ships a responsive layout reachable only from the local workstation. | Remote exposure, passkey login and an installable app wait for Milestone 2 and its own security design (KTD18). |

Settled-decision provenance: PC1, PC2, PC3, PC5 and the removal of the chat box are `user-directed`. The owner chose them after the alternatives (TUI-only, generated mockups, monitor-only, read-only terminal) were shown. The evidence-based task fields in "Web UI and TUI Experience" are `user-approved`.

### Key Technical Decisions

- KTD1. **Extend a pinned OpenRig source baseline.** Use revision `cb79b8c980ec120c8db28d5aaf2c4bb3cc540c61`, whose manifest declares version `0.6.10`, as a maintained source import under `engine/`. Preserve upstream license, applicable notices, source provenance, and a reviewable local patch history. This is a source adaptation, not a promise to track every upstream release. (session-settled: user-approved — chosen over selecting another base or starting a replacement engine: reuse existing native sessions, durable coordination, and TUI infrastructure.)
- KTD2. **Keep TypeScript / Node.js throughout maintained orchestration logic.** Standardize on Node.js 24, npm with the imported lockfile, ESM, existing TypeScript compiler settings, and Vitest. Record exact Node/npm versions during the first reproducible build. Retain the existing custom terminal renderer, Hono service with its WebSocket support, SQLite driver, and the React web package (React 19, Vite 6, Tailwind CSS 3, Radix primitives with the shadcn-style component pattern, TanStack Query/Router/Table, `lucide-react`, xterm.js, React Flow). Introducing Ink, another HTTP or UI framework, Tailwind 4, or PostgreSQL would add migration without closing a product gap. The only new runtime library family is i18next (KTD15). The owner permits migration of nonpreferred languages when justified; this baseline does not require such a rewrite.
- KTD3. **Compose the engineering framework; do not reproduce it.** Pin `leo-kuang-ai/spec-first` revision `74655dc86b1270bb52239e0f8bc9517de7a7071c`. Framework source owns workflow meaning, readiness, and task-pack validation. An integration module owns invocation translation, capability reporting, output validation, and failure propagation. OpenRig owns execution records and process management. Disable competing built-in planning prompts and automatic workflow entry for managed runs without deleting unrelated upstream functionality. (session-settled: user-approved — chosen over two competing planning systems: one approved plan governs all assignments.)
- KTD4. **Extend the existing queue and database owners.** Queue items remain the single task-state authority. Add plan bindings, approvals, attempts, dependency links, and evidence relations to the same database; these describe governance or execution identity, not a second task scheduler. The existing workflow runtime and queue pickup paths enforce prerequisites and eligibility. No Redis, message broker, or separate workflow service is introduced.
- KTD5. **Bind approval to exact work, not to a chat phrase.** Register an immutable plan digest, repository identity, allowed scope, policy revision, and execution limits. The owner confirms that binding through an authenticated control action. Task packs and assignments reference it. Recheck before dispatch, resume, rework, and integration; any plan-byte change suspends affected work until reconciliation. This conservative invalidation includes editorial changes and avoids silently deciding that a changed plan is equivalent.
- KTD6. **Enforce worker/control separation outside native tool policy.** The owner TUI and the local owner Web UI (PC1) are the only orchestration approval clients. Lead and specialist credentials may request decisions but never grant them. Run all managed coding processes under owner-provisioned unprivileged worker identities, distinct from the control identity, with filesystem and process isolation. Native permission controls remain an additional layer, not protection for the daemon database or owner token. Disable inherited broad-access/kernel defaults on fresh launch and resume. (session-settled: user-approved — chosen over same-user configuration-only separation: agents must not gain owner authority through filesystem, process, or tmux access.)
- KTD7. **Make the WSL checkout the sole development source after cutover.** Initially preserve the Windows workspace as-is. U1 copies an explicit source manifest to a new Linux-filesystem checkout, verifies hashes, and records the authority switch. Thereafter all engine and active-document edits, builds, and tests use that WSL checkout. Windows is an editor through WSL integration or an explicitly requested one-way export, not a second writable source. Use a control-owned tmux namespace for agents; run the owner TUI, owner browser and owner terminal host outside it. Docker and other distributions remain outside scope. (session-settled: user-approved — chosen over two development copies: one source identity must bind edits and test evidence.)
- KTD8. **Isolate changes and review the exact candidate.** Use task worktrees from an owner-established base commit where available. For an unborn repository, use a declared snapshot lane with a hashed baseline and isolated copies; do not manufacture an initial commit. A reviewer receives a read-only candidate snapshot plus base/head identifiers or a complete file manifest and patch. Integration means assembling and testing a local candidate, not automatically running Git merge, committing, or updating the original worktree.
- KTD9. **Bound each approved run without reset on retry.** Support one target repository and at most three live sessions per run, including the lead. Defaults are one diagnosed recoverable retry, two review/rework cycles, and 60 minutes of cumulative active wall-clock time per approved run, including its drills, retries, and restart continuation; concurrent sessions do not multiply this clock. Pause accounting only when all managed work is stopped and a durable pause receipt exists. An unknown recovery interval counts against the limit. Each additional probe, comparison, or trial run needs its own recorded authorization; creating a new run ID does not grant budget. Ten minutes without progress triggers the bounded-progress rule below. Monetary usage remains unknown when unsupported; record a provider-supported cap or explicit time-only spending posture before any live call.
- KTD10. **Keep upgrades and rollback local and reversible.** No automatic upstream updates, package publication, PR creation, remote writes, or deployment. Version the adapted application independently at `0.1.0` while recording the upstream revision separately. Keep existing internal package identifiers initially to avoid broad rename churn. Upgrade source and schema together only after compatibility checks; retain the previous binary and database backup through the local acceptance cycle.

- KTD11. **Deliver peer messages through the existing durable mailbox API.** The assigned workflow consumes addressed messages at safe tool boundaries and during bounded waits. Do not type peer messages or submit Enter into native terminals. A supported structured client channel may wake an idle session; otherwise retain the message and expose its pending state until the workflow polls or a verified resume boundary is available. This extends the chat owner rather than introducing another message store. (session-settled: user-approved — chosen over terminal injection: message text must never answer a permission prompt.)
- KTD12. **Separate the demo and retain comparative acceptance.** Use a local demo repository outside the orchestrator's ancestry and worker write mounts. Compare OpenRig with the already-screened ReevesAgents revision `39ce3ace2dd2f2df451e943c432d505fb61d5946` on the same frozen feature task. Keep OpenRig as the selected base; the comparison measures evidence and adaptation cost, not an implicit re-selection or a requirement to build a second complete product. A manual baseline is optional and never replaces this criterion. (session-settled: user-approved — chosen over a nested demo and substituted manual comparison: preserve instruction isolation and the original success criterion.)
- KTD13. **Extend OpenRig's web package into the reference-benchmark Web UI.** Posture: `extend`. Keep the package's build, router, query client, component primitives and terminal components. Replace its theme with design tokens derived from `docs/Rendering.png`: deep navy surfaces, bordered rounded cards, blue accent, and green/amber/red/purple state colors. Add a managed-run navigation shell. Upstream pages outside that shell stay in source but are unreachable from the managed-run navigation and are not supported product surfaces. The daemon serves the built bundle from its existing UI-serving path on loopback only. (session-settled: user-directed — chosen over a TUI-only product and over the generated mockups: the owner wants a browser console that matches the reference rendering.)
- KTD14. **Authenticate the browser with a paired owner session, never a URL token.** The owner pairs a browser from the TUI or owner CLI, which hold the owner credential. They mint a one-time code that is valid for 60 seconds. It reaches the page in the URL fragment and is exchanged by POST for an `HttpOnly`, `SameSite=Strict`, host-only session cookie, plus a per-session anti-forgery token required on every mutating request and WebSocket upgrade. Sessions expire after 30 minutes idle or 12 hours absolute, and the TUI can revoke them. Disable OpenRig's `?token=` query authentication for managed-run routes. Keep its Host and Origin boundary. Workers cannot mint a pairing code because they cannot read the owner credential.
- KTD15. **Share one language catalog between both clients.** Interface strings live in one shared, typed Chinese/English catalog consumed by i18next in the TUI and by its React binding in the Web UI. Store state, status and event identifiers as stable English codes; translate only at display time. Use Chinese as the default; store the owner's choice in owner client configuration and switch without restart. A missing key falls back to the other language and fails the catalog-parity test. Terminal layout measures display width so Chinese characters occupy two columns.
- KTD16. **Separate the owner terminal from agent sessions.** The interactive terminal (PC5) is a shell owned by an owner terminal host process. That process runs under the owner's own login account, in its own tmux socket, and is started by the owner's TUI or owner CLI session. It is never the daemon's control identity and never a worker identity. The daemon only relays authenticated bytes between an owner client and that host. If the host is not running, the terminal tab reports "unavailable"; the daemon does not fall back to spawning a shell. Agent session views, including the Lead, stream read-only by default. Owner keyboard input into an agent session requires an explicit "take over" action with the owner session, is limited to that session, and is audited with start, end and target. This is how the owner talks to the Lead (PC4) and answers unsupported native prompts. Peer messages still never use terminal input (KTD11). The owner terminal and take-over are disabled for any non-loopback client.
- KTD17. **Bound task editing by plan authority.** Owner edits to priority, assignee role, ordering, notes, and dependency links between existing plan-scoped tasks apply immediately as versioned owner-control actions. An edit that adds or removes a task, or changes a task's scope, bounded paths, acceptance criteria or limits, becomes a plan-change request. That request suspends the affected work under KTD5 until the owner approves an updated plan binding. Agents cannot edit tasks. Dependency edits are rejected when they create a cycle or unlock work whose prerequisites lack validated evidence.
- KTD18. **Reserve remote phone access for Milestone 2.** This milestone binds the Web UI to loopback and rejects non-local Host names except the WSL-to-Windows localhost path verified in U1. The responsive layout is built now. Milestone 2 owns exposure through an authenticated tunnel without inbound ports (Cloudflare Tunnel with Access, or Tailscale), passkey login, a fresh passkey check before each approval, read-only default sessions, device revocation, an access audit, and the installable app shell. The owner terminal and take-over stay disabled remotely unless that milestone decides otherwise.

### Existing Capabilities and Extension Ownership

The paths in this table refer to their locations after U1 imports the selected source under `engine/`. New files named later are proposed targets, not claims that they exist today.

| Capability | Existing owner | Posture and adaptation |
|---|---|---|
| Native launch, readiness, resume | `engine/packages/daemon/src/domain/runtime-adapter.ts`; Claude/Codex adapters and the tmux adapter | **Extend:** retain native sessions behind a restricted worker launcher; verify effective identity, isolated mounts, permissions and attempt identity |
| Tasks and dependencies | `engine/packages/daemon/src/domain/queue-repository.ts`; `engine/packages/daemon/src/domain/workflow-runtime.ts` | **Extend:** bind approved scope and prerequisites; guard every pickup, continuation, and completion path |
| Persistent communication | `engine/packages/daemon/src/domain/chat-repository.ts`; `engine/packages/daemon/src/routes/chat.ts` | **Extend:** task/recipient references, authenticated mailbox polling and consumption acknowledgements; no peer-text terminal submission |
| Durable events and replay | `engine/packages/daemon/src/routes/events.ts`; existing event persistence and queue transition log | **Extend:** carry run/attempt/plan correlation and control acknowledgements; replay drives projections |
| TUI | `engine/packages/tui/src/daemon-client.ts`; `engine/packages/tui/src/input.ts`; `engine/packages/tui/src/state.ts` | **Extend:** team/task views and typed approval/cancel controls; retain renderer and reconnect behavior |
| Web UI | `engine/packages/ui/src/routes.tsx`, `App.tsx`, `components/ui/*`, `hooks/*`, `lib/query-client.ts`, `lib/theme.ts`, `tailwind.config.ts` | **Extend (KTD13):** managed-run shell and views, reference-derived tokens, shared contracts; legacy pages stay unreachable from the managed-run navigation |
| UI serving and browser boundary | `engine/packages/daemon/src/server.ts` (UI bundle serving, `webUiEnabled`); `engine/packages/daemon/src/middleware/browser-boundary.ts` | **Extend (KTD14, KTD18):** loopback binding, paired session cookie, anti-forgery token; retain Host/Origin checks |
| Live terminal streaming | `engine/packages/daemon/src/routes/terminal-ws.ts`; `engine/packages/daemon/src/terminal/TerminalSessionBroker.ts`; `engine/packages/ui/src/components/terminal/*` | **Extend (KTD16):** read-only by default, owner-session take-over with audit, no query-string token, relay to the owner terminal host |
| Files and workspace | `engine/packages/daemon/src/routes/files.ts`, `routes/workspace.ts`; `engine/packages/ui/src/hooks/useFiles.ts`, `useWorkspace.ts` | **Extend:** read-only browsing limited to the registered target repository, candidate diffs and plan/knowledge documents |
| Stop and recovery | `engine/packages/daemon/src/domain/rig-teardown.ts`; `engine/packages/daemon/src/domain/queue-recovery.ts` | **Extend:** persistent cancellation intent, owned-process checks, uncertain outcomes, and no automatic side-effect replay |
| Framework invocation | Pinned upstream workflows and task validator | **Compose / thin-glue:** translate bounded invocation and outcome; do not copy workflow policy into a parallel interpreter |
| Approved plan and action authority | No inspected owner represents this project's complete approval binding | **New domain boundary:** `engine/packages/daemon/src/domain/plan-governance.ts` coordinates the existing queue with immutable owner grants; existing human attention items remain its display surface, not its authority store |

The restricted worker launcher is a new security boundary under `engine/packages/daemon/src/adapters/worker-launch.ts`, with a reviewed sandbox profile in `engine/config/isolation/worker-policy.json`. Existing tmux and native permission owners do not provide host-identity isolation. Owner-authorized setup provisions a narrowly scoped launcher that can use only approved worker identities and mount profiles; it is not a general privileged command executor. Workers receive no sudo/root capability and cannot change the installed launcher or profile. Record their installed hashes and ownership. The daemon never runs arbitrary model-generated commands as the control identity. U1 owns feasibility and provisioning documentation; U4 owns runtime integration and tests.

### High-Level Technical Design

```mermaid
flowchart TB
    Owner[Owner discussion with Lead session] --> Framework[Requirements and implementation plan]
    Framework --> Binding[Plan digest and owner approval]
    TUI[Owner TUI outside agent tmux] --> Controls[Control-identity daemon]
    Web[Owner Web UI on loopback, paired session] --> Controls
    Controls <--> OwnerShell[Owner terminal host under owner account]
    Binding --> Controls
    Controls --> Queue[Existing queue and workflow runtime]
    Queue --> Adapters[Native session adapters]
    Adapters --> Isolation[Restricted worker launcher and isolated mounts]
    Isolation --> Implementer[Implementation session]
    Isolation --> Reviewer[Independent review session]
    Implementer <--> Messages[Task-linked messages]
    Reviewer <--> Messages
    Queue <--> DB[SQLite tasks, approvals, attempts, evidence]
    Messages <--> DB
    DB --> Events[Durable events and replay]
    Events --> TUI
    Events --> Web
    Reviewer --> Candidate[Integrated candidate and acceptance evidence]
    Candidate --> Owner
```

The lead makes semantic staffing and decomposition decisions; the daemon checks mechanical eligibility and records execution. A staffing proposal contains the required capabilities and assignment owners. In the first milestone these map to lead, implementer, and reviewer; role configuration supports later expansion without launching every specialty.

The plan remains canonical in the selected repository. Registered copies are immutable evidence of what was approved, not writable replacements. Native session output is an observation, never an instruction to mark a task accepted. Conflicting output, malformed handoffs, or missing evidence leave work blocked or incomplete.

### Interface Contracts

U2 creates the shared additive contract module `engine/packages/daemon/src/contracts/team-control.ts` and a package export through `engine/packages/daemon/src/team-control-surface.ts`; U6 verifies its TUI consumer and U11 its Web UI consumer. Extend the existing daemon package export pattern, not a duplicate client schema. Complete executable validators belong in source, not this document.

| Interface / mode | Consumers and canonical owner | Contract and compatibility | Verification owner |
|---|---|---|---|
| Plan binding and assignments / greenfield | Lead integration, queue, TUI; `engine/packages/daemon/src/domain/plan-governance.ts` and `engine/packages/daemon/src/contracts/team-control.ts` | Plan reference/digest, repository identity, bounded paths, dependencies, roles, limits, policy revision; malformed or stale inputs reject without dispatch. Task packs keep the upstream schema and validator. | U2/U3: schema, drift, and dispatch contract tests |
| Owner controls / greenfield | Owner TUI and local Web UI; `engine/packages/daemon/src/routes/team-control.ts` | Local authenticated requests carry action ID, expected entity version, and idempotency key. Agent capabilities can request but never grant approvals. Responses distinguish accepted request, pending execution, conflict, denial, and observed outcome. Empty approval lists are successful empty results, not unknown state. Task edits (KTD17) use the same envelope and return either `applied` or `plan-change-required`. | U2/U6/U11/U12: actor permissions, races, retries, lost acknowledgement, edit classification |
| Browser session / greenfield | Web UI; `engine/packages/daemon/src/routes/owner-session.ts` and the browser boundary | One-time pairing exchange, session cookie, anti-forgery token, idle/absolute expiry, revocation list. Requests without a valid session and token are denied before any route runs. No credential in a URL query, log or event. | U9: pairing, expiry, revocation, forgery and replay |
| Session attach / evolution | Web UI and TUI terminal views; existing terminal WebSocket route | Read-only stream by default. A take-over frame requires the owner session and names one session. Input frames without an active take-over are rejected and audited. The owner terminal channel relays only to the owner terminal host. | U9: read-only default, take-over audit, host absence |
| Interface language catalog / greenfield | Web UI and TUI; `engine/packages/i18n/` workspace package | Keyed Chinese/English messages with interpolation. Status codes map to labels; unknown codes render the raw code, never a guessed label. Both locales must define the same keys. | U10: key parity, fallback, width |
| Task messages / evolution | Lead, specialists, TUI; existing chat repository and routes | Add task, recipient, reply-to, attachment references and client message ID. Workers poll a capability-scoped mailbox and acknowledge consumption; pending messages survive reconnect. No message body is terminal input or an approval response. Delivery is at-least-once with deduplication. | U4/U6: recipient isolation, prompt-active delivery, acknowledgements and replay |
| Session attempts / evolution | Scheduler, runtime adapters, recovery, TUI; existing runtime-adapter contract plus attempt records | Bind native session token, tmux server/pane, observed process identity, generation, and policy fingerprint. Unsupported permissions or resume semantics are structured blockers, not successful launches. | U4/U7: native adapter characterization and recovery tests |
| Events and evidence / evolution | CLI/TUI projections, delivery report; existing event store plus `engine/packages/daemon/src/contracts/team-control.ts` | Versioned envelope with event ID, entity version, run/task/attempt IDs and payload. Unknown major versions block control use; optional fields are additive. Unavailable usage is null with reason, never zero. | U2/U6/U8: replay, compatibility and final evidence binding |

Keep existing upstream endpoints available for unaffected behavior, but apply the managed-run guard to every path that can mutate, start, wake, restore, complete, or stop managed work. A new guarded endpoint alongside an unguarded legacy path is a failed integration. Direct SQLite access is internal to the daemon, not an agent API. During the local compatibility window, new fields are additive and all bundled consumers ship from the same revision. Older clients may read compatible projections but must not control managed runs without the required protocol version; retain old schema fields until a current consumer inventory establishes zero use.

Use a local loopback listener with authenticated reads and writes and strict allowed origins. Browsers authenticate only through the paired owner session in KTD14. Owner and per-session capabilities are separate, short-lived, revocable, and excluded from logs and generated documents. Only the owner TUI and owner CLI hold the owner control credential; the browser holds a derived, revocable session. The daemon, its database and tmux supervisor use a control identity; all coding processes, including the lead, use restricted worker identities. The threat model includes agent-launched shell commands, test runners, and their children. It trusts the human workstation administrator and does not claim protection against a compromised host kernel or administrator; that exclusion does not exempt managed agents.

### Worker Isolation and Source Transfer

The worker sandbox exposes only its assigned target tree, an isolated home/provider configuration, read-only pinned framework, role and approved plan-binding files, read-only toolchain dependencies, and run-local scratch space. An implementer's assigned tree is writable; a reviewer's candidate is read-only. The control state directory, owner tokens, browser session store, SQLite database/WAL/shared-memory files, backups, daemon source, supervisor sockets, the owner terminal host socket, and other workers' private data are neither mounted nor reachable through alternate paths. Preserve restrictive ownership as a second layer. Do not inherit control file descriptors, unrestricted host process access, Windows-mounted paths, or Windows executable interoperation that would reopen these resources.

Agent processes do not receive the managed tmux socket or owner terminal device. The control-side launcher creates and monitors sessions without exposing a raw terminal-control API to workers. A worker API permits only its assigned mailbox, evidence submission, status reporting, and decision requests. Native provider prompts remain distinct: only verified request/decision channels may carry owner decisions, and peer messages never use that channel.

U1 first checks that Ubuntu supports the selected identity/filesystem/process isolation and that both installed native clients can operate within it with their native protections enabled. Use owner-approved setup and minimal probes, with no business task or publication credentials. No automatic fallback to a weaker identity, shared socket, full-access flag, or alternative host is permitted. Missing capability blocks adaptation dependent on it and returns the failed prerequisite to the owner. U4 repeats the tests through the actual managed launch paths and after resume.

Before cutover, U1 lists the bootstrap source files and hashes, plus explicitly preserved/excluded personal and generated material. Transfer only the approved set; do not copy credentials, dependency installations, caches, or build output. Verify identical source hashes before recording WSL as authoritative. No Git commit is needed for this manifest. Keep repository metadata separately scoped; do not overwrite an existing checkout. After cutover, Windows edits are conflicts, not sync input. Requested WSL-to-Windows exports compare destination hashes with the previous export manifest and stop on external edits, changed deletions, or path escapes; no bidirectional synchronization or implicit mirror deletion.

### State, Persistence, and Approval Invariants

- Use the existing `pending`, `in-progress`, `blocked`, `done`, `failed`, `denied`, `canceled`, and `handed-off` queue states. Preserve the upstream archive-terminal predicate, which is not an execution-success test. Only a completed task with validated result/evidence satisfies a managed dependency. Handoff transfers responsibility and never satisfies a dependency by itself; the referenced successor must complete successfully. Failed, denied and canceled tasks do not unlock consumers.
- Record a queue transition, related authority/evidence changes, and its event in one SQLite transaction. Publish after commit. Use entity-version compare-and-set for competing decisions, and unique keys for message and control deduplication. SQLite is local to WSL, never a shared network database.
- Approval lifecycle is `pending -> approved | rejected | expired | invalidated`. An approved operation has a separate consumption record; a consumed or ambiguous action is never blindly replayed. Approval binds the action payload and target digest, not only a human-readable summary. Only the owner's control session through the TUI can grant orchestration approval; no agent credential can approve any request.
- Native and orchestrator approvals are distinct records: granting one never satisfies the other implicitly. Cancellation or plan invalidation revokes unused grants before further dispatch; an already started effect remains an observed outcome to reconcile, not something cancellation promises to undo.
- A plan grant permits only the recorded local implementation scope. Commit, push, PR creation, merge, release, deployment, scope expansion, and resource-limit increases each need the relevant owner grant. A rejection persists through restart and blocks the requested operation.
- Preserve provider-native tool approval controls. Bridge a pending native request only where the selected CLI exposes a verified request/decision channel; otherwise retain the native prompt and mark the task awaiting owner action. Do not send blind terminal keystrokes or claim the TUI can approve unsupported native requests. TUI plan and orchestrator action controls remain fully supported.
- Prompt instructions and broad shell-command allowlists are not containment. Enforce the Worker Isolation contract independently of native tool approvals. The same real worker must demonstrate an allowed in-scope edit and denied control-token read, database/WAL mutation, supervisor-socket connection, and owner-pane input attempt. Run these checks through ordinary shell/test-process execution, not only native permission requests. Missing or failed containment disables managed launch; native denial remains an additional required proof.
- Owner client actions, browser pairing, take-over and task edits are owner-control records with entity versions and idempotency keys. A task edit classified as `plan-change-required` suspends affected work under the same transaction as the edit request. Terminal input into an agent session without an active take-over record is rejected. Take-over ends on explicit release, session revocation, client disconnect or 15 minutes without input.
- Canonicalize repository roots and resolve symlinks before scope decisions. Preserve unrelated dirty files. Child process environments include only selected provider configuration and run capabilities; unrelated project data and owner control credentials are excluded. Malformed personal configuration is reported and left byte-identical.
- At restart, reconcile the recorded attempt with the native session and owned tmux/process identity before any continuation. Distinguish an active session, a resumable stopped session, and an unknown outcome. Lease expiry permits investigation, not a duplicate launch. Completed side effects require receipts or owner reconciliation.
- Cancellation first records intent and closes dispatch, then requests graceful stop. After 5 seconds escalate only against the recorded owned process group/session; after 15 seconds report unresolved termination if identity or exit remains uncertain. Keep `cancel_requested` as attempt/control state until observed termination; do not mark the queue canceled merely because a button was pressed. Do not delete worktrees, history, or service data as cancellation cleanup.

### Framework and Native-Session Integration

U3 records all 38 upstream entrypoints with supported, gated, or deferred status in `engine/packages/daemon/src/integrations/framework/catalog.ts`. This inventory is availability metadata, not a second routing policy. Changes to the framework pin require a catalog and contract recheck.

| Integration group | First-milestone treatment |
|---|---|
| Requirements, planning, execution, review | Live end-to-end coverage for new-product clarification, implementation planning, execution, diagnosis when needed, and report-only independent code review. Existing-project PRD routing receives contract coverage. |
| Optional decomposition | Use the upstream task-pack producer and validator only when useful; direct plan-unit execution remains supported. A missing validator prevents using a task pack but does not invent a replacement schema. |
| Architecture, rules, document review, simplification | Pass bounded artifact/repository scope to the relevant workflow; verify caller ownership and mutation posture with recorded outcomes. |
| Explicitly invoked, delivery, knowledge, optimization workflows | Discoverable with their original invocation/authorization gates. Availability never grants commit, landing, knowledge promotion, or unbounded loops. |
| Browser/mobile, external feedback, remote nodes, other CLIs | Capability-gated or deferred; show the reason and prerequisite. Mac-only simulator execution is deferred to a Mac node. |

Generate runtime projections from the pinned source inside an application-prepared, worker-readable isolated configuration boundary; do not copy the orchestrator's generated skill trees into it. Keep pinned instructions, skills, role context and plan-binding files immutable and read-only to workers, including through their parent directories; store mutable native-client state separately. Keep the current root `.agents/`, `.claude/`, `.codex/`, `.opencode/`, and `.pi/` trees intact. Each launch/resume manifest records the framework revision, projected-file hashes, role/plan context, native configuration roots, instruction-discovery scope, and any permitted global configuration. Compare observed client discovery with that manifest where exposed and run negative contamination fixtures for parent/global instructions. An unaccounted instruction source blocks managed work; file existence alone is not proof of what the client loaded. U3 owns manifest generation and U4 verifies both clients.

Use Claude Code as implementer and Codex as independent reviewer for the complete primary demonstration. Verify the reverse assignment through targeted native-contract checks: permitted edits, denied control access, mailbox delivery during a pending prompt, instruction provenance, and resume. The reverse pairing does not repeat the full feature task in this milestone. The lead remains a separate configurable session. Bounded workers do not spawn another team or invoke full-delivery workflows by default.

### Web UI and TUI Experience

`docs/Rendering.png` is the benchmark (PC3). The Web UI reproduces its layout and visual language at desktop width: a top bar, a left navigation rail with a current-plan card, a header with the run stepper, a task list beside a task detail pane, a right column of agent and system status plus recent activity, and a bottom panel. The TUI presents the same information as bordered panels with keyboard controls. Where the rendering conflicts with an owner decision or a Product Contract rule, the adaptation below governs.

| Reference region | Data source and behavior | Adaptation from the rendering |
|---|---|---|
| Top bar | Application version, WSL status, clock, daemon connection with last-sync age, pending-decision count, language toggle | Window min/max/close icons are browser chrome and are omitted. Connection state and a pending-decisions badge are added. |
| Navigation rail | Overview, Task management, Workspace, Agent monitor, Review & decisions, Logs, Knowledge base, Settings | "审查中心" becomes "审查与决策" and holds pending approvals as well as review records. |
| Current-plan card | Plan title, digest prefix, approval state (approved, stale, invalidated), approval time, readiness | Replaces "版本 v1.0.0" with digest and approval state; a stale or invalidated plan shows a warning and disables approve controls. |
| Run stepper (0-6) | Run-level projection from durable state: setup checks, plan approved, assignments derived, execution, review, integration verification, delivery decision. The current stage is the earliest stage with unfinished required work; counts show tasks in later stages. | Stage 6 "交付发布" reads "等待交付决定" until the owner records a decision. It never implies that publishing ran (Product Contract separate delivery permissions). |
| Task list | All tasks of the run with search and sort. Filter tabs cover every queue state including blocked, failed, denied, canceled and handed-off. | Priority badge P0-P2 is set by the owner or Lead. The progress bar shows verified acceptance criteria out of the total (for example 3/4), never an agent's self-reported percentage. |
| Task detail tabs | Details (description, acceptance criteria with verification state, dependencies, owners, timestamps), Discussion (task-linked messages, read-only to the owner), Changes (candidate diff), Tests (test evidence), Review record | "预计完成" appears only as "Lead 估计" with its author and time, or is hidden. Approve, reject and cancel controls appear in the header when applicable. |
| Agent status | Role, runtime, configured model label, and session state: active, idle, awaiting native prompt, resumable, unknown outcome, blocked | "在线" (online) is replaced by these states. A "view session" action opens the read-only session view (KTD16). |
| System status | Target repository (branch, or snapshot lane when no commit exists), WSL environment, database, task queue/mailbox, owner clients | "消息队列" becomes "任务队列/邮箱", since no broker exists (KTD4). "TUI 界面" becomes owner-client connections. |
| Recent activity | Durable events, newest first, linked to run, task and attempt | No change. |
| Bottom panel | Terminal (owner terminal plus session views), Logs (task- and attempt-scoped), Review conversation | The "talk to Lead" input box is removed (PC4). The terminal tab follows KTD16. |
| Pending decisions | Owner approvals and native-prompt notices | Not in the rendering. Shown as a highlighted card at the top of the right column when non-empty, and in "审查与决策". Native requests without a verified channel show "open session" instead of approve. |

**Component boundary:** reuse the web package's primitives (`button`, `card`, `tabs`, `dialog`, `badge`, `table`, `tooltip`, terminal components) restyled through the new tokens. New components are limited to the managed-run shell, run stepper, task row, decision card and status cards, each fed by the shared contracts. The TUI reuses its attention model and renderer.

**State matrix (both clients):**
- Loading shows placeholders.
- With no active run, the overview shows a "no active run" state and setup status.
- An unreachable daemon shows a banner and disables controls.
- Data older than 5 seconds without a heartbeat is labeled stale and disables approve and reject.
- An expired browser session prompts for re-pairing without losing the current view.
- A version conflict on a control or task edit shows the newer state and asks again.
- Duplicate clicks are coalesced by idempotency key.
- A pending control shows "requested" until the daemon reports the observed outcome.

**Accessible interaction:**
- Every control is reachable by keyboard, with visible focus and focus restored after dialogs close.
- Status always pairs color with text or a glyph.
- Text and controls meet WCAG AA contrast on the navy surfaces.
- Glow and progress animations stop under reduced-motion preferences.
- Dialogs carry labels and announce errors.
- The TUI shows its key hints persistently.

**Responsive behavior:**
- At 1440 px and wider, the three-column layout matches the rendering.
- From 1024 to 1439 px, the right column moves below the detail pane.
- Below 768 px, a single column with a bottom tab bar (overview, tasks, decisions, logs, settings) prepares the Milestone 2 phone experience. The owner terminal is hidden at this width.
- Touch targets are at least 44 px.

**Runtime verification owner:** component and projection tests run under the existing jsdom setup. Real-browser checks are required at 1440, 1024 and 390 px widths in both languages, through the browser-testing workflow or an equivalent harness. If no browser capability is available, record the claim limit; do not report the UI as verified. The TUI is verified in a real terminal at two sizes in both languages.

### Implementation Scope Boundaries

**Included:** local engine adaptation, build standards, durable authority and messaging, worker isolation, native session coordination, independent review, TUI and local Web UI monitoring and controls, Chinese/English interface catalogs, paired browser sessions, owner terminal and audited session take-over, read-only workspace and knowledge views, bounded task editing, restart/cancel handling, and comparative validation against a separate demo repository. Maintained orchestrator code and evaluation harnesses belong in `engine/`; project plans and reports remain in root `docs/`. Only U8 owns the separately scoped demo seed and agent-produced feature.

**Preserved but inactive:** upstream web UI pages outside the managed-run navigation, remote-host transports, gateways, optional runtimes, and bundled methods not selected for this milestone. Do not launch them or include their administration in either client's managed-run surface. Retaining source for a reproducible baseline does not imply product support.

**Deferred:** broader role presets and simultaneous workers after the first team passes acceptance; Mac/VPS support after local recovery works; Pi/DSH after exact-project identification and adapter proofs; hosted multi-user administration and protection against hostile host administrators after a separate design. Isolation of managed agent processes is required now, not deferred. Milestone 2 covers remote phone access through a domain: tunnel, passkeys, a fresh passkey check per approval, an installable app, and push notifications (KTD18). TUI goal authoring and session administration remain deferred (PC5). The project owner owns later expansions.

### Resource, Data, and Operational Boundaries

Progress means a completed tool step, a meaningful task-state transition, or newly validated evidence. Heartbeats and repeated status text prove liveness, not progress. A supervised long-running test with a recorded deadline remains in a waiting-for-tool state until that deadline, rather than tripping the generic ten-minute inactivity rule. Unknown/unbounded subprocesses receive no exemption. Tool deadlines are capped by the remaining run budget; inactivity, timeout and budget exhaustion stop new dispatch and expose distinct blockers without blind retry. Persist budget accounting before launch/resume and enforce each worker deadline outside the daemon's in-memory timer; controller restart or absence grants no extra runtime. Budget expiry invokes the owned-process cancellation procedure as well as closing dispatch.

- Maximum managed queue size is 100 tasks for the first milestone. Reject dependency cycles before admission. Retry only the failing eligible attempt; never restart the whole team automatically.
- Retain at most 64 MiB of raw execution logs per run and 256 MiB of aggregate run artifacts before pausing new dispatch for owner action. Keep durable decisions and evidence references intact; report omitted/truncated log segments. No automatic history deletion in the initial release. Owner-requested export/pruning is explicit and excludes active runs.
- Treat source snippets, prompts, provider output, local paths, and test logs as potentially sensitive. Redact credentials before shared logs/events and avoid full environment or home-directory capture. Generated artifacts never contain authentication secrets. Native provider retention remains outside the application's control and must be disclosed at setup.
- Watch for pending approvals, lost session identity, stale plans, idle deadlines, failed persistence, and exhausted limits. The local owner responds through the TUI; each signal links to its run/task/attempt and recovery action. Do not collect high-cardinality raw prompt text as metrics.
- TUI and Web UI event updates should be visible within two seconds in a bounded local replay test of 1,000 events; disconnected or stale data must be labeled.
- Audit records for take-over, owner-terminal open/close, browser pairing and revocation are durable decisions, not raw logs. Owner-terminal keystrokes and output are not stored by the daemon. This is an acceptance target for the control surface, not a productivity claim or a guarantee of model response speed.

### Evidence & Limitations

Research was inspected on 2026-10-13. Repository source and manifests establish existing interfaces and declared dependencies, not successful execution. No candidate installation, build, live provider test, or independent runtime review has occurred during planning.

| Evidence | Decision impact and limitation |
|---|---|
| [OpenRig source snapshot](https://github.com/mvschwarz/openrig/tree/cb79b8c980ec120c8db28d5aaf2c4bb3cc540c61), root/workspace manifests and Apache-2.0 license | Supports KTD1/KTD2; manifest version is not proof that this default-branch commit equals the release tag |
| [Native adapter contract](https://github.com/mvschwarz/openrig/blob/cb79b8c980ec120c8db28d5aaf2c4bb3cc540c61/packages/daemon/src/domain/runtime-adapter.ts), Claude/Codex adapters, `kernel-authority.ts`, `yolo-mode.ts` | Supports reuse and KTD6; effective launch defaults and automatic trust/configuration writes require adaptation and native-client verification |
| [Queue owner](https://github.com/mvschwarz/openrig/blob/cb79b8c980ec120c8db28d5aaf2c4bb3cc540c61/packages/daemon/src/domain/queue-repository.ts), chat repository, event replay route, workflow runtime, teardown | Supports KTD4 and recovery design; presence of these modules does not prove complete plan-bound authorization or crash safety |
| [ReevesAgents snapshot](https://github.com/mertkayacs/reevesagents/tree/39ce3ace2dd2f2df451e943c432d505fb61d5946), native launches and JSON approval records | A smaller Node/tmux candidate; inspected approval storage did not by itself establish action enforcement. Not selected because more team-governance and recovery infrastructure would need to be added |
| Earlier candidate matrix in Product Contract | Migration is permitted, but Python/Rust/Bun candidates offer no demonstrated advantage sufficient to replace the selected Node baseline. Archived Overstory is not the preferred maintenance base |
| Pinned framework catalog, task-pack validator and worker-dispatch contract in Product Contract sources | Supports KTD3; generated host discovery is not proof of working invocation. Installed local mirrors can differ from the pin |
| Read-only WSL inventory | Ubuntu and docker-desktop are registered as WSL2 and were stopped. Ubuntu toolchain, tmux, CLI versions and authentication remain unverified; do not infer WSL is absent |
| Local repository inventory | `master` has no commits and the workspace contains untracked user/runtime/document files. Import must be additive; no broad staging, reset, replacement, or inferred initial commit |
| [OpenRig web package](https://github.com/mvschwarz/openrig/blob/cb79b8c980ec120c8db28d5aaf2c4bb3cc540c61/packages/ui/package.json) and its `src/` tree | Supports KTD2/KTD13: React 19, Vite 6, Tailwind 3, Radix, TanStack, xterm.js, React Flow, lucide. Its current "vellum" theme differs from the reference, so tokens are replaced rather than reused. No i18n library is present. |
| OpenRig `server.ts`, `browser-boundary.ts`, `routes/terminal-ws.ts`, `terminal/TerminalSessionBroker.ts` | Supports KTD14/KTD16 and changes them: the UI is served only when `webUiEnabled` is on; the terminal WebSocket forwards client input into tmux sessions and accepts a bearer token through `?token=`. Both are restricted for managed runs. The Host check already recognizes a Tailscale MagicDNS name, which is relevant to Milestone 2, not this one. |
| Owner reference rendering `docs/Rendering.png` | Owner-supplied visual and layout benchmark (PC3). It is a design input, not a behavior source; conflicts are resolved in "Web UI and TUI Experience". |
| Generated mockups `docs/design/mockups/*.png` | Explored adaptations during planning. Not a benchmark (PC3); kept only as a record of the explored adaptations. |

### Demo Ownership and Comparative Acceptance

U8 registers `work-board` as a separate local target repository outside the orchestrator's directory ancestry. Resolve its physical path at execution and reject nested/aliased roots. Workers receive only that repository's assigned snapshot and pinned context; orchestrator source and unrelated repositories are not writable or visible. The engine harness remains control-side and accesses the demo through an explicit registered target, not a relative parent-directory assumption.

The seed owner creates package/build/test configuration, a minimal SQLite schema with fixed sample rows, a list-only API, and a list-only browser view. Baseline tests cover those existing capabilities. Freeze a seed manifest before any evaluated agent work. The agents add status filtering, completion mutation and persistence, request validation, UI interactions, and their feature tests; the seed must not already implement those changes. The control-side acceptance harness checks the fixed feature contract without giving a worker write access to the harness or its expected outcomes.

Run the frozen feature task on OpenRig and the pinned ReevesAgents comparison baseline with fresh copies of the same seed, matching available models, role assignments, acceptance checks and run caps. Use the same worker/control protection boundary. Record every material configuration difference, necessary glue change, adaptation effort, owner intervention, failure, recovery outcome, elapsed time and reliable usage/cost measurement. Unknown cost is unknown. An observed incompatible or blocked scenario is a comparison result with its evidence, not a passing capability; do not replace an unattempted comparison with source inspection. Do not weaken isolation to make a candidate run. The completed comparison report and its limitations are required for milestone closeout; a manual-coordination baseline is optional additional evidence.

### Risks and Execution Prerequisites

The largest unproven risk is end-to-end authority preservation across agent-launched code, native prompts, restart, legacy control paths, and the browser and owner-terminal surfaces. U1 checks host and client isolation feasibility before substantial adaptation. U2, U4 and U9 then prove enforcement through the adapted launch, API, browser and terminal paths. A web-page defect that executes script in the owner's browser can act with the owner session; the anti-forgery token, inert rendering of agent text, loopback binding and the absence of the owner terminal and take-over from non-loopback clients limit that exposure, and Milestone 2 must not widen it. A failed proof blocks the dependent work rather than weakening policy.

The owner confirmation resolves the base-project choice and planning scope. These remaining prerequisites do not change the architecture and are checked at execution, before the affected action:

- **U1 owner:** inspect Ubuntu, record a new Linux checkout and separate demo-root allocation, and verify identity/sandbox/client compatibility before substantial adaptation. Confirm that a Windows browser reaches the WSL loopback listener through WSL localhost forwarding without binding to other interfaces. Provisioning identities or a privileged launcher requires explicit setup scope; do not modify OS accounts or privileges merely because this document is ready. Preserve the Windows workspace and verify the source-manifest cutover.
- **U4 owner:** record exact native CLI versions, select lead/member models and supported isolated configuration, and verify authentication. Do not embed credentials or auto-upgrade the clients.
- **U1/U4/U8 owner:** record spending posture before any live compatibility probe or trial. Offline checks need no model budget. Each separately approved run has its own 60-minute cumulative limit; retries, drills, and daemon restarts do not reset it. An additional comparison or reverse-contract run needs another explicit grant.
- **Future expansion owner:** identify DSH and decide remote identity/transport only when those deferred milestones are selected.

## Implementation Units

### U1. Establish the pinned source and reproducible WSL foundation

- **Goal:** Establish one verified WSL development source and prove the required isolation/client foundation before substantial engine adaptation.
- **Requirements:** R2, R3, R7, R13, R20, R21; F1, F4; AE2, AE6, AE12, AE13; KTD1, KTD2, KTD6, KTD7, KTD10.
- **Dependencies:** None. Inspect current state again before writing.
- **Files:** `engine/` (new pinned source tree), `engine/package.json`, `engine/package-lock.json`, `engine/packages/daemon/package.json`, `engine/packages/tui/package.json`; `engine/config/isolation/worker-policy.json`, `engine/test/project-baseline.test.mjs`, `engine/test/worker-isolation-preflight.test.mjs` (new); `docs/development.md`, `docs/upstream-baseline.md` and `docs/operations.md`. All paths are in the orchestrator repository; no demo source is created in this unit.
- **Approach:** Check Ubuntu, restricted identities, isolated mounts/process access, and both native clients before adapting the engine. Use minimal owner-approved probes and record unsupported capabilities without changing host or weakening protection. Audit the pinned archive and lifecycle scripts before import/install; reject escaping entries. Transfer the approved source manifest, verify hashes, then make the WSL checkout the only development authority. Preserve the Windows files and licenses/notices. Document narrowly scoped launcher provisioning and verify installed ownership/hashes; workers cannot edit it.
- **Test scenarios:** (1) preexisting Windows files remain byte-identical; (2) bootstrap hashes match and changed Windows exports are rejected; (3) an archive/symlink escape is rejected; (4) actual worker identity denies owner token, database/WAL and supervisor socket access while allowing its assigned scratch file; (5) no host-process or Windows-interoperation path bypasses the boundary; (6) both clients retain native sandbox/permission behavior inside that boundary; (7) missing kernel capability, tool, identity or authentication is reported distinctly and blocks dependent adaptation; (8) a clean WSL install builds daemon/CLI/TUI with the recorded SQLite ABI.
- **Verification:** Run the Node baseline and OS-isolation preflight harnesses against the proposed setup, then the audited imported build/typecheck/test scripts. Record source hashes and exact OS, kernel, Node/npm and client versions. Pure filesystem/process probes use no model; any native probe that contacts a provider requires a recorded budget grant. No substantive autonomous feature task runs here.

### U2. Establish plan-bound authority and durable control contracts

- **Goal:** Make approved scope and action permissions enforceable before dispatch exists in the adapted product.
- **Requirements:** R1, R4, R5, R13, R19, R21, R22; F1, F4; AE1, AE4, AE6, AE11, AE13; KTD4-KTD6.
- **Dependencies:** U1.
- **Files:** `engine/packages/daemon/src/contracts/team-control.ts`, `engine/packages/daemon/src/team-control-surface.ts`, `engine/packages/daemon/src/domain/plan-governance.ts`, `engine/packages/daemon/src/routes/team-control.ts` (new); `engine/packages/daemon/package.json`, `engine/packages/daemon/src/index.ts`, `engine/packages/daemon/src/server.ts`, `engine/packages/daemon/src/domain/queue-repository.ts`, `engine/packages/daemon/src/domain/seat-delivery-guard.ts`, `engine/packages/daemon/src/domain/event-bus.ts`, `engine/packages/daemon/src/middleware/auth-bearer-token.ts`, `engine/packages/daemon/src/middleware/browser-boundary.ts`, `engine/packages/daemon/src/db/migrations/104_team_governance.ts` (new at the pinned baseline), `engine/packages/daemon/src/db/all-migrations.ts`; tests `engine/packages/daemon/test/team-governance.test.ts`, `engine/packages/daemon/test/team-control-auth.test.ts`, `engine/packages/daemon/test/team-migration.test.ts` (new).
- **Approach:** Define and validate shared contracts before consumers. Add governance records and transactional event publication. Inventory all legacy mutation routes and internal wake/restore paths, then attach the same guard. Bind approval to content and expected version; refuse agent-supplied owner identity. Include the verified provider-policy capability in eligibility rather than assuming it from launch flags.
- **Test scenarios:** (1) unapproved/requirements-only plans cannot dispatch; (2) plan/repository drift invalidates grants; (3) no agent token approves any request or changes limits through new or legacy routes; (4) actual restricted workers cannot read the owner credential, write database/WAL/shared-memory files, connect to supervisor tmux, or send owner-pane input; (5) rejection survives restart and duplicate decisions do not execute twice; (6) competing approve/cancel decisions have one ordered outcome; (7) persistence failure acknowledges no action; (8) additive migrations preserve old messages and a paired backup restores correctly. API tests and direct worker-process attacks are separate required cases.
- **Verification:** Focused Vitest contracts and route tests, migration fixtures, and explicit legacy-route guard coverage. Native-tool enforcement is finalized by U4 before live work.

### U3. Connect the full framework catalog to bounded team assignments

- **Goal:** Translate approved plans into scope-preserving native workflow assignments without a second methodology.
- **Requirements:** R1-R6, R19, R21, R22; F1, F2; AE1-AE4, AE11, AE13; KTD3-KTD6.
- **Dependencies:** U2.
- **Files:** `engine/packages/daemon/src/integrations/framework/catalog.ts`, `engine/packages/daemon/src/integrations/framework/invocation.ts`, `engine/packages/daemon/src/integrations/framework/context-manifest.ts`, `engine/packages/daemon/src/domain/team-assignment.ts` (new); `engine/packages/daemon/src/domain/workflow-runtime.ts`; application-owned role/configuration source under `engine/config/team/` (new); tests `engine/packages/daemon/test/framework-catalog.test.ts`, `engine/packages/daemon/test/framework-invocation.test.ts`, `engine/packages/daemon/test/framework-context-manifest.test.ts`, `engine/packages/daemon/test/team-assignment.test.ts` (new).
- **Approach:** Derive the catalog from the pinned source and explicitly classify support. Let the lead request capabilities and bounded work; validate repository, plan identity, dependencies, outputs and permissions. Use upstream task validation for optional packs. Keep framework semantics in their original owner and disable conflicting default planning content for managed runs. Report-only and user-invoked boundaries survive translation.
- **Test scenarios:** (1) all pinned entrypoints are accounted for without aliases; (2) backend-only work omits unrelated roles; (3) invalid/stale task packs stop before execution while direct plan assignments work; (4) reviewer invocation cannot grant writes; (5) gated/deferred capabilities preserve their prerequisites; (6) malformed output remains incomplete; (7) launch manifests match pinned/generated instruction and skill hashes, and workers cannot modify or replace their read-only context files; (8) conflicting parent/global instructions and runtime mirrors are excluded, and an unexpected source or resume-time hash change blocks the assignment.
- **Verification:** Catalog equality, upstream validator receipts where applicable, and bounded invocation contract tests for both native clients. Exact native execution proof follows U4/U8.

### U4. Adapt native sessions and persistent peer communication

- **Goal:** Launch separate scoped sessions and deliver task-linked communication with observable identity and permissions.
- **Requirements:** R6-R9, R12, R15, R16, R19, R21; F2, F4; AE3, AE5, AE6, AE8, AE12, AE13; KTD3, KTD6, KTD7, KTD11.
- **Dependencies:** U2, U3.
- **Files:** `engine/packages/daemon/src/domain/runtime-adapter.ts`, Claude/Codex adapters, `engine/packages/daemon/src/adapters/kernel-authority.ts`, `engine/packages/daemon/src/adapters/yolo-mode.ts`, `engine/packages/daemon/src/adapters/tmux-server.ts`, existing chat repository/routes; `engine/packages/daemon/src/adapters/worker-launch.ts`, `engine/packages/daemon/src/domain/mailbox-delivery.ts`, `engine/packages/daemon/src/domain/native-approval-bridge.ts` (new); tests `engine/packages/daemon/test/managed-native-policy.test.ts`, `engine/packages/daemon/test/worker-control-isolation.test.ts`, `engine/packages/daemon/test/team-messaging.test.ts`, `engine/packages/daemon/test/native-session-contract.test.ts` (new), plus existing adapter tests.
- **Approach:** Launch every coding session through the restricted worker boundary established in U1. Verify actual UID, mounts, effective policy, native session identity, loaded-context manifest and readiness on fresh launch and resume. Do not inherit broad access or owner credentials. Extend the existing chat API with addressed mailbox polling and consumption receipts; workers poll at safe tool boundaries and bounded waiting steps. Never submit peer text or Enter to a terminal. Structured wake/resume is allowed only where the selected client contract is verified; otherwise preserve queued messages and expose the pending state. Native approval requests use a separate verified channel, never mailbox content.
- **Test scenarios:** (1) fresh/resumed clients keep distinct identities/configuration and the expected pinned instruction manifest; (2) login/trust/update/permission prompts are not mistaken for readiness; (3) actual native shell and test subprocesses fail owner-token reads, database/WAL mutation, supervisor-socket access and owner-pane injection while an allowed edit succeeds; (4) inherited bypass flags cannot relax launch policy; (5) personal configuration remains byte-identical; (6) duplicate/reconnected mailbox delivery produces one stored message and idempotent consumption; (7) a message containing prompt-answer text, newlines or terminal control sequences during a permission prompt causes no terminal input or approval, remains pending, and is later consumed as data; (8) prompt-state changes between observation and delivery never fall back to terminal submission; (9) cross-task attachments, unexpected parent/global instructions and owner secrets remain inaccessible; (10) all isolation checks repeat after resume.
- **Verification:** Run adapter, isolation, manifest and mailbox tests. Native probes use both installed clients and observe actual filesystem/database/socket outcomes, not only mocked launch flags. Verify pending-message persistence and later safe consumption without owner relay. No broader live trial before these gates pass; a client unable to meet the interaction contract remains blocked.

### U5. Enforce dependencies, isolated changes, and independent review

- **Goal:** Coordinate implementation and bounded review/rework against the same approved candidate.
- **Requirements:** R4-R6, R10, R11, R16-R18, R21, R22; F2, F3; AE2-AE5, AE9-AE11, AE13; KTD4, KTD8, KTD9.
- **Dependencies:** U3, U4.
- **Files:** `engine/packages/daemon/src/domain/workflow-runtime.ts`, queue repository/pickup/recovery; `engine/packages/daemon/src/domain/team-workspace.ts`, `engine/packages/daemon/src/domain/review-evidence.ts` (new); tests `engine/packages/daemon/test/team-dependencies.test.ts`, `engine/packages/daemon/test/team-workspace.test.ts`, `engine/packages/daemon/test/team-review-cycle.test.ts` (new).
- **Approach:** Reject cyclic dependencies and conflicting write ownership before launch. Use worktrees where an approved baseline exists, otherwise declared snapshot isolation. Stage candidate changes without modifying unrelated files or merging branches. Bind reviewer output to the candidate digest and separate reviewer identity. Require verified prerequisite outputs rather than task completion text. Persist retry/review counters and return exhausted work to the owner.
- **Test scenarios:** (1) failed/denied/canceled prerequisites never unlock consumers; (2) handed-off work unlocks nothing until its referenced successor completes with validated evidence; (3) overlapping writes and escaping symlinks are rejected; (4) unborn repositories use snapshot evidence without commits; (5) reviewers see the exact candidate including untracked files and cannot write it; (6) post-review changes invalidate review; (7) defects cause bounded rework and counters survive restart; (8) integrated failure prevents delivery despite successful process exits.
- **Verification:** Dependency, snapshot/worktree and review-state tests, plus source-bound candidate/evidence checks. Inspect original dirty-worktree hashes before and after.

### U6. Add observable team views and owner controls to the TUI

- **Goal:** Make task state and essential intervention usable in the terminal without replacing the lead's native conversation, carrying the same information as the reference-benchmark Web UI.
- **Requirements:** R9, R12-R14, R16; F4; AE5-AE7, AE10, AE12; KTD4-KTD6, KTD15, KTD16; PC1-PC4.
- **Dependencies:** U2, U4, U5, U9, U10.
- **Files:** `engine/packages/tui/src/daemon-client.ts`, `engine/packages/tui/src/input.ts`, `engine/packages/tui/src/state.ts`, `engine/packages/tui/src/live-events.ts`, `engine/packages/tui/src/render.ts`, `engine/packages/tui/src/attention/attention-model.ts`, `engine/packages/tui/src/terminals/terminal-model.ts`, `engine/packages/tui/package.json`; tests `engine/packages/tui/test/team-controls.test.ts`, `engine/packages/tui/test/team-projection.test.ts`, `engine/packages/tui/test/team-language.test.ts` (new), existing event/input/action tests.
- **Approach:** Provide the reference regions as panels: run stepper, task list with all states and evidence-based progress, task detail, pending decisions, agent and system status, recent activity, and task/attempt logs. Logs show stream/source, timestamps, redaction, truncation and reconnect gaps. Render messages, logs and errors as inert text, never executing terminal escape sequences. The TUI holds the owner credential, runs outside agent tmux, starts the owner terminal host, and mints one-time browser pairing codes. Controls use shared typed contracts and show target and scope before confirmation. Add a language key, read-only session views, and a take-over key that opens the audited take-over. Display requested versus observed cancellation, stale data, unknown metrics and pending native decisions. Rehydrate and deduplicate durable events; hide unsupported native approval controls.
- **Test scenarios:** (1) approve/reject binds the displayed version and only an owner control credential; (2) double input, reconnect and lost acknowledgements do not duplicate actions; (3) resize and mixed Chinese/English text keep columns aligned and the selection intact; (4) stale data disables misleading controls; (5) unknown usage is not zero; (6) a failing native command appears with its task/attempt, stderr and exit outcome; (7) redacted/truncated logs and reconnect gaps are visible without executing control sequences; (8) 1,000 events produce the correct final projection within the local visibility target; (9) worker-side tmux access cannot reach or type into the owner TUI; (10) the language switch changes labels immediately and keeps state codes, identifiers and agent text unchanged; (11) a pairing code expires after 60 seconds and works once; (12) session view input is ignored until take-over, and take-over start and end are audited.
- **Verification:** TUI unit/projection tests, input transcripts, and a real terminal acceptance run at two window sizes in both languages. Screenshots or recordings supplement daemon receipts rather than replace them.

### U7. Make cancellation, restart, and data rollback reliable

- **Goal:** Recover durable coordination without duplicate work or false termination claims.
- **Requirements:** R5, R9-R15, R21, R22; F4; AE4, AE6-AE9, AE13; KTD4-KTD9.
- **Dependencies:** U4-U6.
- **Files:** `engine/packages/daemon/src/domain/rig-teardown.ts`, `engine/packages/daemon/src/domain/queue-recovery.ts`, `engine/packages/daemon/src/daemon-shutdown.ts`, existing session identity owners; `engine/packages/daemon/src/domain/team-reconciliation.ts` (new); tests `engine/packages/daemon/test/team-recovery.test.ts`, `engine/packages/daemon/test/team-cancellation.test.ts` (new); `docs/operations.md`.
- **Approach:** Persist control intent before process effects. Fence attempts by generation, check process lineage, and reuse existing teardown without data deletion. On startup reconcile unknown outcomes and pending approvals before enabling dispatch. Use the existing migration runner with a consistent SQLite backup taken while dispatch is quiesced; do not copy only a live database file while ignoring its WAL.
- **Test scenarios:** (1) crash around dispatch/acknowledgement never repeats an ambiguous action; (2) restart finds an active session without duplicating it; (3) PID/pane reuse produces an identity blocker; (4) cancellation closes dispatch and reports resistant children as unresolved; (5) rejected approval, stale plan, mailbox state and worker isolation persist through resume; (6) disk-full/corrupt state preserves evidence and blocks dispatch; (7) a matching binary/database backup restores with external receipts reconciled; (8) no-progress differs from a supervised silent tool within its deadline; (9) retries/restarts cannot reset the cumulative 60-minute run budget or mint a new authorization, and workers hit their recorded deadline even while the daemon is unavailable.
- **Verification:** Fault-injection integration tests and opt-in real-process restart/cancel drills. Record all owned and unrelated sessions before/after; unrelated tmux, Docker and workstation processes must remain untouched.

### U9. Secure the browser and terminal owner surfaces

- **Goal:** Let an owner browser and the owner terminal act safely on loopback, with no URL credentials, read-only agent session views and an isolated owner shell.
- **Requirements:** R12-R14, R19, R21, R22; F4; AE6, AE13; KTD6, KTD14, KTD16, KTD18; PC1, PC4, PC5.
- **Dependencies:** U2, U4.
- **Files:** `engine/packages/daemon/src/routes/owner-session.ts`, `engine/packages/daemon/src/domain/owner-session.ts`, `engine/packages/daemon/src/domain/terminal-takeover.ts`, `engine/packages/daemon/src/terminal/owner-terminal-host.ts` (new); `engine/packages/daemon/src/server.ts`, `engine/packages/daemon/src/middleware/browser-boundary.ts`, `engine/packages/daemon/src/routes/terminal-ws.ts`, `engine/packages/daemon/src/terminal/TerminalSessionBroker.ts`, `engine/packages/daemon/src/db/migrations/105_owner_sessions.ts` (new), `engine/packages/daemon/src/db/all-migrations.ts`; tests `engine/packages/daemon/test/owner-session.test.ts`, `engine/packages/daemon/test/terminal-takeover.test.ts`, `engine/packages/daemon/test/owner-terminal-host.test.ts` (new).
- **Approach:** Implement the pairing exchange, session cookie, anti-forgery token, expiry and revocation from KTD14 behind the existing browser boundary. Turn off query-string tokens for managed-run routes. Bind the listener to loopback. Make terminal streaming read-only unless an owner take-over record is active for that session. The owner terminal host runs under the owner account on its own tmux socket; the daemon relays only authenticated bytes to it and never spawns a shell itself. Disable owner terminal and take-over for non-loopback clients.
- **Test scenarios:** (1) a valid one-time code yields a session once, and reuse or expiry is denied; (2) a mutating request or WebSocket upgrade without the anti-forgery token is denied; (3) a cross-origin page cannot read state or send controls; (4) a `?token=` URL is rejected for managed-run routes; (5) idle and absolute expiry and TUI revocation end the session within one request; (6) input to an agent session without take-over is rejected and audited; (7) take-over ends on release, disconnect, revocation or 15 minutes without input; (8) owner terminal requests fail with "unavailable" when the host is not running, and no shell starts under the control or worker identity; (9) a worker process cannot mint a pairing code, read the session store or reach the owner terminal socket; (10) a non-loopback Host is refused.
- **Verification:** Route and middleware tests, real-process identity checks for the owner terminal host, and a browser check that pairing works from the Windows host through WSL localhost forwarding.

### U10. Share the Chinese/English interface catalog

- **Goal:** Give both clients one language catalog with Chinese as default and runtime switching.
- **Requirements:** R12; KTD15; PC2.
- **Dependencies:** U1.
- **Files:** `engine/packages/i18n/package.json`, `engine/packages/i18n/src/index.ts`, `engine/packages/i18n/src/catalogs/zh-CN.json`, `engine/packages/i18n/src/catalogs/en.json`, `engine/packages/i18n/src/display-width.ts` (new); `engine/package.json` (workspace entry); tests `engine/packages/i18n/test/catalog-parity.test.ts`, `engine/packages/i18n/test/display-width.test.ts` (new).
- **Approach:** Create a small workspace package that owns message keys, both catalogs, the status-code-to-label map, interpolation and display-width measurement. Clients import it; neither keeps its own string table for managed-run views. Persist the owner's choice in owner client configuration. Missing keys fall back to the other language and fail parity tests.
- **Test scenarios:** (1) every key exists in both catalogs with the same interpolation variables; (2) an unknown status code renders the raw code; (3) switching language does not change stored codes or event payloads; (4) display width counts Chinese characters as two columns and handles emoji and combining marks; (5) a missing translation falls back and is reported by the parity test.
- **Verification:** Package tests plus consumption tests in U6 and U11.

### U11. Build the reference-benchmark Web UI

- **Goal:** Deliver the owner Web UI with the layout and visual language of `docs/Rendering.png`, driven by durable state and owner controls.
- **Requirements:** R9, R12-R16, R18; F2-F4; AE5-AE7, AE9, AE10, AE12; KTD2, KTD13-KTD16; PC1-PC4, PC6.
- **Dependencies:** U2, U5, U9, U10.
- **Files:** `engine/packages/ui/src/routes.tsx`, `engine/packages/ui/src/App.tsx`, `engine/packages/ui/src/globals.css`, `engine/packages/ui/tailwind.config.ts`, `engine/packages/ui/src/lib/theme.ts`, `engine/packages/ui/src/lib/status-colors.ts`, `engine/packages/ui/package.json`; new `engine/packages/ui/src/team/` (shell, overview, run stepper, task list, task detail, decision card and dialog, agent status, system status, activity, bottom panel, settings language section) and `engine/packages/ui/src/hooks/useTeamRun.ts`, `useTeamEvents.ts`, `useOwnerSession.ts`; tests `engine/packages/ui/src/team/__tests__/overview.test.tsx`, `task-detail.test.tsx`, `decisions.test.tsx`, `responsive.test.tsx` (new).
- **Approach:**
  - Replace the theme with reference-derived tokens.
  - Add the managed-run navigation shell and the regions in "Web UI and TUI Experience".
  - Give each navigation item a page. Overview; Task management (list and detail, with editing added by U12); Agent monitor (agent status and read-only session views); Review & decisions (pending decisions and review records); Logs (task- and attempt-scoped logs); Settings (language and paired browser sessions). U12 adds the Workspace and Knowledge pages.
  - Reuse the existing primitives and terminal components.
  - Hydrate from durable state, then apply deduplicated live events.
  - Controls show target and scope, then send the versioned owner-control envelope, and show "requested" until the daemon reports the outcome.
  - Task progress comes from verified acceptance criteria; estimates appear only as labeled Lead estimates.
  - The decision dialog shows the requester, action, affected files, plan digest and request version.
  - Add the language toggle in the top bar and in Settings.
  - Implement the three responsive layouts.
- **Test scenarios:**
  - (1) The overview renders every reference region from a fixture run in both languages.
  - (2) All queue states appear under their filters.
  - (3) Progress for a task with 3 of 4 verified criteria shows 3/4, regardless of agent claims.
  - (4) Approve in a stale view is disabled, and a version conflict re-renders and asks again.
  - (5) A double click sends one control.
  - (6) The delivery stage shows "awaiting delivery decision" when every earlier stage is complete.
  - (7) A native request without a verified channel offers "open session" and no approve button.
  - (8) An unknown cost displays as unknown, not zero.
  - (9) A daemon disconnect shows the banner and disables controls.
  - (10) Keyboard-only navigation reaches every control and dialogs restore focus.
  - (11) Reduced motion disables animations.
  - (12) At 390 px the single-column layout hides the owner terminal.
- **Verification:**
  - Component tests under the existing jsdom setup.
  - Real-browser checks at 1440, 1024 and 390 px in both languages against a fixture run and a live run.
  - A side-by-side comparison with `docs/Rendering.png` that records each adaptation listed in the plan.

### U12. Add workspace, knowledge and task-editing views

- **Goal:** Let the owner browse the target repository and plans read-only and edit tasks within plan authority.
- **Requirements:** R4, R5, R12, R16, R21, R22; AE4, AE13; KTD5, KTD17; PC5.
- **Dependencies:** U3, U5, U11.
- **Files:** `engine/packages/daemon/src/routes/files.ts`, `engine/packages/daemon/src/routes/workspace.ts`, `engine/packages/daemon/src/domain/task-edit.ts` (new), `engine/packages/daemon/src/routes/team-control.ts`; `engine/packages/ui/src/team/workspace/`, `engine/packages/ui/src/team/knowledge/`, `engine/packages/ui/src/team/task-edit/` (new); tests `engine/packages/daemon/test/task-edit.test.ts`, `engine/packages/daemon/test/workspace-scope.test.ts`, `engine/packages/ui/src/team/__tests__/task-edit.test.tsx` (new).
- **Approach:** Workspace browsing is read-only and limited to the registered target repository, its candidate snapshots and diffs; canonical paths and symlink resolution prevent escape. The knowledge view reads plans, requirements and solution documents of the registered target and the orchestrator's `docs/`, rendered as inert Markdown. Task editing classifies each edit per KTD17 on the daemon side. Scope-changing edits create a plan-change request and show the affected tasks that will pause.
- **Test scenarios:** (1) path traversal and symlink escapes outside the target are refused; (2) files matching the credential exclusion list of the worker sandbox policy are not served; (3) a priority or notes edit applies with a version check; (4) adding a task or changing acceptance criteria returns `plan-change-required` and suspends the affected work; (5) a cycle-creating dependency edit is rejected; (6) an agent credential cannot edit tasks; (7) Markdown with embedded HTML or scripts renders inert.
- **Verification:** Daemon route tests, UI component tests, and a browser check that an edit's classification and suspension are visible.

### U8. Prove the complete local workflow and document delivery

- **Goal:** Prove the complete local workflow on a separately scoped demo and fulfill the original same-task candidate-comparison criterion.
- **Requirements:** R1-R22; F1-F4; AE1-AE13; Product Contract Success Criteria, including candidate comparison; KTD1-KTD18; PC1-PC6.
- **Dependencies:** U1-U7, U9-U12.
- **Files:** Orchestrator target `ronronner02/multi-agent`: `engine/test/team-e2e.test.mjs`, `engine/test/candidate-comparison.test.mjs`, `engine/test/fixtures/team-failure-cases/` (new), `docs/validation/first-team.md`, `docs/validation/candidate-comparison.md`, `docs/development.md`, `docs/operations.md`. Separate local target `work-board`: `package.json`, `src/server.ts`, `src/client.ts`, `test/api.test.ts`, `test/client.test.ts` and its data/schema setup (new). Demo paths are relative to that repository, not to `engine/`; runtime data is excluded from source manifests.
- **Approach:** Register the separate demo and create only the frozen list-only seed described in Demo Ownership. Through the product, agree the feature plan before agent dispatch: `GET /items` filters `status=open|done`; `PATCH /items/:id` changes status; invalid input returns 400, missing items return 404, and updates survive restart. Agents implement those additions and tests. Run the complete primary workflow with Claude implementing and Codex reviewing, then the specified reverse-pairing native contracts. Run the same frozen feature task through pinned ReevesAgents under matching protections and record the comparative outcomes; do not integrate a second production engine. Hash baseline/candidates, keep each run separately authorized, and never create commits or remote repositories implicitly.
- **Test scenarios:** (1) no feature work precedes an approved plan; (2) seed provenance proves the requested feature was absent; (3) both clients load only the recorded context and cannot access orchestrator source/control state; (4) primary implementation/review produces a usable UI/API with persistent updates; (5) a planted defect receives bounded repair; (6) plan drift, direct control-access attempts, prompt-active messages, rejection, cancellation and restart exercise real gates; (7) reverse pairing runs the defined native-contract subset, not an unspecified second full task; (8) integrated failure prevents acceptance; (9) both candidate attempts use the same frozen seed/task and disclose configuration differences, adaptation, interventions, failure/recovery and available time/cost; (10) no report substitutes an unattempted comparison or a manual baseline for the required engine comparison; (11) the owner monitors and controls the primary run from both the Web UI and the TUI in both languages, including pairing, a decision, cancellation, Lead discussion through take-over, a read-only workspace diff, and a task edit that triggers re-approval.
- **Verification:** Run final adapted regressions and the opt-in end-to-end/comparison harnesses against explicitly registered demo roots. The owner exercises filtering, completion, restart persistence, logs and control actions in the demo, and the Web UI and TUI flows in scenario (11). Require source-bound primary acceptance, reverse-contract results, and a comparative report with observed results or evidenced blocked scenarios for each candidate. Record unavailable measurements and avoid productivity claims unsupported by a measured baseline. The optional manual baseline is additional evidence only.

## Verification Contract

### Proof Authority and Required Coverage

Product Contract confirmation is **inherited** from the owner's requirements decisions; the implementation direction is **confirmed** by the owner's selection in this conversation. The plan was authored and checked in one session. This is not independent implementation review or runtime acceptance.

| Proof intent | Status | Required evidence and owner |
|---|---|---|
| Scope, framework routing, plan/task freshness | required | U2/U3/U8 contract cases and live plan approval; covers AE1-AE4 |
| Distinct native clients and addressed collaboration | required | U4/U8 actual client receipts, persistent mailboxes, no input during pending native prompts, later safe consumption and specified reverse-pairing contracts; covers AE3, AE5, AE12 |
| Rejection, permission separation, context boundaries | required | U1/U2/U3/U4/U5 actual worker token/database/WAL/socket/owner-pane attacks, denied native actions, loaded-context manifest checks and workspace comparisons; covers AE6, AE11, AE13 |
| Independent review and integrated acceptance | required | U5/U8 exact candidate diff/digests, separate reviewer outcome and user-flow results; covers AE9-AE10 |
| Cancellation and restart, including ambiguity | required | U7/U8 observed process outcomes and fault-injection receipts; covers AE4, AE6-AE8 |
| Reproducible build and persistence rollback | required | U1/U7 canonical WSL source/transfer hashes, clean build, schema fixtures, paired binary/database restore and preserved Windows source |
| TUI interaction and event latency | required | U6/U8 owner-only control, task/attempt logs/errors, redaction/truncation, reconnect behavior, replay timing and durable state comparison |
| Web UI against the reference benchmark | required | U11/U12/U8 component tests, real-browser runs at 1440/1024/390 px in both languages, the recorded comparison with `docs/Rendering.png`, and live-run owner flows |
| Browser session and owner terminal safety | required | U9 pairing/forgery/expiry/revocation tests, read-only session default, audited take-over, owner terminal host identity, loopback-only refusal, and worker attempts against session store and owner terminal socket |
| Language switching | required | U10 catalog parity and width tests; U6/U11 runtime switching without changing stored codes or agent text |
| Bounded task editing | required | U12 edit classification, re-approval suspension, cycle rejection and agent denial |
| Remote phone access through a domain | deferred | Milestone 2 (KTD18); this milestone proves only loopback refusal of non-local hosts and the responsive layout |
| Same-task candidate-engine comparison | required | U8 frozen seed/task, OpenRig and pinned ReevesAgents attempts, adaptation/intervention/failure/recovery records, available timing/cost and configuration differences; fulfills Product Contract Success Criteria |
| All optional workflows and remote-node execution | deferred | Owner selects subsequent milestones and supplies appropriate hosts/integrations; no current compatibility claim |
| Publication, deployment, hostile-administrator containment | not applicable | Outside this local milestone. Managed worker isolation is required above; this exclusion applies only to host administrators/kernel compromise |

### Commands and Evidence Binding

Commands here describe execution-time checks; none has been run as part of planning. Engine commands run from `engine/` in the authoritative WSL checkout. U8 invokes the registered demo repository's API/client tests in that repository, never by searching the orchestrator's ancestry. Offline baseline/manifest/process checks must not contact providers; live client and comparison probes are explicit opt-in runs with their own grants.

- `npm ci`, `npm run build`, `npm run lint`, `npm test`, and `npm run test:ui` establish the retained baseline and final regression state. `npm run test:ui` now covers the active managed-run Web UI as well as retained upstream pages; U10 adds the language package to the workspace test set.
- Real-browser checks run through the browser-testing workflow or an equivalent harness against the loopback daemon. Absence of a browser capability limits the UI claim and is recorded; it is not a pass.
- Run changed Vitest files through the relevant workspace test script, for example `npm run test -w packages/daemon -- test/team-governance.test.ts` and `npm run test -w packages/tui -- test/team-controls.test.ts`.
- Node verification includes the baseline, worker-isolation preflight, team end-to-end and candidate-comparison harnesses named in U1/U8. Their live-client branches are opt-in; default/offline execution must not start provider sessions or spend quota. U1 documents the concrete harness invocations once those files exist.
- U1 must verify these commands against the actual imported manifests before use. Any adapted script contract is documented with its source change; a missing script is not a passing check. There is no assumed `release:validate` command or publication gate in this baseline.

Every result records the executed command or interaction, environment/client versions, source commit or source-manifest digest, plan digest, run/task/attempt identity, exit/outcome, and redacted evidence path. A fixture pass is source-bound offline evidence; a native launch receipt is provider/process evidence. Neither alone proves end-to-end acceptance on the final candidate. Re-run affected gates whenever source, policy, CLI version, configuration, or candidate changes.

Before declaring the milestone complete, reconcile every required proof intent against an actual result. Missing, skipped, stale, or ambiguous required proof prevents a verified/complete claim. Any deviation requires owner resolution, not relabeling a failed requirement as deferred. Persistent P0/P1 defects in authority, data preservation, termination or integrated functionality block delivery.

### Local Rollout and Rollback

U1 first proves host/client isolation feasibility and establishes a hash-verified WSL development baseline. U2-U7 and U9-U12 keep automatic managed dispatch disabled until their gates pass. The Web UI stays off (`webUiEnabled` false) until U9's session gates pass, and it binds to loopback only throughout this milestone. U8 enables one separately registered target repository per authorized run and collects the required comparison evidence. The observation window includes the complete primary task, targeted reverse contracts and restart/cancel drills, not merely successful startup.

On unauthorized action, configuration corruption, lost evidence, duplicate work, or uncontained cancellation: close dispatch, preserve diagnostics, stop only confirmed owned processes, and return control to the owner. Restore the previous binary/database pair after reconciliation. Files or external actions produced by agents are not undone by restoring SQLite; preserve them for explicit comparison and recovery. Do not reset user worktrees, discard patches, or erase history to make a check green.

The application owner operates the local runbook. No CI workflow is activated remotely and no artifact is published by this plan. Commit, push, PR, merge, release and deployment remain separately scoped decisions.

## Definition of Done

- U1-U12 meet their stated goals, test scenarios, and verification gates at the final source revision; progress and execution receipts are tracked outside this plan.
- The owner Web UI reproduces the reference rendering's layout and visual language with the recorded adaptations, and both clients show the same run state in Chinese and English. Browsers authenticate only by paired session, agent session views are read-only unless an audited take-over is active, the owner terminal runs only under the owner account, and task edits that change scope pause work until re-approval.
- The Product Contract remains the requirements authority, and every managed assignment/review is traceable to an owner-approved plan and exact candidate.
- The separate work-board repository has a frozen list-only seed and an agent-produced feature that passes owner-visible acceptance. The primary pairing completes the task; the reverse pairing passes the explicitly scoped native contracts. Neither worker instructions nor writable mounts expose the orchestrator repository.
- Real managed processes fail owner-token reads, database/WAL/shared-memory mutation, supervisor-socket access and owner-pane injection on fresh launch and resume. Pending-prompt peer messages cause no approval or terminal submission. Rejection, stale plans, recovery, configuration preservation and unrelated-work preservation have observed negative-case evidence.
- The full pinned catalog and effective instruction/skill manifests are accounted for without unintended ancestor/global content, unsupported compatibility claims, or duplicate framework semantics. Both owner clients expose task/attempt logs and errors as well as messages and owner decisions.
- The WSL checkout is the sole development source after a verified cutover; test evidence binds its hashes, and requested Windows exports preserve external edits.
- The same-task OpenRig/ReevesAgents comparison report includes observed attempts, adaptation effort, interventions, failures, recovery, timing/cost where available, and limitations. A manual baseline or source-only screen does not satisfy this criterion.
- Required-proof reconciliation has no unexplained gaps and no unresolved delivery-blocking defects. Unknown metrics, unsupported actions, remaining risks and unperformed publication steps are stated accurately.
- Upstream provenance, applicable licenses/notices, reproducible build instructions, local operations/rollback guidance and evidence references are present. No abandoned experiments, unused replacement schedulers, accidental credentials, or generated personal runtime files remain in the delivery diff.
- The owner receives the local candidate, its review and acceptance evidence, and an explicit next delivery decision. Nothing is committed, pushed, merged, released or deployed without the corresponding authorization.
