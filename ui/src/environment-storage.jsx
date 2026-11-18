import React, { useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import { api, native, nativeAvailable } from "./api";
import { SafetyMessage } from "./safety-message";

export function EnvironmentStorage({ status, onConfirm }) {
  const [location, setLocation] = useState(null);
  const [pending, setPending] = useState(null);
  const [directory, setDirectory] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const job = status.job;
  const recovery = status.storage_recovery?.required ? status.storage_recovery : location?.recovery;
  const storageJob = job?.kind === "storage" || job?.kind === "storage-recovery";
  const busy = submitting || Boolean(pending) || Boolean(job?.running);
  useEffect(() => {
    let live = true;
    if (pending && job?.id === pending.previousJob) return;
    if (storageJob && job.running) return;
    api("/environment/storage").then((next) => {
      if (!live) return;
      setLocation(next);
      if (pending) {
        setPending(null);
        if (job?.id === pending.id && job.error) setError(job.error);
        else if (job?.id === pending.id || next.directory && next.directory === pending.path) { setDirectory(""); setError(""); }
        else setError("Операция завершена. Проверьте текущий каталог среды и повторите попытку.");
      }
    }).catch((e) => {
      if (live) { setError(e.message); setPending(null); }
    });
    return () => { live = false; };
  }, [pending, job?.id, job?.running, storageJob, status.storage_recovery?.required]);

  const choose = async () => {
    setError("");
    try {
      const selected = await native("chooseFolder", { purpose: "environmentStorage" });
      if (selected) setDirectory(selected);
    } catch { setError("Не удалось выбрать папку. Укажите абсолютный путь вручную."); }
  };
  const apply = async () => {
    if (!location?.directory || busy || recovery?.required) return;
    const path = directory.trim();
    if (location.has_environment && !(await onConfirm({
      title: "Переместить локальную среду?",
      body: `Сначала сохраните файлы. Cage остановит среду и терминалы, скопирует виртуальный диск в ${path}, проверит его и затем переключит расположение. Исходные данные сохраняются как резервная копия; после завершения переноса среду можно запустить вручную.`,
      confirm: "Переместить среду",
    }))) return;
    setSubmitting(true);
    setError("");
    try {
      const accepted = await api("/environment/storage", {
        directory: path, previous: location.directory, migrate: location.has_environment,
      });
      setPending({ id: accepted.id, previousJob: job?.id, path });
    } catch (e) { setError(e.message); }
    finally { setSubmitting(false); }
  };
  const recover = async (repair) => {
    if (busy) return;
    setSubmitting(true);
    setError("");
    try {
      const accepted = await api("/environment/storage/recover", { repair });
      setPending({ id: accepted.id, previousJob: job?.id });
    } catch (e) { setError(e.message); }
    finally { setSubmitting(false); }
  };
  return <section className="environment-versions environment-storage" aria-label="Хранилище локальной среды">
    <h4>Хранилище локальной среды</h4>
    {recovery?.required ? <>
      <p className="field-help">Хранилище среды требует восстановления. Подключите диск, использованный для переноса, и повторите попытку. После восстановления среду можно будет запустить.</p>
      <p role="alert" className="error-message"><SafetyMessage message={recovery.error} /></p>
      <div className="storage-actions">
        <button type="button" disabled={busy} onClick={() => recover(false)}>Повторить восстановление</button>
        {recovery.repair_allowed && <button type="button" disabled={busy} onClick={() => recover(true)}>Исправить системный помощник и восстановить</button>}
      </div>
      {recovery.repair_allowed && <p className="field-help storage-repair-help">Для исправления системного помощника требуется авторизация в Windows. После этого восстановление исходной среды продолжится.</p>}
    </> : <>
    <p className="field-help">Системный образ, кэш загрузок и виртуальный диск можно разместить на другом локальном диске. Файлы проектов хранятся в своих папках проектов.</p>
    <div className="setting-summary-row"><span>Текущий каталог среды</span><strong>{location?.directory || "Чтение…"}</strong></div>
    {status.environment_identity_directory && status.environment_identity_directory !== status.environment_directory &&
      <p className="field-help">Файлы из прежнего рабочего каталога остаются в <code>{status.environment_identity_directory}</code>. При необходимости добавьте эту папку из рабочей области; проекты в приватном каталоге настроек Cage нужно сначала переместить за его пределы.</p>}
    {location?.backup && <p className="field-help">Резервная копия до переноса сохранена в <code>{location.backup}</code>. Убедившись, что новая среда запускается и файлы со входами на месте, можно удалить копию самостоятельно.</p>}
    <label>Новое расположение хранилища
      <input value={directory} onChange={(e) => { setDirectory(e.target.value); setError(""); }} spellCheck="false"
        disabled={busy || !location?.directory} placeholder="Полный путь к отдельной пустой папке на локальном диске" />
    </label>
    <div className="storage-actions">
      {nativeAvailable() && <button type="button" disabled={busy || !location?.directory} onClick={choose}><FolderOpen size={15} />Выбрать папку</button>}
      <button type="button" disabled={busy || !location?.directory || !directory.trim() || directory.trim() === location.directory} onClick={apply}>
        {location?.has_environment ? "Переместить сюда" : "Использовать это место"}
      </button>
    </div>
    </>}
    {storageJob && job.running && <p role="status" className="field-help">{job.message}</p>}
    {error && error !== recovery?.error && <p role="alert" className="error-message"><SafetyMessage message={error} /></p>}
  </section>;
}
