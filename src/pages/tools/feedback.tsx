import { useEffect, useState } from "react";

/** Transient success feedback; errors and task status remain until resolved. */
export function useTransientNotice(duration = 4000) {
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), duration);
    return () => window.clearTimeout(timer);
  }, [notice, duration]);
  return [notice, setNotice] as const;
}

export function TaskStatus({ tone, children }: { tone: "success" | "running" | "attention" | "failed"; children: React.ReactNode }) {
  return <span className={`task-status task-status-${tone}`} role="status"><span aria-hidden="true" />{children}</span>;
}
