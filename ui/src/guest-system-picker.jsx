import React, { useEffect, useRef, useState } from "react";
import { api, native } from "./api";
import { InlineSelect } from "./inline-select";
import "./guest-system-picker.css";

const names = { "debian-12": "Debian 12", "debian-13": "Debian 13", "ubuntu-22.04": "Ubuntu 22.04", "ubuntu-24.04": "Ubuntu 24.04", macos: "macOS", "windows-11": "Windows 11" };
const editions = { Professional: "Профессиональная", ProfessionalN: "Профессиональная N", Enterprise: "Корпоративная", EnterpriseN: "Корпоративная N", Education: "Образовательная", EducationN: "Образовательная N", Core: "Домашняя", CoreSingleLanguage: "Домашняя для одного языка" };
const languages = { "zh-CN": "Китайский (упрощённый)", "zh-TW": "Китайский (традиционный)", "en-US": "Английский (США)" };

export function HostCloneSummary({ pending, onChange }) {
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [attempt, retry] = useState(0);
  useEffect(() => {
    let active = true;
    api("/environment/guest-systems/clone").then((next) => {
      if (!active) return;
      setResult(next);
      onChange((current) => current?.clone ? { ...current, clone_key: next.key, clone_ready: next.enough_space } : current);
    }).catch((failure) => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [attempt, onChange]);
  if (error) return <div className="guest-install-fields" role="alert"><small>{error}</small>
    <button type="button" onClick={() => { setError(""); retry((value) => value + 1); }}>Проверить и подобрать снова</button></div>;
  if (!result) return <small className="guest-install-fields" role="status">Проверка версии системы хоста и подбор официального образа…</small>;
  const plan = result.plan;
  const host = plan.host;
  const download = result.download_bytes > 0 ? `${(result.download_bytes / 1e9).toFixed(2)} GB` : "";
  const source = host.system === "macos" ? "Apple" : host.system === "windows-11" ? "Майкрософт" : "официальный источник дистрибутива";
  const cached = Boolean(plan.path || result.download_bytes === 0 && plan.bytes > 0);
  return <div className="guest-install-fields host-clone-summary" aria-live="polite">
    <strong>Будет установлено: {names[host.system]} {host.system === "windows-11" ? `${host.version} · ${editions[host.edition] || host.edition} · ${languages[host.language] || host.language}` : host.system === "macos" ? plan.version : ""}</strong>
    <small>{pending ? "Используется образ системы, выбранный при первой настройке; установка продолжится в отдельной гостевой системе." : "Официальный образ подбирается по версии системы хоста и устанавливается в отдельную гостевую систему."}</small>
    {host.build && <small>{pending ? "Номер сборки хоста, определённый при первой проверке" : "Номер сборки хоста"} {host.build} · номер сборки образа {plan.build}</small>}
    {host.system === "windows-11" && host.build !== plan.build && <small>Выпуск, редакция и язык Windows совпадают с хостом, отличается только версия обновления.</small>}
    {host.system === "macos" && host.version !== plan.version && <small>На хосте macOS {host.version}. В текущем каталоге Apple нет точно такого же установщика, поэтому будет установлено официальное обновление той же основной версии macOS.</small>}
    <small>Приложения, личные файлы и состояние входа хоста не копируются; инструменты, аккаунты и файлы в гостевой системе сохраняются постоянно.</small>
    <small>{cached ? "Найден подходящий локальный образ: после проверки он используется напрямую, повторная загрузка не требуется." : `Загрузка официального образа системы, источник: ${source}. ${download ? `Осталось скачать около ${download}` : "Размер загрузки будет показан после подключения"}.`}</small>
    <small>{result.installation_started ? "Используется прежний виртуальный диск с сохранённым ходом установки." : `Требуется не менее ${result.minimum_free_gib} GiB свободного места; виртуальный диск растёт по мере использования.`}Компоненты рабочей области — браузер, редактор и другие — загружаются по мере необходимости.</small>
    {!result.enough_space && <small role="alert">Сейчас доступно {result.free_gib} GiB. Выберите в настройках хранилища место с достаточным объёмом и проверьте снова.</small>}
    {!pending && <button type="button" onClick={() => {
      setResult(null);
      onChange((current) => current?.clone ? { ...current, clone_key: "", clone_ready: false } : current);
      retry((value) => value + 1);
    }}>Проверить и подобрать снова</button>}
  </div>;
}

export function GuestSystemPicker({ system, onChange, preserveOnUnmount = false, deferMatch = false }) {
  const [view, setView] = useState(null);
  const [error, setError] = useState("");
  const [attempt, retry] = useState(0);
  const activated = useRef(false);
  useEffect(() => {
    if (!system?.activate || activated.current) return;
    activated.current = true;
    api("/environment/guest-systems/activate",{}).then(() => native("reconnect")).catch(e => setError(e.message));
  }, [system?.activate]);
  useEffect(() => {
    let active = true;
    setError("");
    api("/environment/guest-systems").then((next) => {
      if (!active) return;
      setView(next);
      if (next.fresh || next.pending) {
        onChange(current => !next.pending && current && !current.pending && (current.guest_system !== next.system || !next.host_match_only || current.clone) ? current : ({ guest_system: next.pending?.system || (next.host_match_only ? next.system : "debian-13"), media: next.pending?.media || "",
          sha256: next.pending?.sha256 || "", editor_terms: Boolean(next.pending?.editor_terms),
          clone: Boolean(next.host_match_only && (!next.pending || next.pending.system === next.system) || next.pending?.source && !next.pending?.source_kind), clone_key: "", clone_ready: false,
          activate: next.activate, pending: Boolean(next.pending) }));
      } else onChange(null);
    }).catch((e) => {
      if (!active) return;
      if (e.status === 403 || e.status === 404) onChange(null);
      else setError(e.message);
    });
    return () => { active = false; if (!preserveOnUnmount) onChange(undefined); };
  }, [onChange, attempt, preserveOnUnmount]);
  if (!view || !system) return error ? <div className="guest-system-picker"><span role="alert">{error}</span>
    <button type="button" onClick={() => retry((n) => n + 1)}>Проверить параметры установки снова</button></div> : null;
  const os = system.guest_system;
  const change = (changes) => onChange((current) => current?.guest_system === os ? { ...current, ...changes } : current);
  async function choose() {
    try {
      const path = await native("chooseGuestMedia");
      if (path) change({ media: path });
    } catch (e) { setError(e.message); }
  }
  async function reference(kind) {
    try { await native("guestInstallReference", { kind }); }
    catch (e) { setError(e.message); }
  }
  return (
    <div className="guest-system-picker">
      <span>Гостевая система</span>
      <InlineSelect aria-label="Гостевая система" value={system.clone ? "host" : os} disabled={system.pending}
        onValueChange={(value) => onChange({ guest_system: value === "host" ? view.system : value, clone: value === "host", clone_key: "", clone_ready: false, media: "", sha256: "", editor_terms: false })}>
        {Boolean(view.system) && <option value="host" disabled={!view.available}>Автоподбор версии системы хоста{view.available ? "" : " (недоступно)"}</option>}
        <option value="debian-13">Debian 13</option>
        <option value="ubuntu-22.04" disabled={!view.linux_systems?.includes("ubuntu-22.04")}>Ubuntu 22.04{view.linux_systems?.includes("ubuntu-22.04") ? "" : " (недоступно в этой сборке)"}</option>
        {!view.host_match_only && <option value="macos" disabled={view.system !== "macos" || !view.available}>macOS{view.system === "macos" ? view.available ? "" : " (сейчас недоступно)" : " (требуется совместимый Mac)"}</option>}
        <option value="windows-11" disabled={view.system !== "windows-11" || !view.available}>Windows 11{view.system === "windows-11" ? view.available ? "" : " (сейчас недоступно)" : " (требуются Windows 11 и Hyper-V)"}</option>
      </InlineSelect>
      {system.clone && !system.activate && (deferMatch ? <small className="guest-install-fields">Cage проверит версию системы хоста и на следующем шаге покажет подходящий официальный образ, объём загрузки и требования к месту.</small> : <HostCloneSummary pending={system.pending} onChange={onChange} />)}
      {!system.activate && <small className="guest-install-fields">Образ системы загружается через сеть хоста с учётом системного прокси или TUN хоста и не использует гостевой прокси Cage. При использовании Clash и подобных программ сначала включите системный прокси или TUN; правила прокси определяют фактический выход к сайту с образами.</small>}
      {!system.clone && os !== "debian-13" && !system.activate && <div className="guest-install-fields">
        {os === "ubuntu-22.04" ? <>
          <small>Образ Ubuntu 22.04 LTS загружается с официального источника Ubuntu с проверкой SHA-256. Cage выбирает ARM64 или x86_64 по архитектуре хоста.</small>
          <small>Инструменты разработки, браузер и редактор устанавливаются автоматически. Аккаунты, файлы и состояние входа гостевой системы хранятся на отдельном постоянном виртуальном диске.</small>
          <small>Нужно не менее 17 GiB свободного места. После сбоя можно продолжить установку; система не будет заменена или перезаписана.</small>
        </> : os === "macos" ? <>
          <small>{system.media || "Будет загружена macOS 26.5.2 с Apple (19,77 ГБ) и создан разреженный виртуальный диск на 64 GiB."}</small>
          {!system.pending && <div>
            <button type="button" onClick={choose}>Выбрать локальный IPSW</button>
            {system.media && <button type="button" onClick={() => change({ media: "" })}>Скачать вместо этого</button>}
          </div>}
          <small>Аккаунт гостевой системы и отдельный пароль Cage автоматически готовит и шифрует; вход выполняется автоматически при запуске.</small>
        </> : <>
          <small>Windows 11 x64 требует Hyper-V и не менее 64 GiB свободного места на диске. Перед установкой задайте локального администратора гостевой системы в окне авторизации; Cage создаст ответ для офлайн-аккаунта. После входа в рабочий стол гостевой системы вернитесь в Cage, чтобы продолжить, и подтвердите установку компонентов этим аккаунтом. Затем Cage создаст отдельный обычный аккаунт и перезапустит гостевую систему.</small>
          {!system.pending && <div>
            <button type="button" onClick={() => reference("windows-media")}>Скачать ISO у Microsoft</button>
            <button type="button" onClick={choose}>Выбрать локальный ISO</button>
          </div>}
          {system.media && <small>{system.media}</small>}
          <label>SHA-256 ISO<input value={system.sha256} readOnly={system.pending} spellCheck={false}
            onChange={(e) => change({ sha256: e.target.value.trim() })} placeholder="64-значная шестнадцатеричная сумма от Microsoft" /></label>
          <button type="button" onClick={() => reference("editor-license")}>Прочитать условия лицензии Microsoft VS Code Server</button>
          <label><input type="checkbox" checked={system.editor_terms} disabled={system.pending}
            onChange={(e) => change({ editor_terms: e.target.checked })} />Я принимаю условия лицензии редактора</label>
        </>}
      </div>}
      {system.clone && os === "windows-11" && <div className="guest-install-fields">
        <small>При установке потребуется подтвердить права администратора Windows; затем Cage автоматически установит систему и создаст отдельный аккаунт гостевой системы.</small>
        <button type="button" onClick={() => reference("editor-license")}>Прочитать условия лицензии Microsoft VS Code Server</button>
        <label><input type="checkbox" checked={system.editor_terms} disabled={system.pending}
          onChange={(e) => change({ editor_terms: e.target.checked })} />Я принимаю условия лицензии редактора</label>
      </div>}
      {view.reason && !view.available && <small className="guest-install-fields">{view.reason}</small>}
      {view.reselect && <button type="button" className="guest-install-fields" onClick={async () => {
        try {
          await api("/environment/guest-systems", { id: view.pending.id }, "DELETE");
          setView(await api("/environment/guest-systems"));
          onChange({ guest_system: view.host_match_only ? view.system : "debian-13", clone: Boolean(view.host_match_only), clone_key: "", clone_ready: false, media: "", sha256: "", editor_terms: false });
        } catch (e) { setError(e.message); }
      }}>Выбрать другую систему или образ</button>}
      {system.activate && <small className="guest-install-fields">Гостевая система установлена, можно открыть рабочую область.</small>}
      {error && <p role="alert" className="guest-install-fields">{error}</p>}
    </div>
  );
}

export function validGuestChoice(value) {
  if (value?.clone && !value.activate) return Boolean(value.clone_key && value.clone_ready && (value.guest_system !== "windows-11" || value.editor_terms));
  if (!value || value.activate || value.guest_system === "debian-13" || value.guest_system === "ubuntu-22.04") return true;
  if (value.guest_system === "macos") return true;
  return value.media && /^[a-f\d]{64}$/i.test(value.sha256) && value.editor_terms;
}
