import { createInstance, type i18n } from "i18next";
import english from "./catalogs/en.json" with { type: "json" };
import chinese from "./catalogs/zh-CN.json" with { type: "json" };

export { displayWidth } from "./display-width.js";

export const SUPPORTED_LANGUAGES = ["zh-CN", "en"] as const;
export type InterfaceLanguage = (typeof SUPPORTED_LANGUAGES)[number];
export const DEFAULT_LANGUAGE: InterfaceLanguage = "zh-CN";
export type MessageKey = keyof typeof english;
export type TranslationCatalog = Readonly<Record<MessageKey, string>>;

export const CATALOGS = Object.freeze({
  "zh-CN": Object.freeze(chinese),
  en: Object.freeze(english),
}) satisfies Readonly<Record<InterfaceLanguage, TranslationCatalog>>;

// JSON imports preserve keys, but widen message values to string. Keep the
// interpolation type contract explicit and check it against both catalogs.
export const MESSAGE_PARAMETERS = {
  "souls.seat": ["index"],
  "chat.documentConfirmationConsequence": ["kind", "version"],
  "chat.stageRequestConsequence": ["stage"],
  "documents.discussContext": ["kind", "version", "hash"],
  "documents.latestContext": ["version", "hash"],
  "documents.confirmedAt": ["time"],
  "documents.derivedFrom": ["version"],
  "documents.compareVersion": ["version"],
  "documents.readVersion": ["version"],
  "documents.confirmVersion": ["version"],
  "models.workerClient": ["index"],
  "models.workerModel": ["index"],
  "models.remove": ["index"],
  "records.messageCount": ["count"],
  "records.taskCount": ["count"],
  "records.resultCount": ["count"],
  "task.progress": ["completed", "total"],
  "approval.requestedBy": ["actor"],
  "session.attempt": ["number"],
  // Slice A's progress and board counters. They interpolate in both catalogs, so they belong
  // here; a key that is not declared is one a caller can mistype without the type noticing.
  "overview.verified": ["verified", "total"],
  "shell.snapshotAge": ["seconds"],
  "shell.notificationsCount": ["count"],
  "tasks.count": ["count"],
  "tasks.criteriaOf": ["verified", "total"],
  // C2's review-round line: a blocking finding count, so it is declared here like every
  // other key that interpolates.
  "reviews.blockingFindings": ["count"],
  "reviews.roundLabel": ["round"],
  "reviews.chatContext": ["task"],
  "analytics.partial": ["measured", "total"],
  "analytics.knownOutcomes": ["count"],
  "analytics.attemptCount": ["count"],
  "analytics.agentIndex": ["index"],
  "projects.fileCount": ["count"],
  "projects.createConsequence": ["name"],
  "projects.pushConsequence": ["name"],
  "projects.registerConsequence": ["name"],
  "projects.openConsequence": ["name"],
  // U17a — the Flow view names a seat, its role and its state.
  "flow.selected": ["name", "state"],
  "flow.selectedName": ["name"],
  "flow.nodeLabel": ["name", "role", "state"],
  "overview.integrationHistory": ["count"],
  "tasks.followUpOf": ["name"],
  // MVP — the completion panel names the review task a completion created and the task a
  // review reopened, so both carry the task id they name.
  "completion.reviewCreated": ["taskId"],
  "completion.reworkOpened": ["taskId"],
  // T017 — a stop the daemon could not observe says how many attempts are still alive.
  "workspace.stopUnresolved": ["count"],
  // U10 — the team surface names and times. A review is named by the task it reviews and its
  // round; the line counts what is left; the merge plate names the branch it moves.
  "team.reviewName": ["of"],
  "team.reviewNameRound": ["round", "of"],
  "team.line.waitingOn": ["count"],
  "team.merge.title": ["branch"],
  "team.merge.ready": ["count"],
  "team.merge.consequence": ["branch", "commits", "from"],
  "team.plan.approved": ["time"],
  "team.plan.work": ["count"],
  "team.task.attemptN": ["round"],
  "team.task.roundN": ["round"],
  "team.task.findingCount": ["count"],
  "team.task.blockingCount": ["count"],
  "team.time.minutes": ["count"],
  "team.time.hours": ["count"],
  "team.time.yesterday": ["time"],
  // U8 — a resume that raises a budget says by how much, in the same request.
  "team.resume.minutes": ["count"],
  "team.resume.retries": ["count"],
  "team.resume.rounds": ["count"],
  "team.merge.openTasks": ["count"],
  // Plan R17 — a GitHub project's run is merged as its numbered pull request.
  "team.merge.pullRequest": ["number"],
  "team.pullRequest.link": ["number"],
  "overview.mergePullRequestConsequence": ["number"],
  // U13 — a rule editor labels each row by its position.
  "intake.ruleName": ["index"],
  "intake.ruleInstruction": ["index"],
  "intake.removeRule": ["index"],
} as const satisfies Partial<Record<MessageKey, readonly string[]>>;

export type MessageArguments<Key extends MessageKey> = Key extends keyof typeof MESSAGE_PARAMETERS
  ? [values: Record<(typeof MESSAGE_PARAMETERS)[Key][number], string | number>]
  : [];

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "interface";
    resources: { interface: typeof english };
    keySeparator: false;
    nsSeparator: false;
    strictKeyChecks: true;
    returnNull: false;
  }
}

export const STATUS_LABEL_KEYS = {
  queue: {
    pending: "status.queue.pending",
    "in-progress": "status.queue.in-progress",
    done: "status.queue.done",
    blocked: "status.queue.blocked",
    failed: "status.queue.failed",
    denied: "status.queue.denied",
    canceled: "status.queue.canceled",
    "handed-off": "status.queue.handed-off",
  },
  run: {
    pending: "status.run.pending",
    approved: "status.run.approved",
    cancel_requested: "status.run.cancel_requested",
    canceled: "status.run.canceled",
    invalidated: "status.run.invalidated",
    blocked: "status.run.blocked",
  },
  approval: {
    pending: "status.approval.pending",
    approved: "status.approval.approved",
    rejected: "status.approval.rejected",
    expired: "status.approval.expired",
    invalidated: "status.approval.invalidated",
  },
  attempt: {
    running: "status.attempt.running",
    stopped: "status.attempt.stopped",
    unknown: "status.attempt.unknown",
  },
  receipt: {
    accepted: "status.receipt.accepted",
    "pending-execution": "status.receipt.pending-execution",
    conflict: "status.receipt.conflict",
    denied: "status.receipt.denied",
    observed: "status.receipt.observed",
  },
} as const satisfies Record<string, Record<string, MessageKey>>;
export type StatusDomain = keyof typeof STATUS_LABEL_KEYS;

/** U8 — stable keys for daemon blockers and dispatch refusals. */
export const TEAM_REASON_LABEL_KEYS = {
  leadWakeHourly: "team.reason.leadWakeHourly",
  leadWakeCycles: "team.reason.leadWakeCycles",
  reviewLimitExhausted: "team.reason.reviewLimitExhausted",
  retryLimitExhausted: "team.reason.retryLimitExhausted",
  initialAttemptRegistration: "team.reason.initialAttemptRegistration",
  clockMovedBackwards: "team.reason.clockMovedBackwards",
  activeWallClockBudget: "team.reason.activeWallClockBudget",
  ownerPaused: "team.reason.ownerPaused",
  implementationApprovalInactive: "team.reason.implementationApprovalInactive",
  runClosedToDispatch: "team.reason.runClosedToDispatch",
  nativeIdentityUnknown: "team.reason.nativeIdentityUnknown",
  nativeLaunchUnresolved: "team.reason.nativeLaunchUnresolved",
  providerPolicyUnverified: "team.reason.providerPolicyUnverified",
  liveSessionLimit: "team.reason.liveSessionLimit",
  planBindingChanged: "team.reason.planBindingChanged",
  recoveryWedge: "team.reason.recoveryWedge",
  leadFailed: "team.reason.leadFailed",
  generic: "team.reason.generic",
} as const satisfies Record<string, MessageKey>;

export interface OwnerLanguagePreference {
  read(): unknown | Promise<unknown>;
  write(language: InterfaceLanguage): void | Promise<void>;
}

export interface InterfaceI18n {
  /** Bind this instance to the client; use changeLanguage to persist choices. */
  readonly instance: i18n;
  readonly language: InterfaceLanguage;
  t<Key extends MessageKey>(key: Key, ...values: MessageArguments<Key>): string;
  statusLabel(domain: StatusDomain, code: string): string;
  changeLanguage(language: InterfaceLanguage): Promise<void>;
}

function isLanguage(value: unknown): value is InterfaceLanguage {
  return value === "zh-CN" || value === "en";
}

function requireLanguage(value: unknown): asserts value is InterfaceLanguage {
  if (!isLanguage(value)) throw new RangeError("Unsupported interface language");
}

/** Storage remains in owner-client configuration, never daemon or agent state. */
export async function createInterfaceI18n(options: {
  language?: InterfaceLanguage;
  preference?: OwnerLanguagePreference;
} = {}): Promise<InterfaceI18n> {
  if (options.language !== undefined) requireLanguage(options.language);
  const saved = options.language ?? await options.preference?.read();
  const instance = createInstance();
  await instance.init({
    lng: isLanguage(saved) ? saved : DEFAULT_LANGUAGE,
    supportedLngs: [...SUPPORTED_LANGUAGES],
    load: "currentOnly",
    fallbackLng: { "zh-CN": ["en"], en: ["zh-CN"], default: ["zh-CN", "en"] },
    ns: ["interface"],
    defaultNS: "interface",
    keySeparator: false,
    nsSeparator: false,
    returnNull: false,
    returnEmptyString: false,
    interpolation: { escapeValue: false, skipOnVariables: true },
    resources: {
      "zh-CN": { interface: { ...CATALOGS["zh-CN"] } },
      en: { interface: { ...CATALOGS.en } },
    },
  });

  let changes: Promise<void> = Promise.resolve();
  return {
    instance,
    get language() { return instance.language as InterfaceLanguage; },
    t(key: MessageKey, ...values: [] | [Record<string, string | number>]) {
      return instance.t(key, values[0] ?? {}) as string;
    },
    statusLabel(domain, code) {
      if (!Object.hasOwn(STATUS_LABEL_KEYS, domain)) return code;
      const labels: Readonly<Record<string, MessageKey>> = STATUS_LABEL_KEYS[domain];
      const key = Object.hasOwn(labels, code) ? labels[code] : undefined;
      return key ? instance.t(key, { defaultValue: code }) as string : code;
    },
    changeLanguage(language) {
      const change = changes.then(async () => {
        requireLanguage(language);
        await options.preference?.write(language);
        await instance.changeLanguage(language);
      });
      // Recover the queue tail, while returning the original error to its caller.
      changes = change.catch(() => {});
      return change;
    },
  };
}
