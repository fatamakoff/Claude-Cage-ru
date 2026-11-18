import { MobilePairSettings } from "./mobile-pair-settings";
import { ArchivedSessions } from "./cli-sessions";
import { Smartphone } from "lucide-react";
import { PasswordVaultSettings } from "./password-vault";
import { KeyRound } from "lucide-react";
import { InlineSelect } from "./inline-select";
import { clientKeyboard, isRemoteClient, saveClientKeyboard } from "./client-context.mjs";
import { shortcut, usesControl } from "./platform.mjs";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Globe2,
  Clock3,
  FolderOpen,
  Check,
  LoaderCircle,
  RotateCcw,
  ArrowLeft,
  Settings,
  Palette,
  UserRound,
  Archive,
  Info,
} from "lucide-react";
import { api } from "./api";
import "./settings.css";
import { SafetyMessage } from "./safety-message";
import { AppearanceSettings } from "./appearance-settings";
import { ProxySettings } from "./proxy-settings";
import { ExitPolicyFields } from "./exit-policy";
import { canonicalExitPolicy } from "./safety-state.mjs";
import { EnvironmentVersions } from "./environment-versions";
import { EnvironmentStorage } from "./environment-storage";
import { EnvironmentCache } from "./environment-cache";
import { ResourceSettings } from "./resources";
import { DiagnosticSettings } from "./diagnostics.jsx";
import { MacOSLogin } from "./macos-login";
import { ScreenSharingChecks } from "./macos-screen-sharing";
import { AccountSettings } from "./account";
import { AboutSettings } from "./about-settings";
const sections = [
  ["account", "Аккаунт", UserRound],
  ["vault", "Хранилище паролей", KeyRound],
  ["archived-sessions", "Архив сессий", Archive],
  ["keyboard", "Общие", Settings],
  ["appearance", "Внешний вид", Palette],
  ["mobile", "Удалённое подключение", Smartphone],
  ["network", "Сеть и прокси", Globe2],
  ["region", "Часовой пояс и язык", Clock3],
  ["project", "Среда и восстановление", RotateCcw],
  ["about", "О программе", Info],
];
export function SettingsPanel({
  current,
  status,
  onClose,
  onSaved,
  onConfirm,
  initialSection = "keyboard",
}) {
  const [localKeyboard, setLocalKeyboard] = useState(() => clientKeyboard(current.keyboard));
  const [accountDirty, setAccountDirty] = useState(false);
  const [proxyDirty, setProxyDirty] = useState(false);
  const [resourceDirty, setResourceDirty] = useState(false);
  const [draft, setDraft] = useState({ ...current }),
    [section, setSection] = useState(initialSection),
    [probe, setProbe] = useState(null),
    [probing, setProbing] = useState(false),
    [probeFailed, setProbeFailed] = useState(false),
    [error, setError] = useState(""),
    [jobId, setJobId] = useState(""),
    [submitting, setSubmitting] = useState(false);
  const changed =
    JSON.stringify({
      ...draft,
      browser_home_url: undefined,
      exit_policy: canonicalExitPolicy(draft.exit_policy),
    }) !==
    JSON.stringify({
      ...current,
      browser_home_url: undefined,
      exit_policy: canonicalExitPolicy(current.exit_policy),
    });
  const environmentChanged = [
    "dns_url",
    "timezone",
    "locale",
    "browser_language",
    "auto_timezone",
    "auto_language",
    "exit_policy",
  ].some((k) =>
    k === "exit_policy"
      ? JSON.stringify(canonicalExitPolicy(draft[k])) !==
        JSON.stringify(canonicalExitPolicy(current[k]))
      : draft[k] !== current[k],
  );
  const busy =
    Boolean(status.job?.running) || Boolean(status.storage_recovery?.required) || probing || submitting || Boolean(jobId);
  // Project folders of the other guest systems are always read directly.
  const linuxGuest = !/^(windows|macos)/.test(status.guest_system || "");
  const update = (key, value) => {
    setDraft((p) => ({ ...p, [key]: value }));
    if (["dns_url"].includes(key)) setProbe(null);
    setError("");
  };
  const close = async () => {
    if (submitting) return;
    if (status.job?.running && jobId) {
      onClose();
      return;
    }
    if (
      (!changed && !accountDirty && !proxyDirty && !resourceDirty) ||
      (await onConfirm({
        title: "Отменить несохранённые изменения?",
        body: "Текущая среда не изменится. При закрытии изменения формы будут потеряны.",
        confirm: "Отменить изменения",
      }))
    )
      onClose();
  };
  useEffect(() => {
    if (jobId && status.job?.id === jobId && !status.job.running) {
      setJobId("");
      if (status.job.error || status.job.canceled) {
        if (status.job.settings_saved) onSaved();
        setError(status.job.error || status.job.message);
      } else {
        onSaved();
        if (!proxyDirty) onClose();
      }
    }
  }, [status.job, jobId]);
  const check = async () => {
    setProbing(true);
    setProbeFailed(false);
    setError("");
    try {
      const result = await api("/settings/probe", draft);
      setProbe(result);
      if (draft.auto_timezone)
        setDraft((previous) => ({ ...previous, timezone: result.timezone }));
      if (draft.auto_language && result.suggested_locale)
        setDraft((previous) => ({
          ...previous,
          locale: result.suggested_locale,
          browser_language: result.suggested_browser_language,
        }));
    } catch (e) {
      setError(e.message);
      setProbeFailed(true);
    } finally {
      setProbing(false);
    }
  };
  const save = async () => {
    if (busy) return;
    if (
      environmentChanged &&
      status.vm_running &&
      !(await onConfirm({
        title: "Применить настройки и перезапустить среду?",
        body: "Сначала сохраните файлы в редакторе. Текущие сессии терминала завершатся, страницы и входы в браузере сохранятся.",
        confirm: "Сохранить и перезапустить",
      }))
    )
      return;
    setError("");
    setSubmitting(true);
    try {
      const payload = { ...draft };
      delete payload.browser_home_url;
      const result = await api("/settings", payload);
      setJobId(result.id);
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };
  const zones = useMemo(
    () => [
      ...new Set([
        "Etc/UTC",
        current.timezone,
        ...(Intl.supportedValuesOf?.("timeZone") || []),
      ]),
    ],
    [],
  );
  const contentRef = useRef();
  useEffect(() => {
    contentRef.current?.scrollTo(0, 0);
  }, [section]);
  const currentLoc = probe || status.location;
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement;
    document.getElementById("settings-back")?.focus();
    const dismiss = (event) => {
      if (document.querySelector('[role="dialog"]')) return;
      if (event.type === "cage-close-modal" || event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
      }
    };
    document.addEventListener("keydown", dismiss);
    document.addEventListener("cage-close-modal", dismiss);
    return () => {
      document.removeEventListener("keydown", dismiss);
      document.removeEventListener("cage-close-modal", dismiss);
      previous?.focus?.();
    };
  }, []);
  return (
    <section className="settings-page" aria-label="Настройки">
      <aside className="settings-sidebar">
        <button
          id="settings-back"
          className="back-to-workspace"
          onClick={close}
        >
          <ArrowLeft size={17} />
          Вернуться в рабочую область
        </button>
        <h2>Настройки</h2>
        <nav aria-label="Разделы настроек">
          {sections.map(([id, label, Icon]) => (
            <button
              key={id}
              className={section === id ? "selected" : ""}
              aria-current={section === id ? "page" : undefined}
              onClick={async () => {
                if (id !== section && accountDirty && !(await onConfirm({ title: "Отменить несохранённые изменения?", body: "Сохранённые данные и пароли останутся без изменений.", confirm: "Отменить изменения" }))) return;
                if (id !== section && proxyDirty && !(await onConfirm({ title: "Отменить неприменённые изменения прокси?", body: "Прокси продолжает работать по применённой цепочке. При уходе выбор узлов будет потерян.", confirm: "Отменить изменения" }))) return;
                setSection(id);
              }}
            >
              <Icon size={17} />
              {label}
            </button>
          ))}
        </nav>
      </aside>
      <div className="settings-main">
        <div className={section === "archived-sessions" ? "settings-content settings-content--archives" : section === "mobile" ? "settings-content settings-content--remote" : "settings-content"} ref={contentRef}>
          {section === "appearance" && <AppearanceSettings />}
          {section === "about" && <AboutSettings />}
          {section === "archived-sessions" && <ArchivedSessions ready={status.ready && !busy} />}
          {section === "vault" && <PasswordVaultSettings onConfirm={onConfirm} onDirty={setAccountDirty} />}
          {section === "account" && <AccountSettings busy={busy} onDirty={setAccountDirty} />}
          <fieldset className="settings-fields" disabled={busy && !(section === "project" && status.storage_recovery?.required)}>
            {section === "mobile" && (isRemoteClient()
              ? <section className="section-title"><h3>Подключить этот компьютер</h3><p>Сначала переключитесь на локальную среду этого компьютера, затем создайте код сопряжения или управляйте им.</p></section>
              : <MobilePairSettings relay={draft.mobile_relay ?? ""} savedRelay={current.mobile_relay ?? ""} onChange={value => update("mobile_relay",value)} onConfirm={onConfirm} />)}
            {section === "network" && (
              <>
                <ProxySettings
                  onDirty={setProxyDirty}
                  status={status}
                  onConfirm={onConfirm}
                  onApplied={async () => {
                    setProbe(null);
                    const applied = await api("/settings");
                    if (JSON.stringify(canonicalExitPolicy(applied.exit_policy)) !==
                        JSON.stringify(canonicalExitPolicy(current.exit_policy))) {
                      setDraft(previous => ({ ...previous, exit_policy: applied.exit_policy }));
                    }
                    await onSaved();
                  }}
                />
                <label>
                  Зашифрованный DNS
                  <input
                    value={draft.dns_url}
                    onChange={(e) => update("dns_url", e.target.value)}
                    spellCheck="false"
                  />
                </label>
                <div className="probe-line">
                  <button disabled={busy} onClick={check}>
                    {probing ? (
                      <LoaderCircle size={15} className="spin" />
                    ) : (
                      <Globe2 size={15} />
                    )}
                    Проверить выход
                  </button>
                  <span>Запросить IP и местоположение через текущий узел</span>
                </div>
                {currentLoc && (
                  <div className={`location-result ${probe ? "fresh" : ""}`}>
                    <span className="result-icon">
                      <Globe2 size={19} />
                    </span>
                    <div>
                      <strong>
                        {currentLoc.country} · {currentLoc.city}
                      </strong>
                      <code>{currentLoc.ip}</code>
                      <small>
                        {currentLoc.timezone} ·{" "}
                        {new Date(currentLoc.checked_at).toLocaleTimeString(
                          "ru-RU",
                          { hour: "2-digit", minute: "2-digit" },
                        )}{" "}
                        {probe ? "Проверено" : "Текущая среда · последняя проверка"}
                      </small>
                    </div>
                    {probe && <Check size={18} />}
                  </div>
                )}
                <p className="footnote">
                  Если прокси недоступен, Cage останавливает выход в интернет. После изменения формы требуется повторная проверка.
                </p>
                <section className="network-exit-policy" aria-label="Правила смены IP">
                  <ExitPolicyFields
                    value={draft.exit_policy}
                    onChange={(value) => update("exit_policy", value)}
                    observation={probe}
                    onProbe={check}
                    busy={busy}
                    probing={probing}
                  />
                </section>
              </>
            )}
            {section === "region" && (
              <>
                <div className="section-title">
                  <h3>Часовой пояс и язык</h3>
                  <p>Эти настройки действуют на систему, CLI и браузер внутри Cage.</p>
                </div>
                {!draft.auto_timezone && !draft.auto_language && (
                  <p className="field-help">
                    Часовой пояс и язык берутся из выбранных ниже значений вручную. Для каждого выхода всё равно нужно запрашивать страну или регион и убедиться, что это не материковый Китай; статический IP и отсутствие ограничений по региону не отменяют эту проверку.
                  </p>
                )}
                <label className="toggle-row">
                  <span>
                    <strong>Часовой пояс по IP выхода</strong>
                    <small>
                      Повторный запрос при запуске или применении настроек; работающие задачи не перезапускаются незаметно.
                    </small>
                  </span>
                  <input
                    role="switch"
                    type="checkbox"
                    checked={draft.auto_timezone}
                    onChange={(e) => update("auto_timezone", e.target.checked)}
                  />
                </label>
                <label>
                  {draft.auto_timezone ? "Применяемый часовой пояс" : "Часовой пояс системы"}
                  <InlineSelect editable
                    aria-label={draft.auto_timezone ? "Применяемый часовой пояс" : "Часовой пояс системы"}
                    value={draft.timezone}
                    disabled={draft.auto_timezone}
                    onValueChange={(next) => update("timezone", next)}
                  >
                    {zones.map((zone) => (
                      <option key={zone} value={zone} />
                    ))}
                  </InlineSelect>
                </label>
                {draft.auto_timezone && (
                  <div className="inline-info">
                    <Clock3 size={16} />
                    <span>
                      {probe
                        ? `Рекомендуемый часовой пояс выхода: ${probe.timezone}, применится при сохранении.`
                        : "При сохранении местоположение запрашивается через прокси; при ошибке запроса прежняя конфигурация сохраняется."}
                    </span>
                    <button
                      className="text-button"
                      onClick={check}
                      disabled={busy}
                    >
                      Проверить сейчас
                    </button>
                  </div>
                )}
                <label className="toggle-row">
                  <span>
                    <strong>Язык по региону выхода</strong>
                    <small>
                      Обновляется при запуске или применении настроек. Для многоязычных регионов используются встроенные значения по умолчанию; при отсутствии рекомендации выбранный язык сохраняется.
                    </small>
                  </span>
                  <input
                    role="switch"
                    type="checkbox"
                    checked={Boolean(draft.auto_language)}
                    onChange={(e) => update("auto_language", e.target.checked)}
                  />
                </label>
                {draft.auto_language && (
                  <div className="inline-info">
                    <Globe2 size={16} />
                    <span>
                      {currentLoc?.suggested_locale
                        ? `Рекомендация региона: ${currentLoc.suggested_locale} / ${currentLoc.suggested_browser_language}`
                        : "Рекомендация региона появится после проверки выхода; также можно отключить авторежим и выбрать вручную."}
                    </span>
                    <button
                      className="text-button"
                      onClick={check}
                      disabled={busy}
                    >
                      Проверить сейчас
                    </button>
                  </div>
                )}
                <label>
                  Язык системы
                  <InlineSelect
                    aria-label="Язык системы"
                    value={draft.locale}
                    disabled={draft.auto_language}
                    onValueChange={(next) => update("locale", next)}
                  >
                    {[
                      ["en_US.UTF-8", "English (United States)"],
                      ["zh_CN.UTF-8", "Китайский (упрощённый)"],
                      ["zh_TW.UTF-8", "Китайский (традиционный)"],
                      ["ja_JP.UTF-8", "日本語"],
                      ["de_DE.UTF-8", "Deutsch"],
                      ["fr_FR.UTF-8", "Français"],
                    ].map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                    {![
                      "en_US.UTF-8",
                      "zh_CN.UTF-8",
                      "zh_TW.UTF-8",
                      "ja_JP.UTF-8",
                      "de_DE.UTF-8",
                      "fr_FR.UTF-8",
                    ].includes(draft.locale) && (
                      <option value={draft.locale}>{draft.locale}</option>
                    )}
                  </InlineSelect>
                </label>
                <label>
                  Предпочитаемый язык веб-страниц
                  <InlineSelect
                    aria-label="Предпочитаемый язык веб-страниц"
                    value={draft.browser_language}
                    disabled={draft.auto_language}
                    onValueChange={(next) => update("browser_language", next)}
                  >
                    {[
                      ["en-US", "English (United States)"],
                      ["zh-CN", "Китайский (упрощённый)"],
                      ["zh-TW", "Китайский (традиционный)"],
                      ["ja-JP", "日本語"],
                      ["de-DE", "Deutsch"],
                      ["fr-FR", "Français"],
                    ].map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                    {![
                      "en-US",
                      "zh-CN",
                      "zh-TW",
                      "ja-JP",
                      "de-DE",
                      "fr-FR",
                    ].includes(draft.browser_language) && (
                      <option value={draft.browser_language}>
                        {draft.browser_language}
                      </option>
                    )}
                  </InlineSelect>
                </label>
                <p className="footnote">
                  Страницы по-прежнему могут выбирать язык по своим правилам. Интерфейс рабочей области — на русском.
                </p>
              </>
            )}
            {section === "keyboard" && (
              <>
                <div className="section-title">
                  <h3>Общие</h3>
                  <p>Управление поведением клавиш и повседневными действиями рабочей области.</p>
                </div>
                <label>
                  Формат времени
                  <InlineSelect inline
                    aria-label="Формат времени"
                    value={draft.clock_12_hour ? "12" : "24"}
                    onValueChange={(next) => update("clock_12_hour", next === "12")}
                  >
                    <option value="24">24-часовой формат</option>
                    <option value="12">12-часовой формат (AM/PM)</option>
                  </InlineSelect>
                </label>
                <p className="field-help">
                  По умолчанию используется 24-часовой формат. После сохранения обновляются часы внизу рабочей области без перезапуска среды; 12-часовой формат различает утро и вечер по AM/PM.
                </p>
                <label>
                  Команда запуска терминала Claude
                  <input
                    value={draft.claude_terminal_command ?? "claude"}
                    onChange={(e) => update("claude_terminal_command", e.target.value)}
                    placeholder="claude"
                    maxLength={4096}
                    spellCheck="false"
                    autoComplete="off"
                  />
                </label>
                <p className="field-help">
                  После выбора «Терминал Claude» эта команда выполняется в выбранном проекте, например claude --continue.
                  Если оставить пустым, используется claude; после сохранения это влияет только на новые терминалы Claude, и после выхода из Claude можно продолжить работу в shell.
                </p>
                {typeof current.balanced_display === "boolean" && <label className="toggle-row">
                  <span>
                    <strong>Приоритет плавности</strong>
                    <small>Снижает чёткость браузера и Claude Desktop; в среде Linux также уменьшает анимацию Claude Desktop. Применяется при следующем запуске среды.</small>
                  </span>
                  <input type="checkbox" role="switch" checked={draft.balanced_display}
                    onChange={(event) => update("balanced_display", event.target.checked)} />
                </label>}
                {typeof current.project_file_cache === "boolean" && linuxGuest && <label className="toggle-row">
                  <span>
                    <strong>Кэш файлов проекта</strong>
                    <small>Сокращает обмен с хостом при чтении файлов проекта. Изменения, сделанные на хосте, становятся видны в среде не позднее чем через 20 секунд; также можно нажать «Обновить файлы проекта» на панели проекта для немедленной синхронизации. Применяется при следующем запуске среды.</small>
                  </span>
                  <input type="checkbox" role="switch" checked={draft.project_file_cache}
                    onChange={(event) => update("project_file_cache", event.target.checked)} />
                </label>}
                <h4>Поведение клавиш</h4>
                <div className="choice-list">
                  {[
                    [
                      "mac",
                      "Сочетания Mac",
                      "Использовать ⌘ для веб-страниц и редактора. В гостевых системах Linux и Windows используются соответствующие сочетания с Ctrl, в гостевой macOS сохраняется Command.",
                    ],
                    [
                      "native",
                      "Родные сочетания гостевой системы",
                      "Использовать Control, Command и другие сочетания по правилам гостевой системы.",
                    ],
                  ].map(([value, title, help]) => (
                    <label
                      className={`choice ${(isRemoteClient() ? localKeyboard : draft.keyboard) === value ? "checked" : ""}`}
                      key={value}
                    >
                      <input
                        type="radio"
                        name="keyboard"
                        value={value}
                        checked={(isRemoteClient() ? localKeyboard : draft.keyboard) === value}
                        onChange={() => {
                          if (!isRemoteClient()) { update("keyboard", value); return; }
                          try { saveClientKeyboard(value); setLocalKeyboard(value); setError(""); }
                          catch { setError("Не удалось сохранить поведение клавиатуры на этом компьютере. Проверьте свободное место в локальном хранилище."); }
                        }}
                      />
                      <span>
                        <strong>{title}</strong>
                        <small>{help}</small>
                      </span>
                    </label>
                  ))}
                </div>
                <p className="field-help">
                  В терминале копирование и вставка — {usesControl ? "Ctrl+Shift+C / Ctrl+Shift+V" : "⌘C / ⌘V"}; Ctrl+C всегда прерывает команду.
                  {isRemoteClient() && "Поведение клавиатуры применяется сразу и сохраняется только на этом клиенте, не изменяя облачные настройки."}
                </p>
                <h4>Сочетания клавиш рабочей области</h4>
                <div className="shortcut-list">
                  {[
                    ["Открыть проект", "⌘O"],
                    ["Новая веб-страница", "⌘T"],
                    ["Новый терминал", "⌘⇧↵"],
                    ["Адресная строка", "⌘L"],
                    ["Закрыть текущую вкладку", "⌘W"],
                    ["Переключить вкладку", "⌘1–9"],
                    ["Настройки", "⌘,"],
                  ].map(([label, key]) => (
                    <div key={label}>
                      <span>{label}</span>
                      <kbd>{shortcut(key)}</kbd>
                    </div>
                  ))}
                </div>
              </>
            )}
            {section === "project" && (
              <>
                <div className="section-title">
                  <h3>Среда и восстановление</h3>
                  <p>{isRemoteClient() ? "Проект находится в облаке, изменения в Cage сразу сохраняются в облачные файлы." : "Изменения на хосте и в Cage синхронизируются в обе стороны."}</p>
                </div>
                {status.local_vm_storage && !isRemoteClient() && <EnvironmentStorage status={status} onConfirm={onConfirm} />}
                <div className="setting-summary-row">
                  <span>Текущий проект</span>
                  <strong title={current.workspace}>
                    {current.workspace || "Проект не выбран"}
                  </strong>
                </div>
                <p className="field-help">
                  {isRemoteClient() ? "Нажмите плюс рядом с заголовком «Проект» на боковой панели, чтобы выбрать облачную папку." : "Нажмите плюс рядом с заголовком «Проект» на боковой панели, чтобы выбрать другую локальную папку."}
                </p>
                <div className="project-explanation">
                  <FolderOpen size={22} />
                  <div>
                    <strong>Все проекты используют одну среду Cage</strong>
                    <p>
                      Явно открытые папки проектов становятся доступны в одной среде. Вход в Claude на хосте,
                      SSH-ключи и личные настройки не импортируются автоматически. Загрузки браузера
                      сохраняются в отдельный временный каталог загрузок; их можно открыть или сохранить из панели загрузок.
                    </p>
                  </div>
                </div>
                <p className="footnote">
                  Переключение проекта меняет только начальное расположение новых терминалов и файлового редактора; существующие терминалы, страницы и сеансы входа сохраняются.
                </p>
                {!status.storage_recovery?.required && <EnvironmentVersions status={status} onConfirm={onConfirm} />}
                {!status.storage_recovery?.required && <EnvironmentCache status={status} onConfirm={onConfirm} />}
                {status.guest_system === "macos" && <section aria-label="Разрешения гостевой системы">
                  <h4>Разрешения гостевой системы</h4>
                  <p className="field-help">Выполните авторизацию в ограниченном окне настроек гостевой системы; Cage автоматически проверит и переподключит проект.</p>
                  <div className="project-recovery-actions">
                    <MacOSLogin maintenance="projects" label="Доступ к общим файлам" disabled={!status.ready || busy} />
                    <MacOSLogin maintenance="screen" label="Запись экрана" disabled={!status.ready || busy} />
                    <MacOSLogin maintenance="input" label="Универсальный доступ" disabled={!status.ready || busy} />
                  </div>
                </section>}
                {status.guest_system === "macos" && !isRemoteClient() && <MacOSScreenSharingSettings disabled={!status.ready || busy} onError={setError} />}
                {!status.storage_recovery?.required && <ResourceSettings status={status} onConfirm={onConfirm} onDirtyChange={setResourceDirty} />}
 <DiagnosticSettings />
                {status.can_restore && (
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={async () => {
                      if (
                        await onConfirm({
                          title: "Восстановить предыдущую конфигурацию?",
                          body: "Текущая среда будет остановлена и восстановятся настройки, действовавшие до последнего применения. Завершённые процессы терминала восстановить нельзя.",
                          confirm: "Восстановить и перезапустить",
                        })
                      ) {
                        try {
                          const result = await api("/restore", {});
                          setJobId(result.id);
                        } catch (e) {
                          setError(e.message);
                        }
                      }
                    }}
                  >
                    <RotateCcw size={14} />
                    Восстановить предыдущую конфигурацию
                  </button>
                )}
              </>
            )}
          </fieldset>
          {error && (
            <div role="alert" className="error-message">
              <SafetyMessage message={error} />
              {probeFailed && (draft.auto_timezone || draft.auto_language) && (
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => {
                    setDraft((previous) => ({
                      ...previous,
                      auto_timezone: false,
                      auto_language: false,
                    }));
                    setProbeFailed(false);
                    setError("");
                    setSection("region");
                  }}
                >
                  Указать часовой пояс и язык вручную
                </button>
              )}
            </div>
          )}
        </div>
        {(!["appearance", "browser", "account", "vault", "mobile", "archived-sessions", "project", "about"].includes(section) || changed) && (
          <footer className="settings-footer">
            {" "}
            <>
              <span className="save-note">
                {status.job?.running
                  ? status.job.message
                  : proxyDirty
                    ? "Изменения прокси ждут применения — нажмите «Применить прокси»"
                    : changed
                    ? environmentChanged && status.vm_running
                      ? "Сетевые и системные настройки требуют перезапуска"
                      : "Есть несохранённые изменения"
                    : "Несохранённых изменений нет"}
              </span>
              <button onClick={close}>Вернуться в рабочую область</button>
              <button
                className="primary"
                disabled={!changed || busy}
                onClick={save}
              >
                {busy ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <Check size={15} />
                )}{" "}
                {environmentChanged && status.vm_running
                  ? "Сохранить и перезапустить"
                  : "Сохранить настройки"}
              </button>
            </>
          </footer>
        )}
      </div>
    </section>
  );
}

function MacOSScreenSharingSettings({ disabled, onError }) {
  const [sharingBusy, setSharingBusy] = useState("");
  const [sharingStatus, setSharingStatus] = useState(null);
  async function run(action) {
    setSharingBusy(action);
    onError("");
    try {
      const result = await api("/environment/macos-screen-sharing", { action });
      if (action !== "open") setSharingStatus(result);
    } catch (error) {
      onError(error.message);
    } finally {
      setSharingBusy("");
    }
  }
  return (
    <section aria-label="Общий доступ к экрану гостевой системы">
      <h4>Общий доступ к экрану гостевой системы</h4>
      <p className="field-help">Обычный пункт «Открыть общий доступ к экрану гостевой системы» лишь создаёт локальную SSH-ретрансляцию и не даёт гостевой системе выхода в интернет, поэтому сначала отключать сеть не требуется. При первой установке служба включается на этапе подготовки, а в мастере системной авторизации проверяется её реальная доступность; в macOS 26 её нужно один раз включить вручную в «Системные настройки → Основные → Общий доступ». Чтобы повторно включить службу или снова открыть эту страницу настроек, сначала приостановите интернет в рабочей области.</p>
      <ScreenSharingChecks status={sharingStatus} />
      <div className="project-recovery-actions">
        <button
          type="button"
          className="text-button"
          disabled={disabled || Boolean(sharingBusy)}
          onClick={() => run("check")}
        >
          {sharingBusy === "check" ? <LoaderCircle size={14} /> : null}
          Проверить состояние общего доступа к экрану
        </button>
        <button
          type="button"
          className="text-button"
          disabled={disabled || Boolean(sharingBusy)}
          onClick={() => run("open")}
        >
          {sharingBusy === "open" ? <LoaderCircle size={14} /> : null}
          Открыть общий доступ к экрану гостевой системы
        </button>
        <button
          type="button"
          className="text-button"
          disabled={disabled || Boolean(sharingBusy)}
          onClick={() => run("enable")}
        >
          {sharingBusy === "enable" ? <LoaderCircle size={14} /> : null}
          Повторно включить службу общего доступа к экрану
        </button>
        <MacOSLogin maintenance="sharing" label="Открыть настройки общего доступа к экрану" disabled={disabled || Boolean(sharingBusy)} />
      </div>
    </section>
  );
}
