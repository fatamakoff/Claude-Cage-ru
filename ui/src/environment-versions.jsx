import React, { useEffect, useState } from "react";
import { api } from "./api";
import { SafetyMessage } from "./safety-message";

export function EnvironmentVersions({ status, onConfirm }) {
  const [data, setData] = useState(null), [error, setError] = useState(""), [loading, setLoading] = useState(false), [starting, setStarting] = useState(false);
  const refresh = async () => {
    setLoading(true);
    try { setData(await api("/environment/versions")); setError(""); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    let live = true;
    setLoading(true);
    api("/environment/versions")
      .then((next) => { if (live) { setData(next); setError(""); } })
      .catch((e) => { if (live) setError(e.message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [status.vm_running, status.job?.running]);
  const busy = Boolean(status.job?.running) || starting;
  const update = async (tools) => {
    if (!(await onConfirm({
      title: tools ? "Обновить инструменты среды?" : "Обновить компоненты среды?",
      body: data?.maintenance?.native
        ? "Сначала сохраните данные и завершите работающие терминалы и циклы Claude Code. Обновление перезапустит браузер, редактор и файловые подключения; история чатов, файлы проектов и данные входа сохранятся." + (data.maintenance.guest_system === "windows-11" ? "Подтвердите в системном запросе авторизацию управления хостом и проверьте аккаунт администратора привязанной гостевой системы." : "")
        : "Сначала сохраните содержимое браузера и редактора. Браузер и редактор ненадолго перезапустятся, терминалы внутри редактора могут завершиться; терминалы рабочей области, файлы проектов и состояние входа сохранятся.",
      confirm: tools ? "Обновить инструменты" : "Обновить компоненты",
    }))) return;
    setStarting(true); setError("");
    try { await api(tools ? "/environment/tools" : "/environment/update", {}); }
    catch (e) { setError(e.message); }
    finally { setStarting(false); }
  };
  const componentLabels = { current: "Синхронизировано", update_required: "Требуется обновление", stopped: "Среда остановлена", unknown: "Пока не удаётся определить" };
  const toolNames = { chromium: "Браузер", code_server: "Редактор файлов", claude: "Claude Code", mise: "Менеджер версий инструментов", node: "Node.js", python: "Python", git: "Git", gh: "GitHub CLI", proxy: "Ядро прокси" };
  return (
    <section className="environment-versions" aria-label="Версии среды">
      <h4>Версии и компоненты</h4>
      <div className="setting-summary-row"><span>Служба управления</span><strong>{data?.controller?.version || "—"}</strong></div>
      <div className="setting-summary-row"><span>Компоненты среды</span><strong>{componentLabels[data?.components?.status] || (loading ? "Читаем…" : "Пока не удаётся определить")}</strong></div>
      {data?.tools && <table className="environment-tool-table">
        <thead><tr><th>Инструмент</th><th>Текущая версия</th><th>Управляемая версия</th></tr></thead>
        <tbody>{Object.entries(toolNames).filter(([key]) => data.tools[key]).map(([key, name]) => <tr key={key}><td>{name}</td><td>{data.tools[key]?.current || "—"}</td><td>{data.tools[key]?.required || "—"}</td></tr>)}</tbody>
      </table>}
      {(error || data?.error) && <p role="alert" className="error-message"><SafetyMessage message={error || data.error} /></p>}
      <div className="environment-version-actions">
        <button disabled={loading || busy} onClick={refresh}>{loading ? "Читаем…" : "Обновить версии"}</button>
        {data?.components?.update_required && <button className="primary" disabled={busy || !status.vm_running} onClick={() => update(false)}>Обновить компоненты среды</button>}
        <button disabled={busy || !data?.tools_update_allowed} onClick={() => update(true)}>Обновить инструменты среды</button>
      </div>
      <p className="field-help">{data?.maintenance?.native
        ? "Перед обновлением нативных компонентов завершите работающие терминалы и циклы Claude Code. Системный диск, проекты и данные аккаунтов сохраняются, приостановленная внешняя сеть остаётся приостановленной. Пакеты инструментов готовит и проверяет хост, затем передаёт в гостевую систему."
        : "Обновление компонентов сохраняет виртуальный диск и терминалы. Для обновления инструментов запустите среду и синхронизируйте компоненты; зависимости скачиваются через выбранный прокси — открывать рабочую сеть не требуется, приостановленная внешняя сеть сама не возобновится."}</p>
    </section>
  );
}
