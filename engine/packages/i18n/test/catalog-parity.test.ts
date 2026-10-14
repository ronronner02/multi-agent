import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  ApprovalState, AttemptState, ControlReceipt, TeamQueueState, TeamRunState,
} from "../../daemon/src/contracts/team-control.js";
import {
  CATALOGS, DEFAULT_LANGUAGE, MESSAGE_PARAMETERS, STATUS_LABEL_KEYS,
  SUPPORTED_LANGUAGES, createInterfaceI18n,
  type InterfaceLanguage, type MessageKey, type OwnerLanguagePreference,
} from "../src/index.js";

type CatalogFixture = Record<InterfaceLanguage, Partial<Record<MessageKey, string>>>;

function variables(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{\s*([^{}\s]+)\s*\}\}/g)].map((match) => match[1]))].sort() as string[];
}

function parityIssues(catalogs: CatalogFixture): string[] {
  const issues: string[] = [];
  const keys = new Set([
    ...Object.keys(CATALOGS.en), ...Object.keys(catalogs.en), ...Object.keys(catalogs["zh-CN"]),
  ]);
  for (const key of keys) {
    const parameters = MESSAGE_PARAMETERS[key as keyof typeof MESSAGE_PARAMETERS] ?? [];
    for (const language of SUPPORTED_LANGUAGES) {
      const text = catalogs[language][key as MessageKey];
      if (typeof text !== "string" || text.trim() === "") {
        issues.push(`${language}:${key}:missing`);
      } else if (JSON.stringify(variables(text)) !== JSON.stringify([...parameters].sort())) {
        issues.push(`${language}:${key}:interpolation`);
      }
    }
  }
  return issues;
}

function replaceCatalog(client: Awaited<ReturnType<typeof createInterfaceI18n>>, language: InterfaceLanguage,
  catalog: Partial<Record<MessageKey, string>>): void {
  client.instance.removeResourceBundle(language, "interface");
  client.instance.addResourceBundle(language, "interface", catalog);
}

describe("shared catalog contract", () => {
  it("has identical nonempty keys and typed interpolation variables in both catalogs", () => {
    expect(Object.keys(CATALOGS["zh-CN"]).sort()).toEqual(Object.keys(CATALOGS.en).sort());
    expect(parityIssues(CATALOGS)).toEqual([]);
  });

  it("reports missing, empty, extra and mismatched translations", () => {
    const catalogs: CatalogFixture = { "zh-CN": { ...CATALOGS["zh-CN"] }, en: { ...CATALOGS.en } };
    delete catalogs["zh-CN"]["status.queue.done"];
    catalogs.en["status.queue.failed"] = "";
    catalogs.en["task.progress"] = "{{finished}} / {{total}} completed";
    Object.assign(catalogs.en, { "unpaired.key": "Only one language" });
    expect(parityIssues(catalogs)).toEqual(expect.arrayContaining([
      "zh-CN:status.queue.done:missing", "en:status.queue.failed:missing",
      "en:task.progress:interpolation", "zh-CN:unpaired.key:missing",
    ]));
  });

  it("defaults to Chinese and interpolates the same keys in English", async () => {
    const client = await createInterfaceI18n();
    expect(DEFAULT_LANGUAGE).toBe("zh-CN");
    expect(client.language).toBe("zh-CN");
    expect(client.t("task.progress", { completed: 2, total: 3 })).toBe("已完成 2 / 3");
    await client.changeLanguage("en");
    expect(client.language).toBe("en");
    expect(client.t("task.progress", { completed: 2, total: 3 })).toBe("2 / 3 completed");
  });

  it("treats interpolated text as data without translating or escaping it", async () => {
    const client = await createInterfaceI18n({ language: "en" });
    const actor = "$t(language.en) <b>A&B</b> {{total}} 中文";
    expect(client.t("approval.requestedBy", { actor })).toBe(`Requested by ${actor}`);
    expect(actor).toBe("$t(language.en) <b>A&B</b> {{total}} 中文");
  });

  it.each(SUPPORTED_LANGUAGES)("falls back from a missing %s entry and reports the defect", async (language) => {
    const client = await createInterfaceI18n({ language });
    const missing = { ...CATALOGS[language] } as Partial<Record<MessageKey, string>>;
    delete missing["status.queue.done"];
    replaceCatalog(client, language, missing);
    const other = language === "en" ? "zh-CN" : "en";
    expect(client.statusLabel("queue", "done")).toBe(CATALOGS[other]["status.queue.done"]);
    expect(parityIssues({ ...CATALOGS, [language]: missing })).toContain(`${language}:status.queue.done:missing`);
    expect(client.language).toBe(language);
  });

  it("falls back for empty entries, but exposes raw keys/codes when both translations are missing", async () => {
    const client = await createInterfaceI18n();
    const empty = { ...CATALOGS["zh-CN"], "status.queue.done": "" };
    replaceCatalog(client, "zh-CN", empty);
    expect(client.statusLabel("queue", "done")).toBe("Done");
    replaceCatalog(client, "en", { ...CATALOGS.en, "status.queue.done": "" });
    expect(client.statusLabel("queue", "done")).toBe("done");
    expect(client.t("status.queue.done")).toBe("status.queue.done");
  });

  it("does not share mutable resources or selected language between owner clients", async () => {
    const first = await createInterfaceI18n();
    const second = await createInterfaceI18n();
    first.instance.addResource("zh-CN", "interface", "status.queue.done", "fixture");
    await first.changeLanguage("en");
    expect(second.language).toBe("zh-CN");
    expect(second.statusLabel("queue", "done")).toBe("已完成");
    expect(CATALOGS["zh-CN"]["status.queue.done"]).toBe("已完成");
  });

  it("keeps typed message keys and required interpolation parameters", async () => {
    const client = await createInterfaceI18n();
    expectTypeOf(client.t("status.queue.done")).toEqualTypeOf<string>();
    expectTypeOf(client.instance.t("status.queue.done")).toEqualTypeOf<string>();
    if (false) {
      // These calls are checked by the package typecheck, not executed.
      // @ts-expect-error Unknown messages are not part of the shared catalog.
      client.t("not.a.message");
      // @ts-expect-error Interpolated messages require their declared values.
      client.t("task.progress");
      // @ts-expect-error Parameter names must match both catalogs.
      client.t("task.progress", { finished: 2, total: 3 });
      // @ts-expect-error Plain messages take no interpolation object.
      client.t("status.queue.done", { count: 1 });
      // @ts-expect-error The underlying binding also uses the shared key type.
      client.instance.t("not.a.message");
    }
  });
});

describe("display-only status labels", () => {
  it("covers the existing domain contracts without importing daemon runtime into the package", () => {
    expectTypeOf<keyof typeof STATUS_LABEL_KEYS.queue>().toEqualTypeOf<TeamQueueState>();
    expectTypeOf<keyof typeof STATUS_LABEL_KEYS.run>().toEqualTypeOf<TeamRunState>();
    expectTypeOf<keyof typeof STATUS_LABEL_KEYS.approval>().toEqualTypeOf<ApprovalState>();
    expectTypeOf<keyof typeof STATUS_LABEL_KEYS.attempt>().toEqualTypeOf<AttemptState>();
    expectTypeOf<keyof typeof STATUS_LABEL_KEYS.receipt>().toEqualTypeOf<ControlReceipt["status"]>();
    expect(STATUS_LABEL_KEYS.queue.pending).not.toBe(STATUS_LABEL_KEYS.approval.pending);
  });

  it.each(SUPPORTED_LANGUAGES)("labels every mapped status in %s", async (language) => {
    const client = await createInterfaceI18n({ language });
    for (const [domain, labels] of Object.entries(STATUS_LABEL_KEYS)) {
      for (const [code, key] of Object.entries(labels)) {
        expect(client.statusLabel(domain as keyof typeof STATUS_LABEL_KEYS, code)).toBe(CATALOGS[language][key]);
      }
    }
  });

  it.each(SUPPORTED_LANGUAGES)("passes unknown %s codes through without guessing or prototype lookup", async (language) => {
    const client = await createInterfaceI18n({ language });
    for (const code of ["future-state", "", "pending.more", "queue:pending", "__proto__", "constructor", "toString", "原始状态"]) {
      expect(client.statusLabel("queue", code)).toBe(code);
    }
    expect(client.statusLabel("queue", "approved")).toBe("approved");
  });

  it("does not change identifiers, events, logs, evidence or agent text on a runtime switch", async () => {
    const event = Object.freeze({ type: "team.control", action: "cancel_requested", status: "pending", payload: {
      agentText: "Original 中文 output", evidence: "review.json", log: "pending -> approved",
    } });
    const before = JSON.stringify(event);
    const client = await createInterfaceI18n();
    expect(client.statusLabel("run", event.status)).toBe("等待批准");
    await client.changeLanguage("en");
    expect(client.statusLabel("run", event.status)).toBe("Awaiting approval");
    expect(JSON.stringify(event)).toBe(before);
  });
});

describe("owner-owned language preference", () => {
  it("loads and persists through the client-owned configuration interface", async () => {
    let saved: unknown = "en";
    const preference: OwnerLanguagePreference = { read: () => saved, write: (value) => { saved = value; } };
    const client = await createInterfaceI18n({ preference });
    expect(client.language).toBe("en");
    await client.changeLanguage("zh-CN");
    expect(saved).toBe("zh-CN");
    const reopened = await createInterfaceI18n({ preference });
    expect(reopened.language).toBe("zh-CN");
  });

  it.each([undefined, null, "fr", "en-US", 7, {}])("defaults stale saved value %j without overwriting configuration", async (saved) => {
    const writes: InterfaceLanguage[] = [];
    const client = await createInterfaceI18n({ preference: { read: () => saved, write: (value) => { writes.push(value); } } });
    expect(client.language).toBe("zh-CN");
    expect(writes).toEqual([]);
  });

  it("honors an explicit initial language without writing a preference on startup", async () => {
    const client = await createInterfaceI18n({ language: "en", preference: {
      read: () => { throw new Error("explicit language should not read storage"); },
      write: () => { throw new Error("startup should not write storage"); },
    } });
    expect(client.language).toBe("en");
  });

  it("exposes configuration read errors instead of inventing a persisted preference", async () => {
    await expect(createInterfaceI18n({ preference: {
      read: () => { throw new Error("configuration read failed"); }, write: () => {},
    } })).rejects.toThrow("configuration read failed");
  });

  it("leaves the current language unchanged on write failure and permits a later retry", async () => {
    let fail = true;
    const client = await createInterfaceI18n({ preference: { read: () => undefined, write: () => {
      if (fail) throw new Error("configuration write failed");
    } } });
    await expect(client.changeLanguage("en")).rejects.toThrow("configuration write failed");
    expect(client.language).toBe("zh-CN");
    fail = false;
    await client.changeLanguage("en");
    expect(client.language).toBe("en");
  });

  it("serializes rapid changes so stored preference and active language finish together", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const writes: InterfaceLanguage[] = [];
    let saved: unknown;
    const client = await createInterfaceI18n({ preference: { read: () => saved, write: async (language) => {
      writes.push(language);
      if (language === "en") await gate;
      saved = language;
    } } });
    const notifications: string[] = [];
    client.instance.on("languageChanged", (language) => { notifications.push(language); });
    const first = client.changeLanguage("en");
    const second = client.changeLanguage("zh-CN");
    await Promise.resolve();
    expect(writes).toEqual(["en"]);
    expect(client.language).toBe("zh-CN");
    release();
    await Promise.all([first, second]);
    expect(writes).toEqual(["en", "zh-CN"]);
    expect(notifications).toEqual(["en", "zh-CN"]);
    expect(saved).toBe(client.language);
    expect(saved).toBe("zh-CN");
  });

  it("rejects unsupported explicit languages without writing configuration", async () => {
    const writes: InterfaceLanguage[] = [];
    const client = await createInterfaceI18n({ preference: { read: () => undefined, write: (language) => { writes.push(language); } } });
    await expect(client.changeLanguage("fr" as InterfaceLanguage)).rejects.toThrow("Unsupported interface language");
    await expect(createInterfaceI18n({ language: "fr" as InterfaceLanguage })).rejects.toThrow("Unsupported interface language");
    expect(writes).toEqual([]);
  });
});
