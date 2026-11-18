import React, { useEffect, useRef, useState } from "react";
import { ExternalLink, LoaderCircle, RefreshCw } from "lucide-react";
import { api, native, nativeAvailable } from "./api";
import "./about-settings.css";

const repository = "https://github.com/Lee-xeo/Claude-Cage";
const sourceMessages = {
  current: "Синхронизировано с основной веткой",
  available: "В основной ветке есть новые коммиты",
  ahead: "Коммит текущей сборки опережает основную ветку",
  diverged: "Текущая сборка разошлась с основной веткой — проверьте различия",
  unknown: "В сборке нет данных о коммите, проверить актуальность нельзя",
};
const releaseMessages = {
  current: "Установлена последняя версия (включая предварительные)",
  available: "Доступна новая версия",
  ahead: "Текущая версия новее последней",
  unknown: "Версии не удалось сравнить — проверьте примечания к выпуску",
  missing: "Нет публичных версий для сравнения",
};

function RepositoryLink({ kind, onError, children }) {
  const url = `${repository}/${kind === "source" ? "commits/main" : "releases"}`;
  return <a href={url} target="_blank" rel="noopener noreferrer" onClick={async event => {
    if (!nativeAvailable()) return;
    event.preventDefault();
    try { await native("appReference", { kind }); }
    catch (error) { onError(error.message); }
  }}>{children}<ExternalLink size={13} aria-hidden="true" /></a>;
}

function CheckResult({ label, item, source, onError }) {
  return <section className="about-result" aria-label={label}>
    <h4>{label}</h4>
    {!item ? <p className="footnote">Ещё не проверено</p> : <>
      <p className={item.error ? "error-message" : "about-result-status"}>
        {item.error || (source ? sourceMessages : releaseMessages)[item.status]}
      </p>
      {item.retryAt && <p className="footnote">Повторить можно после {new Date(item.retryAt).toLocaleString()}</p>}
      {source && item.commit && <p className="about-result-detail">Коммит основной ветки <code title={item.commit}>{item.commit.slice(0, 12)}</code></p>}
      {source && item.status === "available" && item.aheadBy > 0 && <p className="footnote">В основной ветке {item.aheadBy} новых коммитов</p>}
      {!source && item.version && <p className="about-result-detail">{item.version} · {item.prerelease ? "предварительная версия" : "стабильная версия"}</p>}
      <RepositoryLink kind={source ? "source" : "releases"} onError={onError}>{source ? "Смотреть коммиты" : "Примечания к выпуску и загрузка"}</RepositoryLink>
    </>}
  </section>;
}

export function AboutSettings() {
  const [build, setBuild] = useState(null);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [clock, setClock] = useState(Date.now);
  const retryAt = Math.max(Date.parse(result?.source?.retryAt || "") || 0, Date.parse(result?.release?.retryAt || "") || 0);
  const coolingDown = retryAt > clock;
  useEffect(() => {
    if (!coolingDown) return;
    const timer = setTimeout(() => setClock(Date.now()), Math.min(60000, retryAt - Date.now()));
    return () => clearTimeout(timer);
  }, [clock, coolingDown, retryAt]);
  const request = useRef(null);
  useEffect(() => {
    const controller = new AbortController();
    api("/client/about", undefined, undefined, {}, { signal: controller.signal })
      .then(setBuild).catch(error => { if (!controller.signal.aborted) setError(error.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); request.current?.abort(); };
  }, []);
  const check = async () => {
    if (request.current || retryAt > Date.now()) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError(""); setResult(null);
    try {
      const next = await api("/client/about", {}, undefined, {}, { signal: controller.signal });
      setBuild(next.build); setResult(next); setClock(Date.now());
    } catch (error) { if (!controller.signal.aborted) setError(error.message); }
    finally {
      request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return <section className="about-settings" aria-label="О Cage">
    <div className="section-title"><h3>О программе</h3><p>Версия Cage и сведения об обновлениях</p></div>
    <dl className="about-build">
      <div><dt>Версия ПО</dt><dd>{loading ? "Чтение…" : build?.version || "Неизвестно"}</dd></div>
      <div><dt>Коммит сборки</dt><dd>{build?.commit ? <code title={build.commit}>{build.commit.slice(0, 12)}</code> : loading ? "Чтение…" : "Не записан"}</dd></div>
    </dl>
    {build?.modified && <p className="footnote">Сборка содержит незакоммиченные изменения; сверка коммитов отражает только записанный коммит.</p>}
    <div className="about-check-actions">
      <button className="secondary-button" onClick={check} disabled={busy || coolingDown}>
        {busy ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}
        {busy ? "Проверка…" : coolingDown ? "Ожидание повтора" : "Проверить обновления"}
      </button>
      {result?.checkedAt && <span className="footnote">Время проверки: {new Date(result.checkedAt).toLocaleString()}</span>}
    </div>
    <p className="footnote">Коммит основной ветки и последняя версия (включая предварительные) проверяются через сеть хоста и системный прокси; при сбое подключения используется прокси, выбранный в Cage. После проверки можно скачать версию со страницы выпусков.</p>
    {busy && <p role="status">Сверка коммитов и выпусков…</p>}
    {error && <p className="error-message" role="alert">{error}</p>}
    <div className="about-results" aria-live="polite" aria-busy={busy}>
      <CheckResult label="Обновление исходников" item={result?.source} source onError={setError} />
      <CheckResult label="Обновление версии (включая предварительные)" item={result?.release} onError={setError} />
    </div>
  </section>;
}
