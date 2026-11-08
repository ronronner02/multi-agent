import { TextPreview } from "../text-preview.js";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TeamOwnerRead } from "@openrig/daemon/team-control";
import { namedSeat } from "../display.js";
import { attemptForSeat, SeatHeading, taskForSeat, WorkspaceView } from "./workspace-view.js";
import { WorkspaceFocus } from "./workspace-focus.js";

export function WorkspaceScreen({ read, selectedTaskId }: { read?: TeamOwnerRead; selectedTaskId: string }) {
  const { t } = useTranslation();
  const [layout, setLayout] = useState<"grid" | "split" | "focus">("grid");
  const [selected, setSelected] = useState("");
  const seats = read?.seats ?? [];
  const taskSeat = read?.tasks.find(task => task.taskId === selectedTaskId)?.seat;
  const seat = seats.find(seat => seat.seat === (selected || taskSeat))
    ?? seats.find(seat => !seat.retired && attemptForSeat(read, seat)?.state === "running")
    ?? seats.find(seat => !seat.retired) ?? seats[0];
  return <main className="ui-screen ui-workspace">
    <header className="ui-page-head">
      <div><h1>{t("nav.workspace")}</h1><div className="ui-subtitle"><TextPreview text={read?.run.displayName ?? t("value.unavailable")} /></div></div>
      <div className="ui-layout-switch" role="group" aria-label={t("workspace.layout")}>
        {(["grid", "split", "focus"] as const).map(name => <button key={name} aria-pressed={layout === name} onClick={() => setLayout(name)}>
          {t(("workspace." + name) as "workspace.grid")}</button>)}
      </div>
    </header>
    {layout === "grid" ? <WorkspaceView read={read} selected={seat?.seat ?? ""} onSelect={setSelected} />
      : !read || !seat ? <p className="ui-muted">{t("workspace.noTask")}</p>
        : <>
          {layout === "focus" && <label className="ui-focus-select">{t("workspace.agent")}
            <select value={seat.seat} onChange={event => setSelected(event.target.value)}>
              {seats.map(item => <option key={item.seat} value={item.seat}>{namedSeat(item, t)}{item.retired ? " — " + t("workspace.retired") : ""}</option>)}
            </select>
          </label>}
          <div className={layout === "split" ? "ui-workspace-split" : "ui-workspace-focus"}>
            {layout === "split" && <div className="ui-seat-list" role="group" aria-label={t("workspace.agent")}>
              {seats.map(item => <button className="ui-card ui-seat-choice" key={item.seat} aria-pressed={item.seat === seat.seat}
                onClick={() => setSelected(item.seat)}><SeatHeading seat={item} task={taskForSeat(read, item)} /></button>)}
            </div>}
            <WorkspaceFocus read={read} seat={seat} />
          </div>
        </>}
  </main>;
}
