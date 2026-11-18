import React, { useState } from "react";
import { api } from "./api";
import { Modal } from "./modal";
import { SafetyMessage } from "./safety-message";
import "./device-checks.css";

const labels = { passed: "Пройдено", failed: "Не пройдено", unknown: "Не наблюдается", warning: "Требует внимания", observed: "Наблюдалось" };
const renderers = { software: "Программный рендеринг", "virtual-gpu": "Виртуальный GPU", "driver-reported": "Рендерер по данным драйвера", unobserved: "Не наблюдается" };

export function DeviceChecks({ target, disabled = false }) {
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(selected) {
    setBusy(true); setError(""); setReport(null);
    try { setReport(await api("/environment/device-check", { target: selected })); }
    catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  return <section className="device-checks" aria-label="Проверка конфигурации и рендеринга устройств">
    <h4>Проверка конфигурации и рендеринга устройств</h4>
    <p>Сверяет фактическую конфигурацию, идентичность браузера и графические возможности. Результаты помогают выявить расхождения и не подтверждают физическое устройство или анонимность.</p>
    <div className="device-check-actions">
      {(!target || target === "browser") && <button disabled={busy || disabled} onClick={() => run("browser")}>{busy ? "Проверка…" : "Проверить браузер"}</button>}
      {(!target || target === "desktop") && <button disabled={busy || disabled} onClick={() => run("desktop")}>{busy ? "Проверка…" : "Проверить Claude Desktop"}</button>}
    </div>
    {error && <p role="alert"><SafetyMessage message={error} /></p>}
    {report && <div aria-live="polite">
      <p>{report.target === "desktop" ? "Claude Desktop" : "Браузер"} · {new Date(report.checked_at).toLocaleString()}</p>
      {report.renderer_class && <p>Фактическая графическая среда: {renderers[report.renderer_class] || "Не наблюдается"}</p>}
      {report.browser && <details><summary>Фактические значения браузера</summary><dl>
        <dt>User Agent</dt><dd>{report.browser.user_agent}</dd>
        <dt>Графический рендерер</dt><dd>{report.browser.webgl.renderer || "Не наблюдается"}</dd>
        <dt>Размер экрана</dt><dd>{report.browser.screen.width} × {report.browser.screen.height}, соотношение пикселей {report.browser.screen.pixel_ratio}</dd>
        <dt>Viewport диагностического документа</dt><dd>{report.browser.viewport.width} × {report.browser.viewport.height}</dd>
      </dl></details>}
      <ul className="device-check-results">{report.checks.map(check => <li key={check.id} data-state={check.state}><strong>{check.title}</strong><span>{labels[check.state] || "Не наблюдается"}</span><p>{check.evidence}</p></li>)}</ul>
    </div>}
  </section>;
}

export function DeviceCheckButton({ target = "desktop", disabled = false }) {
  const [open, setOpen] = useState(false);
  return <><button disabled={disabled} onClick={() => setOpen(true)}>Проверить среду</button>{open && <Modal title="Проверка конфигурации и рендеринга устройств" onClose={() => setOpen(false)}><div className="modal-body"><DeviceChecks target={target} /></div></Modal>}</>;
}
