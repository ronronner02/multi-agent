import React, { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { createInterfaceI18n } from "@openrig/i18n";
import { I18nextProvider } from "react-i18next";
import { OwnerDialog } from "../decision-dialog.js";

it.each(["en", "zh-CN"] as const)("focuses the dialog scope before actions and restores its trigger (%s)", async locale => {
  const language = await createInterfaceI18n({ preference: { read: () => locale, write() {} } });
  function Dialog() {
    const [trigger, setTrigger] = useState<HTMLElement | null>(null);
    const [failed, setFailed] = useState(false);
    return <div className="team-shell">
      <button onClick={event => setTrigger(event.currentTarget)}>{language.t("action.approve")}</button>
      {trigger && <OwnerDialog title={language.t("team.confirm")} description={language.t("action.approve")}
        trigger={trigger} onClose={() => setTrigger(null)}>
        <p>{"src/long-scope/".repeat(50)}</p>
        {failed && <p role="alert">{language.t("team.conflict")}</p>}
        <button onClick={() => setFailed(true)}>{language.t("web.confirmDecision")}</button>
      </OwnerDialog>}
    </div>;
  }
  render(<I18nextProvider i18n={language.instance}><Dialog /></I18nextProvider>);
  const trigger = screen.getByRole("button", { name: language.t("action.approve") });
  fireEvent.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: language.t("team.confirm") });
  await waitFor(() => expect(document.activeElement).toBe(dialog));
  expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: language.t("web.confirmDecision") }));
  expect(screen.getByRole("alert").textContent).toBe(language.t("team.conflict"));
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});
