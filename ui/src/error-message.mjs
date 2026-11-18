export function operationName(path = "", method = "GET") {
  const reading = method === "GET";
  if (path === "/client/about") return reading ? "Чтение версии приложения" : "Проверка обновлений приложения";
  if (path.startsWith("/api/mobile/cli")) return reading ? "Чтение сообщений сессии" : "Отправка действия в сессии";
  if (path.startsWith("/api/mobile/browser")) return "Подключение браузера на компьютере";
  if (path.startsWith("/api/mobile/desktop")) return "Подключение Claude Desktop на компьютере";
  if (path.startsWith("/environment/resources")) return reading ? "Чтение конфигурации ресурсов" : "Применение конфигурации ресурсов";
  if (path === "/environment/initialization") return reading ? "Чтение хода инициализации" : "Сохранение состояния инициализации";
  if (path.startsWith("/environment/versions")) return "Чтение версий компонентов среды";
  if (path.startsWith("/environment/macos-screen-sharing")) return "Общий доступ к экрану гостевой системы";
  if (path === "/environment/cache/inventory") return "Инвентаризация кеша среды";
  if (path === "/environment/cache/clean") return "Очистка выбранного кеша";
  if (path === "/environment/cache/restore") return "Восстановление кеша";
  if (path.startsWith("/environment/")) return "Обновление среды";
  if (path.startsWith("/input/files") || path.startsWith("/browser/files")) return "Передача файлов";
  if (path.startsWith("/tailscale")) return reading ? "Чтение состояния Tailscale" : "Управление Tailscale";
  if (path.startsWith("/browser")) return "Управление браузером";
  if (path.startsWith("/proxy")) return reading ? "Чтение настроек прокси" : "Применение настроек прокси";
  if (path.startsWith("/safety")) return "Проверка условий подключения к сети";
  if (path.startsWith("/settings/probe")) return "Проверка выхода через прокси";
  if (path.startsWith("/settings")) return reading ? "Чтение настроек" : "Сохранение настроек";
  if (path.startsWith("/diagnostics/export")) return "Экспорт журнала диагностики";
  if (path.startsWith("/diagnostics")) return "Чтение журнала диагностики";
  if (path.startsWith("/projects")) return "Подключение каталога проекта";
  if (path.startsWith("/account")) return "Операции с аккаунтом";
  if (path.startsWith("/claude-desktop")) return "Управление Claude Desktop";
  if (path.startsWith("/terminals")) return "Подключение терминала";
  if (path === "/start") return "Запуск среды";
  if (path === "/stop") return "Остановка среды";
  return "Подключение к рабочей области Cage";
}

export function httpErrorMessage(path, status, text = "", contentType = "", method = "GET") {
  // HTML-страницы прокси, трассировки стека и нелокализованные ошибки среды —
  // не пояснения интерфейса. Короткие сообщения от самого Cage сохраняем.
  const message = text.trim();
  if (contentType.startsWith("text/plain") && message.length <= 2000 && /\p{Script=Han}/u.test(message) && !/<(?:html|body|script|!doctype)\b/i.test(message)) return message;
  if (path === "/settings" && method === "POST" && status === 503) {
    return "Пока не удаётся подтвердить, сохранены ли настройки (HTTP 503). После восстановления соединения проверьте настройки и детали операции, затем решите, нужно ли сохранять заново.";
  }
  const action = operationName(path, method);
  const reasons = {
    400: "Бэкенд не принял этот запрос. Проверьте введённые данные; если ошибка повторяется, экспортируйте пакет диагностики в настройках.",
    401: "Сессия входа в рабочую область истекла. Подключитесь к Cage заново и повторите операцию.",
    403: "Бэкенд отклонил доступ. Откройте рабочую область заново из приложения Cage.",
    404: "Бэкенд не предоставляет нужную функцию. Убедитесь, что приложение и бэкенд обновлены.",
    409: "Состояние среды изменилось или другая операция ещё не завершена. Обновите состояние и дождитесь завершения текущей операции.",
    413: "Размер файла или запроса превышает допустимый. Уменьшите файл или обработайте его частями.",
    423: "Cage заблокирован. Сначала разблокируйте аккаунт, затем повторите операцию.",
    429: "Слишком много запросов. Подождите немного и не нажимайте подряд.",
    500: "Бэкенд обработал запрос с ошибкой. Экспортируйте пакет диагностики в настройках и укажите только что выполненное действие.",
    502: "Бэкенд не смог подключиться к сервисам внутри среды. Убедитесь, что среда запущена, и проверьте состояние её компонентов.",
    503: "Сервис бэкенда ещё не готов или перезапускается. Дождитесь восстановления соединения.",
    504: "Истекло время ожидания ответа бэкенда. Проверьте нагрузку среды; после восстановления соединения выясните, применилась ли операция.",
  };
  return `${action} — ошибка (HTTP ${status}): ${reasons[status] || "причина не распознана. Экспортируйте пакет диагностики в настройках."}`;
}

export function connectionErrorMessage(path, method = "GET") {
  return `${operationName(path, method)} — ошибка: соединение рабочей области с бэкендом Cage прервано. Переподключитесь; если вы сохраняли или загружали данные, после восстановления сначала проверьте результат, затем повторите попытку.`;
}

export function nativeFailureMessage(action, message = "") {
  if (/\p{Script=Han}/u.test(message) && !["文件操作失败", "原生操作超时，请重试", "操作失败"].includes(message)) return message;
  const names = { chooseFolder: "выбор папки на этом компьютере", chooseUploadFiles: "выбор файлов для загрузки", uploadHostFiles: "загрузка файлов с компьютера", openHostPath: "открытие файла на компьютере", exportDiagnostics: "экспорт пакета диагностики", appUpdate: "проверка или установка обновлений приложения", clipboardRead: "чтение буфера обмена", clipboardWrite: "запись в буфер обмена", refreshSession: "восстановление сессии рабочей области" };
  return `${names[action] || "выполнение локальной операции"} — ошибка: ${/timeout|超时/i.test(message) ? "истекло время ожидания ответа локального компонента" : "локальный компонент не вернул распознаваемую причину"}. Подключитесь к Cage заново; если ошибка повторяется, экспортируйте пакет диагностики в настройках.`;
}
