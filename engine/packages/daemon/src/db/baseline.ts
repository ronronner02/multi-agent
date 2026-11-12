import type Database from "better-sqlite3";

/** Marker written to PRAGMA user_version in the same transaction as the fresh team schema. */
export const BASELINE_VERSION = 1;

/**
 * The one-shot schema for the retained team product. The statements are kept as one SQL
 * payload so SQLite can commit the complete schema atomically.
 */
const BASELINE_SQL = String.raw`-- rigs
CREATE TABLE rigs (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    , workspace_json TEXT, archived_at TEXT, permission_policy TEXT, rig_policy_origin TEXT, rig_policy_resolved_target TEXT, rig_policy_declaring_dir TEXT, rig_policy_launch_posture TEXT, claude_managed_block_file TEXT, non_interruptive INTEGER NOT NULL DEFAULT 0 CHECK (non_interruptive IN (0, 1)), install_root TEXT, team_model_allowlist TEXT
      CHECK (team_model_allowlist IS NULL OR json_valid(team_model_allowlist)), team_kind TEXT NOT NULL DEFAULT 'project'
      CHECK (team_kind IN ('project', 'test')));
-- nodes
CREATE TABLE nodes (
      id          TEXT PRIMARY KEY,
      rig_id      TEXT NOT NULL REFERENCES rigs(id) ON DELETE CASCADE,
      logical_id  TEXT NOT NULL,
      role        TEXT,
      runtime     TEXT,
      model       TEXT,
      cwd         TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')), surface_hint TEXT, workspace TEXT, restore_policy TEXT, package_refs TEXT, pod_id TEXT REFERENCES pods(id) ON DELETE SET NULL, agent_ref TEXT, profile TEXT, label TEXT, resolved_spec_name TEXT, resolved_spec_version TEXT, resolved_spec_hash TEXT, occupant_lifecycle TEXT, continuity_outcome TEXT, handover_result TEXT, previous_occupant TEXT, handover_at TEXT, codex_config_profile TEXT, permission_policy TEXT, policy_origin TEXT, policy_resolved_target TEXT, policy_declaring_dir TEXT, policy_launch_posture TEXT, session_source_json TEXT, effort TEXT, retired_at TEXT, soul_id TEXT,
      UNIQUE(rig_id, logical_id)
    );
-- edges
CREATE TABLE edges (
      id          TEXT PRIMARY KEY,
      rig_id      TEXT NOT NULL REFERENCES rigs(id) ON DELETE CASCADE,
      source_id   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      target_id   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
-- bindings
CREATE TABLE bindings (
      id              TEXT PRIMARY KEY,
      node_id         TEXT NOT NULL UNIQUE REFERENCES nodes(id) ON DELETE CASCADE,
      tmux_session    TEXT,
      tmux_window     TEXT,
      tmux_pane       TEXT,
      cmux_workspace  TEXT,
      cmux_surface    TEXT,
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    , attachment_type TEXT NOT NULL DEFAULT 'tmux', external_session_name TEXT);
-- sessions
CREATE TABLE sessions (
      id              TEXT PRIMARY KEY,
      node_id         TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      session_name    TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'unknown',
      last_seen_at    TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    , resume_type TEXT, resume_token TEXT, restore_policy TEXT NOT NULL DEFAULT 'resume_if_possible', origin TEXT NOT NULL DEFAULT 'launched', startup_status TEXT NOT NULL DEFAULT 'pending', startup_completed_at TEXT, resume_provenance TEXT, resume_last_verified TEXT, resume_last_probe_status TEXT, resume_launch_token TEXT, resume_rotated_from TEXT, resume_rotated_process TEXT, resume_launch_process TEXT, intentionally_stopped INTEGER NOT NULL DEFAULT 0
      CHECK (intentionally_stopped IN (0, 1)));
-- events
CREATE TABLE events (
      seq         INTEGER PRIMARY KEY AUTOINCREMENT,
      -- INTENTIONALLY NOT AN FK to rigs(id).
      -- Events are an append-only history log. They must survive rig deletion
      -- so the full timeline is preserved for replay and audit.
      rig_id      TEXT,
      -- INTENTIONALLY NOT AN FK to nodes(id).
      -- Same rationale: events must survive node deletion.
      node_id     TEXT,
      type        TEXT NOT NULL,
      payload     TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
-- pods
CREATE TABLE pods (
      id                      TEXT PRIMARY KEY,
      rig_id                  TEXT NOT NULL REFERENCES rigs(id) ON DELETE CASCADE,
      label                   TEXT NOT NULL,
      summary                 TEXT,
      continuity_policy_json  TEXT,
      created_at              TEXT NOT NULL DEFAULT (datetime('now'))
    , namespace TEXT NOT NULL DEFAULT '');
-- chat_messages
CREATE TABLE chat_messages (
      id          TEXT PRIMARY KEY,
      rig_id      TEXT NOT NULL REFERENCES rigs(id) ON DELETE CASCADE,
      sender      TEXT NOT NULL,
      kind        TEXT NOT NULL DEFAULT 'message',
      body        TEXT NOT NULL DEFAULT '',
      topic       TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
-- context_usage
CREATE TABLE context_usage (
      node_id                 TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
      session_id              TEXT,
      session_name            TEXT,
      availability            TEXT NOT NULL DEFAULT 'unknown',
      reason                  TEXT,
      source                  TEXT,
      used_percentage         REAL,
      remaining_percentage    REAL,
      context_window_size     INTEGER,
      total_input_tokens      INTEGER,
      total_output_tokens     INTEGER,
      current_usage           TEXT,
      transcript_path         TEXT,
      sampled_at              TEXT,
      updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
    );
-- rig_services
CREATE TABLE rig_services (
      rig_id TEXT PRIMARY KEY REFERENCES rigs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      spec_json TEXT NOT NULL,
      rig_root TEXT NOT NULL,
      compose_file TEXT NOT NULL,
      project_name TEXT NOT NULL,
      latest_receipt_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
-- stream_items
CREATE TABLE stream_items (
      stream_item_id TEXT PRIMARY KEY,
      ts_emitted TEXT NOT NULL,
      stream_sort_key TEXT NOT NULL,
      source_session TEXT NOT NULL,
      body TEXT NOT NULL,
      format TEXT NOT NULL DEFAULT 'text',
      hint_type TEXT,
      hint_urgency TEXT,
      hint_destination TEXT,
      hint_tags TEXT,
      interrupt INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT
    , identity_provenance TEXT);
-- queue_items
CREATE TABLE queue_items (
      qitem_id TEXT PRIMARY KEY,
      ts_created TEXT NOT NULL,
      ts_updated TEXT NOT NULL,
      source_session TEXT NOT NULL,
      destination_session TEXT NOT NULL,
      state TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'routine',
      tier TEXT,
      tags TEXT,
      blocked_on TEXT,
      handed_off_to TEXT,
      handed_off_from TEXT,
      expires_at TEXT,
      chain_of_record TEXT,
      body TEXT NOT NULL,
      closure_reason TEXT,
      closure_target TEXT,
      closure_required_at TEXT,
      claimed_at TEXT,
      last_nudge_attempt TEXT,
      last_nudge_result TEXT,
      last_heartbeat TEXT,
      resolution TEXT
    , target_repo TEXT, summary TEXT, evidence_ref TEXT, minting_generation_uuid TEXT, claimed_by_generation_uuid TEXT, human_intent TEXT CHECK (human_intent IN ('decision', 'update')), human_detail TEXT, reply_to TEXT, human_questions TEXT, human_answers TEXT);
-- queue_transitions
CREATE TABLE queue_transitions (
      transition_id INTEGER PRIMARY KEY AUTOINCREMENT,
      qitem_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      state TEXT NOT NULL,
      transition_note TEXT,
      actor_session TEXT NOT NULL,
      closure_reason TEXT,
      closure_target TEXT
    , identity_provenance TEXT, owner_notification_kind TEXT, owner_notification_level TEXT);
-- inbox_entries
CREATE TABLE inbox_entries (
      inbox_id TEXT PRIMARY KEY,
      destination_session TEXT NOT NULL,
      sender_session TEXT NOT NULL,
      body TEXT NOT NULL,
      tags TEXT,
      urgency TEXT NOT NULL DEFAULT 'routine',
      ts_dropped TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      absorbed_at TEXT,
      absorbed_qitem_id TEXT,
      denied_at TEXT,
      denied_reason TEXT,
      audit_pointer TEXT
    , identity_provenance TEXT);
-- outbox_entries
CREATE TABLE outbox_entries (
      outbox_id TEXT PRIMARY KEY,
      sender_session TEXT NOT NULL,
      destination_session TEXT NOT NULL,
      body TEXT NOT NULL,
      tags TEXT,
      urgency TEXT NOT NULL DEFAULT 'routine',
      ts_dispatched TEXT NOT NULL,
      delivery_state TEXT NOT NULL DEFAULT 'pending',
      delivered_at TEXT,
      audit_pointer TEXT
    , identity_provenance TEXT, guard_binding TEXT, retired_at TEXT, retired_by TEXT, retirement_reason TEXT);
-- project_classifications
CREATE TABLE project_classifications (
      project_id TEXT PRIMARY KEY,
      stream_item_id TEXT NOT NULL UNIQUE REFERENCES stream_items(stream_item_id),
      classification_type TEXT,
      classification_urgency TEXT,
      classification_maturity TEXT,
      classification_confidence TEXT,
      classification_destination TEXT,
      action TEXT,
      classifier_session TEXT NOT NULL,
      ts_projected TEXT NOT NULL
    , area TEXT, scope_ref TEXT, duplicate_of_stream_item_id TEXT
      REFERENCES stream_items(stream_item_id), needs_human INTEGER
      CHECK (needs_human IS NULL OR needs_human IN (0, 1)), lease_id TEXT, classifier_version TEXT, taxonomy_version TEXT, candidate_set_version TEXT, identity_provenance TEXT);
-- classifier_leases
CREATE TABLE classifier_leases (
      lease_id TEXT PRIMARY KEY,
      classifier_session TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_heartbeat TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active',
      reclaimed_by_session TEXT,
      reclaim_reason TEXT
    );
-- views_custom
CREATE TABLE views_custom (
      view_id TEXT PRIMARY KEY,
      view_name TEXT NOT NULL UNIQUE,
      definition TEXT NOT NULL,
      registered_by_session TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      last_evaluated_at TEXT
    );
-- watchdog_jobs
CREATE TABLE watchdog_jobs (
      job_id TEXT PRIMARY KEY,
      policy TEXT NOT NULL,
      spec_yaml TEXT NOT NULL,
      target_session TEXT NOT NULL,
      interval_seconds INTEGER NOT NULL,
      active_wake_interval_seconds INTEGER,
      scan_interval_seconds INTEGER,
      last_evaluation_at TEXT,
      last_fire_at TEXT,
      actionable INTEGER NOT NULL DEFAULT 0,
      last_actionable_at TEXT,
      state TEXT NOT NULL DEFAULT 'active',
      registered_by_session TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      terminal_reason TEXT
    , registered_by_generation_uuid TEXT, target_generation_uuid TEXT, watched_file_path TEXT, threshold_bytes INTEGER, requires_job_id TEXT, last_fired_generation_uuid TEXT, watched_file_generation_uuid TEXT, last_fired_condition TEXT);
-- watchdog_history
CREATE TABLE watchdog_history (
      history_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES watchdog_jobs(job_id),
      evaluated_at TEXT NOT NULL,
      outcome TEXT NOT NULL,
      skip_reason TEXT,
      delivery_target_session TEXT,
      delivery_status TEXT,
      delivery_message TEXT,
      evaluation_notes TEXT
    );
-- workflow_specs
CREATE TABLE workflow_specs (
      spec_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      purpose TEXT,
      target_rig TEXT,
      roles_json TEXT NOT NULL,
      steps_json TEXT NOT NULL,
      coordination_terminal_turn_rule TEXT NOT NULL DEFAULT 'hot_potato',
      source_path TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      cached_at TEXT NOT NULL
    , status TEXT NOT NULL DEFAULT 'valid', error_message TEXT, spec_json TEXT);
-- workflow_instances
CREATE TABLE workflow_instances (
      instance_id TEXT PRIMARY KEY,
      workflow_name TEXT NOT NULL,
      workflow_version TEXT NOT NULL,
      created_by_session TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      current_frontier_json TEXT NOT NULL DEFAULT '[]',
      current_step_id TEXT,
      hop_count INTEGER NOT NULL DEFAULT 0,
      fallback_synthesis TEXT,
      last_continuation_decision_json TEXT,
      completed_at TEXT
    , version INTEGER NOT NULL DEFAULT 0, resume_count INTEGER NOT NULL DEFAULT 0, hops_baseline INTEGER NOT NULL DEFAULT 0, bound_rig TEXT, lifecycle_operation_key TEXT, compiled_input_digest TEXT, lifecycle_binding_json TEXT);
-- workflow_step_trails
CREATE TABLE workflow_step_trails (
      trail_id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL REFERENCES workflow_instances(instance_id),
      step_id TEXT NOT NULL,
      step_role TEXT NOT NULL,
      closed_at TEXT NOT NULL,
      closure_reason TEXT NOT NULL,
      closure_evidence_json TEXT,
      actor_session TEXT NOT NULL,
      next_qitem_id TEXT REFERENCES queue_items(qitem_id),
      prior_qitem_id TEXT REFERENCES queue_items(qitem_id)
    );
-- mission_control_actions
CREATE TABLE mission_control_actions (
      action_id TEXT PRIMARY KEY,
      action_verb TEXT NOT NULL,
      qitem_id TEXT REFERENCES queue_items(qitem_id),
      actor_session TEXT NOT NULL,
      acted_at TEXT NOT NULL,
      before_state_json TEXT,
      after_state_json TEXT,
      reason TEXT,
      annotation TEXT,
      notify_attempted INTEGER NOT NULL DEFAULT 0,
      notify_result TEXT,
      audit_notes_json TEXT
    , identity_provenance TEXT);
-- queue_transitions_archive
CREATE TABLE queue_transitions_archive (
      transition_id INTEGER PRIMARY KEY,
      qitem_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      state TEXT NOT NULL,
      transition_note TEXT,
      actor_session TEXT NOT NULL,
      closure_reason TEXT,
      closure_target TEXT,
      archived_at TEXT NOT NULL
    , owner_notification_kind TEXT, owner_notification_level TEXT, identity_provenance TEXT);
-- occupant_tenures
CREATE TABLE occupant_tenures (
      id                        TEXT PRIMARY KEY,
      node_id                   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      generation_ordinal        INTEGER NOT NULL,
      generation_uuid           TEXT NOT NULL UNIQUE,
      kind                      TEXT NOT NULL,
      native_session_id_at_boot TEXT,
      boot_at                   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(node_id, generation_ordinal)
    );
-- daemon_lifecycle
CREATE TABLE daemon_lifecycle (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      boot_epoch TEXT NOT NULL,
      started_at TEXT NOT NULL,
      last_heartbeat_at TEXT,
      stopped_at TEXT
    );
-- usage_samples
CREATE TABLE usage_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lane TEXT NOT NULL CHECK (lane IN ('context', 'provider_window')),
      seat_session TEXT NOT NULL,
      node_id TEXT,
      source TEXT,
      sampled_at TEXT,
      captured_at TEXT NOT NULL,
      total_input_tokens INTEGER,
      total_output_tokens INTEGER,
      used_percentage REAL,
      window TEXT CHECK (window IN ('five_hour', 'weekly') OR window IS NULL),
      window_used_percent REAL,
      resets_at TEXT
    );
-- projection_manifest
CREATE TABLE projection_manifest (
      target_path TEXT PRIMARY KEY,
      last_hash   TEXT NOT NULL,
      written_at  TEXT NOT NULL,
      source_spec TEXT,
      category    TEXT
    );
-- applied_launch_observations
CREATE TABLE applied_launch_observations (
      generation_uuid TEXT PRIMARY KEY REFERENCES occupant_tenures(generation_uuid) ON DELETE CASCADE,
      runtime         TEXT NOT NULL,
      axis            TEXT NOT NULL,
      observation_state TEXT NOT NULL CHECK (observation_state IN ('observed', 'unknown')),
      value           TEXT,
      reason          TEXT,
      observed_at     TEXT NOT NULL DEFAULT (datetime('now'))
    , approval_policy TEXT);
-- applied_launch_observation_invalidations
CREATE TABLE applied_launch_observation_invalidations (
      generation_uuid TEXT PRIMARY KEY REFERENCES occupant_tenures(generation_uuid) ON DELETE CASCADE,
      invalidated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
-- queue_transition_wakes
CREATE TABLE queue_transition_wakes (
      transition_id  INTEGER PRIMARY KEY,
      qitem_id       TEXT NOT NULL,
      phase          TEXT NOT NULL CHECK (phase IN ('armed', 'fired')),
      wake_kind      TEXT NOT NULL CHECK (wake_kind IN ('watchdog', 'timer', 'blocker')),
      wake_ref       TEXT NOT NULL,
      delivery_status TEXT
    );
-- workflow_frontier_bindings
CREATE TABLE workflow_frontier_bindings (
      instance_id TEXT NOT NULL REFERENCES workflow_instances(instance_id),
      packet_id TEXT NOT NULL REFERENCES queue_items(qitem_id),
      step_id TEXT NOT NULL,
      branch_drive INTEGER NOT NULL DEFAULT 0,
      hop_count INTEGER NOT NULL DEFAULT 0,
      hops_baseline INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      PRIMARY KEY (instance_id, packet_id),
      UNIQUE (packet_id)
    );
-- workflow_failure_occurrences
CREATE TABLE workflow_failure_occurrences (
      occurrence_id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL REFERENCES workflow_instances(instance_id),
      failed_packet_id TEXT NOT NULL REFERENCES queue_items(qitem_id),
      step_id TEXT NOT NULL,
      branch_drive INTEGER NOT NULL DEFAULT 0,
      hop_count INTEGER NOT NULL DEFAULT 0,
      hops_baseline INTEGER NOT NULL DEFAULT 0,
      failure_reason TEXT,
      status TEXT NOT NULL DEFAULT 'unresolved',
      redrive_packet_id TEXT REFERENCES queue_items(qitem_id),
      resume_decision TEXT,
      failed_at TEXT NOT NULL,
      resolved_at TEXT
    );
-- operator_context_mode_bindings
CREATE TABLE "operator_context_mode_bindings" (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL CHECK (scope IN ('global_host', 'rig', 'project', 'mission', 'workstream', 'qitem')),
      qualifier TEXT,
      mode TEXT NOT NULL CHECK (mode IN ('sleep', 'desk', 'mobile', 'away', 'focus', 'debug', 'human-led', 'delegated')),
      record_json TEXT NOT NULL,
      set_at TEXT NOT NULL,
      set_by TEXT NOT NULL CHECK (set_by = 'operator')
    );
-- classification_attempts
CREATE TABLE classification_attempts (
      attempt_id TEXT PRIMARY KEY,
      stream_item_id TEXT NOT NULL REFERENCES stream_items(stream_item_id),
      classifier_version TEXT NOT NULL,
      taxonomy_version TEXT NOT NULL,
      evidence_epoch TEXT NOT NULL,
      status TEXT NOT NULL
        CHECK (status IN ('in_flight', 'abstained', 'written', 'error', 'exhausted')),
      attempt_count INTEGER NOT NULL CHECK (attempt_count >= 1),
      execution_id TEXT NOT NULL,
      lease_id TEXT NOT NULL,
      classifier_session TEXT NOT NULL,
      retry_after TEXT,
      reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (stream_item_id, classifier_version, taxonomy_version, evidence_epoch)
    );
-- node_permission_selections
CREATE TABLE node_permission_selections (
      node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
      runtime TEXT NOT NULL CHECK (runtime IN ('codex', 'claude-code')),
      mode TEXT NOT NULL,
      actor TEXT NOT NULL,
      reason TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
-- team_approvals
CREATE TABLE team_approvals (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES team_runs(id),
      kind TEXT NOT NULL CHECK (kind IN ('orchestrator', 'native')),
      action TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      payload_digest TEXT NOT NULL,
      target_digest TEXT NOT NULL,
      binding_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'expired', 'invalidated')),
      entity_version INTEGER NOT NULL DEFAULT 1 CHECK (entity_version > 0),
      expires_at TEXT NOT NULL,
      decision_actor TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (id, run_id)
    );
-- team_control_requests
CREATE TABLE team_control_requests (
      run_id TEXT NOT NULL REFERENCES team_runs(id),
      idempotency_key TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      response_json TEXT NOT NULL CHECK (json_valid(response_json)),
      created_at TEXT NOT NULL,
      PRIMARY KEY (run_id, idempotency_key)
    );
-- team_queue_authority
CREATE TABLE team_queue_authority (
      qitem_id TEXT PRIMARY KEY REFERENCES queue_items(qitem_id),
      run_id TEXT NOT NULL REFERENCES team_runs(id),
      task_id TEXT NOT NULL,
      assignment_json TEXT NOT NULL CHECK (json_valid(assignment_json)),
      entity_version INTEGER NOT NULL DEFAULT 1 CHECK (entity_version > 0),
      evidence_json TEXT CHECK (evidence_json IS NULL OR json_valid(evidence_json)), outputs_json TEXT
      CHECK (outputs_json IS NULL OR json_valid(outputs_json)), permissions_json TEXT
      CHECK (permissions_json IS NULL OR json_valid(permissions_json)), display_name TEXT, document_versions_json TEXT
      CHECK (document_versions_json IS NULL OR json_valid(document_versions_json)), workflow_json TEXT
      CHECK (workflow_json IS NULL OR json_valid(workflow_json)),
      UNIQUE (run_id, task_id),
      UNIQUE (qitem_id, run_id)
    );
-- team_attempts
CREATE TABLE team_attempts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES team_runs(id),
      qitem_id TEXT,
      role TEXT NOT NULL CHECK (role IN ('lead', 'implementer', 'reviewer')),
      provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
      identity_json TEXT CHECK (identity_json IS NULL OR json_valid(identity_json)),
      unknown_reason TEXT,
      state TEXT NOT NULL CHECK (state IN ('running', 'stopped', 'unknown')),
      usage_json TEXT NOT NULL CHECK (json_valid(usage_json)),
      active_ms INTEGER NOT NULL CHECK (active_ms >= 0),
      entity_version INTEGER NOT NULL DEFAULT 1 CHECK (entity_version > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, failure_json TEXT CHECK (failure_json IS NULL OR json_valid(failure_json)),
      UNIQUE (id, run_id),
      FOREIGN KEY (qitem_id, run_id) REFERENCES team_queue_authority(qitem_id, run_id),
      CHECK ((state = 'unknown' AND unknown_reason IS NOT NULL) OR
        (state <> 'unknown' AND identity_json IS NOT NULL AND unknown_reason IS NULL))
    );
-- team_approval_consumptions
CREATE TABLE team_approval_consumptions (
      approval_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('reserved', 'confirmed', 'ambiguous')),
      receipt_json TEXT CHECK (receipt_json IS NULL OR json_valid(receipt_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (approval_id, run_id) REFERENCES team_approvals(id, run_id),
      FOREIGN KEY (attempt_id, run_id) REFERENCES team_attempts(id, run_id)
    );
-- owner_pairing_codes
CREATE TABLE owner_pairing_codes (
      code_hash TEXT PRIMARY KEY, owner_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL, consumed_at INTEGER
    );
-- owner_sessions
CREATE TABLE owner_sessions (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, csrf_hash TEXT NOT NULL,
      owner_hash TEXT NOT NULL, origin TEXT NOT NULL,
      created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, revoked_at INTEGER
    );
-- team_scope_extensions
CREATE TABLE team_scope_extensions (
      approval_id TEXT PRIMARY KEY REFERENCES team_approvals(id),
      task_id TEXT NOT NULL,
      chain_head TEXT,
      automatic INTEGER NOT NULL CHECK (automatic IN (0, 1))
    );
-- team_worker_credentials
CREATE TABLE team_worker_credentials (
      run_id TEXT NOT NULL REFERENCES team_runs(id),
      session_id TEXT NOT NULL,
      token_digest TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      PRIMARY KEY (run_id, session_id)
    );
-- team_runs
CREATE TABLE "team_runs" (
      id TEXT PRIMARY KEY,
      rig_id TEXT NOT NULL REFERENCES rigs(id),
      binding_json TEXT NOT NULL CHECK (json_valid(binding_json)),
      binding_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'cancel_requested', 'canceled', 'invalidated', 'blocked')),
      state_reason TEXT,
      entity_version INTEGER NOT NULL DEFAULT 1 CHECK (entity_version > 0),
      active_ms INTEGER NOT NULL DEFAULT 0 CHECK (active_ms >= 0),
      accounted_at TEXT,
      retries_used INTEGER NOT NULL DEFAULT 0 CHECK (retries_used >= 0),
      review_rounds_used INTEGER NOT NULL DEFAULT 0 CHECK (review_rounds_used >= 0),
      reviewer_seat TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    , display_name TEXT, phase TEXT NOT NULL DEFAULT 'delivery' CHECK (phase IN ('planning', 'delivery')), integration_branch TEXT, integration_worktree TEXT, integration_repository TEXT, response_language TEXT
    CHECK (response_language IS NULL OR response_language IN ('en', 'zh-CN')));
-- team_integration_commits
CREATE TABLE team_integration_commits (
      run_id TEXT NOT NULL REFERENCES team_runs(id),
      task_id TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      subject TEXT NOT NULL,
      committed_at TEXT NOT NULL,
      PRIMARY KEY (run_id, task_id)
    );
-- team_bootstraps
CREATE TABLE team_bootstraps (
      repository TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      lead_client TEXT NOT NULL CHECK (lead_client IN ('claude-code', 'codex')),
      github_login TEXT NOT NULL,
      step TEXT NOT NULL CHECK (step IN ('pending', 'folder', 'init', 'ignore', 'commit', 'repo', 'push')),
      commit_oid TEXT,
      branch_ref TEXT,
      remote_url TEXT,
      team_id TEXT REFERENCES rigs(id) ON DELETE CASCADE,
      last_error_code TEXT
    );
-- attempt_telemetry
CREATE TABLE attempt_telemetry (
      attempt_id TEXT PRIMARY KEY REFERENCES team_attempts(id) ON DELETE CASCADE,
      native_session_id TEXT,
      native_usage_json TEXT CHECK (native_usage_json IS NULL OR json_valid(native_usage_json)),
      seat_name TEXT,
      started_at TEXT NOT NULL,
      stopped_at TEXT NOT NULL,
      active_ms INTEGER NOT NULL CHECK (active_ms >= 0),
      usage_json TEXT NOT NULL CHECK (json_valid(usage_json)),
      activity_json TEXT NOT NULL CHECK (json_valid(activity_json)),
      activity_status TEXT NOT NULL CHECK (activity_status IN ('available', 'partial', 'unavailable')),
      outcome TEXT NOT NULL DEFAULT 'unknown' CHECK (outcome IN ('succeeded', 'failed', 'canceled', 'unknown')),
      retry_scheduled INTEGER NOT NULL DEFAULT 0 CHECK (retry_scheduled IN (0, 1))
    );
-- team_document_workflows
CREATE TABLE team_document_workflows (
      run_id TEXT PRIMARY KEY REFERENCES team_runs(id) ON DELETE CASCADE,
      stage TEXT NOT NULL CHECK (stage IN ('exploration', 'requirements', 'plan')),
      confirmed_brainstorm TEXT,
      confirmed_requirements TEXT,
      confirmed_plan TEXT,
      pending_stage TEXT CHECK (pending_stage IN ('exploration', 'requirements', 'plan')),
      error TEXT
    );
-- team_document_versions
CREATE TABLE team_document_versions (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('brainstorm', 'requirements', 'plan')),
      version INTEGER NOT NULL CHECK (version > 0),
      path TEXT NOT NULL,
      content TEXT NOT NULL,
      hash TEXT NOT NULL,
      requirements_version_id TEXT REFERENCES team_document_versions(id),
      source_attempt_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      confirmed_at TEXT,
      confirmed_by TEXT,
      UNIQUE (run_id, kind, version),
      UNIQUE (run_id, kind, source_attempt_id)
    );
-- team_document_captures
CREATE TABLE team_document_captures (
      run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
      attempt_id TEXT NOT NULL,
      PRIMARY KEY (run_id, attempt_id)
    );
-- team_chat_messages
CREATE TABLE "team_chat_messages" (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES team_runs(id),
      sender TEXT NOT NULL CHECK (sender IN ('owner', 'lead')),
      body TEXT NOT NULL CHECK (length(body) <= 65536 OR
        (sender = 'owner' AND id IS (run_id || ':initial') AND length(body) <= 65536 + 256)),
      attempt_id TEXT,
      delivered_attempt TEXT,
      created_at TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'text',
      options_json TEXT,
      answered_by TEXT, response_language TEXT
    CHECK (response_language IS NULL OR response_language IN ('en', 'zh-CN')),
      CHECK ((sender = 'lead') = (attempt_id IS NOT NULL)),
      CHECK (sender = 'owner' OR delivered_attempt IS NULL)
    );
-- team_soul_versions
CREATE TABLE team_soul_versions (
      rig_id TEXT NOT NULL REFERENCES rigs(id) ON DELETE CASCADE,
      soul_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      name TEXT NOT NULL,
      roles_json TEXT NOT NULL CHECK (json_valid(roles_json)),
      content TEXT NOT NULL,
      digest TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (rig_id, soul_id, version)
    );
-- team_workflow_outcomes
CREATE TABLE team_workflow_outcomes (
      attempt_id TEXT NOT NULL,
      qitem_id TEXT NOT NULL REFERENCES team_queue_authority(qitem_id) ON DELETE CASCADE,
      generation INTEGER NOT NULL,
      entrypoint TEXT NOT NULL,
      revision TEXT NOT NULL,
      outcome_json TEXT NOT NULL CHECK (json_valid(outcome_json)),
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (attempt_id, generation)
    );
-- indexes/triggers
-- idx_events_rig_seq
CREATE INDEX idx_events_rig_seq ON events(rig_id, seq);
-- idx_chat_messages_rig_created
CREATE INDEX idx_chat_messages_rig_created
      ON chat_messages (rig_id, created_at);
-- idx_pods_rig_namespace
CREATE UNIQUE INDEX idx_pods_rig_namespace ON pods(rig_id, namespace) WHERE namespace != '';
-- idx_stream_items_source
CREATE INDEX idx_stream_items_source ON stream_items(source_session);
-- idx_stream_items_hint_destination
CREATE INDEX idx_stream_items_hint_destination ON stream_items(hint_destination);
-- idx_stream_items_chronological
CREATE INDEX idx_stream_items_chronological ON stream_items(ts_emitted, stream_sort_key);
-- idx_stream_items_archived
CREATE INDEX idx_stream_items_archived ON stream_items(archived_at);
-- idx_queue_items_destination_state
CREATE INDEX idx_queue_items_destination_state ON queue_items(destination_session, state);
-- idx_queue_items_source
CREATE INDEX idx_queue_items_source ON queue_items(source_session);
-- idx_queue_items_state
CREATE INDEX idx_queue_items_state ON queue_items(state);
-- idx_queue_items_handed_off_to
CREATE INDEX idx_queue_items_handed_off_to ON queue_items(handed_off_to);
-- idx_queue_items_closure_overdue
CREATE INDEX idx_queue_items_closure_overdue ON queue_items(state, closure_required_at) WHERE state = 'in-progress';
-- idx_queue_transitions_qitem
CREATE INDEX idx_queue_transitions_qitem ON queue_transitions(qitem_id, ts);
-- idx_queue_transitions_actor
CREATE INDEX idx_queue_transitions_actor ON queue_transitions(actor_session);
-- idx_inbox_entries_destination_state
CREATE INDEX idx_inbox_entries_destination_state ON inbox_entries(destination_session, state);
-- idx_inbox_entries_sender
CREATE INDEX idx_inbox_entries_sender ON inbox_entries(sender_session);
-- idx_inbox_entries_state
CREATE INDEX idx_inbox_entries_state ON inbox_entries(state);
-- idx_outbox_entries_sender
CREATE INDEX idx_outbox_entries_sender ON outbox_entries(sender_session);
-- idx_outbox_entries_destination
CREATE INDEX idx_outbox_entries_destination ON outbox_entries(destination_session);
-- idx_outbox_entries_delivery_state
CREATE INDEX idx_outbox_entries_delivery_state ON outbox_entries(delivery_state);
-- idx_project_classifications_classifier_session
CREATE INDEX idx_project_classifications_classifier_session ON project_classifications(classifier_session);
-- idx_project_classifications_destination
CREATE INDEX idx_project_classifications_destination ON project_classifications(classification_destination);
-- idx_project_classifications_ts_projected
CREATE INDEX idx_project_classifications_ts_projected ON project_classifications(ts_projected);
-- idx_classifier_leases_active_singleton
CREATE UNIQUE INDEX idx_classifier_leases_active_singleton
      ON classifier_leases(state) WHERE state = 'active';
-- idx_classifier_leases_classifier_session
CREATE INDEX idx_classifier_leases_classifier_session
      ON classifier_leases(classifier_session);
-- idx_classifier_leases_expires_at
CREATE INDEX idx_classifier_leases_expires_at
      ON classifier_leases(expires_at) WHERE state = 'active';
-- idx_views_custom_registered_by
CREATE INDEX idx_views_custom_registered_by ON views_custom(registered_by_session);
-- idx_watchdog_jobs_state
CREATE INDEX idx_watchdog_jobs_state ON watchdog_jobs(state);
-- idx_watchdog_jobs_policy
CREATE INDEX idx_watchdog_jobs_policy ON watchdog_jobs(policy);
-- idx_watchdog_jobs_target_session
CREATE INDEX idx_watchdog_jobs_target_session ON watchdog_jobs(target_session);
-- idx_watchdog_jobs_active_next_eval
CREATE INDEX idx_watchdog_jobs_active_next_eval
      ON watchdog_jobs(last_evaluation_at) WHERE state = 'active';
-- idx_watchdog_history_job_recent
CREATE INDEX idx_watchdog_history_job_recent
      ON watchdog_history(job_id, evaluated_at DESC);
-- idx_watchdog_history_outcome_recent
CREATE INDEX idx_watchdog_history_outcome_recent
      ON watchdog_history(outcome, evaluated_at DESC);
-- idx_workflow_specs_name_version
CREATE UNIQUE INDEX idx_workflow_specs_name_version
      ON workflow_specs(name, version);
-- idx_workflow_specs_target_rig
CREATE INDEX idx_workflow_specs_target_rig
      ON workflow_specs(target_rig);
-- idx_workflow_instances_status_name
CREATE INDEX idx_workflow_instances_status_name
      ON workflow_instances(status, workflow_name);
-- idx_workflow_instances_creator_status
CREATE INDEX idx_workflow_instances_creator_status
      ON workflow_instances(created_by_session, status);
-- idx_workflow_step_trails_instance_recent
CREATE INDEX idx_workflow_step_trails_instance_recent
      ON workflow_step_trails(instance_id, closed_at DESC);
-- idx_workflow_step_trails_recent
CREATE INDEX idx_workflow_step_trails_recent
      ON workflow_step_trails(closed_at DESC);
-- idx_mc_actions_recent
CREATE INDEX idx_mc_actions_recent
      ON mission_control_actions(acted_at DESC, action_verb);
-- idx_mc_actions_qitem
CREATE INDEX idx_mc_actions_qitem
      ON mission_control_actions(qitem_id, acted_at DESC);
-- idx_mc_actions_actor
CREATE INDEX idx_mc_actions_actor
      ON mission_control_actions(actor_session, acted_at DESC);
-- idx_queue_items_target_repo
CREATE INDEX idx_queue_items_target_repo ON queue_items(target_repo);
-- idx_rigs_archived
CREATE INDEX idx_rigs_archived ON rigs(archived_at);
-- idx_events_node_type_seq
CREATE INDEX idx_events_node_type_seq ON events(node_id, type, seq);
-- idx_sessions_node_created_id
CREATE INDEX idx_sessions_node_created_id
      ON sessions(node_id, created_at DESC, id DESC);
-- idx_queue_transitions_archive_qitem
CREATE INDEX idx_queue_transitions_archive_qitem ON queue_transitions_archive(qitem_id, ts);
-- idx_occupant_tenures_node
CREATE INDEX idx_occupant_tenures_node ON occupant_tenures(node_id);
-- idx_usage_samples_seat_time
CREATE INDEX idx_usage_samples_seat_time
      ON usage_samples(seat_session, lane, captured_at);
-- idx_usage_samples_node_time
CREATE INDEX idx_usage_samples_node_time
      ON usage_samples(node_id, captured_at);
-- idx_queue_transition_wakes_qitem
CREATE INDEX idx_queue_transition_wakes_qitem
      ON queue_transition_wakes (qitem_id, transition_id);
-- idx_queue_transition_wakes_ref
CREATE INDEX idx_queue_transition_wakes_ref
      ON queue_transition_wakes (wake_ref, phase);
-- idx_workflow_instances_lifecycle_operation
CREATE UNIQUE INDEX idx_workflow_instances_lifecycle_operation
      ON workflow_instances(lifecycle_operation_key)
      WHERE lifecycle_operation_key IS NOT NULL;
-- idx_workflow_frontier_bindings_instance
CREATE INDEX idx_workflow_frontier_bindings_instance
      ON workflow_frontier_bindings(instance_id, created_at, packet_id);
-- idx_workflow_failure_occurrences_instance_status
CREATE INDEX idx_workflow_failure_occurrences_instance_status
      ON workflow_failure_occurrences(instance_id, status, failed_at, occurrence_id);
-- idx_operator_context_mode_bindings_scope_qualifier
CREATE UNIQUE INDEX idx_operator_context_mode_bindings_scope_qualifier
      ON operator_context_mode_bindings(scope, qualifier);
-- idx_queue_human_intent_updated
CREATE INDEX idx_queue_human_intent_updated ON queue_items(human_intent, ts_updated DESC);
-- idx_queue_transitions_handoff_ts
CREATE INDEX idx_queue_transitions_handoff_ts
      ON queue_transitions(ts DESC)
      WHERE closure_reason = 'handed_off_to';
-- idx_queue_items_ts_updated
CREATE INDEX idx_queue_items_ts_updated
      ON queue_items(ts_updated);
-- idx_events_restore_seq
CREATE INDEX idx_events_restore_seq ON events(seq DESC)
      WHERE type IN ('restore.completed', 'restore.subset_completed', 'restore.outcome_reconciled');
-- idx_events_restore_rig_seq
CREATE INDEX idx_events_restore_rig_seq ON events(rig_id, seq DESC)
      WHERE type IN ('restore.completed', 'restore.subset_completed', 'restore.outcome_reconciled');
-- idx_events_startup_node_seq
CREATE INDEX idx_events_startup_node_seq ON events(node_id, seq DESC)
      WHERE type IN ('node.startup_challenged','node.startup_proof_skipped','node.startup_proof_verified','node.startup_proof_rejected');
-- idx_project_classifications_area
CREATE INDEX idx_project_classifications_area
      ON project_classifications(area);
-- idx_project_classifications_scope_ref
CREATE INDEX idx_project_classifications_scope_ref
      ON project_classifications(scope_ref);
-- idx_classification_attempts_status_retry
CREATE INDEX idx_classification_attempts_status_retry
      ON classification_attempts(status, retry_after);
-- idx_outbox_guard_active
CREATE INDEX idx_outbox_guard_active ON outbox_entries(destination_session, delivery_state)
      WHERE delivery_state = 'retained';
-- idx_usage_samples_context_latest
CREATE INDEX idx_usage_samples_context_latest
      ON usage_samples(seat_session, id) WHERE lane = 'context';
-- idx_usage_samples_window_latest
CREATE INDEX idx_usage_samples_window_latest
      ON usage_samples(seat_session, window, id) WHERE lane = 'provider_window';
-- idx_queue_transitions_qitem_id_order
CREATE INDEX idx_queue_transitions_qitem_id_order
      ON queue_transitions(qitem_id, transition_id);
-- idx_queue_items_recovery_tags
CREATE INDEX idx_queue_items_recovery_tags
      ON queue_items(qitem_id)
      WHERE (tags LIKE '%"recovery-for:%' OR tags LIKE '%\%') OR tags LIKE '%"stuck-sweep:%';
-- idx_team_approvals_run_state
CREATE INDEX idx_team_approvals_run_state ON team_approvals(run_id, state);
-- idx_team_attempts_run_state
CREATE INDEX idx_team_attempts_run_state ON team_attempts(run_id, state);
-- idx_owner_sessions_expiry
CREATE INDEX idx_owner_sessions_expiry ON owner_sessions(expires_at);
-- team_scope_extensions_task
CREATE INDEX team_scope_extensions_task ON team_scope_extensions(task_id);
-- idx_attempt_telemetry_native_session
CREATE INDEX idx_attempt_telemetry_native_session ON attempt_telemetry(native_session_id);
-- idx_attempt_telemetry_stopped
CREATE INDEX idx_attempt_telemetry_stopped ON attempt_telemetry(stopped_at);
-- team_document_versions_run
CREATE INDEX team_document_versions_run ON team_document_versions(run_id, kind, version DESC);
-- idx_team_chat_messages_run
CREATE INDEX idx_team_chat_messages_run ON team_chat_messages (run_id);
-- idx_team_chat_messages_lead_attempt
CREATE UNIQUE INDEX idx_team_chat_messages_lead_attempt ON team_chat_messages (run_id, attempt_id) WHERE sender = 'lead';
-- team_workflow_owner_request
CREATE UNIQUE INDEX team_workflow_owner_request ON team_queue_authority(json_extract(workflow_json, '$.ownerMessageId'))
      WHERE json_extract(workflow_json, '$.ownerMessageId') IS NOT NULL;
-- edge_same_rig_insert
CREATE TRIGGER edge_same_rig_insert
    BEFORE INSERT ON edges
    BEGIN
      SELECT RAISE(ABORT, 'edge source and target must belong to the same rig')
      WHERE (SELECT rig_id FROM nodes WHERE id = NEW.source_id)
         != (SELECT rig_id FROM nodes WHERE id = NEW.target_id);
      SELECT RAISE(ABORT, 'edge rig_id must match source node rig_id')
      WHERE NEW.rig_id != (SELECT rig_id FROM nodes WHERE id = NEW.source_id);
    END;
`;

export class LegacyDatabaseError extends Error {
  readonly code = "legacy_database";
  constructor(public readonly databasePath: string) {
    super(`legacy_database: ${databasePath}`);
    this.name = "LegacyDatabaseError";
  }
}

export interface BaselineOptions {
  /** Test-only failure injection. The callback runs inside the schema transaction. */
  injectFailure?: () => void;
}

function writeBaseline(db: Database.Database, options?: BaselineOptions): void {
  db.transaction(() => {
    db.exec(BASELINE_SQL);
    db.pragma(`user_version = ${BASELINE_VERSION}`);
    options?.injectFailure?.();
  })();
}

function hasUserTables(db: Database.Database): boolean {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'index', 'trigger', 'view') AND name NOT LIKE 'sqlite_%' LIMIT 1",
  ).get());
}

function userVersion(db: Database.Database): number {
  return Number(db.pragma("user_version", { simple: true }));
}

/** Inspect schema metadata only; legacy application rows are never read. */
export function assertSupportedDatabase(db: Database.Database, databasePath: string): void {
  if (userVersion(db) !== BASELINE_VERSION && hasUserTables(db)) {
    throw new LegacyDatabaseError(databasePath);
  }
}

/** Initialize an empty database atomically, or reopen the existing baseline. */
export function initializeDatabase(
  db: Database.Database,
  databasePath: string = db.name,
  options?: BaselineOptions,
): void {
  assertSupportedDatabase(db, databasePath);
  if (userVersion(db) === BASELINE_VERSION) return;
  writeBaseline(db, options);
}
