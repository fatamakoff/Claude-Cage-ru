import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronLeft, LoaderCircle, ShieldCheck } from "lucide-react";
import { api, native, nativeAvailable } from "./api";
import { isRemoteClient } from "./client-context.mjs";
import { MacOSAccountGate, useAccount } from "./account";
import { GuestSystemPicker, HostCloneSummary, validGuestChoice } from "./guest-system-picker";
import { InitializationStorage } from "./initialization-storage";
import { GuestProfileOptions, guestOptionsForSystem } from "./guest-profile";
import { ProxySettings } from "./proxy-settings";
import { SetupProgress } from "./setup-progress";
import { DiagnosticSettings } from "./diagnostics.jsx";
import { MacOSFirstSetup } from "./macos-first-setup";
import { InitializationProjectApproval } from "./macos-project-approval";
import { InitializationChecks, InitializationDetails } from "./initialization-checks";
import { MacOSLogin } from "./macos-login";
import { Modal } from "./modal";
import { SafetyMessage } from "./safety-message";
import { bindDetectedMacOSExit } from "./safety";
import { needsProxySetup } from "./onboarding-state.mjs";
import { networkState } from "./safety-state.mjs";
import { useSSHNavigation } from "./remote-hosts";
import logo from "./logo.png";
import "./initialization.css";

const steps = [["system", "Система и хранилище"], ["proxy", "Сетевой прокси"], ["install", "Установка и проверка"]];

function InitializationFrame({ children }) {
  return <main className="initialization"><header className="initialization-brand"><img src={logo} alt="" /><strong>Cage</strong><span>Первая настройка</span></header>{children}</main>;
}

export function InitializationGate({ children }) {
  const { account } = useAccount();
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const [attempt, retry] = useState(0);
  const remote = isRemoteClient();
  useEffect(() => {
    if (remote) return;
    let live = true;
    setError("");
    (async () => {
      const next = await api("/environment/initialization");
      if (next.required && !next.tracked && !next.started && !account?.initial_mac_setup) await api("/environment/initialization", { action: "begin" });
      if (live) setState(next);
    })().catch(error => { if (live) setError(error.message); });
    return () => { live = false; };
  }, [remote, attempt, account?.initial_mac_setup]);
  if (remote) return children;
  if (account?.initial_mac_setup) return <MacOSAccountGate><MacOSFirstSetup /></MacOSAccountGate>;
  if (error) return <InitializationFrame><section className="initialization-content"><h1>Продолжаем подготовку Cage</h1><p role="alert"><SafetyMessage message={error} /></p><button className="primary" onClick={() => retry(value => value + 1)}>Подключиться снова</button><DiagnosticSettings /></section></InitializationFrame>;
  if (!state) return <InitializationFrame><section className="initialization-content"><h1>Чтение состояния среды</h1><p role="status"><LoaderCircle size={18} className="spin" />Проверяем текущие настройки и ход установки…</p></section></InitializationFrame>;
  return state.required ? <MacOSAccountGate><Initialization initial={state} onComplete={() => setState({ required: false })} /></MacOSAccountGate> : children;
}

function Initialization({ initial, onComplete }) {
  const { account, refresh } = useAccount();
  const navigation = useSSHNavigation();
  const [step, setStep] = useState(initial.started || account?.guest_system ? "install" : "system");
  const [status, setStatus] = useState(null);
  const [proxy, setProxy] = useState(null);
  const [choice, setChoice] = useState(undefined);
  const [guestProfile, setGuestProfile] = useState(null);
  const [storage, setStorage] = useState(null);
  const [pending, setPending] = useState(null);
  const [macRecovery, setMacRecovery] = useState(null);
  const [recoveryError, setRecoveryError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [details, setDetails] = useState(false);
  const [help, setHelp] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [approvalWorkspace, setApprovalWorkspace] = useState("");
  const [proxyDirty, setProxyDirty] = useState(false);
  const alive = useRef(true);
  const pollNow = useRef(null);
  const activation = useRef(false);
  const actionPending = useRef(false);
  const restored = useRef(false);
  const job = status?.job || {};
  const busy = submitting || Boolean(job.running);
  const network = networkState(status);
  const exitCandidate = status?.guest_system === "macos" && status.safety?.macos_exit_candidate?.ip;
  const needsExitRestart = status?.guest_system === "macos" && status.safety?.error === "已保存固定出口。请重启 macOS 客机，登录后重新检测。";
  const ready = Boolean(status?.ready && status.vm_running && !busy && !job.error && !needsExitRestart && network.mode === "open");
  const confirm = options => new Promise(resolve => setDialog({ ...options, resolve }));
  const settleDialog = value => { dialog?.resolve(value); setDialog(null); };

  useEffect(() => {
    alive.current = true;
    let timer, polling = false;
    async function poll() {
      if (polling || !alive.current) return;
      clearTimeout(timer);
      polling = true;
      try {
        const next = await api("/status");
        if (!alive.current) return;
        setStatus(next);
        setConnectionError("");
        const results = await Promise.allSettled([
          api("/proxy"),
          account?.guest_system ? Promise.resolve(null) : api("/environment/guest-systems"),
        ]);
        if (!alive.current) return;
        if (results[0].status === "fulfilled") setProxy(results[0].value);
        else setConnectionError(results[0].reason.message);
        if (results[1].status === "fulfilled") {
          const install = results[1].value;
          if (install?.pending?.system === "macos" && !install?.activate) {
            try { setMacRecovery(await api("/macos/install-recovery")); setRecoveryError(""); }
            catch (error) { if (alive.current) { setMacRecovery(null); setRecoveryError(error.message); } }
          } else { setMacRecovery(null); setRecoveryError(""); }
          setPending(install?.pending || null);
          if (!restored.current) {
            restored.current = true;
            if (initial.started && !initial.prepared && !account?.guest_system && !install?.pending && !next.job?.running && !next.job?.setup_progress && !next.ready) setStep("system");
          }
          if (install?.activate && !activation.current) {
            activation.current = true;
            setStep("install");
            try {
              await api("/environment/guest-systems/activate", {});
              await native("reconnect");
            } catch (error) {
              activation.current = false;
              if (alive.current) setError(error.message);
            }
          }
        } else setConnectionError(results[1].reason.message);
        if (next.job?.running && ["start", "guest-install", "safety"].includes(next.job.kind)) setStep("install");
      } catch (error) { if (alive.current) setConnectionError(error.message); }
      finally {
        polling = false;
        if (alive.current) timer = setTimeout(poll, 1200);
      }
    }
    pollNow.current = poll;
    poll();
    if (nativeAvailable()) native("workbenchReady").catch(() => {});
    window.cageWorkbenchAction = async action => { if (action === "quit") await native("quitNow"); };
    return () => { alive.current = false; clearTimeout(timer); pollNow.current = null; delete window.cageWorkbenchAction; };
  }, [account?.guest_system]);

  async function run(operation) {
    if (actionPending.current) return;
    actionPending.current = true;
    setSubmitting(true); setError("");
    try { await operation(); }
    catch (error) { if (alive.current) setError(error.message); }
    finally { actionPending.current = false; if (alive.current) { setSubmitting(false); pollNow.current?.(); } }
  }
  function startOptions() {
    if (account?.guest_system) return {};
    if (pending) return { guest_system: pending.system };
    const preferences = guestProfile ? { guest_profile: guestOptionsForSystem(guestProfile, choice?.guest_system) } : {};
    if (!choice) return job.setup_progress?.system ? { guest_system: job.setup_progress.system } : preferences;
    return { guest_system: choice.guest_system, media: choice.media, sha256: choice.sha256, clone_key: choice.clone_key, editor_terms: choice.editor_terms, ...preferences };
  }
  async function install() {
    if (needsProxySetup(null, status, proxy)) { setError("Сначала выберите и примените узел прокси."); setStep("proxy"); return; }
    await run(async () => {
      await api("/environment/initialization", { action: "install" });
      const accepted = await api("/start", startOptions());
      if (!alive.current) return;
      setStep("install");
      setStatus(current => ({ ...current, job: { ...accepted, running: true, kind: accepted.kind || "start", message: accepted.message || "Подготовка среды гостевой системы…" } }));
    });
  }
  async function stop() {
    if (!await confirm({ title: "Остановить текущую установку?", body: "Ход установки, загруженные файлы и виртуальный диск сохранятся. Установку можно будет продолжить на этом экране.", confirm: "Остановить установку" })) return;
    await run(async () => { const accepted = await api("/stop", {}); setStatus(current => ({ ...current, job: { ...accepted, running: true } })); });
  }
  async function enter() {
    await run(async () => { await api("/environment/initialization", { action: "complete" }); await refresh(); if (alive.current) onComplete(); });
  }
  async function waitForJob(accepted, kind) {
    if (!accepted.id) throw new Error("Операция не вернула номер задачи. Проверьте состояние и повторите попытку.");
    while (alive.current) {
      const next = await api("/status");
      if (!alive.current) break;
      setStatus(next);
      const current = next.job;
      if (current?.id !== accepted.id || current.kind !== kind) throw new Error("Состояние операции изменилось. Проверьте состояние и повторите попытку.");
      if (current.error || current.canceled) throw new Error(current.error || "Операция отменена. Проверьте состояние и повторите попытку.");
      if (!current.running) return next;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw new Error("Страница инициализации закрыта, операция прервана.");
  }
  async function bindExit() {
    await run(async () => {
      const accepted = await bindDetectedMacOSExit(exitCandidate, confirm);
      if (!accepted) return;
      await waitForJob(accepted, "settings");
    });
  }
  async function restart() {
    await run(async () => {
      const running = status.vm_running;
      if (!await confirm({ title: running ? "Перезапустить виртуальный Mac и проверить?" : "Запустить гостевую систему и проверить снова?", body: "Сначала сохраните файлы. Текущая сессия терминала завершится, вход в браузере и файлы проектов сохранятся. До успешной проверки внешняя сеть остаётся отключённой.", confirm: running ? "Перезапустить и проверить" : "Запустить и проверить" })) return;
      const current = await api("/status");
      if (!alive.current) return;
      if (current.job?.running) throw new Error("Другая операция ещё выполняется. Дождитесь её завершения и повторите попытку.");
      if (current.vm_running) {
        const stopped = await waitForJob(await api("/stop", {}), "stop");
        if (stopped.vm_running) throw new Error("Гостевая система ещё не остановлена. Проверьте состояние и повторите попытку.");
      }
      if (!alive.current) return;
      const accepted = await api("/start", {});
      if (!accepted.id) throw new Error("Запрос на запуск не вернул номер задачи. Проверьте состояние и повторите попытку.");
      setStatus(current => ({ ...current, job: { ...accepted, running: true, kind: "start", message: accepted.message || "Запускаем и проверяем гостевую систему…" } }));
    });
  }
  async function checkNetwork() {
    await run(async () => {
      const accepted = await api("/safety/check", {});
      setStatus(current => ({ ...current, job: { ...accepted, running: true, kind: "safety", message: "Проверяем выход прокси и изоляцию среды…" } }));
    });
  }
  async function back() {
    if (step === "proxy" && proxyDirty && !await confirm({ title: "Отменить неприменённые изменения прокси?", body: "Сохранённые и применённые настройки прокси останутся, несохранённые изменения формы будут отброшены.", confirm: "Отменить изменения" })) return;
    setProxyDirty(false);
    setStep(step === "install" ? "proxy" : pending || account?.guest_system ? "install" : "system");
  }
  async function nextFromSystem() {
    await run(async () => {
      const directory = storage.directory.trim();
      if (directory !== storage.location.directory) {
        const accepted = await api("/environment/storage", { directory, previous: storage.location.directory, migrate: false });
        let job;
        do {
          await new Promise(resolve => setTimeout(resolve, 300));
          if (!alive.current) return;
          const next = await api("/status");
          setStatus(next); job = next.job;
          if (job.id !== accepted.id) throw new Error("Состояние операции с хранилищем изменилось. Проверьте каталог и повторите попытку.");
        } while (job.running);
        if (job.error) throw new Error(job.error);
        const location = await api("/environment/storage");
        if (location.directory !== directory) throw new Error("Каталог хранилища не сохранён. Выберите его снова и повторите попытку.");
        setStorage({ location, directory: location.directory });
      }
      setStep("proxy");
    });
  }
  const failed = Boolean(job.error || error);
  const networkPending = Boolean(status?.ready && status.vm_running && network.mode !== "open");
  const progress = !status?.ready && job.setup_progress ? { ...job, setup_progress: job.setup_progress } : null;
  const title = step === "system" ? "Отдельная среда для Cage" : step === "proxy" ? "Подключите сетевой прокси" : ready ? "Cage готов к работе" : !busy && networkPending ? "Среда запущена, ждём проверку сети" : failed ? "Завершите установку среды" : busy ? "Готовим вашу среду" : "Установка и проверка гостевой среды";
  const index = steps.findIndex(([key]) => key === step);
  return <InitializationFrame>
    <section className="initialization-content">
      <ol className="initialization-steps" aria-label="Этапы инициализации">{steps.map(([key, label], position) => <li key={key} aria-current={step === key ? "step" : undefined}><span>{position < index ? <Check size={14} /> : position + 1}</span>{label}</li>)}</ol>
      <div className="initialization-title"><h1>{title}</h1><p>{step === "system" ? "Выберите систему гостевой машины и расположение хранилища. После инициализации вы перейдёте в рабочую область." : step === "proxy" ? "Этот прокси используется процессами и инструментами разработки внутри гостевой системы. Системные образы загружаются через прокси хоста с учётом системного прокси или режима TUN в Clash и подобных программах." : ready ? "Система, компоненты разработки и проверка сети завершены — можно переходить в рабочую область." : "Скачивание, установка, необходимые разрешения и проверки выполняются здесь. Прерванную задачу можно продолжить."}</p></div>
      {connectionError && <div className="initialization-notice" role="alert"><SafetyMessage message={connectionError} /><button onClick={() => pollNow.current?.()}>Подключиться снова</button></div>}
      {!status ? <p role="status"><LoaderCircle size={18} className="spin" />Читаем состояние установки…</p> : <>
        <div className="initialization-stage" key={step}>
          {step === "system" && <>
            <GuestSystemPicker system={choice} onChange={setChoice} preserveOnUnmount deferMatch />
            <InitializationStorage value={storage} onChange={setStorage} disabled={busy} />
            <GuestProfileOptions value={guestProfile} onChange={setGuestProfile} disabled={busy} system={choice?.guest_system} />
          </>}
          {step === "proxy" && <><ProxySettings initializing status={status} onConfirm={confirm} onDirty={setProxyDirty} onApplied={async () => { setProxy(await api("/proxy")); pollNow.current?.(); }} />{choice?.clone && !needsProxySetup(null, status, proxy) && <HostCloneSummary pending={choice.pending} onChange={setChoice} />}</>}
          {step === "install" && (ready ? <div className="initialization-ready"><ShieldCheck size={36} /><h2>Среда готова</h2><p>Отдельная гостевая система установлена; инструменты, файлы и данные входа сохраняются постоянно. В дальнейшем Cage сразу открывает рабочую область.</p></div> : <>
            {exitCandidate && <section className="initialization-notice" aria-label="Подтвердите постоянный выход"><p>Терминал, браузер и прокси гостевой системы используют один и тот же выход. Подтвердите, что его нужно закрепить как постоянный.</p><button disabled={busy || Boolean(connectionError)} onClick={bindExit}>Закрепить обнаруженный выход {exitCandidate}</button></section>}
            {needsExitRestart && <section className="initialization-notice" aria-label="Постоянный выход сохранён"><p>Постоянный выход сохранён. Чтобы перейти в рабочую область, перезапустите гостевую систему и пройдите проверку заново.</p><button className="primary" disabled={busy || Boolean(connectionError)} onClick={restart}>{status.vm_running ? "Перезапустить гостевую систему и проверить" : "Запустить гостевую систему и проверить"}</button></section>}
            {progress ? <SetupProgress job={progress} onDetails={() => setDetails(true)} onStop={stop} onRetry={needsExitRestart ? restart : install} disconnected={Boolean(connectionError) || submitting} /> : (busy || status.guest_system !== "macos" || !networkPending) && <div className="initialization-operation" role="status">{busy && <LoaderCircle size={22} className="spin" />}<p>{job.message || (status.vm_running ? "Завершите подключение гостевой системы и проверку сети." : "Готовим продолжение установки; существующие файлы и диски сохранятся.")}</p>{!busy && !job.error && !needsExitRestart && <button className="primary" disabled={Boolean(connectionError)} onClick={install}>{status.ready ? "Перезапустить и проверить" : "Продолжить установку"}</button>}{busy && <button onClick={stop} disabled={submitting}>Остановить установку</button>}</div>}
            {pending?.system === "macos" && macRecovery?.available && <section className="initialization-notice" aria-label="Возобновление установки компонентов macOS">
              <h2>Продолжить установку macFUSE</h2>
              <p>В macOS 27 нужно один раз подтвердить права администратора в гостевой системе — это нормальный порядок работы. Диск гостевой системы и ход установки сохранены. Действуйте по порядку:</p>
              <ol>
                <li>Запустите гостевую систему восстановления.</li>
                <li>Откройте экран восстановления и войдите в обычный аккаунт гостевой системы, созданный при установке.</li>
                <li>Нажмите «Открыть Apple Installer», чтобы продолжить установку.</li>
                <li>Когда установщик потребует права администратора, укажите имя пользователя cagesetup и пароль, совпадающий с паролем вашего аккаунта Cage.</li>
                <li>Когда система запросит доступ к системным файлам конфигурации, выберите разрешение.</li>
              </ol>
              <p>Если закрыть экран восстановления во время установки, задача будет отменена; отмена не теряет уже достигнутый прогресс — перезапустите гостевую систему и попробуйте снова. При повторных сбоях используйте «Журналы и диагностика» внизу страницы.</p>
              {!macRecovery.running && <button disabled={busy} onClick={() => run(() => api("/macos/install-recovery", { action: "start" }))}>Запустить гостевую систему восстановления</button>}
              {macRecovery.running && <MacOSLogin initialSetup installRecovery label="Открыть экран восстановления" setupHint="Сначала войдите в обычный аккаунт гостевой системы, созданный при установке, затем нажмите «Открыть Apple Installer». Для прав администратора укажите имя cagesetup и пароль аккаунта Cage; при запросах системы выбирайте разрешение." setupStatus="После установки вернитесь в Cage, чтобы продолжить подготовку." setupActions={<button disabled={busy} onClick={() => run(() => api("/macos/install-recovery", { action: "resume" }))}>Открыть Apple Installer</button>} onSettings={() => setHelp(true)} />}
            </section>}
            {pending?.system === "macos" && macRecovery && !macRecovery.available && macRecovery.can_prepare && <section className="initialization-notice" aria-label="Восстановление установки macOS">
              <p>Обнаружена незавершённая установка macOS; в macOS 27 нужно один раз подтвердить права администратора в гостевой системе — это нормальный порядок работы. Восстановление продолжит работу с прежним диском гостевой системы. После подготовки здесь появится инструкция по продолжению установки.</p>
              <button disabled={busy} onClick={() => run(async () => { await api("/macos/install-recovery", { action: "prepare" }); pollNow.current?.(); })}>Подготовить вход восстановления</button>
            </section>}
            {pending?.system === "macos" && macRecovery && !macRecovery.available && !macRecovery.can_prepare && <section className="initialization-notice" aria-label="Вход восстановления macOS недоступен">
              <p>Обнаружена незавершённая установка macOS; в macOS 27 нужно один раз подтвердить права администратора в гостевой системе — это нормальный порядок работы. Вход восстановления ещё не готов и, возможно, подготавливается. Откройте сведения об операции, чтобы увидеть прогресс, или продолжите установку; существующие данные сохранятся.</p>
              <button disabled={busy} onClick={() => setDetails(true)}>Сведения об операции</button>
              <button className="primary" disabled={busy || Boolean(connectionError)} onClick={install}>Продолжить установку</button>
            </section>}
            {pending?.system === "macos" && recoveryError && <section className="initialization-notice" role="alert" aria-label="Не удалось прочитать состояние восстановления">
              <p>Сейчас не удаётся прочитать состояние восстановления установки macOS; ход установки не затронут.</p>
              <p><SafetyMessage message={recoveryError} /></p>
              <button disabled={busy} onClick={() => pollNow.current?.()}>Проверить снова</button>
            </section>}
            {job.error && !progress && !(status.guest_system === "macos" && networkPending) && <div className="initialization-notice" role="alert"><SafetyMessage message={job.error} />{!networkPending && !needsExitRestart && <button className="primary" disabled={busy || Boolean(connectionError)} onClick={install}>Продолжить установку</button>}</div>}
            {status.guest_system === "macos" && status.vm_running && !status.ready && !busy && <section className="initialization-notice"><h2>Подключение к виртуальному Mac</h2><p>{status.environment_update_error || "Гостевая система запущена, но подключение к рабочей области не установлено. Проверьте, не осталась ли она на экране входа."}</p><MacOSLogin onSessionClosed={() => pollNow.current?.()} /><button disabled={Boolean(connectionError)} onClick={install}>Подключиться и проверить снова</button></section>}
            {status.ready && network.mode !== "open" && !busy && !needsExitRestart && <>
              {status.guest_system === "macos" && <InitializationChecks status={status} busy={Boolean(connectionError)} onWorkspace={setApprovalWorkspace} onCheck={checkNetwork} onStart={install} onRestart={restart} onUpdate={() => run(() => api("/environment/update", {}))} onDiagnostics={() => setHelp(true)} />}
              <div className="initialization-network"><p>{status.safety?.error || job.error || status.network_error || "Гостевая система подключена. Завершите проверку сети и изоляции, чтобы перейти в рабочую область."}</p><button disabled={Boolean(connectionError)} onClick={checkNetwork}>Проверить сеть и изоляцию</button></div>
            </>}
            {(progress?.setup_progress.phase === "image" || (failed && !networkPending)) && <p>Системный образ и компоненты установки macOS, подготавливаемые на хосте, используют настройки прокси хоста. При сбое загрузки откройте сведения об операции, чтобы увидеть текущий файл и историю повторов. Сетевые запросы внутри гостевой системы идут через прокси Cage.</p>}
            <div className="initialization-recovery"><button onClick={() => setStep("proxy")} disabled={busy}>Проверить настройки прокси Cage</button>{!progress && <button onClick={() => setDetails(true)}>Сведения об операции</button>}</div>
          </>)}
        </div>
        {error && <p className="initialization-notice" role="alert"><SafetyMessage message={error} /></p>}
        <footer className="initialization-actions">
          {step === "system" ? <span /> : <button className="text-button" disabled={busy} onClick={back}><ChevronLeft size={16} />Назад</button>}
          {step === "system" && <button className="primary" disabled={busy || !storage?.directory.trim() || choice === undefined || (!choice?.clone && !validGuestChoice(choice)) || choice?.clone && choice.guest_system === "windows-11" && !choice.editor_terms || Boolean(connectionError)} onClick={nextFromSystem}>{submitting && <LoaderCircle size={16} className="spin" />}Далее: настроить прокси</button>}
          {step === "proxy" && <button className="primary" disabled={busy || proxyDirty || !account?.guest_system && !pending && !validGuestChoice(choice) || needsProxySetup(null, status, proxy) || Boolean(connectionError)} onClick={install}>{submitting ? <LoaderCircle size={16} className="spin" /> : null}Начать установку</button>}
          {step === "install" && ready && <button className="primary" disabled={submitting || Boolean(connectionError)} onClick={enter}>Перейти в рабочую область</button>}
        </footer>
      </>}
      <div className="initialization-support"><button className="text-button" aria-expanded={help} onClick={() => setHelp(!help)}>Журналы и диагностика</button>{navigation && !busy && <button className="text-button" onClick={() => navigation.open()}>Только подключение по SSH</button>}</div>
      {help && <DiagnosticSettings />}
    </section>
    {approvalWorkspace && <InitializationProjectApproval workspace={approvalWorkspace} jobRunning={Boolean(job.running)} onClose={() => { setApprovalWorkspace(""); pollNow.current?.(); }} onApproved={() => { setApprovalWorkspace(""); void checkNetwork(); }} />}
    {details && <Modal title="Сведения об операции инициализации" onClose={() => setDetails(false)}><InitializationDetails status={status} /></Modal>}
    {dialog && <Modal title={dialog.title} onClose={() => settleDialog(false)} footer={<><button onClick={() => settleDialog(false)}>Отмена</button><button className="primary" onClick={() => settleDialog(true)}>{dialog.confirm}</button></>}><div className="modal-body"><p>{dialog.body}</p></div></Modal>}
  </InitializationFrame>;
}
