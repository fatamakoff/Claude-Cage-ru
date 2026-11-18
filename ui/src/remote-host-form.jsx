import React, { useState } from "react";
import { api } from "./api";
import { InlineSelect } from "./inline-select";
import { Modal } from "./modal";

const emptyHost = () => ({
  name: "",
  host: "",
  port: 22,
  user: "",
  platform: "linux",
  auth: { kind: "key_file", identity_file: "" },
  executable: "cage",
  config_path: "",
});

export function HostForm({ initial, platform, onSaved, onClose }) {
  const [form, setForm] = useState(() =>
    initial ? structuredClone(initial) : emptyHost(),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const update = (field, value) =>
    setForm((old) => ({
      ...old,
      [field]: value,
      ...(["host", "port"].includes(field) ? { host_key: undefined } : {}),
    }));
  async function save(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const saved = await api(
        form.id ? `/client/hosts/${form.id}` : "/client/hosts",
        { ...form, port: Number(form.port) },
        form.id ? "PUT" : "POST",
      );
      await onSaved(saved);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={form.id ? "Изменить удалённый хост" : "Добавить удалённый хост"}
      onClose={busy ? undefined : onClose}
    >
      <form className="remote-host-form" onSubmit={save}>
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        <fieldset disabled={busy}>
          <label>
            Имя хоста
            <input
              required
              value={form.name}
              onChange={(event) => update("name", event.target.value)}
              placeholder="Например: сервер разработки"
              maxLength={200}
            />
          </label>
          <div className="remote-form-row">
            <label>
              Адрес сервера
              <input
                required
                value={form.host}
                onChange={(event) => update("host", event.target.value)}
                placeholder="IP-адрес или домен"
                autoComplete="off"
                spellCheck="false"
              />
            </label>
            <label className="remote-port">
              Порт SSH
              <input
                required
                type="number"
                min="1"
                max="65535"
                value={form.port}
                onChange={(event) => update("port", event.target.value)}
              />
            </label>
          </div>
          <label>
            Удалённая система
            <InlineSelect
              inline
              aria-label="Удалённая система"
              value={form.platform || "linux"}
              onValueChange={(value) => update("platform", value)}
            >
              <option value="linux">Linux</option>
              <option value="windows">Windows (развёрнутая служба)</option>
            </InlineSelect>
          </label>
          <label>
            Имя пользователя SSH
            <input
              required
              value={form.user}
              onChange={(event) => update("user", event.target.value)}
              placeholder="cage"
              autoComplete="off"
              spellCheck="false"
            />
          </label>
          <label>
            Способ входа SSH
            <InlineSelect
              aria-label="Способ входа SSH"
              value={form.auth.kind}
              onValueChange={(kind) =>
                update("auth", {
                  kind,
                  identity_file:
                    kind === "key_file" ? form.auth.identity_file || "" : "",
                })
              }
            >
              <option value="key_file">Файл ключа на этом компьютере</option>
              <option value="agent">SSH-агент этого компьютера</option>
            </InlineSelect>
          </label>
          {form.auth.kind === "key_file" && (
            <label>
              Файл закрытого ключа
              <input
                aria-label="Файл закрытого ключа"
                required
                value={form.auth.identity_file}
                onChange={(event) =>
                  update("auth", {
                    ...form.auth,
                    identity_file: event.target.value,
                  })
                }
                placeholder={
                  platform === "windows"
                    ? "C:\\Users\\имя\\.ssh\\id_ed25519"
                    : "/Users/имя/.ssh/id_ed25519"
                }
                autoComplete="off"
                spellCheck="false"
              />
              <small>Укажите абсолютный путь. Ключ остаётся на этом компьютере и не загружается в облако.</small>
            </label>
          )}
          <details>
            <summary>Путь установки в облаке</summary>
            <div className="remote-advanced">
              <label>
                Путь к программе Cage
                <input
                  value={form.executable || ""}
                  onChange={(event) => update("executable", event.target.value)}
                  placeholder="cage"
                  spellCheck="false"
                />
                <small>По умолчанию используется cage; можно указать абсолютный путь к программе в облаке.</small>
              </label>
              <label>
                Файл конфигурации Cage
                <input
                  value={form.config_path || ""}
                  onChange={(event) =>
                    update("config_path", event.target.value)
                  }
                  placeholder={form.platform === "windows" ? "например C:\\ProgramData\\Cage Remote\\config.json" : "по умолчанию ~/.claude-cage/config.json аккаунта облака"}
                  spellCheck="false"
                />
                <small>При своём значении укажите абсолютный путь в облаке.</small>
              </label>
            </div>
          </details>
          <div className="remote-button-row">
            <button className="primary" type="submit">
              Сохранить хост
            </button>
            <button type="button" onClick={onClose}>
              Отмена
            </button>
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}
