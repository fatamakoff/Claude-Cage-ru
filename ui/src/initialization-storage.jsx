import React, { useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import { api, native, nativeAvailable } from "./api";

export function InitializationStorage({ value, onChange, disabled }) {
  const [error, setError] = useState("");
  const [attempt, retry] = useState(0);
  useEffect(() => {
    if (value) return;
    let live = true;
    api("/environment/storage").then(location => {
      if (live) onChange({ location, directory: location.suggested_directory || location.directory });
    }).catch(error => { if (live) setError(error.message); });
    return () => { live = false; };
  }, [Boolean(value), onChange, attempt]);
  const locked = disabled || !value || value.location.has_environment;
  async function choose() {
    try {
      const directory = await native("chooseFolder", { purpose: "environmentStorage" });
      if (directory) { onChange({ ...value, directory }); setError(""); }
    } catch (error) { setError(error.message); }
  }
  return <section className="initialization-storage" aria-label="Каталог хранилища среды">
    <label htmlFor="initialization-directory">Каталог хранилища</label>
    <p>Здесь хранятся системный образ, кэш загрузок и виртуальный диск. Каталог по умолчанию уже подставлен; можно выбрать отдельную пустую папку на другом локальном диске.</p>
    <p>Это каталог данных среды Cage. Данные сохраняются при обновлении, переустановке и удалении приложения; не удаляйте их вручную.</p>
    <div className="initialization-directory-control">
      <input id="initialization-directory" value={value?.directory || ""} disabled={locked} spellCheck={false} placeholder={value ? "Введите полный путь к каталогу хранилища" : "Чтение каталога по умолчанию…"} onChange={event => onChange({ ...value, directory: event.target.value })} />
      {nativeAvailable() && <button type="button" disabled={locked} onClick={choose}><FolderOpen size={16} />Выбрать папку</button>}
    </div>
    {value?.location.has_environment && <p>Виртуальный диск уже существует, используется прежний каталог хранилища. После инициализации его можно перенести в настройках.</p>}
    {error && <p role="alert">{error}<button onClick={() => { setError(""); retry(value => value + 1); }}>Прочитать снова</button></p>}
  </section>;
}
