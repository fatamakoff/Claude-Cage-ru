import React, { useState } from "react";
import { api } from "./api";
import "./environment-cache.css";

function size(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function EnvironmentCache({ status, onConfirm }) {
  const [inventory, setInventory] = useState(null);
  const [selected, setSelected] = useState([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const disabled = working || !status.ready || status.job?.running;

  async function inspect() {
    const next = await api("/environment/cache/inventory", {});
    setInventory(next);
    setSelected([]);
  }

  async function refresh() {
    setWorking(true);
    setError("");
    setResult(null);
    try { await inspect(); }
    catch (failure) { setInventory(null); setSelected([]); setError(failure.message); }
    finally { setWorking(false); }
  }

  async function mutate(action, batch) {
    setWorking(true);
    setError("");
    try {
      const cleaning = action === "clean";
      const choices = inventory.items.filter(item => selected.includes(item.id));
      const confirmed = await onConfirm({
        title: cleaning ? "Очистить выбранный кэш?" : "Восстановить этот набор кэша?",
        body: cleaning
          ? `Перемещение в набор восстановления: ${choices.length} элементов кэша (${size(choices.reduce((total, item) => total + item.bytes, 0))}).\n${choices.map(item => item.title).join(", ")}.\nАккаунты, входы, сессии, проекты и постоянные диски сохраняются. Восстановленная копия всё ещё занимает место; при следующем использовании клиент может создать кэш заново.`
          : "Восстанавливается только этот набор кэша. Используемый кэш и данные, созданные заново в исходном месте, сохраняются — восстановление их не перезаписывает.",
        confirm: cleaning ? "Очистить кэш" : "Восстановить кэш",
      });
      if (!confirmed) return;
      const outcome = await api(`/environment/cache/${action}`, cleaning
        ? { plan_id: inventory.plan_id, items: selected }
        : { batch });
      setResult({ ...outcome, action, titles: Object.fromEntries(inventory.items.map(item => [item.id, item.title])) });
      // Refresh only as part of the explicit user operation, never on mount or a timer.
      await inspect();
    } catch (failure) {
      setInventory(null);
      setSelected([]);
      setError(failure.message);
    } finally { setWorking(false); }
  }

  return <section className="environment-cache" aria-label="Очистка среды" aria-busy={working}>
    <h4>Очистка среды</h4>
    <p className="field-help">Ручная инвентаризация кэша и защищённых данных текущей среды. Очистка перемещает только кэш из разрешённого списка, сохраняя входы, сессии, проекты, настройки и постоянные диски.</p>
    <div className="environment-version-actions">
      <button disabled={disabled} onClick={refresh}>{working ? "Обработка…" : inventory ? "Обновить инвентаризацию" : "Инвентаризация без изменений"}</button>
      {inventory && <button disabled={disabled || !selected.length} onClick={() => mutate("clean")}>Очистить выбранный кэш{selected.length ? ` (${selected.length})` : ""}</button>}
    </div>
    {!status.ready && <p className="field-help">Сначала запустите текущую среду. Операция не сканирует данные других приложений на этом компьютере.</p>}
    {error && <p role="alert" className="error-message">{error}</p>}
    {result && <div role="status" className="cache-result">
      <strong>{result.status === "partial" ? "Часть элементов не завершена, см. причину" : result.action === "clean" ? "Кэш очищен, копии для восстановления сохранены" : "Кэш восстановлен"}</strong>
      {result.outcomes.map(item => <p key={item.id}>{result.titles[item.id] || item.id}: {item.reason}</p>)}
    </div>}
    {inventory && <>
      <p className="field-help">{inventory.notice}</p>
      <div className="cache-items">
        {inventory.items.filter(item => item.state !== "absent").map(item => <label className="check-line cache-item" key={item.id}>
          <input type="checkbox" aria-label={item.title} checked={selected.includes(item.id)} disabled={disabled || item.state !== "ready"}
            onChange={event => setSelected(previous => event.target.checked ? [...previous, item.id] : previous.filter(id => id !== item.id))} />
          <span><strong>{item.title}</strong><small>{item.location}</small><small>{item.reason}</small></span>
          <span className="cache-size">{size(item.bytes)}<small>файлов: {item.files}</small></span>
        </label>)}
      </div>
      {!inventory.items.some(item => item.state !== "absent") && <p>Кэш из разрешённого списка не найден.</p>}
      <p className="field-help">Работающие клиенты, каталоги с неопределённой принадлежностью и каталоги со ссылками сохраняются. Перед очисткой выполняется повторная сверка; предпросмотр действителен 10 минут.</p>
      <div className="cache-protected" aria-label="Защищённые данные">
        <strong>Эти данные сохраняются</strong>
        {inventory.protected.map(item => <p key={item.title}>{item.title}: найдено {item.present}{item.unknown ? `, не определено: ${item.unknown}` : ""}</p>)}
        <p>Системное хранилище учётных данных, содержимое проектов и постоянные диски не сканируются и не очищаются. Наличие данных не говорит о входе — ориентируйтесь на страницу аккаунтов и то, что показывает клиент.</p>
      </div>
      <div className="cache-recovery" aria-label="Наборы восстановления кэша">
        <h4>Наборы восстановления кэша</h4>
        <p className="field-help">Копии всё ещё занимают место на диске и не удаляются автоматически. Восстановление не перезаписывает новые данные.</p>
        {!inventory.batches.length && <p className="field-help">Нет наборов для восстановления.</p>}
        {inventory.batches.map(batch => <div className="setting-summary-row" key={batch.id}>
          <span>{new Date(batch.created_at * 1000).toLocaleString()} · элементов кэша: {batch.count}</span>
          <button disabled={disabled} onClick={() => mutate("restore", batch.id)}>Восстановить этот набор</button>
        </div>)}
      </div>
    </>}
    <p className="field-help">Процессы инвентаризации, защиты данных и восстановимой очистки основаны на claude-post-ban-cleanup и Claude-Guardian и реализованы в Cage независимо.</p>
  </section>;
}
