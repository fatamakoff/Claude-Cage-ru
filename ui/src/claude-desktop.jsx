import { InlineSelect } from "./inline-select";
import React, { useEffect, useRef, useState } from "react";
import {
  Download,
  ChevronDown,
  ChevronUp,
  Monitor,
  PanelLeftOpen,
  Power,
  RefreshCw,
} from "lucide-react";
import { BrowserUploads } from "./browser-uploads";
import { ProjectDialog } from "./project-dialog";
import { api, nativeAvailable } from "./api";
import { SafetyMessage } from "./safety-message";
import { DeviceCheckButton } from "./device-checks";
import { RemoteView } from "./views";
import { useWindowVisibility } from "./window-visibility";
import { guestCapability } from "./guest-capabilities.mjs";
import "./claude-desktop.css";

const desktopZooms = [0.75, 0.9, 1, 1.1, 1.25, 1.5];

export function useDesktopZoom(automatic = false) {
  const [zoom, setZoom] = useState(() => {
    try {
      const stored = localStorage.getItem(automatic ? "cage-windows-desktop-zoom" : "cage-desktop-zoom");
      if (automatic && (stored === null || stored === "auto")) return "auto";
      const value = Number(stored);
      return desktopZooms.includes(value) ? value : automatic ? "auto" : 1;
    } catch { return automatic ? "auto" : 1; }
  });
  return [zoom, setZoom];
}

export function DesktopToolbar({ desktop, platform, title = "Claude Desktop", zoom, setZoom, onConfirm, onStop, busy, refresh, sidebarCollapsed, onExpand, children, automatic = false }) {
  const [hidden, setHidden] = useState(() => {
    try { return localStorage.getItem("cage-desktop-toolbar-hidden") === "true"; }
    catch { return false; }
  });
  const toggleToolbar = (value) => {
    setHidden(value);
    try { localStorage.setItem("cage-desktop-toolbar-hidden", String(value)); }
    catch { /* Keep the preference for this session. */ }
  };
  if (hidden && desktop?.running) {
    return (
      <div className="desktop-toolbar-reveal">
        {sidebarCollapsed && <button className="icon-button" aria-label="Развернуть панель" title="Развернуть панель" onClick={onExpand}><PanelLeftOpen size={15} /></button>}
        <button className="icon-button" aria-label="Показать панель Desktop" title="Показать панель Desktop" onClick={() => toggleToolbar(false)}><ChevronDown size={15} /></button>
      </div>
    );
  }
  return (
      <header className="claude-desktop-toolbar">
        {sidebarCollapsed && (
          <button
            className="icon-button"
            aria-label="Развернуть панель"
            onClick={onExpand}
          >
            <PanelLeftOpen size={17} />
          </button>
        )}
        <Monitor size={18} />
        <strong>{title}</strong>
        <span className="desktop-version">
          {desktop?.version ? `v${desktop.version}` : platform}
        </span>
        <span className="desktop-toolbar-spacer" />
        {children}
        <DeviceCheckButton target="desktop" disabled={busy || !desktop?.running} />
        {desktop?.running && (
          <label className="desktop-display-size">
            Масштаб
            <InlineSelect aria-label="Масштаб Desktop" value={zoom} onValueChange={(next) => {
              const value = next === "auto" ? "auto" : Number(next);
              setZoom(value);
              try { localStorage.setItem(automatic ? "cage-windows-desktop-zoom" : "cage-desktop-zoom", String(value)); } catch { /* Session-only preference. */ }
            }}>
              {automatic && <option value="auto">Авто (рекомендуется)</option>}
              {desktopZooms.map((value) => <option key={value} value={value}>{Math.round(value * 100)}%{value === 1 ? " (по умолчанию)" : ""}</option>)}
            </InlineSelect>
          </label>
        )}
        {desktop?.running && onStop && (
          <button
            className="quiet-button"
            disabled={busy}
            onClick={async () => {
              if (
                await onConfirm({
                  title: "Закрыть Claude Desktop?",
                  body: "Сначала сохраните работу в приложении. Браузер и терминалы Cage продолжат работу.",
                  confirm: "Закрыть приложение",
                })
              )
                onStop();
            }}
          >
            <Power size={15} />
            Закрыть приложение
          </button>
        )}
        <button
          className="icon-button"
          aria-label={"Обновить состояние: " + title}
          disabled={busy}
          onClick={refresh}
        >
          <RefreshCw size={15} />
        </button>
        {desktop?.running && <button className="icon-button" aria-label="Скрыть панель Desktop" title="Скрыть панель Desktop" onClick={() => toggleToolbar(true)}><ChevronUp size={15} /></button>}
      </header>
  );
}

export function ClaudeDesktop({
  uploads = [],
  status,
  onProjectOpened,
  visible,
  remoteRef,
  onStatus,
  onFallback,
  onConfirm,
  onDetails,
  onExpand,
  sidebarCollapsed,
}) {
  const [closedChooser, setClosedChooser] = useState("");
  const directoryRequest = uploads.find((item) => item.directory && item.id !== closedChooser);
  const automatic = status.guest_system?.startsWith("windows");
  const available = guestCapability(status, "desktop");
  const [zoom, setZoom] = useDesktopZoom(automatic);
  const windowVisible = useWindowVisibility();
  const screenVisible = visible && windowVisible;
  const [desktop, setDesktop] = useState(null);
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [jobID, setJobID] = useState("");
  const opened = useRef(false);
  const statusRequest = useRef(null);
  const statusRevision = useRef(0);
  const ownJob = status.job?.kind?.startsWith("claude-desktop-");
  const busy = submitting || Boolean(status.job?.running) || Boolean(jobID);
  const refresh = async (valid = () => true) => {
    if (!available) return null;
    const revision = statusRevision.current;
    const request = statusRequest.current ??= api("/claude-desktop");
    try {
      const value = await request;
      if (!valid() || revision !== statusRevision.current) return null;
      setDesktop(value);
      setStatusError("");
      return value;
    } catch (e) {
      if (valid() && revision === statusRevision.current) setStatusError(e.message);
      return null;
    } finally {
      if (statusRequest.current === request) statusRequest.current = null;
    }
  };
  const run = async (action) => {
    if (!available) return;
    statusRevision.current++;
    statusRequest.current = null;
    setSubmitting(true);
    setError("");
    try {
      const job = await api(`/claude-desktop/${action}`, {});
      setJobID(job.id);
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };
  useEffect(() => {
    if (!available || !screenVisible || !status.vm_running || status.job?.running) return;
    let disposed = false;
    let timer;
    const poll = async () => {
      const value = await refresh(() => !disposed);
      if (disposed) return;
      if (value && !opened.current) {
        opened.current = true;
        if (value.installed && !value.running && !value.failed && !jobID)
          await run("start");
      }
      if (!disposed) timer = setTimeout(poll, 5000);
    };
    poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [available, screenVisible, status.vm_running, status.job?.running]);
  useEffect(() => {
    if (!jobID || status.job?.id !== jobID || status.job.running) return;
    setJobID("");
    if (status.job.error) {
      setError(status.job.error);
      return;
    }
    if (["claude-desktop-install", "claude-desktop-update"].includes(status.job.kind)) run("start");
    else refresh();
  }, [status.job]);
  return (
    <section className="claude-desktop-view" aria-label="Claude Desktop">
      {!nativeAvailable() && <BrowserUploads requests={uploads} onStatus={onStatus} />}
      {directoryRequest && <ProjectDialog
        key={directoryRequest.id}
        status={status}
        activate={false}
        onClose={() => {
          setClosedChooser(directoryRequest.id);
          void api("/input/files/cancel", { target: "desktop", id: directoryRequest.id }).catch((e) => onStatus(e.message));
        }}
        onOpened={async (workspace) => {
          await api("/input/files/directory", { target: "desktop", id: directoryRequest.id, workspace });
          setClosedChooser(directoryRequest.id);
          await onProjectOpened(workspace);
        }}
      />}
      <DesktopToolbar desktop={desktop} platform={automatic ? "Windows" : "Linux"} zoom={zoom} setZoom={setZoom} automatic={automatic}
        onConfirm={onConfirm} onStop={() => run("stop")} busy={busy || !available} refresh={() => refresh()} sidebarCollapsed={sidebarCollapsed} onExpand={onExpand}>
        {desktop?.installed && !status.guest_system?.startsWith("windows") && <button className="quiet-button" disabled={busy} onClick={async () => {
          if (!desktop.running || await onConfirm({ title: "Обновить Claude Desktop?", body: "Сначала сохраните работу в приложении. При обновлении Claude Desktop будет закрыт, доступная версия установится из официального источника, затем приложение откроется снова; данные входа сохранятся.", confirm: "Обновить приложение" })) run("update");
        }}>Обновить приложение</button>}
      </DesktopToolbar>
      {(error || statusError || desktop?.failed) && (
        <div className="connection-banner" role="alert">
          <SafetyMessage message={error || statusError || (desktop?.failure_reason === "oom-kill"
            ? "Среде не хватает памяти, система закрыла Claude Desktop. Проверьте вычислительные ресурсы в настройках и откройте приложение снова."
            : "Claude Desktop не запустился. Повторите открытие или восстановите установку.")} />
          <button onClick={onDetails}>Детали операции</button>
        </div>
      )}
      {desktop?.running && desktop.managed === false && !desktop.native_user_session && <div className="connection-banner" role="status">Приложение ещё не использует разблокировку аккаунтом Cage. Сохраните работу, закройте и снова откройте приложение.</div>}
      {busy && ownJob && (
        <div className="desktop-progress" role="status">
          <RefreshCw size={16} className="spin" />
          {status.job.message}
          <button className="text-button" onClick={onDetails}>
            Смотреть прогресс
          </button>
        </div>
      )}
      <div className="desktop-screen">
        {!available ? (
          <div className="desktop-empty">
            <Monitor size={36} />
            <h2>Claude Desktop пока недоступен в облачной Windows</h2>
            <p>Сейчас можно использовать изолированный PowerShell{guestCapability(status, "browser") && " и браузер"} без входа в аккаунт Claude.</p>
          </div>
        ) : desktop?.running && status.vm_running ? (
          <RemoteView
            ref={remoteRef}
            desktop
            zoom={zoom}
            visible={visible}
            keyboard={status.keyboard}
            guestPlatform={status.guest_system?.startsWith("windows") ? "windows" : status.guest_system}
            onStatus={onStatus}
            onFallback={onFallback}
          />
        ) : (
          <div className="desktop-empty">
            <Monitor size={36} />
            <h2>
              {desktop?.installed
                ? "Claude Desktop"
                : "Claude Desktop в Cage"}
            </h2>
            <p>
              Chat и Code работают в одном официальном приложении. Установите,
              войдите и работайте в Cage; файлы проектов берутся из открытой папки.
            </p>
            {!desktop?.installed && (
              <p>
                При первом использовании приложение скачивается из официального
                источника Anthropic и не увеличивает размер установочного пакета Cage.
              </p>
            )}
            <div className="desktop-actions">
              {desktop && (
                <button
                  className="primary"
                  disabled={busy || !status.vm_running}
                  onClick={() => run(desktop.installed ? "start" : "install")}
                >
                  {desktop.installed ? (
                    <Monitor size={16} />
                  ) : (
                    <Download size={16} />
                  )}
                  {desktop.installed ? "Открыть Claude Desktop" : "Скачать и установить"}
                </button>
              )}
              {desktop?.installed && !status.guest_system?.startsWith("windows") && (
                <button
                  className="quiet-button"
                  disabled={busy}
                  onClick={() => run("install")}
                >
                  Обновить / восстановить установку
                </button>
              )}
              {!desktop && (
                <button
                  className="quiet-button"
                  disabled={busy}
                  onClick={refresh}
                >
                  Перечитать состояние
                </button>
              )}
            </div>
            {desktop?.installed && <p>{status.guest_system?.startsWith("windows")
              ? "Проверяйте и устанавливайте обновления в самом приложении Claude Desktop."
              : "Версия для Linux обновляется через системный репозиторий. Нажмите «Обновить приложение» выше или выполните в терминале Cage: sudo apt update && sudo apt install --only-upgrade claude-desktop."}</p>}
            <p className="desktop-note">
              После закрытия приложения освобождаются ресурсы графической сессии, а
              состояние входа сохраняется в среде Cage. Функция Cowork с отдельной
              виртуальной машиной пока не поддерживается.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
