import React, { useEffect, useState } from "react";
import { api } from "./api";
import { InlineSelect } from "./inline-select";
import { SafetyMessage } from "./safety-message";

const textFields = [
  ["hostname", "Имя хоста", "Оставьте пустым для случайного имени ПК", 15],
  ["username", "Рабочий аккаунт Linux", "Оставьте пустым для генерации", 24],
  ["work_home", "Домашний каталог рабочего аккаунта", "Оставьте пустым для /home/<рабочий аккаунт>", 69],
  ["browser_username", "Аккаунт браузера Linux", "Оставьте пустым для генерации; должен отличаться от рабочего аккаунта", 24],
  ["browser_home", "Домашний каталог аккаунта браузера", "Оставьте пустым для /home/<аккаунт браузера>", 69],
  ["extension_name", "Имя расширения управления Linux", "Оставьте пустым для случайного выбора", 64],
];
const dimensions = [["display", "Виртуальный дисплей Linux"], ["browser", "Начальное окно браузера"]];

const nativeFields = new Set(["hostname", "browser_width", "browser_height", "webgl", "canvas", "graphics_backend"]);
const backendSystems = { metal: "macos", d3d11: "windows-11", vulkan: "linux" };

export function guestOptionsForSystem(input, system) {
  const native = system === "macos" || system === "windows-11";
  const options = native
    ? Object.fromEntries(Object.entries(input).filter(([key]) => nativeFields.has(key)))
    : { ...input };
  const required = backendSystems[options.graphics_backend];
  if (required && required !== (native ? system : "linux")) delete options.graphics_backend;
  return options;
}

export function GuestProfileOptions({ value, onChange, disabled, system }) {
  const [saved, setSaved] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [editable, setEditable] = useState(false);
  const [error, setError] = useState("");
  const [generating, setGenerating] = useState(false);
  const [capabilities, setCapabilities] = useState(null);
  useEffect(() => {
    let live = true;
    api("/environment/guest-profile").then(result => {
      if (!live) return;
      setSaved(result.profile); setEditable(result.editable); setLoaded(true);
      setCapabilities(result);
      if (!result.editable) onChange(null);
    }).catch(error => { if (live) setError(error.message); });
    return () => { live = false; };
  }, [onChange]);
  const native = system === "macos" || system === "windows-11";
  const options = guestOptionsForSystem(saved || value || {}, system);
  const locked = disabled || !editable || generating;
  const set = (key, next) => {
    const updated = { ...(value || {}), [key]: next };
    if (key === "webgl" && next === "disabled") updated.graphics_backend = "auto";
    if (key === "gpu_backend" && next === "virgl" && updated.graphics_backend === "vulkan") updated.graphics_backend = "opengl";
    onChange(updated);
  };
  async function randomize() {
    setGenerating(true); setError("");
    try {
      const preview = await api("/environment/guest-profile/preview", { webgl: options.webgl || "native", canvas: options.canvas || "native", graphics_backend: options.graphics_backend || "auto", gpu_backend: options.gpu_backend || "default" });
      onChange(guestOptionsForSystem(preview, system));
    }
    catch (error) { setError(error.message); }
    finally { setGenerating(false); }
  }
  return <details className="guest-profile-options"><summary>Имя гостевой системы и начальная конфигурация устройств</summary>
    <p>Выберите естественное, запоминающееся имя, отличное от прежних идентичностей в средах. Имя пользователя, домашний каталог, имя хоста и размеры можно задать вручную; при пустых полях создаются начальные значения, сохраняемые при перезапусках.</p>
    {error && <p role="alert"><SafetyMessage message={error} /></p>}
    {loaded && !editable && <p>{saved ? "Конфигурация создания этой среды сохранена; при продолжении установки будут использованы настройки ниже." : "Существующая среда использует прежнюю конфигурацию; эти параметры относятся к созданию отдельной новой среды."}</p>}
    {loaded && (editable || saved) && <fieldset disabled={locked}>
      {textFields.filter(([key]) => !native || key === "hostname").map(([key, label, placeholder, maxLength]) => <label key={key}>{label}<input value={options[key] || ""} maxLength={maxLength} placeholder={placeholder} onChange={event => set(key, event.target.value)} autoComplete="off" /></label>)}
      {dimensions.filter(([key]) => !native || key === "browser").map(([key, label]) => <label key={key}>{label}<span className="guest-profile-size">{["width", "height"].map((axis, i) => <React.Fragment key={axis}>{i > 0 && " × "}<input type="number" min={i ? 600 : 800} max={i ? 2160 : 3840} placeholder={i ? "Высота (случайно)" : "Ширина (случайно)"} value={options[`${key}_${axis}`] || ""} onChange={event => set(`${key}_${axis}`, event.target.value === "" ? 0 : Number(event.target.value))} /></React.Fragment>)}</span></label>)}
      {!native && <label>Аудиоустройство (автоматический выбор реальной модели)<output>{options.audio_description || `При создании случайный выбор из ${capabilities?.audio_models?.length || 12} моделей`}</output><small>Название модели соответствует идентификатору устройства; случайный суффикс служит только для идентификации этой среды.</small></label>}
      <label>Идентичность браузера<output>Соответствует фактически установленному браузеру, UA и Client Hints согласованы</output></label>
      <label>Графический бэкенд<InlineSelect inline aria-label="Графический бэкенд" value={options.graphics_backend || "auto"} onValueChange={value => set("graphics_backend", value)} disabled={locked || options.webgl === "disabled"}><option value="auto">Автоматически использовать доступные устройства гостевой системы</option>{system === "macos" && <option value="metal">ANGLE / Metal</option>}{system === "windows-11" && <option value="d3d11">ANGLE / D3D11</option>}{!native && <option value="vulkan" disabled={options.gpu_backend === "virgl"}>ANGLE / Vulkan (требует поддержки драйвера, VirGL не подходит)</option>}<option value="opengl">ANGLE / OpenGL</option><option value="software">Программный режим совместимости SwiftShader</option></InlineSelect></label>
      {!native && capabilities?.host_os === "linux" && !capabilities.container && <label>Виртуальный GPU<InlineSelect inline aria-label="Виртуальный GPU" value={options.gpu_backend || "default"} onValueChange={value => set("gpu_backend", value)}><option value="default">Использовать существующее виртуальное устройство</option><option value="virgl">QEMU VirGL + DRI3 (экспериментально, требуется GPU хоста)</option></InlineSelect></label>}
      <label>WebGL<InlineSelect inline aria-label="WebGL" value={options.webgl || "native"} onValueChange={value => set("webgl", value)}><option value="native">Использовать нативные графические возможности гостевой системы</option><option value="disabled">Отключить 3D-графику в браузере</option></InlineSelect></label>
      <label>Чтение изображений Canvas<InlineSelect inline aria-label="Чтение изображений Canvas" value={options.canvas || "native"} onValueChange={value => set("canvas", value)}><option value="native">Разрешить сайтам читать изображения Canvas</option><option value="blocked">Запретить сайтам читать изображения Canvas</option></InlineSelect></label>
      <p>Название бэкенда указывает фактический путь рендеринга; наличие аппаратного ускорения проверяется при диагностике среды. Отключение WebGL или блокировка чтения Canvas влияет на некоторые сайты; эти параметры не подменяют модель видеокарты, сообщаемую драйвером.</p>
      <button type="button" onClick={randomize}>{generating ? "Создание…" : "Сгенерировать новые имена и размеры"}</button>
    </fieldset>}
  </details>;
}
