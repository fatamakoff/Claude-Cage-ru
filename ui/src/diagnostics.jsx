import React, { useEffect, useState } from "react";
import { ArrowDownToLine, LoaderCircle } from "lucide-react";
import { api, native, nativeAvailable } from "./api";
import { reportDiagnostic } from "./diagnostics.mjs";
import { isRemoteClient, runtimeURL } from "./client-context.mjs";

export function DiagnosticSettings() {
  const remote = isRemoteClient();
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    api("/diagnostics").then(value => { if (live) setInfo(value); })
      .catch(error => { if (live) setError(error.message); });
    return () => { live = false; };
  }, []);
  const save = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      if (nativeAvailable()) {
        const result = await native("exportDiagnostics");
        if (!result?.canceled) setNotice("Пакет диагностики сохранён. Проверьте его содержимое перед публикацией.");
      } else {
        // Fetch before downloading so authentication or disk failures are shown.
        const response = await fetch(runtimeURL("/diagnostics/export"));
        if (!response.ok) throw new Error((await response.text()).trim() || "Не удалось экспортировать пакет диагностики");
        if (!response.headers.get("content-type")?.startsWith("application/zip")) throw new Error("Текущий бэкенд не поддерживает экспорт диагностики. Откройте Cage заново");
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement("a"); link.href = url; link.download = "cage-diagnostics.zip"; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
        setNotice("Пакет диагностики загружен. Проверьте его содержимое перед публикацией.");
      }
    } catch (error) { setError(error.message); }
    finally { setBusy(false); }
  };
  return <section className="settings-group" aria-label="Журналы и диагностика">
    <h3>Журналы и диагностика</h3>
    <p className="footnote">Сбои приложения записываются автоматически с обезличиванием и хранятся 14 дней. Каждый журнал бэкенда — до 40 MiB, лимит служб среды — 10 MiB. Пакет диагностики собирает записи подключения к рабочему столу и текущей среды, до 96 MiB. Собираются только журналы сбоев и состояние среды.</p>
    {info && <p className="footnote">{remote ? "Серверные" : "Локальные"} журналы {(info.bytes / 1024 / 1024).toFixed(1)} MiB · файлов: {info.files}</p>}
    <button className="secondary-button" disabled={busy} onClick={save}>
      {busy ? <LoaderCircle size={14} className="spin" /> : <ArrowDownToLine size={14} />}
      {busy ? "Экспорт…" : remote ? "Экспортировать пакет диагностики сервера" : "Экспортировать пакет диагностики"}
    </button>
    <p className="footnote">{remote ? "Пакет диагностики содержит обезличенные журналы локального интерфейса и текущего облачного хоста, версии и состояние сбора; требуется активное удалённое подключение. После экспорта файл сохраняется в выбранное вами место на этом компьютере." : "Пакет диагностики содержит обезличенные журналы интерфейса и среды, версии и состояние сбора; локальные записи можно экспортировать даже при недоступной среде. Сохраняется только в выбранное вами место."}</p>
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="error-message">{error}</p>}
  </section>;
}

export class DiagnosticBoundary extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error, info) { reportDiagnostic("react", new Error(`${error.message}\n${error.stack || ""}\n${info.componentStack || ""}`)); }
  render() {
    if (!this.state.failed) return this.props.children;
    return <main style={{ padding: 32 }}>
      <h2>Ошибка отображения рабочей области</h2>
      <p>Фоновые задачи продолжают работать. Можно экспортировать пакет диагностики и перезагрузить интерфейс.</p>
      <DiagnosticSettings />
      <button className="primary-button" onClick={() => location.reload()}>Перезагрузить интерфейс</button>
    </main>;
  }
}
