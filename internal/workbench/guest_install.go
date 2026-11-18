package workbench

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/google/uuid"
	"github.com/sylvinus/agent-vm/internal/cage"
	"github.com/sylvinus/agent-vm/internal/diagnostics"
	"github.com/sylvinus/agent-vm/internal/guestos"
	"github.com/sylvinus/agent-vm/internal/guestprofile"
	"github.com/sylvinus/agent-vm/internal/host"
	"github.com/sylvinus/agent-vm/internal/hostimage"
	"github.com/sylvinus/agent-vm/internal/hostproxy"
)

type guestInstallRequest struct {
	GuestProfile *guestprofile.Options `json:"guest_profile,omitempty"`
	EditorTerms  bool                  `json:"editor_terms"`
	System       string                `json:"guest_system"`
	Media        string                `json:"media"`
	SHA256       string                `json:"sha256"`
	CloneKey     string                `json:"clone_key,omitempty"`
}

type guestInstallView struct {
	LinuxSystems  []string              `json:"linux_systems,omitempty"`
	HostMatchOnly bool                  `json:"host_match_only,omitempty"`
	Reselect      bool                  `json:"reselect,omitempty"`
	System        string                `json:"system,omitempty"`
	Available     bool                  `json:"available"`
	Reason        string                `json:"reason,omitempty"`
	Fresh         bool                  `json:"fresh"`
	Pending       *guestos.Installation `json:"pending,omitempty"`
	Activate      bool                  `json:"activate,omitempty"`
}

func (s *Server) guestInstallView() (guestInstallView, error) {
	v := guestInstallView{}
	if !s.localVMStorage() || s.macosGuest != nil || s.windowsGuest != nil {
		return v, nil
	}
	pending, err := guestos.LoadInstallation(s.profile)
	if err != nil {
		return v, err
	}
	loc, err := cage.GetStorageLocation(s.profile)
	if err != nil {
		return v, err
	}
	v.Fresh = !loc.HasEnvironment
	v.Pending = pending
	if !v.Fresh && pending == nil {
		return v, nil
	}
	v.LinuxSystems = linuxGuestSystems(runtime.GOOS, runtime.GOARCH)
	switch {
	case runtime.GOOS == "darwin" && (runtime.GOARCH == "arm64" || runtime.GOARCH == "amd64"):
		v.System = guestos.MacOS
		v.HostMatchOnly = runtime.GOARCH == "amd64"
	case runtime.GOOS == "windows" && runtime.GOARCH == "amd64":
		v.System = guestos.Windows11
	case runtime.GOOS == "linux" && runtime.GOARCH == "amd64":
		identity, hostErr := hostimage.Host(context.Background())
		if hostErr != nil {
			v.Reason = hostErr.Error()
		} else {
			v.System = identity.System
		}
	default:
		return v, nil
	}
	if pending != nil {
		v.Reselect, err = guestos.UnstartedInstallation(s.profile, *pending)
		if err != nil {
			return v, err
		}
		catalog := pending.SourceKind == guestos.LinuxImageSource && canInstallCatalogLinux(pending.System) && pending.Source.Host.Arch == runtime.GOARCH
		if !catalog && pending.System != v.System {
			return v, errors.New("Запись установки гостевой системы не соответствует этому хосту")
		}
		if pending.SourceKind == guestos.LinuxImageSource && !catalog {
			return v, errors.New("Архитектура образа гостевой системы не соответствует этому хосту, восстановите исходную среду хоста")
		}
		mac, err := guestos.LoadMacOSProfile(s.profile)
		if err != nil {
			return v, err
		}
		win, err := guestos.LoadWindowsProfile(s.profile)
		if err != nil {
			return v, err
		}
		v.Activate = (pending.System == guestos.MacOS && mac != nil) || (pending.System == guestos.Windows11 && win != nil)
		if pending.System == guestos.Windows11 && win != nil {
			cleanup, err := guestos.WindowsCloneCleanupPending(s.profile)
			if err != nil {
				return v, err
			}
			v.Activate = !cleanup
		}
	}
	if v.System == "" {
		return v, nil
	}
	if !hostimage.IsLinux(v.System) && !guestos.HasNativeWorkbenchKit(s.exe, v.System) {
		v.Reason = "В этой сборке отсутствуют компоненты установки гостевой системы"
		return v, nil
	}
	v.Available = true
	return v, nil
}

func (s *Server) guestInstallation(w http.ResponseWriter, r *http.Request) {
	if !s.hasTrustedView(r) || !s.localVMStorage() {
		http.Error(w, "Выберите гостевую систему в окне Cage на этом компьютере", http.StatusForbidden)
		return
	}
	v, err := s.guestInstallView()
	if err != nil {
		requestError(w, err)
		return
	}
	if r.Method == http.MethodGet {
		if v.System == guestos.Windows11 && v.Available && v.Pending == nil {
			check := guestos.Inspect(r.Context())
			if !check.HostCheckPassed {
				v.Available = false
				v.Reason = check.Detail
			}
		}
		jsonReply(w, v)
		return
	}
	if r.Method == http.MethodDelete {
		var body struct {
			ID uuid.UUID `json:"id"`
		}
		if !readJSON(w, r, &body) {
			return
		}
		if !v.Reselect || s.busy() || !s.op.TryLock() {
			http.Error(w, "Задача установки или диск уже существует, продолжите исходную установку", http.StatusConflict)
			return
		}
		defer s.op.Unlock()
		if err := guestos.ClearUnstartedInstallation(s.profile, body.ID); err != nil {
			requestError(w, err)
			return
		}
		jsonReply(w, map[string]bool{"cleared": true})
		return
	}
	if !v.Activate || !s.op.TryLock() {
		http.Error(w, "Установка гостевой системы ещё не завершена", http.StatusConflict)
		return
	}
	if v.Pending != nil && v.Pending.System == guestos.Windows11 {
		owner, err := s.installedWindowsVMOwner(*v.Pending)
		if err != nil {
			s.op.Unlock()
			requestError(w, err)
			return
		}
		s.handoffWithVMOwnerLocked(w, owner)
		return
	}
	s.handoffLocked(w)
}

func (s *Server) installedWindowsVMOwner(install guestos.Installation) (string, error) {
	binding, err := guestos.LoadWindowsProfile(s.profile)
	if err != nil || binding == nil || install.System != guestos.Windows11 || install.ID == uuid.Nil {
		return "", errors.New("Привязка установки Windows не подтверждена, продолжите исходную установку; исходный диск и аккаунт сохранены")
	}
	state, err := cage.StoragePhysicalPath(filepath.Join(s.profile, "state"))
	if err != nil {
		return "", err
	}
	expected := filepath.Join(state, "windows-"+strings.ReplaceAll(install.ID.String(), "-", ""))
	receipt, err := os.ReadFile(filepath.Join(s.profile, "windows-install-vm.txt"))
	id, parseErr := uuid.Parse(strings.TrimSpace(string(receipt)))
	if err != nil || parseErr != nil || id != binding.VMID || !strings.EqualFold(filepath.Clean(binding.InstanceDirectory), filepath.Clean(expected)) {
		return "", errors.New("Запись установки Windows не соответствует исходной гостевой системе, сверьте исходную среду; существующие данные сохранены")
	}
	return "windows/" + binding.VMID.String() + "/Running", nil
}

func (s *Server) resumePendingMacOSInstall(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	recovery, err := guestos.LoadMacOSInstallRecovery(s.profile)
	if err != nil {
		_ = diagnostics.New(s.profile).Record("warn", "macos-install-recovery", "Продолжение исходной установки отклонено, проверка подлинности точки восстановления не пройдена: "+err.Error())
		http.Error(w, "Не удаётся подтвердить точку восстановления установки, повторите позже; исходный диск и запись установки сохранены", http.StatusConflict)
		return
	}
	if recovery == nil || recovery.InstallationID != id {
		http.Error(w, "Сначала подготовьте точку восстановления, соответствующую исходной гостевой системе", http.StatusConflict)
		return
	}
	if !s.hasTrustedView(r) || s.macosGuest != nil || s.windowsGuest != nil || !s.localVMStorage() {
		http.Error(w, "Восстановите исходную установку macOS в окне Cage на этом компьютере", http.StatusForbidden)
		return
	}
	s.beginGuestInstallMode(w, r, guestInstallRequest{System: guestos.MacOS}, true, recovery.User)
}

func (s *Server) beginGuestInstall(w http.ResponseWriter, r *http.Request, in guestInstallRequest) {
	s.beginGuestInstallMode(w, r, in, false, "")
}

// guestInstallFailureMessage keeps every install failure actionable without
// implying that the recovery screen is required: only the macOS component
// recovery prompt needs GUI authorization, everything else is diagnosed from
// the operation details and the diagnostics bundle.
func guestInstallFailureMessage(system string, err error) error {
	next := "Откройте на странице инициализации «Детали операции», просмотрите запись о сбое и нажмите «Продолжить установку»; если сбой повторится, выгрузите пакет диагностики в разделе «Журналы и диагностика»."
	if system == guestos.MacOS {
		next = "Откройте на странице инициализации «Детали операции», просмотрите запись о сбое и нажмите «Продолжить установку»; экран восстановления нужен только при появлении подсказки «Восстановить установку компонентов macOS», остальные сбои разбираются по пакету диагностики в разделе «Журналы и диагностика»."
	}
	return fmt.Errorf("Установка гостевой системы не завершена, прогресс установки и файлы сохранены. %sПричина сбоя: %w", next, err)
}

func (s *Server) beginGuestInstallMode(w http.ResponseWriter, r *http.Request, in guestInstallRequest, guiAuthorize bool, recoveryUser string) {
	if in.System == guestos.MacOS && !s.account.view().MacOSCredentialsReady {
		http.Error(w, "Сначала зарегистрируйте или подтвердите аккаунт Cage, затем устанавливайте гостевую macOS", http.StatusConflict)
		return
	}
	v, err := s.guestInstallView()
	if err != nil {
		requestError(w, err)
		return
	}
	catalog := canInstallCatalogLinux(in.System) && in.CloneKey == ""
	if v.Pending != nil {
		catalog = v.Pending.SourceKind == guestos.LinuxImageSource
	}
	if (!catalog && (!v.Available || v.System != in.System)) || !s.hasTrustedView(r) || (!v.Fresh && v.Pending == nil) || v.Activate {
		http.Error(w, "В текущей среде нельзя установить выбранную гостевую систему", http.StatusConflict)
		return
	}
	if v.HostMatchOnly && in.System == v.System && v.Pending == nil && in.CloneKey == "" {
		requestError(w, errors.New("Для Intel Mac выберите полный установочный пакет Apple через «Автоподбор версии системы хоста»"))
		return
	}
	install := guestos.Installation{Version: 1, System: in.System, Media: in.Media, SHA256: strings.ToLower(in.SHA256), ID: uuid.New(), EditorTerms: in.EditorTerms}
	if v.Pending != nil {
		if v.Pending.System != in.System || (in.Media != "" && in.Media != v.Pending.Media) || (in.SHA256 != "" && !strings.EqualFold(in.SHA256, v.Pending.SHA256)) {
			http.Error(w, "Продолжить установку нужно с той же системой и тем же установочным носителем", http.StatusConflict)
			return
		}
		install = *v.Pending
	} else if in.CloneKey != "" {
		plan, planErr := s.hostClonePlan(r.Context())
		if planErr != nil {
			requestError(w, planErr)
			return
		}
		if plan.Key() != in.CloneKey || plan.Host.System != in.System {
			requestError(w, errors.New("Версия на этом компьютере или сведения об образе системы изменились, выполните проверку и сопоставление заново"))
			return
		}
		install.Source = plan
	} else if catalog {
		if in.Media != "" || in.SHA256 != "" || in.EditorTerms {
			requestError(w, errors.New("Ubuntu использует проверенный Cage официальный образ, отдельный установочный носитель не нужен"))
			return
		}
		plan, err := linuxGuestImagePlan(r.Context(), s.profile, in.System, runtime.GOARCH)
		if err != nil {
			requestError(w, err)
			return
		}
		install.Source, install.SourceKind = plan, guestos.LinuxImageSource
	}
	if err := install.Validate(); err != nil {
		requestError(w, err)
		return
	}
	s.launch(w, "guest-install", func() error {
		s.jobs.execution().setSetupProgress(&SetupProgress{Phase: "image", System: install.System, Label: "Подготовка материалов установки " + guestProgressName(install.System)})
		cfg, err := loadConfig(s.configPath)
		if err != nil {
			return err
		}
		if err := cfg.RequireManagedProxy(s.profile); err != nil {
			return err
		}
		lease, loc, err := cage.AcquireStorageUse(s.profile)
		if err != nil {
			return err
		}
		defer lease.Close()
		current, err := guestos.LoadInstallation(s.profile)
		if err != nil {
			return err
		}
		if current == nil && loc.HasEnvironment || current != nil && *current != install {
			return errors.New("Уже есть другая среда или задача установки, откройте страницу установки заново")
		}
		if install.Media != "" {
			f, err := os.Stat(install.Media)
			if err != nil || !f.Mode().IsRegular() {
				return errors.New("Исходный установочный образ недоступен для чтения, восстановите его исходный путь и повторите")
			}
		}
		if install.System == guestos.Windows11 {
			check := guestos.Inspect(s.operationContext())
			if !check.HostCheckPassed {
				return errors.New(check.Detail)
			}
		}
		if err := s.prepareGuestProfile(in.GuestProfile, in.System); err != nil {
			return err
		}
		if err := guestos.SaveInstallation(s.profile, install); err != nil {
			return err
		}
		if install.Source.Host.System != "" {
			cache := filepath.Join(s.profile, "state", "guest-media", install.System)
			unstarted, err := guestos.UnstartedInstallation(s.profile, install)
			if err != nil {
				return err
			}
			minimumGiB := hostCloneSystemReserve(install.Source)
			if !unstarted {
				minimumGiB = 0
			}
			minimumGiB += int((install.Source.RemainingBytes(cache) + (1 << 30) - 1) / (1 << 30))
			if available, ok := host.FreeGiB(cache); ok && available < minimumGiB {
				return fmt.Errorf("Для создания выбранной системы нужно не менее %d GiB свободного места, сейчас доступно %d GiB; выберите в настройках хранилища расположение с достаточным объёмом", minimumGiB, available)
			}
			s.setMessage("Подготовка официального образа системы " + guestProgressName(install.System) + "…")
			transport := hostproxy.NewTransport()
			defer transport.CloseIdleConnections()
			prepared, prepareErr := hostimage.Prepare(s.operationContext(), cache, install.Source, s.jobs.execution(), transport)
			if prepareErr != nil {
				return prepareErr
			}
			install.Source, install.Media = prepared, prepared.Path
			install.SHA256 = strings.TrimPrefix(prepared.Digest, "sha256:")
			if err := guestos.RecordPreparedMedia(s.profile, install.ID, prepared); err != nil {
				return err
			}
		}
		var credential macGuestCredential
		if install.System == guestos.MacOS {
			saved, err := s.account.savedMacGuestPassword(s.operationContext(), install.ID)
			if err != nil {
				return err
			}
			unstarted, err := guestos.UnstartedInstallation(s.profile, install)
			if err != nil {
				return err
			}
			if saved == "" && !unstarted {
				return errors.New("Отсутствуют учётные данные установки гостевой системы, восстановите зашифрованное хранилище; существующий аккаунт и диск сохранены")
			}
			credential, err = s.account.macGuestCredentials(s.operationContext(), install.ID)
			if err != nil {
				return err
			}
			if guiAuthorize {
				recovery, err := guestos.LoadMacOSInstallRecovery(s.profile)
				if err != nil {
					_ = diagnostics.New(s.profile).Record("warn", "guest-install", "Проверка подлинности точки восстановления не пройдена: "+err.Error())
					return errors.New("Не удаётся сверить точку восстановления исходной установки, повторите позже; исходный диск и запись установки сохранены")
				}
				if recovery == nil || recovery.InstallationID != install.ID || recovery.User != credential.Username || recovery.User != recoveryUser {
					_ = diagnostics.New(s.profile).Record("warn", "guest-install", fmt.Sprintf("Точка восстановления не совпадает с текущей установкой record_present=%t installation_match=%t user_match=%t",
						recovery != nil, recovery != nil && recovery.InstallationID == install.ID, recovery != nil && recovery.User == credential.Username && recovery.User == recoveryUser))
					return errors.New("Точка восстановления не совпадает с исходной установкой, подготовьте её заново на странице инициализации; исходный диск и запись установки сохранены")
				}
			}
		}
		if err := s.prepareEnvironment(); err != nil {
			return err
		}
		if hostimage.IsLinux(install.System) {
			if err := hostimage.WriteLinuxTemplate(filepath.Join(s.profile, "state"), install.Source); err != nil {
				return err
			}
			if err := s.startEnvironment(true); err != nil {
				return err
			}
			return guestos.FinishLinuxInstallation(s.profile, install.ID)
		}
		s.setMessage("Установка выбранной гостевой системы…")
		s.jobs.execution().setSetupProgress(&SetupProgress{Phase: "packages", System: install.System, Label: "Установка системы " + guestProgressName(install.System)})
		var cmd *exec.Cmd
		if install.System == guestos.MacOS {
			cmd = exec.CommandContext(s.operationContext(), s.exe, "guest-os", "macos", "install")
			cmd.Env = append(os.Environ(), cage.ConfigEnv+"="+s.configPath, "CAGE_MACOS_ACCOUNT="+credential.Username)
			if guiAuthorize {
				cmd.Env = append(cmd.Env, "CAGE_MACOS_GUI_AUTHORIZE=1")
			}
			cmd.Stdin = strings.NewReader(credential.Password)
		} else {
			cmd, err = guestos.WindowsInstallCommand(s.operationContext(), s.profile, filepath.Join(filepath.Dir(s.exe), "guest-os"), install)
			if err != nil {
				return err
			}
		}
		cmd.Stdout = s.jobs.execution()
		cmd.Stderr = s.jobs.execution()
		if err := cmd.Run(); err != nil {
			return guestInstallFailureMessage(install.System, err)
		}
		return nil
	})
}
