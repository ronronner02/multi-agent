import { useEffect, useId, useRef, useState, type RefObject } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import { Search, X } from "lucide-react";
import type { TeamReviewView } from "@openrig/daemon/team-control";
import { taskName } from "./display.js";

export function CommandPalette({ open, onOpenChange, tasks, onChoose, opener }: {
  open: boolean; onOpenChange: (open: boolean) => void; tasks: readonly TeamReviewView[];
  onChoose: (taskId: string) => void; opener: RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const listId = useId();
  const matches = tasks.filter(task => taskName(task, t).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const active = Math.min(selected, matches.length - 1);
  const activeOption = useRef<HTMLButtonElement>(null);
  const activeTaskId = matches[active]?.qitemId;
  useEffect(() => {
    if (open) activeOption.current?.scrollIntoView({ block: "nearest" });
  }, [activeTaskId, open]);
  const close = (next: boolean) => { onOpenChange(next); if (!next) { setQuery(""); setSelected(0); } };
  const choose = (task: TeamReviewView) => { onChoose(task.taskId); close(false); };
  return <Dialog.Root open={open} onOpenChange={close}>
    <Dialog.Overlay className="ui-dialog-overlay ui-command-overlay" />
    <Dialog.Content className="ui-command-palette" aria-describedby={undefined} onCloseAutoFocus={event => {
      event.preventDefault(); opener.current?.focus();
    }}>
      <Dialog.Title className="sr-only">{t("shell.searchJump")}</Dialog.Title>
      <div className="ui-command-input"><Search aria-hidden="true" />
        <input role="combobox" aria-label={t("shell.searchJump")} aria-autocomplete="list" aria-expanded="true"
          aria-controls={listId} aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          value={query} onChange={event => { setQuery(event.target.value); setSelected(0); }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (matches.length) setSelected((active + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length);
            } else if (event.key === "Enter" && matches[active]) { event.preventDefault(); choose(matches[active]!); }
          }} />
        <Dialog.Close className="ui-icon-button" aria-label={t("shell.closeSearch")}><X aria-hidden="true" /></Dialog.Close>
      </div>
      <div id={listId} role="listbox" aria-label={t("nav.tasks")} className="ui-command-results">
        {matches.map((task, index) => <button role="option" key={task.qitemId} id={`${listId}-${index}`}
          ref={index === active ? activeOption : undefined}
          aria-selected={index === active} tabIndex={-1} onMouseMove={() => setSelected(index)} onClick={() => choose(task)}>
          {taskName(task, t)}
        </button>)}
      </div>
      {matches.length === 0 && <p className="ui-command-empty" role="status">{t("shell.noMatchingTasks")}</p>}
    </Dialog.Content>
  </Dialog.Root>;
}
