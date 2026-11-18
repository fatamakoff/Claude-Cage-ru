import test from "node:test";
import assert from "node:assert/strict";
import { httpErrorMessage, connectionErrorMessage, nativeFailureMessage } from "./error-message.mjs";

test("HTTP failures name the operation and avoid upstream HTML or opaque runtime output", () => {
  for (const [status, reason] of [[401, "Сессия входа"], [409, "операция"], [413, "Размер"], [503, "ещё не готов"], [504, "Истекло время"]]) {
    const message = httpErrorMessage("/environment/resources", status, "<html>token=private</html>", "text/html");
    assert.match(message, /конфигурации ресурсов/);
    assert.ok(message.includes(reason));
    assert.ok(!message.includes("private"));
  }
  const specific = "上传窗口已关闭，请重新点击网页上传按钮";
  assert.equal(httpErrorMessage("/input/files", 409, specific, "text/plain; charset=utf-8"), specific);
  assert.match(connectionErrorMessage("/input/files"), /Передача файлов.*соединение.*проверьте результат/);
  assert.match(httpErrorMessage("/settings", 503, "", "", "POST"), /не удаётся подтвердить, сохранены ли настройки.*проверьте настройки/);
});

test("native errors retain precise rules and explain opaque failures in context", () => {
  assert.match(nativeFailureMessage("exportDiagnostics", "Native operation timeout"), /экспорт пакета диагностики.*истекло время ожидания/);
  assert.match(nativeFailureMessage("uploadHostFiles", "operation failed token=private"), /загрузка файлов с компьютера.*распознаваемую причину/);
  assert.ok(!nativeFailureMessage("uploadHostFiles", "operation failed token=private").includes("private"));
  const rule = "请选择本机项目中的文件";
  assert.equal(nativeFailureMessage("uploadHostFiles", rule), rule);
});
