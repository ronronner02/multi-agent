import { rigInstallRootSchema } from "../../src/db/migrations/096_rig_install_root.js";
import { threadPartMapSchema } from "../../src/db/migrations/097_thread_part_map.js";
import { queueTransitionsQitemIdOrderSchema } from "../../src/db/migrations/098_queue_transitions_qitem_id_order.js";
import { queueItemsRecoveryTagsSchema } from "../../src/db/migrations/099_queue_items_recovery_tags.js";
import { resumeRotationSchema } from "../../src/db/migrations/101_claude_resume_rotation.js";
import { sessionStopIntentSchema } from "../../src/db/migrations/103_session_stop_intent.js";
import { teamGovernanceSchema } from "../../src/db/migrations/104_team_governance.js";
import { ownerSessionsSchema } from "../../src/db/migrations/105_owner_sessions.js";
import { managedAttemptInputsSchema } from "../../src/db/migrations/106_managed_attempt_inputs.js";
import { scopeExtensionsSchema } from "../../src/db/migrations/105_scope_extensions.js";
import { reviewLoopSchema } from "../../src/db/migrations/107_review_loop.js";
import { cancellationSchema } from "../../src/db/migrations/108_cancellation.js";
import { attemptFailureSchema } from "../../src/db/migrations/110_attempt_failure.js";
import { displayNamesSchema } from "../../src/db/migrations/112_display_names.js";
import { leadChatSchema } from "../../src/db/migrations/113_lead_chat.js";
import { integrationBranchSchema } from "../../src/db/migrations/114_integration_branch.js";
import { leadDecisionsSchema } from "../../src/db/migrations/116_lead_decisions.js";
import { teamBootstrapAndRetirementSchema } from "../../src/db/migrations/117_team_bootstrap_and_retirement.js";
import { attemptTelemetrySchema } from "../../src/db/migrations/118_attempt_telemetry.js";
import { rigNonInterruptiveSchema } from "../../src/db/migrations/095_rig_non_interruptive.js";
import type Database from "better-sqlite3";
import { createDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { coreSchema } from "../../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../../src/db/migrations/003_events.js";
import { snapshotsSchema } from "../../src/db/migrations/004_snapshots.js";
import { checkpointsSchema } from "../../src/db/migrations/005_checkpoints.js";
import { resumeMetadataSchema } from "../../src/db/migrations/006_resume_metadata.js";
import { nodeSpecFieldsSchema } from "../../src/db/migrations/007_node_spec_fields.js";
import { packagesSchema } from "../../src/db/migrations/008_packages.js";
import { installJournalSchema } from "../../src/db/migrations/009_install_journal.js";
import { journalSeqSchema } from "../../src/db/migrations/010_journal_seq.js";
import { bootstrapSchema } from "../../src/db/migrations/011_bootstrap.js";
import { discoverySchema } from "../../src/db/migrations/012_discovery.js";
import { discoveryFkFix } from "../../src/db/migrations/013_discovery_fk_fix.js";
import { agentspecRebootSchema } from "../../src/db/migrations/014_agentspec_reboot.js";
import { startupContextSchema } from "../../src/db/migrations/015_startup_context.js";
import { chatMessagesSchema } from "../../src/db/migrations/016_chat_messages.js";
import { podNamespaceSchema } from "../../src/db/migrations/017_pod_namespace.js";
import { contextUsageSchema } from "../../src/db/migrations/018_context_usage.js";
import { externalCliAttachmentSchema } from "../../src/db/migrations/019_external_cli_attachment.js";
import { rigServicesSchema } from "../../src/db/migrations/020_rig_services.js";
import { seatHandoverObservabilitySchema } from "../../src/db/migrations/021_seat_handover_observability.js";
import { nodePermissionPolicySchema } from "../../src/db/migrations/055_node_permission_policy.js";
import { rigPermissionPolicySchema } from "../../src/db/migrations/056_rig_permission_policy.js";
import { nodePolicyProvenanceSchema } from "../../src/db/migrations/057_node_policy_provenance.js";
import { rigPolicyProvenanceSchema } from "../../src/db/migrations/058_rig_policy_provenance.js";
import { selfHostIdentitySchema } from "../../src/db/migrations/059_self_host_identity.js";
import { occupantTenuresSchema } from "../../src/db/migrations/060_occupant_tenures.js";
import { daemonLifecycleSchema } from "../../src/db/migrations/061_daemon_lifecycle.js";
import { watchdogJobsSchema } from "../../src/db/migrations/031_watchdog_jobs.js";
import { occupantGenerationStampsSchema } from "../../src/db/migrations/063_occupant_generation_stamps.js";
import { projectionManifestSchema } from "../../src/db/migrations/064_projection_manifest.js";
import { watchdogTargetGenerationSchema } from "../../src/db/migrations/066_watchdog_target_generation.js";
import { appliedLaunchObservationsSchema } from "../../src/db/migrations/069_applied_launch_observations.js";
import { appliedLaunchObservationInvalidationsSchema } from "../../src/db/migrations/070_applied_launch_observation_invalidations.js";
import { threadSeatMapSchema } from "../../src/db/migrations/072_thread_seat_map.js";
import { queueTransitionWakesSchema } from "../../src/db/migrations/073_queue_transition_wakes.js";
import { nodeCodexConfigProfileSchema } from "../../src/db/migrations/022_node_codex_config_profile.js";
import { nodeSessionSourceSchema } from "../../src/db/migrations/077_node_session_source.js";
// PL-019: GET /api/rigs/:id/graph + GET /api/rigs/:rigId/nodes/:logicalId
// now perform a read-side join over queue_items (in-progress qitem
// ownership per session). The route returns 500 if the table is absent,
// so the integration harness needs the queue migrations through 025.
import { streamItemsSchema } from "../../src/db/migrations/023_stream_items.js";
import { queueItemsSchema } from "../../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../../src/db/migrations/025_queue_transitions.js";
import { scopedOperatingPostureSchema } from "../../src/db/migrations/080_scoped_operating_posture.js";
import { humanNotificationIntentSchema } from "../../src/db/migrations/081_human_notification_intent.js";
import { reviewReadIndexesSchema } from "../../src/db/migrations/083_review_read_indexes.js";
import { inventoryEventIndexesSchema } from "../../src/db/migrations/084_inventory_event_indexes.js";
import { rigClaudeManagedBlockFileSchema } from "../../src/db/migrations/085_rig_claude_managed_block_file.js";
import { nodePermissionSelectionsSchema } from "../../src/db/migrations/088_node_permission_selections.js";
import { humanReplyToSchema } from "../../src/db/migrations/090_human_reply_to.js";
import { humanQuestionsSchema } from "../../src/db/migrations/091_human_questions.js";
import { nodeEffortSchema } from "../../src/db/migrations/092_node_effort.js";
import { rigPolicySchema } from "../../src/db/migrations/041_rig_policy.js";
import { rigArchiveSchema } from "../../src/db/migrations/042_rig_archive.js";
import { resumeProvenanceSchema } from "../../src/db/migrations/043_resume_provenance.js";
import { resumeVerificationSchema } from "../../src/db/migrations/045_resume_verification.js";
import { seatIdentityVerdictsSchema } from "../../src/db/migrations/046_seat_identity_verdicts.js";
import { DiscoveryRepository } from "../../src/domain/discovery-repository.js";
import { ContextUsageStore } from "../../src/domain/context-usage-store.js";
import { TranscriptStore } from "../../src/domain/transcript-store.js";
import { RigRepository } from "../../src/domain/rig-repository.js";
import { SessionRegistry } from "../../src/domain/session-registry.js";
import { EventBus } from "../../src/domain/event-bus.js";
import { QueueRepository } from "../../src/domain/queue-repository.js";
import type { RuntimeAdapter } from "../../src/domain/runtime-adapter.js";
import { AgentActivityStore } from "../../src/domain/agent-activity-store.js";
import { createApp } from "../../src/server.js";

/** Seam B R6: the canonical full-fixture migration list, exported so file-backed
 *  DB-reopen tests migrate IDENTICALLY to createFullTestDb. */
import { teamModelPolicySchema } from "../../src/db/migrations/119_team_model_policy.js";
import { projectDocumentsSchema } from "../../src/db/migrations/120_project_documents.js";
import { workflowSoulsSchema } from "../../src/db/migrations/121_workflow_souls.js";
import { replyLanguageSchema } from "../../src/db/migrations/122_reply_language.js";

export const migrationsForFullTestDb = [coreSchema, bindingsSessionsSchema, eventsSchema, snapshotsSchema, checkpointsSchema, resumeMetadataSchema, nodeSpecFieldsSchema, packagesSchema, installJournalSchema, journalSeqSchema, bootstrapSchema, discoverySchema, discoveryFkFix, agentspecRebootSchema, startupContextSchema, chatMessagesSchema, podNamespaceSchema, contextUsageSchema, externalCliAttachmentSchema, rigServicesSchema, seatHandoverObservabilitySchema, nodeCodexConfigProfileSchema, nodePermissionPolicySchema, rigPermissionPolicySchema, nodePolicyProvenanceSchema, rigPolicyProvenanceSchema, streamItemsSchema, queueItemsSchema, queueTransitionsSchema, rigPolicySchema, rigArchiveSchema, resumeProvenanceSchema, resumeVerificationSchema, seatIdentityVerdictsSchema, selfHostIdentitySchema, occupantTenuresSchema, daemonLifecycleSchema, watchdogJobsSchema, occupantGenerationStampsSchema, projectionManifestSchema, watchdogTargetGenerationSchema, appliedLaunchObservationsSchema, appliedLaunchObservationInvalidationsSchema, threadSeatMapSchema, queueTransitionWakesSchema, nodeSessionSourceSchema, scopedOperatingPostureSchema, humanNotificationIntentSchema, reviewReadIndexesSchema, inventoryEventIndexesSchema, rigClaudeManagedBlockFileSchema, nodePermissionSelectionsSchema, humanReplyToSchema, humanQuestionsSchema, nodeEffortSchema, rigNonInterruptiveSchema, rigInstallRootSchema, threadPartMapSchema, queueTransitionsQitemIdOrderSchema, queueItemsRecoveryTagsSchema, resumeRotationSchema, sessionStopIntentSchema, teamGovernanceSchema, ownerSessionsSchema, managedAttemptInputsSchema, scopeExtensionsSchema, reviewLoopSchema, cancellationSchema, attemptFailureSchema, displayNamesSchema, leadChatSchema, integrationBranchSchema, leadDecisionsSchema, teamBootstrapAndRetirementSchema, attemptTelemetrySchema, teamModelPolicySchema, projectDocumentsSchema, workflowSoulsSchema, replyLanguageSchema]

/**
 * P24 — the DECLARED exclusions for {@link migrationsForFullTestDb}. That list is deliberately a
 * schema-MINIMAL core-topology DB (node / rig / session / pod / discovery / stream / queue items+
 * transitions / projection) shared by ~135 suites; each per-subsystem table below is a shipped
 * migration intentionally omitted so the shared fixture stays lean. The exclusion is SAFE evidence,
 * not a guess: the fixture omits these AND all ~135 consumers pass, which proves no createFullTestDb
 * consumer reads them — a subsystem that needs its table migrates that migration in its own suite's
 * inline list. The P24 guard (migration-fixture-parity.test.ts) fails LOUD if a shipped migration is
 * neither in the list above nor declared here (the 064/066/067 silent-omission tax).
 *
 * TO RE-EVALUATE any entry: check whether a createFullTestDb consumer now reads that table/column
 * (e.g. a new shared read). If one does, the migration must MOVE INTO migrationsForFullTestDb (delete
 * its exclusion); the guard's redundant-exclusion check then keeps the two in sync.
 */
export const migrationsForFullTestDbExclusions: Record<string, string> = {
  "082_archive_identity_provenance.sql": "archive extension; 054 is excluded from this core fixture. Archive identity regressions use ALL_MIGRATIONS.",
  "026_inbox_entries.sql": "inbox subsystem table — not on the shared core edge (inbox suites migrate it inline).",
  "027_outbox_entries.sql": "outbox subsystem table — not on the shared core edge (outbox suites migrate it inline).",
  "028_project_classifications.sql": "project-classification subsystem table — classifier suites migrate it inline.",
  "029_classifier_leases.sql": "project-classification subsystem table — classifier-lease suites migrate it inline.",
  "086_classification_fields_and_attempts.sql": "extends 028 (excluded here) and adds the S02 attempt ledger — classifier suites migrate it inline.",
  "087_seat_delivery_guard.sql": "extends outbox_entries (027 is excluded); delivery-guard suites use ALL_MIGRATIONS. Revisit if a core-fixture consumer uses retained delivery.",
  "089_classification_identity_provenance.sql": "extends project_classifications (028 is excluded); classifier fixtures migrate it inline.",
  "030_views_custom.sql": "custom-views subsystem table — views suites migrate it inline.",
  "032_watchdog_history.sql": "watchdog history table — watchdog suites migrate it inline (watchdog_jobs is the only watchdog base the core edge carries).",
  "033_workflow_specs.sql": "workflow subsystem table — workflow-* suites migrate the workflow schema inline.",
  "034_workflow_instances.sql": "workflow subsystem table — workflow-* suites migrate the workflow schema inline.",
  "035_workflow_step_trails.sql": "workflow subsystem table — workflow-* suites migrate the workflow schema inline.",
  "036_watchdog_policy_enum_extension.sql": "watchdog policy extension — watchdog suites migrate it inline.",
  "037_mission_control_actions.sql": "mission-control subsystem table — mission-control + review-freeze suites migrate it inline.",
  "038_workspace_primitive.sql": "workspace subsystem table — workspace suites migrate it inline.",
  "039_queue_target_repo.sql": "queue-spine EXTENSION beyond core items+transitions — suites needing target_repo (queue-routes, queue-target-repo) migrate it inline.",
  "040_workflow_specs_diagnostic.sql": "workflow subsystem table — workflow-* suites migrate the workflow schema inline.",
  "044_queue_item_summary.sql": "queue-spine EXTENSION column — suites needing the summary column migrate it inline.",
  "047_events_node_type_index.sql": "events perf index — index/perf suites add it inline; the core edge uses the base events table.",
  "048_queue_item_evidence_ref.sql": "queue-spine EXTENSION column — suites needing evidence_ref migrate it inline.",
  "049_workflow_instance_version.sql": "workflow subsystem column — workflow-* suites migrate the workflow schema inline.",
  "050_workflow_spec_json.sql": "workflow subsystem column — workflow-* suites migrate the workflow schema inline.",
  "051_workflow_resume.sql": "workflow subsystem column — workflow-* suites migrate the workflow schema inline.",
  "052_workflow_instance_bound_rig.sql": "workflow subsystem column — workflow-* suites migrate the workflow schema inline.",
  "053_sessions_node_id_index.sql": "sessions perf index — index/perf suites add it inline; the core edge uses the base sessions table.",
  "054_queue_transitions_archive.sql": "queue-retention EXTENSION table — queue-retention suites migrate it inline.",
  "062_usage_samples.sql": "usage-metering subsystem table — usage suites migrate it inline.",
  "094_usage_samples_latest_indexes.sql": "indexes usage_samples (062 is excluded); usage index tests migrate the canonical full schema.",
  "065_identity_provenance.sql": "P21 additive era-stamp column on 037_mission_control_actions (itself excluded) — mission-control / review-freeze / scope suites migrate it inline where they assert provenance.",
  "067_i3_identity_provenance.sql": "P21 additive era-stamp columns; it ALTERs inbox_entries + outbox_entries (both excluded from the core edge) alongside queue_transitions/stream_items, so it cannot ride the core-edge list — queue / inbox / outbox / stream suites asserting provenance migrate it inline.",
  "068_enforcer_decisions.sql": "W4 compaction-enforcement decision table — the suite was unbuilt and 071 drops the table forward; 068 stays as applied history. No consumer reads it, and 071 is IF EXISTS so it is a no-op on this fixture.",
  "071_drop_enforcer_decisions.sql": "The forward drop of 068, excluded above — this fixture never creates enforcer_decisions, so applying its drop would be a no-op (the DROP is IF EXISTS). Re-check together with 068: if 068 is ever added to the core edge, add this one too or the fixture keeps a table the shipped schema has dropped.",
  "074_context_usage_watchdog.sql": "watchdog extension migrated inline by context-usage watchdog suites.",
  "075_context_usage_watchdog_generation.sql": "context watchdog generation-binding extension migrated inline by context-usage watchdog suites.",
  "076_owner_notification_levels.sql": "owner-notification columns extend queue transitions plus the archive table (054 is excluded); focused S14 suites use the canonical full migration list.",
  "078_idle_gate_fired_condition.sql": "idle-gate watchdog extension migrated inline by the idle-gate policy suite.",
  "079_workflow_lifecycle_parallel.sql": "workflow lifecycle identity, frontier, and failure tables — workflow suites migrate the canonical workflow schema inline; the shared core fixture does not read them.",
};

export function createFullTestDb(): Database.Database {
  const db = createDb();
  migrate(db, migrationsForFullTestDb);
  return db;
}

export function createTestApp(
  db: Database.Database,
  opts?: {
    adapters?: Partial<Record<string, RuntimeAdapter>>;
    activityFreshnessMs?: number;
    eventLoopMonitor?: import("../../src/domain/event-loop-monitor.js").EventLoopMonitor;
    routeTimingRecorder?: import("../../src/domain/route-timing-recorder.js").RouteTimingRecorder;
    appDeps?: Partial<import("../../src/server.js").AppDeps>;
    wireRuntimeAdapters?: boolean;
  },
) {
  const rigRepo = new RigRepository(db);
  const sessionRegistry = new SessionRegistry(db);
  const eventBus = new EventBus(db);
  const queueRepo = new QueueRepository(db, eventBus);
  const transcriptStore = new TranscriptStore("/tmp/openrig-test-transcripts");
  const discoveryRepo = new DiscoveryRepository(db);
  const contextUsageStore = new ContextUsageStore(db, { stateDir: "/tmp/openrig-test" });
  const agentActivityStore = new AgentActivityStore({
    db,
    eventBus,
    freshnessMs: opts?.activityFreshnessMs,
    resolveOccupantGeneration: nodeId => sessionRegistry.currentOccupantTenure(nodeId)?.generationUuid ?? null,
    isRegisteredOccupantGeneration: (nodeId, generation) => sessionRegistry.isOccupantGenerationRegistered(nodeId, generation),
  });
  const testAppDeps: Record<string, unknown> = {
    rigRepo,
    sessionRegistry,
    eventBus,
    discoveryRepo,
    queueRepo,
    transcriptStore,
    contextUsageStore,
    agentActivityStore,
    eventLoopMonitor: opts?.eventLoopMonitor,
    routeTimingRecorder: opts?.routeTimingRecorder,
    runtimeAdapters: opts?.wireRuntimeAdapters ? opts?.adapters as Record<string, RuntimeAdapter> | undefined : opts?.adapters as Record<string, RuntimeAdapter> | undefined,
    ...opts?.appDeps,
  };
  const built = { app: createApp(testAppDeps as never) };
  return {
    app: built.app,
    db,
    rigRepo,
    sessionRegistry,
    eventBus,
    discoveryRepo,
    queueRepo,
    transcriptStore,
    contextUsageStore,
    agentActivityStore,
  };
}
