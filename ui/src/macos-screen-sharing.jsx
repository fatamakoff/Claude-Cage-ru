import React from "react";
import "./initialization.css";

const labels = { passed: "Пройдено", failed: "Не пройдено", unknown: "Не завершено" };

export function ScreenSharingChecks({ checks = [], summary, status }) {
  const items = checks.length ? checks : status?.checks || [];
  const text = summary || status?.summary;
  if (!text && items.length === 0) return null;
  return <>
    {text && <p role="status">{text}</p>}
    {items.length > 0 && <ol className="initialization-checks" aria-label="Результаты проверки общего доступа к экрану">
      {items.map(check => <li key={check.id}>
        <strong>{check.title} · {labels[check.state] || "Не завершено"}</strong>
        <p>{check.evidence}</p>
        {check.state !== "passed" && check.remedy && <p>{check.remedy}</p>}
      </li>)}
    </ol>}
  </>;
}
