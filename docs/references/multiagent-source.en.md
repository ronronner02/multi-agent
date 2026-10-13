# spec-first Multi-Agent Team: Requirements and Provisional Technology Selection

> Document status: Research phase / provisional proposal  
> Updated: 2026-10-13  
> Objective: First clarify requirements, architectural boundaries, and open-source project selection, then conduct small-scale validation. Large-scale development has not yet begun and is not in scope at this stage.

## 1. Project Goal

Build a multi-agent collaboration team that uses the existing **spec-first** project as its shared foundation for engineering standards and task management. Claude Code, Codex CLI, Pi, DSH, and other tools should continue running in their native CLIs, while a separate, capable model acts as the lead agent to break down goals, assign tasks, coordinate collaboration, track progress, and consolidate results.

The user wants a terminal TUI dashboard to view the team's overall activity, including each agent's status, task progress, inter-agent communication, execution logs, errors, and acceptance results. The first phase focuses on running locally on Windows, with Mac and VPS support added later.

## 2. Core Requirements

### 2.1 Lead Agent and Role Assignment

- Configure a separate, capable model as the lead agent / orchestrator.
- The lead agent is responsible for understanding goals, breaking down tasks, assigning owners, handling dependencies, tracking blockers, coordinating conflicts, and consolidating results.
- Other agents take clearly defined roles, such as requirements analysis, architecture design, implementation, testing, code review, documentation, and research.
- Agent responsibilities must be configurable rather than permanently tied to a particular model or CLI.
- Both the lead agent and execution agents should retain their own session context, with support for resuming tasks or changing owners when needed.

### 2.2 Native CLI Execution

- Claude Code, Codex CLI, Pi, DSH, and similar tools should continue running in their native CLIs / sessions wherever practical.
- There is no requirement to rewrite all agents using a single agent SDK.
- Validate each CLI's startup, input handling, output capture, exit status, session recovery, permission prompts, and structured event interfaces.
- Being able to run in a terminal does not establish that an external team system can schedule it reliably. Each CLI must be verified individually.
- Start with a minimal end-to-end workflow using Claude Code and Codex, then verify compatibility with Pi and DSH.

### 2.3 Inter-Agent Communication

- Agents can send messages to other agents, ask questions, hand off tasks, and report blockers.
- Support direct messages, broadcasts from the lead agent, and task handoffs.
- Messages should be associated with a project, task ID, sender, recipient, timestamp, status, and relevant artifacts.
- Important messages and decisions must be traceable rather than existing only in easily lost terminal scrollback.
- Decide whether communication uses SQLite, file-based messages, MCP, an event bus, or another mechanism, and verify persistence, concurrency, and cross-machine capabilities.

### 2.4 TUI Dashboard and Observability

The primary interface is a terminal TUI, rather than only a web or desktop GUI.

The dashboard should show:

- Team and individual agent states: online, running, waiting, blocked, failed, and completed.
- Tasks, owners, dependencies, priorities, progress, and acceptance results.
- Inter-agent message streams, task handoffs, and important decisions.
- Live output or searchable logs for each CLI.
- Errors, retries, operations awaiting human approval, and recovery information.
- Git branches / worktrees, changed files, test results, and commit history.
- Token usage and cost statistics, where the underlying CLI or model interface provides reliable data.

Dashboard state must come from actual execution events and persisted records, not solely from the lead agent's natural-language account.

### 2.5 spec-first Integration

Existing repository: <https://github.com/leo-kuang-ai/spec-first>

spec-first remains the shared foundation for engineering standards and workflows, maintaining requirements, Spec, Plan, Task, Review, Knowledge, and verification evidence within the project. The external orchestration layer runs agents, handles messaging, assigns tasks, and displays status. It must not duplicate the requirements-management system.

Integration requirements:

- Every team task can reference the corresponding spec-first Spec / Plan / Task and acceptance criteria.
- Task states, including started, blocked, completed, reviewed, and verified, can be written back to or associated with existing artifacts.
- Preserve the executor, reviewer, timestamps, related Git changes, test output, and outcome evidence.
- Preserve human confirmation and approval boundaries.
- Project standards, task evidence, and knowledge should remain within the spec-first workflow even if the scheduler or dashboard is replaced.
- Actual commands, directory structures, state fields, and extension interfaces must follow the current repository implementation. Inspect code and documentation before implementation; do not assume unverified interfaces exist.

### 2.6 Cross-Machine Expansion

- Phase one: Run locally on Windows.
- Later: Add Mac and Linux VPS execution nodes.
- Future requirements include node registration, authentication, project path mapping, Git synchronization, worktree isolation, reconnection, task recovery, permissions, and centralized logs.
- Avoid introducing complex distributed infrastructure in phase one. Validate the single-machine collaboration workflow first.

## 3. Architectural Principles

1. **Separate standards from execution:** spec-first owns engineering standards and evidence; the scheduler owns runtime execution, messaging, and state.
2. **Prefer native CLIs:** Preserve the working patterns of Claude Code, Codex, Pi, and DSH wherever practical.
3. **Use a single source of truth for task state:** Define the authoritative state of each task so that spec-first, the scheduler, and the dashboard do not maintain contradictory versions.
4. **Make messages traceable:** Persist important messages, decisions, handoffs, and failure records.
5. **Keep humans in control:** Retain configurable approval for dangerous operations, privilege escalation, deployments, and important decisions.
6. **Prefer adapters:** Build thin adapters for each CLI to isolate differences in commands, event formats, and session recovery.
7. **Implement incrementally:** Use a minimal team to validate task creation, assignment, communication, execution, review, and acceptance before adding more machines and CLIs.
8. **Avoid duplicate development:** Reuse existing open-source projects first. Add custom functionality only when hands-on testing identifies a clear gap.

## 4. Provisional Open-Source Project Selection

### 4.1 First Candidate: Squad

Repository: <https://github.com/mco-org/squad>

**Proposed role:** A candidate for lightweight team collaboration, messaging, and task handoffs in the first phase.

**Reasons for considering it:**

- It targets collaboration and task assignment among multiple coding agents.
- Public materials mention SQLite storage for collaboration state and messages.
- Installation options include a prebuilt Windows binary, making it a candidate for an initial local proof of concept.
- It may be relatively straightforward to connect to the existing spec-first workflow through task references, command invocation, or thin adapters.

**Items to verify:**

- Whether it provides the required terminal-only TUI experience.
- Whether the lead agent can use a user-selected, separate model and native CLI.
- Actual support for Claude Code, Codex, Pi, and DSH, especially Pi and DSH.
- Whether messaging supports full two-way communication, broadcasts, history queries, failure retries, and task recovery.
- Whether the SQLite / messaging mechanism can support future cross-machine expansion or is limited to a single machine.
- Whether spec-first integration requires modifying Squad or only adding an adapter.

**Important limitation:** Squad is not a confirmed infrastructure choice. It is the first candidate for validating collaboration mechanisms. Replace it if its TUI or CLI coverage does not meet the requirements.

### 4.2 Primary TUI Candidate: multiagents

Repository: <https://github.com/zetbrush/multiagents>

**Proposed role:** Evaluate its TUI, messaging, planning, shared knowledge, task review, and statistics. If needed, consider it as a replacement for Squad, rather than assuming both should run together.

**Reasons for considering it:**

- Public materials describe a terminal dashboard with agent states, live messaging, task plans, shared knowledge, file ownership, and execution statistics.
- Its feature coverage appears closer to the team's monitoring needs than a basic CLI launcher.

**Items to verify:**

- Whether orchestration depends on Claude Desktop, and whether a separate model running through a CLI can act as the lead instead.
- Actual compatibility with Claude Code, Codex, Pi, and DSH, including how each CLI is driven.
- Whether it provides reliable task-state persistence, session recovery, and queryable events.
- Its automatic-approval behavior and permission boundaries, including whether these can be configured safely per task.
- How spec-first task references, acceptance criteria, and evidence would be integrated.

### 4.3 Other Comparison Candidates

#### Agent Dashboard

Repository: <https://github.com/dustinblack/agent-dashboard>

Useful for studying native CLI session management, live terminal output, and multi-host execution architecture. Its primary interface is a web console. Support for multiple CLIs alone does not establish that it meets the terminal-only TUI requirement. Its process-management and observability design may provide useful references.

#### Agency

Repository: <https://github.com/christag/agency>

Useful for studying agent identity, long-lived roles, memory, proposals, and decision governance. It could serve as a future role-governance layer, but should stay out of phase one unless Squad / multiagents fail to meet the corresponding requirements.

#### Runner

Repository: <https://github.com/yicheng47/runner>

Supports a lead / worker team model and multiple native CLIs, making its team organization and collaboration patterns worth examining. However, it is a desktop application, which does not meet the primary terminal-only TUI requirement. Project maturity also needs verification.

#### AgentsCommander

Repository: <https://github.com/mblua/AgentsCommander>

A reference for native terminals, multi-agent rooms, messaging, and isolated working copies. Its primary interface is a desktop UI, so it is an architectural reference or fallback rather than the first choice.

#### AgentMonitor

Repository: <https://github.com/Ericonaldo/AgentMonitor>

Focuses on a unified console, pipelines, and session management for Claude Code / Codex. It can serve as a comparison for automated development pipelines, although its CLI coverage may be insufficient.

## 5. Provisional Overall Approach

The current approach is not a final decision. Validate it in the following order:

1. **Standards layer:** Keep the existing spec-first workflow rather than building a duplicate Spec / Plan / Task system.
2. **Initial collaboration validation:** Try Squad locally on Windows to verify messaging, roles, task handoffs, and history.
3. **TUI evaluation:** Test multiagents separately to assess its terminal-monitoring experience and whether a separate model running through a CLI can act as the lead.
4. **Executor adaptation:** First validate the complete Claude Code + Codex CLI workflow, then test Pi and DSH.
5. **Custom-development boundary:** Write thin adapters or supplementary TUI views only when existing projects lack required capabilities. Do not begin by rewriting a complete scheduler.
6. **Additional nodes:** Once the single-machine workflow is stable, investigate Mac / VPS nodes, authentication, Git worktrees, disconnection recovery, and remote logs.

### Provisional Architecture Diagram

```text
                         User
                          |
                          v
           Separate model as lead agent
                    / Orchestrator
                          |
               +----------+-----------+
               |                      |
               v                      v
     Team collaboration /         spec-first
        messaging layer        Spec / Plan / Task
     (provisionally Squad)     Review / Knowledge
               |                      |
         +-----+------+               |
         |     |      |               |
         v     v      v               |
      Claude Codex  Pi / DSH           |
      Code   CLI    (unverified)       |
         |     |      |               |
         +-----+------+---------------+
                          |
                          v
           Task state, messages, and
                acceptance evidence
                          |
                          v
             Terminal TUI dashboard
        (evaluate multiagents first; reuse
          or extend a lightweight TUI
                   if necessary)
```

**Note:** This diagram describes the target architecture. It does not mean Squad already provides native integration between all components. In particular, lead-agent model invocation, the TUI dashboard, and spec-first state synchronization require hands-on verification or adapters.

## 6. Minimal Proof of Concept (PoC)

Use one real, small software task to validate the following end-to-end workflow:

1. The user submits a goal to the lead agent.
2. The lead agent creates tasks that reference requirements, plans, or acceptance criteria in spec-first.
3. The lead agent assigns implementation to Codex CLI.
4. Codex implements the task and runs tests in an independent native session.
5. Claude Code reviews the diff, test results, and acceptance criteria in an independent session.
6. Review feedback returns to Codex through the communication layer, with revisions made when needed.
7. The lead agent consolidates the results and records the commit / diff, test output, review results, and unresolved issues.
8. The TUI displays agent states, task progress, message streams, errors, and the final result.
9. Important task state and messages remain recoverable after the terminal is closed and restarted.

### PoC Acceptance Criteria

- [ ] The lead agent uses an independently configured model rather than being forced to share the identity of an execution agent.
- [ ] At least Claude Code and Codex CLI can be launched and scheduled independently through the team mechanism.
- [ ] Agents can send and receive messages associated with task IDs.
- [ ] The TUI shows actual execution state and logs.
- [ ] Tasks reference spec-first artifacts, and acceptance results are traceable.
- [ ] Failures, blockers, and failed reviews are visible rather than incorrectly marked as completed.
- [ ] Important state is persisted and recoverable after a restart.
- [ ] Dangerous operations and steps requiring human judgment retain approval mechanisms.
- [ ] The compatibility level and required adaptation work for Pi and DSH can be clearly stated.

## 7. Risks and Open Decisions

- **TUI compatibility:** The most important unresolved question is whether the collaboration candidates provide a stable, complete terminal dashboard rather than merely CLI commands.
- **Lead-agent model:** A separate model requires decisions about invocation, provider, context management, cost, and failure fallback.
- **Duplicate state:** spec-first and the scheduler may both store task state. Define the authoritative source and synchronization rules.
- **CLI compatibility:** Session recovery, structured events, approval mechanisms, and input / output interfaces vary substantially between CLIs.
- **Security:** Do not automatically approve every CLI tool invocation by default. Define permissions by role, task, and environment.
- **Multiple machines:** SQLite, local files, and machine-local paths may not be suitable for cross-host sharing. Address this separately during expansion.
- **Project maturity:** Open-source functionality, activity, and compatibility change over time. Recheck README files, releases, issues, licenses, and recent commits before implementation.

## 8. Next Actions

1. Read the latest Squad and multiagents README files, installation guides, CLI drivers, communication protocols, and TUI implementations.
2. Install and run them in a Windows test environment, keeping destructive experiments out of important project directories.
3. Use Claude Code + Codex CLI for a small task and inspect assignment, messaging, review, and state recovery.
4. Inspect the current spec-first commands, artifact directories, and extension mechanisms to identify reusable interfaces.
5. Make an explicit choice between Squad and multiagents based on hands-on results.
6. Only then decide whether to write adapters, add TUI functionality, or introduce remote nodes.

---

## 9. Reference Links

- spec-first: <https://github.com/leo-kuang-ai/spec-first>
- Squad: <https://github.com/mco-org/squad>
- multiagents: <https://github.com/zetbrush/multiagents>
- Agent Dashboard: <https://github.com/dustinblack/agent-dashboard>
- Agency: <https://github.com/christag/agency>
- Runner: <https://github.com/yicheng47/runner>
- AgentsCommander: <https://github.com/mblua/AgentsCommander>
- AgentMonitor: <https://github.com/Ericonaldo/AgentMonitor>
- dsh-cc: <https://github.com/dsh-cc/dsh-cc>
- DSH-Code: <https://github.com/UNLINEARITY/dsh-code>

## Appendix: Trailing Source Snippet

The original file ends with the following export-related snippet. It is preserved verbatim here for completeness and is not part of the project requirements.

```text
"""
path = "/mnt/data/spec-first-multi-agent-team-requirements-and-provisional-selection.md"
convert_text(md, "md", format="md", outputfile=path, extra_args=["--standalone"])
print(path)
```
