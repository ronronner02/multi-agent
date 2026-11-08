import { useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp } from "lucide-react";

/** Preserve the full text while keeping long prose from sizing every neighboring panel. */
export function TextPreview({ text }: { text: string }) {
  const { t } = useTranslation();
  const id = useId();
  const body = useRef<HTMLSpanElement>(null);
  const [expandedText, setExpandedText] = useState<string | null>(null);
  const [overflows, setOverflows] = useState(false);
  const expandable = overflows || text.length > 160 || text.split("\n").length > 3;
  const expanded = expandedText === text;
  useLayoutEffect(() => {
    const element = body.current!;
    const measure = () => {
      if (!expanded) setOverflows(element.scrollHeight > element.clientHeight + 1);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element); measure();
    return () => observer.disconnect();
  }, [text, expanded]);
  const Icon = expanded ? ChevronUp : ChevronDown;
  return <span className="ui-text-preview" data-expandable={expandable} data-expanded={expanded}>
    <span ref={body} id={id} className="ui-text-preview-body" tabIndex={expandable && expanded ? 0 : undefined}>{text}</span>
    {expandable && <button type="button" className="ui-text-preview-toggle" aria-controls={id} aria-expanded={expanded}
      onClick={() => setExpandedText(expanded ? null : text)}>{t(expanded ? "layout.showLess" : "layout.showMore")}<Icon aria-hidden="true" /></button>}
  </span>;
}
