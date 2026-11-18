package workbench

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/sylvinus/agent-vm/internal/cage"
	"github.com/sylvinus/agent-vm/internal/host"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

type DesktopOptions struct{ CompleteUpdate, UseExisting bool }
type DesktopResult struct {
	Status     string             `json:"status"`
	URL        string             `json:"url,omitempty"`
	Message    string             `json:"message,omitempty"`
	Legacy     bool               `json:"legacy,omitempty"`
	Controller ControllerIdentity `json:"controller"`
}
type controllerClient struct {
	profile, origin string
	connectionID    string
	record          controlFile
	launch          launchResponse
	client          *http.Client
}

var errControllerUnavailable = errors.New("control service is unavailable")

const (
	// Ordinary launcher requests only read controller memory.
	controllerRequestTimeout = 5 * time.Second
	// Status and handoff probe the VM synchronously. A bound Windows guest is
	// queried through Hyper-V, so their budget must outlast that probe.
	controllerVMRequestTimeout = windowsVMProbeTimeout + 5*time.Second
	// Release probes once for its decision and once more before handing off.
	controllerReleaseRequestTimeout = 2*windowsVMProbeTimeout + 5*time.Second
	// Connecting may start a controller and then wait for its first status.
	localBootstrapTimeout = controllerVMRequestTimeout + 12*time.Second
)

// controllerRequestBudget extends the client timeout only for the requests
// whose handlers wait on a VM state probe.
func controllerRequestBudget(path string) time.Duration {
	switch path {
	case "/api/desktop-local/status", "/api/handoff":
		return controllerVMRequestTimeout
	case "/api/desktop-local/release":
		return controllerReleaseRequestTimeout
	}
	return 0
}

func openController(profile string) (*controllerClient, error) {
	path := filepath.Join(profile, "control.json")
	if err := host.CheckPrivateFile(path); err != nil {
		if os.IsNotExist(err) {
			return nil, errControllerUnavailable
		}
		return nil, err
	}
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, errControllerUnavailable
	}
	if err != nil {
		return nil, err
	}
	var record controlFile
	if json.Unmarshal(b, &record) != nil || record.Port < 1024 || record.Port > 65535 || len(record.Token) != 64 || record.PID < 1 {
		return nil, errors.New("Запись фонового сервиса недействительна. Сохраните текущую среду и проверьте приватную конфигурацию.")
	}
	jar, _ := cookiejar.New(nil)
	c := &controllerClient{profile: profile, record: record, origin: fmt.Sprintf("http://localhost:%d", record.Port), client: &http.Client{Timeout: controllerRequestTimeout, Jar: jar, Transport: &http.Transport{Proxy: nil}, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect refused") }}}
	return c, nil
}

func connectController(profile string) (*controllerClient, error) {
	if controllerLockFree(profile) {
		return nil, errControllerUnavailable
	}
	c, err := openController(profile)
	if err != nil {
		if controllerLockFree(profile) {
			return nil, errControllerUnavailable
		}
		return nil, err
	}
	record := c.record
	status, err := c.call("POST", "/api/launch", map[string]string{"token": record.Token}, &c.launch)
	if err != nil {
		c.close()
		var networkError *url.Error
		if errors.As(err, &networkError) {
			return nil, errControllerUnavailable
		}
		return nil, err
	}
	if status != http.StatusOK {
		c.close()
		if status == http.StatusServiceUnavailable {
			return nil, errControllerUnavailable
		}
		// A dead controller can leave a record whose port or PID is now reused.
		// Only a free profile lock permits a new controller to replace that
		// record. An occupied or inaccessible lock must preserve its owner.
		if controllerLockFree(profile) {
			return nil, errControllerUnavailable
		}
		return nil, errors.New("Не удалось аутентифицировать существующий фоновый сервис; останавливать или заменять его не стали.")
	}
	u, err := url.Parse(c.launch.URL)
	if err != nil || u.Scheme != "http" || u.Host != fmt.Sprintf("localhost:%d", record.Port) || u.User != nil || u.Fragment == "" {
		c.close()
		return nil, errors.New("Фоновый сервис вернул неверную точку входа; подключение к старой рабочей области не выполнено.")
	}
	if c.launch.Controller.Protocol != 0 && c.launch.Controller.PID != record.PID {
		c.close()
		return nil, errors.New("Идентичность фонового сервиса изменилась. Повторите подключение.")
	}
	return c, nil
}
func (c *controllerClient) close() { c.client.CloseIdleConnections() }

// The private launcher record supplies the same desktop proof used by the
// local workbench. Protected requests still require a session and unlock.
func (c *controllerClient) setTrustedViewCookie(origin *url.URL) {
	c.client.Jar.SetCookies(origin, []*http.Cookie{{
		Name: cookieName + "_" + origin.Port() + "-desktop", Value: trustedViewProof(c.record.Token),
		Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode,
	}})
}

// Shutdown removes the record before releasing the profile lock. A new window
// can arrive in that interval; wait for retirement or a ready service without
// spawning a replacement against an occupied lock.
func waitControllerReady(ctx context.Context, profile string) (*controllerClient, error) {
	for {
		c, err := connectController(profile)
		if !errors.Is(err, errControllerUnavailable) {
			return c, err
		}
		free, lockErr := controllerLockStatus(profile)
		if lockErr != nil {
			return nil, lockErr
		}
		if free {
			return nil, errControllerUnavailable
		}
		select {
		case <-ctx.Done():
			return nil, errors.New("Локальный фоновый сервис ещё не завершился или не отвечает. Повторите позже")
		case <-time.After(100 * time.Millisecond):
		}
	}
}
func (c *controllerClient) call(method, path string, input, output any) (int, error) {
	return c.callContext(context.Background(), method, path, input, output)
}

func (c *controllerClient) callContext(ctx context.Context, method, path string, input, output any) (int, error) {
	var body []byte
	var err error
	if input != nil {
		body, err = json.Marshal(input)
		if err != nil {
			return 0, err
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, c.origin+path, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Origin", c.origin)
	req.Header.Set("Content-Type", "application/json")
	if c.connectionID != "" {
		req.Header.Set(connectionHeader, c.connectionID)
	}
	client := c.client
	if budget := controllerRequestBudget(path); client.Timeout != 0 && client.Timeout < budget {
		longer := *client
		longer.Timeout = budget
		client = &longer
	}
	res, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusOK && output != nil {
		if err = json.NewDecoder(io.LimitReader(res.Body, 256<<10)).Decode(output); err != nil {
			return res.StatusCode, errors.New("Неверный ответ фонового сервиса; обновление не продолжено.")
		}
	}
	return res.StatusCode, nil
}
func pendingUpdate(c *controllerClient) DesktopResult {
	return DesktopResult{Status: "upgrade_pending", Legacy: c.launch.Controller.Protocol == 0, Controller: c.launch.Controller, Message: "Новая версия готова, но текущий фоновый сервис ещё работает. Сначала откройте текущую среду и сохраните файлы, затем выберите «Сохранить, остановить среду и завершить обновление». Задачи в терминале завершатся, проекты и состояние входа сохранятся."}
}

// Desktop never silently loads a different build's UI. Completing an update is
// an explicit user action because it stops the existing environment's work.
func Desktop(configPath string, options DesktopOptions) (DesktopResult, error) {
	return desktopLaunch(filepath.Dir(configPath), false, options, func() error { return startController(configPath) })
}

func desktopLaunch(profile string, gateway bool, options DesktopOptions, start func() error) (DesktopResult, error) {
	want, err := currentController()
	if err != nil {
		return DesktopResult{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	current, err := waitControllerReady(ctx, profile)
	if err == nil {
		defer current.close()
		if current.launch.DesktopGateway != gateway {
			return DesktopResult{}, errors.New("Этот каталог уже используется другой службой Cage. Проверьте путь к конфигурации")
		}
		if options.CompleteUpdate {
			if current.launch.DesktopGateway {
				err = current.releaseDesktopEntry()
			} else {
				err = current.stopAndHandoff()
			}
			if err != nil {
				return DesktopResult{}, err
			}
		} else if want.matches(current.launch.Controller) || options.UseExisting {
			status := "ready"
			if !want.matches(current.launch.Controller) {
				status = "existing"
			}
			return DesktopResult{Status: status, URL: current.launch.URL, Controller: current.launch.Controller, Legacy: current.launch.Controller.Protocol == 0}, nil
		} else {
			if current.launch.Controller.Protocol != controlProtocol {
				return pendingUpdate(current), nil
			}
			status, handoffErr := current.call("POST", "/api/handoff", map[string]string{"token": current.record.Token}, nil)
			if handoffErr != nil {
				return DesktopResult{}, handoffErr
			}
			if status != http.StatusOK {
				return pendingUpdate(current), nil
			}
			if err = current.waitForExit(); err != nil {
				return DesktopResult{}, err
			}
		}
	} else if !errors.Is(err, errControllerUnavailable) {
		return DesktopResult{}, err
	}
	if err = start(); err != nil {
		return DesktopResult{}, err
	}
	for i := 0; i < 60; i++ {
		c, readErr := connectController(profile)
		if readErr == nil {
			c.close()
			if c.launch.DesktopGateway != gateway {
				return DesktopResult{}, errors.New("Во время запуска идентичность службы управления изменилась. Выберите заново")
			}
			if want.matches(c.launch.Controller) {
				return DesktopResult{Status: "ready", URL: c.launch.URL, Controller: c.launch.Controller}, nil
			}
			return pendingUpdate(c), nil
		}
		time.Sleep(200 * time.Millisecond)
	}
	return DesktopResult{}, errors.New("Рабочая область не запустилась. Проверьте control.log в приватной конфигурации и повторите.")
}

// PrepareUpdate is shared by the explicit migration button and the installer.
// It returns only after the old service has released its profile lock.
func PrepareUpdate(configPath string, stop bool) (DesktopResult, error) {
	// A closing controller stops accepting requests before releasing its lock.
	// Use the same bounded retirement wait as desktop startup; the lock and VM
	// checks below still decide whether replacing the application is safe.
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	c, err := waitControllerReady(ctx, filepath.Dir(configPath))
	if errors.Is(err, errControllerUnavailable) {
		lock, lockErr := openControllerLock(filepath.Dir(configPath), os.O_RDWR)
		if lockErr == nil {
			defer lock.Close()
			if lockController(lock) != nil {
				return DesktopResult{}, errors.New("Фоновый сервис временно недоступен и ещё не завершился. Восстановите соединение и повторите обновление.")
			}
			defer unlockController(lock)
		} else if !os.IsNotExist(lockErr) {
			return DesktopResult{}, lockErr
		}
		if controllerHasVM(filepath.Dir(configPath)) {
			return DesktopResult{}, errors.New("Фоновый сервис недоступен, но процессы среды ещё есть. Восстановите подключение к рабочей области, сохраните данные и остановите среду, затем повторите обновление.")
		}
		return DesktopResult{Status: "prepared"}, nil
	}
	if err != nil {
		return DesktopResult{}, err
	}
	defer c.close()
	if stop {
		if err = c.stopAndHandoff(); err != nil {
			return DesktopResult{}, err
		}
		return DesktopResult{Status: "prepared"}, nil
	}
	if c.launch.Controller.Protocol == controlProtocol {
		// Routine status probes also hold the operation lock. Retry briefly.
		// every request still checks running jobs, terminals and VM ownership.
		// The retry window bounds conflicts only: each request keeps its own
		// VM probe budget, which a Windows guest needs in full.
		retryUntil := time.Now().Add(3 * time.Second)
		for {
			status, err := c.call("POST", "/api/handoff", map[string]string{"token": c.record.Token}, nil)
			if err != nil {
				return DesktopResult{}, err
			}
			if status == http.StatusOK {
				if err = c.waitForExit(); err != nil {
					return DesktopResult{}, err
				}
				return DesktopResult{Status: "prepared"}, nil
			}
			if status != http.StatusConflict || time.Now().After(retryUntil) {
				break
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
	return DesktopResult{Status: "stop_required", Message: "Сохраните файлы и подтвердите остановку среды и установку обновления. Задачи в терминале завершатся, проекты и состояние входа сохранятся."}, nil
}
func (c *controllerClient) stopAndHandoff() error {
	legacy := c.launch.Controller.Protocol == 0
	var owner legacyProcessIdentity
	var err error
	if legacy {
		owner, err = identifyLegacyController(c.profile, c.record)
		if err != nil {
			return err
		}
	} else if c.launch.Controller.Protocol != controlProtocol {
		return errors.New("Текущий протокол фонового сервиса не поддерживается этой версией; работающая среда сохранена. Остановите среду подходящей версией Cage.")
	}
	u, _ := url.Parse(c.launch.URL)
	status, err := c.call("POST", "/api/session", map[string]string{"token": u.Fragment}, nil)
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		return errors.New("Не удалось создать сессию остановки. Повторите.")
	}
	var clientContext ClientContext
	contextStatus, contextErr := c.call("GET", "/api/client/context", nil, &clientContext)
	if contextErr == nil && contextStatus == http.StatusOK && (clientContext.Mode == "remote" || clientContext.ClientOnly) {
		path := "/api/client/local"
		if clientContext.ClientOnly {
			path = "/api/client/disconnect"
		}
		status, err = c.call("POST", path, map[string]string{"connection_id": clientContext.ConnectionID}, nil)
		if err != nil || status != http.StatusOK {
			return errors.New("Не удалось отключить локальное удалённое соединение; обновление не продолжено")
		}
		if clientContext.ClientOnly {
			status, err = c.call("POST", "/api/handoff", map[string]string{"token": c.record.Token}, nil)
			if err != nil || status != http.StatusOK {
				return errors.New("Служба локального подключения ещё не завершилась. Повторите позже")
			}
			return c.waitForExit()
		}
	} else if !legacy && !c.launch.DesktopGateway && !c.launch.ClientOnly &&
		c.launch.ConfigPath != "" && filepath.Dir(c.launch.ConfigPath) == filepath.Clean(c.profile) &&
		contextErr == nil && contextStatus == http.StatusOK && !clientContext.DesktopGateway &&
		clientContext.Mode == "local" && clientContext.ConnectionID == "local" {
		// A selection change after the context request must not send the
		// stop request to a remote workload.
		c.connectionID = clientContext.ConnectionID
		c.setTrustedViewCookie(u)
	}
	var requested Job
	status, err = c.call("POST", "/api/stop", map[string]any{}, &requested)
	if err != nil {
		return err
	}
	if status != http.StatusOK || requested.ID == "" {
		return errors.New("Фоновый сервис не принял запрос на остановку; обновление отменено.")
	}
	deadline := time.Now().Add(2 * time.Minute)
	for {
		var state struct {
			VMRunning *bool `json:"vm_running"`
			Job       Job   `json:"job"`
		}
		status, err = c.call("GET", "/api/status", nil, &state)
		if err != nil {
			return err
		}
		if status != http.StatusOK || state.VMRunning == nil || state.Job.ID != requested.ID {
			return errors.New("Состояние остановки изменилось, фоновый сервис не завершён. Проверьте текущие задачи и повторите.")
		}
		if !state.Job.Running {
			if state.Job.Error != "" || *state.VMRunning {
				return errors.New("Среду не удалось безопасно остановить; обновление не продолжено. Проверьте результат остановки в исходной рабочей области.")
			}
			break
		}
		if time.Now().After(deadline) {
			return errors.New("Истекло время ожидания остановки среды, фоновый сервис продолжает работу. Повторите обновление позже.")
		}
		time.Sleep(200 * time.Millisecond)
	}
	var terminals []struct {
		Closed bool `json:"closed"`
	}
	status, err = c.call("GET", "/api/terminals", nil, &terminals)
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		return errors.New("Не удалось подтвердить остановку терминалов; обновление не продолжено.")
	}
	for _, terminal := range terminals {
		if !terminal.Closed {
			return errors.New("Терминалы всё ещё работают; обновление не продолжено.")
		}
	}
	if legacy {
		verified, err := identifyLegacyController(c.profile, c.record)
		if err != nil || verified != owner {
			return errors.New("Идентичность старого фонового процесса изменилась; сигнал завершения не отправлен. Повторите обновление.")
		}
		var final struct {
			VMRunning *bool `json:"vm_running"`
			Job       Job   `json:"job"`
		}
		status, err = c.call("GET", "/api/status", nil, &final)
		if err != nil || status != http.StatusOK || final.VMRunning == nil || *final.VMRunning || final.Job.ID != requested.ID || final.Job.Running || final.Job.Error != "" || controllerHasVM(c.profile) {
			return errors.New("После остановки в среде снова началась работа; старый фоновый сервис не завершён. Сохраните данные, остановите среду и повторите.")
		}
		if err = terminateLegacy(owner.PID); err != nil {
			return errors.New("Старый фоновый сервис не завершился; приложение не заменено.")
		}
	} else {
		status, err = c.call("POST", "/api/handoff", map[string]string{"token": c.record.Token}, nil)
		if err != nil {
			return err
		}
		if status != http.StatusOK {
			return errors.New("Фоновый сервис ещё выполняет работу; обновление не продолжено. Сохраните данные, остановите среду и повторите.")
		}
	}
	return c.waitForExit()
}
func (c *controllerClient) waitForExit() error {
	f, err := openControllerLock(c.profile, os.O_RDWR)
	if err != nil {
		return errors.New("Не удалось подтвердить завершение фонового сервиса; обновление не продолжено.")
	}
	defer f.Close()
	for i := 0; i < 100; i++ {
		if lockController(f) == nil {
			_ = unlockController(f)
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return errors.New("Фоновый сервис ещё не завершился; принудительное завершение процесса не выполнялось. Повторите обновление позже.")
}
func startController(configPath string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	return startControllerExecutable(configPath, exe)
}

func startControllerExecutable(configPath, exe string, extraEnv ...string) error {
	profile := filepath.Dir(configPath)
	if err := host.EnsurePrivateDir(profile); err != nil {
		return err
	}
	cmd := exec.Command(exe, "log-relay", "controller")
	cmd.Dir = profile
	cmd.Env = append(os.Environ(), cage.ConfigEnv+"="+configPath)
	cmd.Env = append(cmd.Env, extraEnv...)
	detachController(cmd)
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}
