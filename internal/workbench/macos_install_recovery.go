package workbench

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/sylvinus/agent-vm/internal/cage"
	"github.com/sylvinus/agent-vm/internal/diagnostics"
	"github.com/sylvinus/agent-vm/internal/guestos"
)

func macOSInstallRecoveryRoute(method, path string) bool {
	if path == "/api/diagnostics" || path == "/api/diagnostics/export" ||
		strings.HasPrefix(path, "/api/diagnostics/events") {
		return true
	}
	if method == http.MethodGet {
		switch path {
		case "/api/account", "/api/status", "/api/proxy", "/api/proxy/connections", "/api/proxy/logs",
			"/api/environment/initialization", "/api/environment/guest-systems", "/api/host/git",
			"/api/macos/install-recovery", "/api/remote/manifest":
			return true
		}
		return strings.HasPrefix(path, "/api/agent/jobs/")
	}
	if method == http.MethodPost {
		switch path {
		case "/api/account/unlock", "/api/account/lock", "/api/account/recovery-generate", "/api/account/recovery-reset", "/api/environment/initialization",
			"/api/environment/guest-systems/activate", "/api/host/git", "/api/stop", "/api/start",
			"/api/macos/install-recovery", "/api/session", "/api/launch", "/api/handoff":
			return true
		}
	}
	// Re-selection of the guest system is the one destructive call the recovery
	// mode needs: an unstarted installation has no disk to protect yet, and the
	// DELETE handler still refuses once any partial VM exists.
	if method == http.MethodDelete {
		return path == "/api/environment/guest-systems"
	}
	return false
}

// recordInstallRecovery keeps the precise, sanitized cause of a refused
// recovery operation in the local diagnostics log. Client messages stay
// generic on purpose: they never reveal the guest account or machine
// identity that the recovery record protects.
func (s *Server) recordInstallRecovery(detail string) {
	_ = diagnostics.New(s.profile).Record("warn", "macos-install-recovery", detail)
}

// macOSInstallRecovery exposes only the pending VM's setup screen and fixed
// lifecycle operations. It never creates or substitutes a MacOSProfile.
func (s *Server) macOSInstallRecovery(w http.ResponseWriter, r *http.Request) {
	if !s.hasTrustedView(r) || !s.localVMStorage() {
		http.Error(w, "Продолжите установку в окне Cage на этом компьютере", http.StatusForbidden)
		return
	}
	recovery, err := guestos.LoadMacOSInstallRecovery(s.profile)
	if err != nil {
		s.recordInstallRecovery("Проверка идентичности точки восстановления не пройдена: " + err.Error())
		http.Error(w, "Проверка идентичности точки восстановления установки не пройдена; исходный диск и запись об установке сохранены. Повторите позже; если ошибка повторится, экспортируйте диагностический пакет в разделе «Логи и диагностика»", http.StatusConflict)
		return
	}
	if s.macosGuest != nil {
		s.recordInstallRecovery("Уже есть привязанная гостевая система macOS; точка восстановления установки отключена")
		http.Error(w, "Уже есть привязанная гостевая система macOS, восстановление установки не требуется; исходный диск и запись об установке сохранены", http.StatusConflict)
		return
	}
	if recovery == nil {
		if r.Method == http.MethodGet {
			install, loadErr := guestos.LoadInstallation(s.profile)
			canPrepare := false
			if loadErr == nil && install != nil && install.System == guestos.MacOS {
				canPrepare, loadErr = guestos.CanRecoverMacOSInstall(s.profile, install.ID)
			}
			if loadErr != nil {
				s.recordInstallRecovery("Не удалось проверить восстанавливаемость исходной записи об установке: " + loadErr.Error())
				http.Error(w, "Сейчас невозможно проверить, восстанавливаема ли исходная запись об установке. Повторите позже; данные сохранены, диагностический пакет можно экспортировать в разделе «Логи и диагностика»", http.StatusConflict)
				return
			}
			jsonReply(w, map[string]bool{"available": false, "can_prepare": canPrepare})
			return
		}
		var input guestos.MacLoginRequest
		if !readJSON(w, r, &input) || input.Action != "prepare" {
			http.Error(w, "Сначала подтвердите исходную запись об установке", http.StatusConflict)
			return
		}
		install, loadErr := guestos.LoadInstallation(s.profile)
		if loadErr != nil {
			s.recordInstallRecovery("Не удалось прочитать исходную запись об установке: " + loadErr.Error())
			http.Error(w, "Сейчас невозможно прочитать исходную запись об установке. Повторите позже; данные сохранены, диагностический пакет можно экспортировать в разделе «Логи и диагностика»", http.StatusConflict)
			return
		}
		if install == nil || install.System != guestos.MacOS {
			s.recordInstallRecovery("Подготовка точки восстановления отклонена: нет соответствующей записи об установке macOS")
			http.Error(w, "Нет записи об установке macOS, которую можно восстановить. Вернитесь на страницу инициализации и подтвердите заново", http.StatusConflict)
			return
		}
		credential, loadErr := s.account.macGuestCredentials(r.Context(), install.ID)
		if loadErr != nil {
			s.recordInstallRecovery("Не удалось прочитать учётные данные исходной гостевой системы: " + loadErr.Error())
			http.Error(w, "Сейчас невозможно прочитать учётные данные исходной гостевой системы. Проверьте логин и пароль Cage и повторите; исходная учётная запись и диск сохранены", http.StatusConflict)
			return
		}
		if !guestos.ValidMacOSAccountName(credential.Username) || credential.Password == "" {
			s.recordInstallRecovery("Подготовка точки восстановления отклонена: учётные данные исходной гостевой системы неполны")
			http.Error(w, "Учётные данные исходной гостевой системы неполны. Проверьте логин и пароль Cage в настройках и повторите; исходная учётная запись и диск сохранены", http.StatusConflict)
			return
		}
		canRecover, loadErr := guestos.CanRecoverMacOSInstall(s.profile, install.ID)
		if loadErr != nil {
			s.recordInstallRecovery("Не удалось сверить идентичность диска исходной гостевой системы: " + loadErr.Error())
			http.Error(w, "Сейчас невозможно сверить идентичность диска исходной гостевой системы. Повторите позже; диск и запись об установке сохранены", http.StatusConflict)
			return
		}
		if !canRecover {
			s.recordInstallRecovery("Подготовка точки восстановления отклонена: диск или идентификатор машины исходной гостевой системы ещё не готовы")
			http.Error(w, "Диск или идентификатор машины исходной гостевой системы ещё не готовы, подготовить точку восстановления сейчас нельзя; диск и запись об установке сохранены", http.StatusConflict)
			return
		}
		s.launch(w, "macos-install-recovery", func() error {
			if err := guestos.CreateMacOSInstallRecovery(s.profile, credential.Username, install.ID); err != nil {
				return err
			}
			cmd := exec.CommandContext(s.operationContext(), s.exe, "guest-os", "macos", "stop")
			cmd.Env = append(os.Environ(), cage.ConfigEnv+"="+s.configPath)
			cmd.Stdout, cmd.Stderr = s.jobs.execution(), s.jobs.execution()
			return cmd.Run()
		})
		return
	}
	if r.Method == http.MethodGet {
		identity, err := guestos.LoadMacOSProfileOrRecovery(s.profile)
		if err != nil || identity == nil {
			http.Error(w, "Не удалось сверить идентичность восстанавливаемой гостевой системы", http.StatusConflict)
			return
		}
		jsonReply(w, map[string]any{"available": true, "phase": recovery.Phase, "running": macOSInstanceRunning(filepath.Join(s.profile, "state", "lima", "mac"), identity.Backend)})
		return
	}
	var input guestos.MacLoginRequest
	if !readJSON(w, r, &input) {
		return
	}
	switch input.Action {
	case "start":
		s.launch(w, "macos-install-recovery", func() error {
			cmd := exec.CommandContext(s.operationContext(), s.exe, "guest-os", "macos", "start")
			cmd.Env = append(os.Environ(), cage.ConfigEnv+"="+s.configPath)
			cmd.Stdout, cmd.Stderr = s.jobs.execution(), s.jobs.execution()
			return cmd.Run()
		})
		return
	case "resume":
		s.beginGuestInstallMode(w, r, guestInstallRequest{System: guestos.MacOS}, true, recovery.User)
		return
	case "open", "close", "frame", "click", "key", "scroll":
	default:
		http.Error(w, "Недопустимая операция экрана восстановления", http.StatusBadRequest)
		return
	}
	input.Setup = true
	input.Maintenance = ""
	input.Password = ""
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	var dial net.Dialer
	conn, err := dial.DialContext(ctx, "unix", filepath.Join(s.profile, "state", "lima", "mac", "cage-login.sock"))
	if err != nil {
		s.recordInstallRecovery("Не удалось подключиться к экрану восстановления: " + err.Error())
		http.Error(w, "Сначала запустите восстанавливаемую гостевую систему", http.StatusConflict)
		return
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(8 * time.Second))
	if err := json.NewEncoder(conn).Encode(input); err != nil {
		s.recordInstallRecovery(fmt.Sprintf("Не удалось отправить запрос экрану восстановления: %v", err))
		http.Error(w, "Экран восстановления не отвечает", http.StatusServiceUnavailable)
		return
	}
	var result guestos.MacLoginReply
	if err := json.NewDecoder(io.LimitReader(conn, 6<<20)).Decode(&result); err != nil {
		s.recordInstallRecovery(fmt.Sprintf("Не удалось прочитать ответ экрана восстановления: %v", err))
		http.Error(w, "Экран восстановления не отвечает", http.StatusServiceUnavailable)
		return
	}
	if input.Action == "close" || result.Closed {
		s.mu.Lock()
		lease := s.macLoginLease
		matching := lease != nil && lease.request.Session == input.Session
		s.mu.Unlock()
		if matching && s.jobs.snapshot().Kind == "guest-install" {
			s.jobs.cancelRunning()
		}
	}
	epoch, _ := s.account.access()
	// lifetimeContext takes s.mu; resolve it before the lease critical section
	// below takes the same lock.
	lifetime := s.lifetimeContext()
	if input.Action == "open" && result.Session != "" {
		lease := &macLoginLease{request: guestos.MacLoginRequest{Action: "close", Session: result.Session, Setup: true}, socket: filepath.Join(s.profile, "state", "lima", "mac", "cage-login.sock")}
		s.mu.Lock()
		previous := s.macLoginLease
		s.macLoginLease = lease
		lease.stopAccount = context.AfterFunc(epoch, func() { s.revokeMacLogin(result.Session) })
		lease.stopService = context.AfterFunc(lifetime, func() { s.revokeMacLogin(result.Session) })
		s.mu.Unlock()
		previous.stop()
	} else if input.Action == "close" || result.Closed {
		s.trackMacLogin(epoch, input, result)
	}
	w.Header().Set("Cache-Control", "no-store")
	jsonReply(w, result)
}
