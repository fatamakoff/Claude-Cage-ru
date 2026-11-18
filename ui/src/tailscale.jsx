import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Copy, ExternalLink, KeyRound, LoaderCircle, Monitor, Network, RefreshCw, Search, Smartphone, Terminal, Trash2 } from "lucide-react";
import { api, writeClipboard } from "./api";
import "./tailscale.css";

const labels = { Running: "Подключено", NeedsLogin: "Ожидание входа", NeedsMachineAuth: "Ожидание одобрения администратора", Starting: "Подключение", Stopped: "Отключено", NotInstalled: "Не установлено" };
const descriptions = {
  Stopped: "Войдите в Tailscale, чтобы добавить Cage в вашу частную сеть. Устройства в той же сети появятся здесь.",
  NeedsLogin: "Войдите во встроенном браузере и авторизуйте это устройство.",
  NeedsMachineAuth: "Вход выполнен. Попросите администратора этой сети одобрить устройство Cage в консоли Tailscale.",
  Starting: "Подключение к Tailscale. Список устройств обновится автоматически после подключения.",
};
const deviceName = peer => peer.hostname || peer.name?.split(".")[0] || peer.ip;
function DeviceIcon({ os }) { return ["android", "iOS"].includes(os) ? <Smartphone size={20} /> : <Monitor size={20} />; }

export function TailscalePanel({ status, onOpenLogin, onOpenBrowser, onInstall, onConfirm }) {
  const [state, setState] = useState(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [key, setKey] = useState(""), [notice, setNotice] = useState(""), [query, setQuery] = useState("");
  const [sshOpen, setSSHOpen] = useState(false), [selected, setSelected] = useState(""), [username, setUsername] = useState("");
  const [port, setPort] = useState("80"), [appsOpen, setAppsOpen] = useState(false);
  const mounted = useRef(true), inflight = useRef(false), loginRequested = useRef(false), revision = useRef(0);
  const ready = status.ready && !status.job?.running;
  const connected = ready && state?.backend === "Running";
  const address = state?.ips?.find(ip => !ip.includes(":"));
  const peers = [...(state?.peers || [])].sort((a, b) => Number(b.online) - Number(a.online) || deviceName(a).localeCompare(deviceName(b)));
  const visible = peers.filter(peer => [deviceName(peer), peer.name, peer.ip, peer.os].some(value => value?.toLowerCase().includes(query.trim().toLowerCase())));
  const openLogin = async value => {
    loginRequested.current = false;
    setLoginError("");
    try { if (await onOpenLogin(value) === false && mounted.current) setLoginError("Не удалось открыть страницу входа. Нажмите «Открыть страницу входа» и повторите."); }
    catch { if (mounted.current) setLoginError("Не удалось открыть страницу входа. Нажмите «Открыть страницу входа» и повторите."); }
  };
  const refresh = async () => {
    if (inflight.current || !ready) return;
    inflight.current = true;
    const current = ++revision.current;
    try {
      const value = await api("/tailscale");
      if (mounted.current && current === revision.current) {
        setState(value); setError("");
        if (loginRequested.current && value.auth_url) await openLogin(value);
        if (value.backend === "Running") loginRequested.current = false;
      }
      return value;
    } catch (e) { if (mounted.current && current === revision.current) setError(e.message); }
    finally { if (current === revision.current) inflight.current = false; }
  };
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => { mounted.current = false; revision.current++; inflight.current = false; loginRequested.current = false; clearInterval(timer); };
  }, [ready]);
  const act = async (action, body = {}) => {
    if (busy) return;
    setBusy(true); setError(""); setLoginError(""); setNotice(""); revision.current++;
    try {
      inflight.current = true;
      const value = await api(`/tailscale/${action}`, body);
      if (mounted.current) { setState(value); if (action === "add-key") setKey(""); }
      return value;
    } catch (e) { if (mounted.current) setError(e.message); }
    finally { inflight.current = false; if (mounted.current) setBusy(false); }
  };
  const login = async () => {
    loginRequested.current = true;
    const result = await act(state?.enabled ? "login" : "connect");
    if (mounted.current && result?.auth_url) await openLogin(result);
    else if (!result || result.backend === "Running") loginRequested.current = false;
  };
  const copy = async (text, message = "Скопировано") => {
    try { await writeClipboard(text); setNotice(message); }
    catch { setNotice("Не удалось скопировать. Выделите текст и скопируйте вручную."); }
  };
  const stop = async logout => {
    if (!await onConfirm({ title: logout ? "Выйти из Tailscale?" : "Отключить Tailscale?", body: logout ? "Подключение к частной сети прервётся, для следующего подключения потребуется снова войти. Добавленные открытые ключи SSH сохранятся." : "Текущее подключение к частной сети прервётся, вход и открытые ключи SSH сохранятся.", confirm: logout ? "Выйти" : "Отключиться" })) return;
    loginRequested.current = false;
    if (await act(logout ? "logout" : "disconnect")) { setSelected(""); setSSHOpen(false); }
  };
  return <div className="tailscale-panel">
      <div className={`tailscale-overview${connected ? " connected" : ""}`}>
        <div className="tailscale-state" role="status">
          <div className="tailscale-network-icon"><Network size={24} /></div>
          <div><strong>{!ready ? "Ожидание готовности среды Cage" : labels[state?.backend] || (state ? "Состояние подключения не подтверждено" : "Чтение состояния…")}</strong>
            {connected && <span>{state.tailnet || "Частная сеть Tailscale"}</span>}
          </div>
          <button className="icon-button" aria-label="Обновить состояние Tailscale" disabled={!ready || busy} onClick={refresh}><RefreshCw size={16} /></button>
        </div>
        <p className="field-help">{!ready ? "После запуска среды Cage можно войти и подключиться к частной сети." : connected ? "Cage в частной сети. Выберите устройство, чтобы увидеть адрес и использовать его сервисы." : state?.backend === "NeedsLogin" && !state.auth_url ? "Получаем ссылку для входа в Tailscale. Если браузер долго не открывается, проверьте сеть среды и повторите вход." : descriptions[state?.backend] || "Чтение состояния Tailscale текущей среды."}</p>
        {state?.account && connected && <p className="tailscale-account">Аккаунт · {state.account}</p>}
        {ready && state && <div className="tailscale-actions">
          {!state.installed ? <button className="primary-button" disabled={busy} onClick={async () => {
            setBusy(true); setError("");
            try { await onInstall(); } catch (e) { setError(e.message); }
            finally { if (mounted.current) setBusy(false); }
          }}>{["macos", "windows-11"].includes(status.guest_system) ? "Обновите компоненты среды для установки" : "Установить Tailscale"}</button> : <>
            {!connected && !["NeedsMachineAuth", "Starting"].includes(state.backend) && <button className="primary-button" disabled={busy} onClick={login}>{busy ? <LoaderCircle size={15} className="spin" /> : <ExternalLink size={15} />}{state.enabled ? "Войти снова" : "Подключиться и войти"}</button>}
            {state.auth_url && !connected && <button className="quiet-button" disabled={busy} onClick={() => openLogin(state)}>Открыть страницу входа</button>}
            {state.enabled && <button className="quiet-button" disabled={busy} onClick={() => stop(false)}>Отключиться</button>}
            {connected && <button className="quiet-button" disabled={busy} onClick={() => stop(true)}>Выйти</button>}
          </>}
        </div>}
      </div>
      {(error || loginError && !connected) && <p className="error-message" role="alert">{error || loginError}</p>}
      {ready && state?.health?.length > 0 && <div className="tailscale-health" role="status"><strong>Сеть требует внимания</strong>{state.health.map((message, i) => <p key={i}>{message}</p>)}</div>}
      {connected && <section className="tailscale-self" aria-label="Текущее устройство Cage">
        <DeviceIcon os={state.os} />
        <div><strong>{state.hostname || state.name?.split(".")[0] || "Cage"} <span className="tailscale-badge">Текущая среда</span></strong><span className="tailscale-address">{address || "Назначение адреса…"}{state.os ? ` · ${state.os}` : ""}</span></div>
        {address && <button className="quiet-button" onClick={() => copy(address, "Скопирован адрес Cage в частной сети")}><Copy size={14} />Копировать адрес</button>}
      </section>}
      <section className="tailscale-section tailscale-devices" aria-labelledby="tailscale-devices-title">
        <div className="tailscale-section-heading"><h3 id="tailscale-devices-title">Устройства в сети{connected && <span>{peers.length}</span>}</h3>{connected && peers.length > 0 && <span className="field-help">{peers.filter(peer => peer.online).length} онлайн</span>}</div>
        {connected && peers.length > 0 && <label className="tailscale-search"><Search size={16} /><input aria-label="Поиск устройств" type="search" placeholder="Поиск по имени или адресу" value={query} onChange={e => setQuery(e.target.value)} /></label>}
        {!connected ? <div className="tailscale-empty"><Monitor size={26} /><strong>Устройства появятся после подключения</strong><p>Завершите вход в браузере — список устройств появится автоматически.</p></div>
          : peers.length === 0 ? <div className="tailscale-empty"><Monitor size={26} /><strong>Частная сеть подключена, других устройств пока нет</strong><p>Установите Tailscale на компьютер или телефон и подключитесь к той же сети. Здесь видны только устройства, которые эта сеть разрешает обнаруживать Cage.</p></div>
          : visible.length === 0 ? <p className="tailscale-empty">Нет подходящих устройств. Попробуйте другое имя или адрес.</p>
          : <div className="tailscale-peers">{visible.map(peer => <article className="tailscale-peer" key={peer.id || peer.ip}>
            <div className="tailscale-peer-row"><DeviceIcon os={peer.os} /><div className="tailscale-peer-info"><strong>{deviceName(peer)}</strong><span>{peer.ip}{peer.os ? ` · ${peer.os}` : ""}</span></div>
              <span className={`tailscale-presence${peer.online ? " online" : ""}`}><i />{peer.online ? "В сети" : "Не в сети"}</span>
              <button className="icon-button" aria-label={`Копировать адрес ${deviceName(peer)}`} onClick={() => copy(peer.ip, "Скопирован адрес устройства в частной сети")}><Copy size={15} /></button>
              <button className="quiet-button" aria-expanded={selected === peer.ip} aria-controls={`tailnet-device-${peer.ip}`} onClick={() => { setSelected(selected === peer.ip ? "" : peer.ip); setUsername(""); setPort("80"); }}>Использовать устройство<ChevronDown size={14} /></button>
            </div>
            {selected === peer.ip && <div className="tailscale-device-detail" id={`tailnet-device-${peer.ip}`}>
              {peer.name && <p className="field-help tailscale-dns">{peer.name}</p>}
              {!peer.online && <p className="field-help">Устройство не в сети. Сначала подключите Tailscale на этом устройстве.</p>}
              <label className="field-label" htmlFor="tailnet-service-port">Доступ к сервисам на устройстве</label>
              <p className="field-help">Укажите порт сервиса, чтобы создать локальный адрес для браузера, клиента БД или другого приложения внутри Cage.</p>
              <div className="tailscale-connect-form"><input id="tailnet-service-port" aria-label="Порт сервиса" type="number" min="1" max="65535" inputMode="numeric" value={port} onChange={e => setPort(e.target.value)} /><button className="quiet-button" disabled={busy || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535} onClick={async () => { if (await act("open-service", { host: peer.ip, port: Number(port) })) setNotice("Локальный адрес готов. Используйте его внутри среды Cage."); }}>Создать адрес</button></div>
              {(state.forwards || []).filter(entry => entry.host === peer.ip).map(entry => <div className="tailscale-forward" key={`${entry.host}:${entry.port}`}><span><strong>Порт {entry.port}</strong><code>{entry.address}</code></span><button className="icon-button" aria-label={`Копировать адрес порта ${entry.port}`} onClick={() => copy(entry.address, "Скопирован адрес, доступный внутри Cage")}><Copy size={14} /></button><button className="quiet-button" onClick={async () => { try { if (!await onOpenBrowser(`http://${entry.address}`)) setError("Не удалось открыть страницу сервиса. Повторите попытку."); } catch { setError("Не удалось открыть страницу сервиса. Повторите попытку."); } }}>Открыть HTTP-страницу</button></div>)}
              <label className="field-label" htmlFor="tailnet-ssh-user"><Terminal size={14} />SSH-подключение</label>
              <p className="field-help">Укажите системное имя пользователя на этом устройстве. На целевом устройстве должен быть включён SSH и разрешён вход для текущего аккаунта.</p>
              <div className="tailscale-connect-form"><input id="tailnet-ssh-user" value={username} onChange={e => setUsername(e.target.value)} placeholder="Системное имя пользователя" autoComplete="off" maxLength={128} /><button className="quiet-button" disabled={!username.trim() || !/^[a-zA-Z0-9_.@\\-]+$/.test(username.trim())} onClick={() => copy(`ssh -l '${username.trim()}' ${peer.ip}`, "Команда SSH скопирована. Запустите её в терминале Cage")}>Копировать команду SSH</button></div>
              <p className="field-help">SSH, SFTP и инструменты на базе OpenSSH могут напрямую использовать адрес частной сети выше. Для других приложений см. раздел «Доступ приложений к частной сети» ниже.</p>
            </div>}
          </article>)}</div>}
      </section>
      {connected && <section className="tailscale-section">
        <button className="tailscale-disclosure" aria-expanded={sshOpen} aria-controls="tailnet-inbound-ssh" onClick={() => setSSHOpen(!sshOpen)}><span><KeyRound size={16} />SSH на Cage с других устройств</span><ChevronDown size={16} /></button>
        {sshOpen && <div id="tailnet-inbound-ssh" className="tailscale-detail">
          <p className="field-help">Настраивайте только для удалённого терминала, SFTP или подключения из редактора. Добавьте сюда открытый ключ SSH подключающегося устройства; закрытый ключ остаётся на нём.</p>
          {address && <div className="tailscale-command"><code>{`ssh ${state.user}@${address}`}</code><button className="icon-button" aria-label="Копировать команду подключения к Cage" onClick={() => copy(`ssh ${state.user}@${address}`)}><Copy size={15} /></button></div>}
          <label className="field-label" htmlFor="tailscale-key">Открытый ключ SSH подключающегося устройства</label>
          <textarea id="tailscale-key" rows={3} placeholder="ssh-ed25519 AAAA…" value={key} onChange={e => setKey(e.target.value)} maxLength={8192} spellCheck={false} />
          <button className="quiet-button" disabled={busy || !key.trim()} onClick={() => act("add-key", { key: key.trim() })}>Добавить ключ</button>
          <div className="tailscale-keys">{(state.keys || []).map(entry => <div className="tailscale-key" key={entry}><code title={entry}>{entry}</code><button className="icon-button" disabled={busy} aria-label="Удалить открытый ключ SSH" onClick={() => act("remove-key", { key: entry })}><Trash2 size={14} /></button></div>)}</div>
        </div>}
      </section>}
      {connected && state.proxy_url && <section className="tailscale-section">
        <button className="tailscale-disclosure" aria-expanded={appsOpen} aria-controls="tailnet-apps" onClick={() => setAppsOpen(!appsOpen)}><span><Network size={16} />Доступ приложений к частной сети</span><ChevronDown size={16} /></button>
        {appsOpen && <div id="tailnet-apps" className="tailscale-detail"><p className="field-help">Если нужны домены устройств, HTTPS или несколько портов, настройте HTTP-прокси в приложениях внутри Cage. Доступ разрешён только к устройствам этой частной сети; интернет идёт через обычный выход.</p><button className="quiet-button" onClick={() => copy(state.proxy_url, "Скопирован адрес HTTP-прокси частной сети (с локальными учётными данными)")}>Копировать адрес прокси частной сети</button><p className="field-help">Адрес прокси содержит локальные учётные данные — используйте его только в приложениях внутри Cage. Поддерживаются TCP-сервисы; UDP, системный VPN и маршрутизация подсетей не включены.</p></div>}
      </section>}
      <p className="field-help tailscale-footer">Другим устройствам нужен Tailscale и та же сеть. Доступ к устройствам управляется правами сети; приостановка сети Cage или остановка среды разорвёт подключение к частной сети.</p>
      {notice && <p className="tailscale-notice" role="status"><Check size={14} />{notice}</p>}
    </div>;
}
