import React, { useState } from "react";
import {
  ShieldCheck,
  ShieldAlert,
  Check,
  CircleHelp,
  X,
  LoaderCircle,
  ArrowUpRight,
  Copy,
  Settings,
  ChevronDown,
} from "lucide-react";
import { api, writeClipboard } from "./api";
import { Modal } from "./views";
import { DeviceChecks } from "./device-checks";
import { networkState, reportForSharing } from "./safety-state.mjs";

const diagnostics = [
  {
    name: "Качество IP",
    source: "ip.net.coffee",
    url: "https://ip.net.coffee/claude/",
    description: "Свойства IP, ASN, репутация и диагностика сети.",
  },
  {
    name: "Данные браузера",
    source: "fuck-claude.vercel.app",
    url: "https://fuck-claude.vercel.app/",
    description: "Оценка сообществом сигналов браузера: часового пояса, языка, шрифтов.",
    attribution: "Исходный проект FuckClaude создан и поддерживается LinXiaoTao.",
    links: [
      { label: "Сайт проекта", url: "https://fuck-claude.vercel.app/" },
      { label: "Репозиторий", url: "https://github.com/LinXiaoTao/FuckClaude" },
      {
        label: "Первый коммит",
        url: "https://github.com/LinXiaoTao/FuckClaude/commit/420c79bb0531b12ea2788e726ffbf81075111737",
      },
    ],
  },
];

export async function bindDetectedMacOSExit(ip, onConfirm) {
  if (!(await onConfirm({ title: "Привязать фиксированный выход?", body: `Терминал гостевой системы, браузер и прокси показали ${ip}. После сохранения перезапустите гостевую систему и повторите проверку.`, confirm: "Привязать фиксированный выход" }))) return null;
  return api("/macos/exit-policy", { ip });
}

export function SafetyPanel({
  status,
  onClose,
  onSettings,
  onOpenPage,
  onConfirm,
}) {
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const network = networkState(status),
    safety = status.safety || {},
    report = safety.report;
  const busy = Boolean(status.job?.running),
    online = network.mode === "open";
  const passed =
    report?.checks?.filter((c) => c.critical && c.state === "passed").length ||
    0;
  const total = report?.checks?.filter((c) => c.critical).length || 0;
  const run = async () => {
    setError("");
    if (
      status.vm_running &&
      !safety.gate &&
      !(await onConfirm({
        title: "Перезапустить среду и загрузить компонент проверки?",
        body: "Текущие сессии терминала завершатся. Сначала сохраните файлы; входы в браузере и файлы проекта сохранятся.",
        confirm: "Перезапустить и проверить",
      }))
    )
      return;
    try {
      await api(status.ready && safety.gate ? "/safety/check" : "/start", {});
    } catch (e) {
      setError(e.message);
    }
  };
  const pause = async () => {
    setError("");
    try {
      await api("/safety/close", {});
    } catch (e) {
      setError(e.message);
    }
  };
  const copy = async () => {
    try {
      await writeClipboard(JSON.stringify(reportForSharing(report), null, 2));
      setNotice("Отчёт скопирован: без учётных данных прокси, IP-адресов и локальных путей");
    } catch {
      setError("Не удалось записать в буфер обмена. Проверьте разрешения браузера на доступ к буферу обмена.");
    }
  };
  const open = async (url) => {
    if (await onOpenPage(url)) onClose();
  };
  return (
    <Modal
      title="Проверка сети и изоляции"
      wide
      onClose={onClose}
      footer={
        <>
          <span className="save-note">
            {busy ? status.job.message : "При выключенном внешнем доступе офлайн-терминалы и файлы остаются доступны"}
          </span>
          {(online || network.mode === "checking") && (
            <button onClick={pause}>
              {network.mode === "checking" ? "Отменить проверку и отключить сеть" : "Приостановить сеть"}
            </button>
          )}
          <button className="primary" disabled={busy} onClick={run}>
            {busy ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <ShieldCheck size={15} />
            )}
            {busy
              ? "Идёт проверка"
              : online
                ? "Отключить сеть и перепроверить"
                : status.ready && safety.gate
                  ? "Проверить снова"
                  : status.vm_running
                    ? "Перезапустить и проверить"
                    : "Запустить и проверить"}
          </button>
        </>
      }
    >
      <div className="modal-body safety-body">
        {safety.macos_exit_candidate?.ip && <button disabled={busy} onClick={async () => {
          try { if (await bindDetectedMacOSExit(safety.macos_exit_candidate.ip, onConfirm)) setNotice("Фиксированный выход отправлен. После сохранения перезапустите гостевую систему и повторите проверку."); }
          catch (e) { setError(e.message); }
        }}>Привязать обнаруженный фиксированный выход {safety.macos_exit_candidate.ip}</button>}
        <div className={`safety-summary ${network.mode}`}>
          {online ? (
            <ShieldCheck size={27} />
          ) : network.mode === "checking" ? (
            <LoaderCircle size={27} className="spin" />
          ) : (
            <ShieldAlert size={27} />
          )}
          <div>
            <h3>{network.label}</h3>
            <p>
              {busy
                ? status.job.message
                : online
                  ? status.network_error || "Ключевые проверки пройдены, в фоне продолжается сверка правил выхода и конфигурации среды."
                  : status.network_error || safety.error ||
                    safety.gate?.reason ||
                    "Подключение к внешним сайтам разрешается только после ключевых проверок."}
            </p>
          </div>
          <button className="text-button" onClick={() => onSettings("network")}>
            <Settings size={15} />
            Правила выхода
          </button>
        </div>
        {(error || notice) && (
          <div
            role="status"
            className={error ? "error-message" : "inline-info"}
          >
            {error || notice}
          </div>
        )}
        <div className="safety-section-heading">
          <h4>Ключевые проверки</h4>
          <span>{total ? `${passed} / ${total} пройдено` : "Записей о проверках нет"}</span>
          {report && (
            <button className="text-button" onClick={copy}>
              <Copy size={14} />
              Копировать отчёт
            </button>
          )}
        </div>
        {report ? (
          <>
            <p className="safety-timestamp">
              Проверено {new Date(report.created_at).toLocaleString("ru-RU")} ·{" "}
              {online ? "текущий запущенный экземпляр" : "отчёт не означает, что доступ сейчас разрешён"}
            </p>
            <div className="safety-checks">
              {report.checks
                .filter((check) => check.critical)
                .map((check) => {
                  const Icon =
                    check.state === "passed"
                      ? Check
                      : check.state === "failed"
                        ? X
                        : CircleHelp;
                  return (
                    <details
                      className={`safety-check ${check.state}`}
                      key={check.id}
                    >
                      <summary>
                        <Icon size={16} />
                        <strong>{check.title}</strong>
                        <span>
                          {check.state === "passed"
                            ? "Пройдено"
                            : check.state === "failed"
                              ? "Не пройдено"
                              : busy && check.checked_at === report.created_at
                                ? "Ожидает проверки"
                                : "Неизвестно"}
                        </span>
                        <ChevronDown size={14} />
                      </summary>
                      <div>
                        <p>{check.evidence}</p>
                        {check.state !== "passed" && check.remedy && (
                          <p className="check-remedy">{check.remedy}</p>
                        )}
                      </div>
                    </details>
                  );
                })}
            </div>
          </>
        ) : (
          <p className="safety-empty">
            Проверки охватывают правила исходящих соединений, отказ при сбое прокси, DNS, общие каталоги, интерфейс управления хостом, а также фактическую конфигурацию системы и браузера. При сбое или неизвестном результате ключевой проверки внешний доступ остаётся закрытым.
          </p>
        )}
        <DeviceChecks disabled={busy || !status.vm_running} />
        {report?.checks?.some((check) => !check.critical) && (
          <div className="safety-advisories">
            {report.checks
              .filter((check) => !check.critical)
              .map((check) => (
                <p key={check.id}>
                  <CircleHelp size={15} />
                  <span>
                    <strong>{check.title}:</strong>
                    {check.evidence}
                  </span>
                </p>
              ))}
          </div>
        )}
        <div className="safety-section-heading">
          <h4>Дополнительные проверки сообщества</h4>
          <span>Рекомендации, не влияют на допуск к сети</span>
        </div>
        <div className="diagnostic-sites">
          {diagnostics.map((site) => (
            <div key={site.url}>
              <strong>{site.name}</strong>
              <small>{site.source}</small>
              <p>{site.description}</p>
              <button disabled={!online || busy} onClick={() => open(site.url)}>
                Открыть в Cage
                <ArrowUpRight size={14} />
              </button>
              {site.attribution && (
                <div className="safety-scope">
                  <p>{site.attribution}</p>
                  <div className="safety-sources">
                    {site.links.map((link) => (
                      <button
                        key={link.url}
                        className="text-button"
                        disabled={!online || busy}
                        onClick={() => open(link.url)}
                      >
                        {link.label}
                        <ArrowUpRight size={12} />
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
        <p className="field-help">
          Сторонние сайты посещаются только после нажатия. Сайт получит IP-адрес выхода Cage
          и сможет прочитать доступные на странице данные браузера. Оценки носят справочный характер.
        </p>
        <details className="safety-scope">
          <summary>Объём и источники проверки</summary>
          <p>
            Текущая версия проверяет выход IPv4; публичный IPv6 и UDP в гостевой системе отключены. Мониторинг выхода выполняется примерно раз в 30
            секунд; местоположение берётся из базы IP-адресов,
            определение города может быть неточным. Поведение самого прокси с разделением по целям нужно ограничивать на стороне прокси.
          </p>
          <p>
            Отчёт содержит политики времени выполнения и свидетельства выборки и не заменяет полный аудит виртуализации, а также не предсказывает право на аккаунт платформы или блокировки. Полная проверка действует
            24 часа; после потери связи со службой управления сетевой доступ сохраняется не более 90 секунд.
          </p>
          <div className="safety-sources">
            <span>Методика</span>
            <button
              className="text-button"
              disabled={!online}
              onClick={() =>
                open("https://github.com/YOURSJEYO/claude-switcher")
              }
            >
              claude-switcher
              <ArrowUpRight size={12} />
            </button>
            <button
              className="text-button"
              disabled={!online}
              onClick={() =>
                open("https://github.com/DUNHKpcc/Claude-Guardian")
              }
            >
              Claude-Guardian
              <ArrowUpRight size={12} />
            </button>
          </div>
        </details>
      </div>
    </Modal>
  );
}
