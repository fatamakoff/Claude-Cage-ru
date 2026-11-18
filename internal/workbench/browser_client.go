package workbench

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"

	"github.com/sylvinus/agent-vm/internal/diagnostics"
	"github.com/sylvinus/agent-vm/internal/usererror"
)

const browserResponseLimit = 1 << 20
const browserOrigin = "http://127.0.0.1:18500"

// browserClient owns host connections to the guest browser controller. Closing
// it cancels those connections; the guest browser process remains untouched.
type browserClient struct {
	ctx    context.Context
	cancel context.CancelFunc
	http   *http.Client
}

func newBrowserClient(parent context.Context) *browserClient {
	ctx, cancel := context.WithCancel(parent)
	return &browserClient{ctx: ctx, cancel: cancel, http: &http.Client{
		Transport:     &http.Transport{Proxy: nil, IdleConnTimeout: 30 * time.Second, MaxIdleConnsPerHost: 4, DialContext: (&net.Dialer{Timeout: 3 * time.Second}).DialContext},
		CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect refused") },
	}}
}

func (c *browserClient) close() {
	c.cancel()
	c.http.CloseIdleConnections()
}

// The response owns cancellation until its body is closed. This also covers
// event subscriptions, whose lifetime extends beyond receiving HTTP headers.
func (c *browserClient) open(parent context.Context, token, method, path, contentType string, body io.Reader, length int64, timeout time.Duration) (*http.Response, error) {
	if err := c.ctx.Err(); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(parent)
	stop := context.AfterFunc(c.ctx, cancel)
	finish := func() { stop(); cancel() }
	if timeout > 0 {
		var cancelTimeout context.CancelFunc
		ctx, cancelTimeout = context.WithTimeout(ctx, timeout)
		finish = func() { stop(); cancelTimeout(); cancel() }
	}
	req, err := http.NewRequestWithContext(ctx, method, browserOrigin+path, body)
	if err != nil {
		finish()
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if body != nil {
		req.Header.Set("Content-Type", contentType)
		req.ContentLength = length
	}
	response, err := c.http.Do(req)
	if err != nil {
		finish()
		return nil, err
	}
	response.Body = &browserResponseBody{ReadCloser: response.Body, finish: finish}
	return response, nil
}

type browserResponseBody struct {
	io.ReadCloser
	finish func()
}

func (b *browserResponseBody) Close() error {
	b.finish()
	return b.ReadCloser.Close()
}

func (c *browserClient) request(ctx context.Context, token, method, path string, body []byte) ([]byte, error) {
	timeout := 5 * time.Second
	switch path {
	case "/audit", "/paste-image", "/tailnet":
		timeout = 20 * time.Second
	case "/editor-restart":
		timeout = 30 * time.Second
	case "/extensions":
		timeout = 25 * time.Second
	}
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	response, err := c.open(ctx, token, method, path, "application/json", reader, int64(len(body)), timeout)
	if err != nil {
		diagnostics.Log("warn", "browser", fmt.Sprintf("operation=%s transport=%v", path, err))
		return nil, usererror.Wrap(browserOperation(path), err, "Убедитесь, что среда работает, и переподключите браузер; если ошибка повторяется, экспортируйте диагностический пакет в настройках.")
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, browserResponseLimit+1))
	if err != nil {
		return nil, usererror.Wrap(browserOperation(path), err, "Ответ браузера получен не полностью. Переподключитесь и проверьте, применилась ли операция.")
	}
	if len(data) > browserResponseLimit {
		return nil, errors.New(browserOperation(path) + ": ответ браузера превышает 1 MiB, чтение остановлено. Закройте неиспользуемые вкладки или расширения и повторите; если ошибка повторяется, экспортируйте диагностический пакет.")
	}
	if response.StatusCode != http.StatusOK {
		diagnostics.Log("warn", "browser", fmt.Sprintf("operation=%s http=%d", path, response.StatusCode))
		var result struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(data, &result)
		known := map[string]string{
			"Tab no longer exists": "Вкладка закрыта. Снова откройте веб-страницу и повторите.",
			"Browser is starting":  "Браузер ещё запускается. Дождитесь завершения запуска.",
			"Input target changed": "Страница получения содержимого изменилась. Вернитесь на исходную страницу и снова нажмите поле ввода.",
			"Image target changed": "Страница получения изображения изменилась. Вернитесь на исходную страницу и снова нажмите поле ввода.",
			"Copy target changed":  "Страница копирования изменилась. Вернитесь на исходную страницу и скопируйте заново.",
			"Image too large":      "Изображение превышает допустимый размер. Уменьшите его и вставьте снова.",
			"Invalid PNG":          "Файл не является допустимым PNG. Скопируйте или экспортируйте изображение заново.",
			"Only HTTP(S) URLs without credentials are accepted":         "URL содержит имя пользователя или пароль. Используйте URL http или https без учётных данных.",
			"Only HTTP(S) URLs and supported browser pages are accepted": "Этот тип URL не поддерживается. Используйте URL http или https.",
			"Unknown browser action":                                     "Компонент браузера не поддерживает эту операцию. Обновите компоненты среды и повторите.",
			"Split controller unavailable":                               "Компонент разделённого экрана не готов. Обновите компоненты среды и снова откройте разделение.",
			"Editor authentication is unavailable":                       "Локальная сессия входа редактора недоступна. Снова откройте редактор из Cage.",
			"文件接收网页已切换，请返回原网页重试":                                         "Страница получения файла изменилась. Вернитесь на исходную страницу и повторите.",
			"浏览器组件未能恢复，请重启环境":                                            "Компонент браузера не восстановился. Сохраните работу и перезапустите среду.",
			"不同浏览会话不能分屏":                                                 "Страницы из разных сеансов браузера нельзя объединить в разделённый экран. Откройте обе страницы в одном сеансе.",
			"无痕标签暂不支持双网页分屏":                                              "Разделённый экран с двумя страницами пока не поддерживается для вкладок инкогнито. Используйте обычные вкладки.",
			"设置页请在单个浏览器窗格内使用":                                            "Страницу настроек используйте в одной панели браузера. Сначала выйдите из разделённого экрана.",
			"扩展 ZIP 不能超过 32 MB":                                          "ZIP-архив расширения не должен превышать 32 MB. Уменьшите пакет и импортируйте снова.",
		}
		if reason := known[result.Error]; reason != "" {
			return nil, errors.New(browserOperation(path) + ": " + reason)
		}
		return nil, serviceHTTPFailure(browserOperation(path), response.StatusCode)
	}
	return data, nil
}

func (c *browserClient) events(ctx context.Context, token string) (io.ReadCloser, error) {
	response, err := c.open(ctx, token, http.MethodGet, "/events", "", nil, 0, 0)
	if err != nil {
		return nil, err
	}
	if response.StatusCode != http.StatusOK {
		response.Body.Close()
		return nil, serviceHTTPFailure("Получение состояния браузера", response.StatusCode)
	}
	return response.Body, nil
}

func (c *browserClient) file(ctx context.Context, token, method, path string, body io.Reader, length int64) (*http.Response, error) {
	return c.open(ctx, token, method, path, "application/octet-stream", body, length, 30*time.Minute)
}
