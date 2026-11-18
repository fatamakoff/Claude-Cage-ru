package workbench

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"

	"github.com/sylvinus/agent-vm/internal/cage"
	"github.com/sylvinus/agent-vm/internal/guestos"
)

type windowsRemoteEvidence struct {
	SandboxSID     string         `json:"sandbox_sid"`
	ProxyPort      int            `json:"proxy_port"`
	Session        string         `json:"session"`
	TokenVerified  bool           `json:"token_verified"`
	PolicyVerified bool           `json:"-"` // Set only by the host's WFP readback.
	Nonce          string         `json:"nonce"`
	TCP            map[string]int `json:"tcp"`
	UDP4           *int           `json:"udp4"`
	UDP6           *int           `json:"udp6"`
	SystemDNS      *int           `json:"system_dns"`
	PrivateRead    *int           `json:"private_read"`
	HomeRoundtrip  bool           `json:"home_roundtrip"`
}

func (s *Server) remoteWindowsObservation(ctx context.Context, input map[string]any) (guestObservation, error) {
	var observation guestObservation
	cfg, err := loadConfig(s.configPath)
	if err != nil {
		return observation, err
	}
	input["timezone"] = cfg.Timezone
	cmd, err := guestos.WindowsRelayCommand(ctx, s.profile, "headless-safety")
	if err != nil {
		return observation, err
	}
	data, err := json.Marshal(input)
	if err != nil {
		return observation, err
	}
	cmd.Stdin = bytes.NewReader(append(data, '\n'))
	cmd.Stderr = io.Discard
	var output bytes.Buffer
	cmd.Stdout = &boundedWindowsStatusWriter{buffer: &output, remaining: 64 << 10}
	if err = cmd.Run(); err != nil {
		return observation, errors.New("Наблюдение за облачной песочницей Windows не завершено, внешняя сеть остаётся закрытой")
	}
	observation, err = decodeWindowsObservation(output.Bytes())
	if err != nil {
		return observation, err
	}
	evidence := observation.Remote
	if evidence == nil || !evidence.TokenVerified || !strings.HasPrefix(evidence.SandboxSID, "S-1-15-2-") || !strings.HasPrefix(evidence.Session, "headless-") {
		return observation, errors.New("Облачное наблюдение Windows не подтвердило фактический идентификатор AppContainer")
	}
	// This command reads all four account filters, all four package filters,
	// the exact broker permit and loopback exception; it cannot install rules.
	policy := exec.CommandContext(ctx, s.windowsGuest.RelayExecutable, "remote-network-policy", "broker-status", "--profile", guestos.WindowsProfilePath(s.profile))
	output.Reset()
	policy.Stdout = &boundedWindowsStatusWriter{buffer: &output, remaining: 8192}
	policy.Stderr = io.Discard
	var state struct {
		Version    int    `json:"version"`
		Package    string `json:"package"`
		Broker     string `json:"broker"`
		Filter     bool   `json:"broker_filter"`
		Loopback   bool   `json:"loopback_exemption"`
		UDPFilters int    `json:"udp_bind_filters"`
	}
	if policy.Run() != nil || json.Unmarshal(output.Bytes(), &state) != nil || state.Version != 1 || state.Package != evidence.SandboxSID || state.Broker != "127.0.0.1:17897" || !state.Filter || !state.Loopback || state.UDPFilters != 2 {
		return observation, errors.New("Облачная политика WFP Windows не соответствует текущей песочнице, внешняя сеть остаётся закрытой")
	}
	evidence.PolicyVerified = true
	return observation, nil
}

func remoteWindowsDenied(e *windowsRemoteEvidence, names ...string) bool {
	if e == nil || !e.TokenVerified || !e.PolicyVerified {
		return false
	}
	for _, name := range names {
		code, found := e.TCP[name]
		if !found || code != 10013 {
			return false
		} // WSAEACCES, not a timeout.
	}
	return true
}

func remoteWindowsDNSBlocked(v guestObservation) bool {
	e := v.Remote
	return remoteWindowsDenied(e, "dns", "dot") && e.UDP4 != nil && *e.UDP4 == 10013 &&
		e.SystemDNS != nil && (*e.SystemDNS == 11001 || *e.SystemDNS == 10013)
}

func (s *Server) remoteWindowsBoundary(ctx context.Context, cfg cage.Config, client *cage.GateClient,
	set func(string, cage.CheckState, string, string)) (guestObservation, cage.GateStatus, error) {
	var state cage.GateStatus
	var observation guestObservation
	private, err := os.CreateTemp(s.profile, ".cage-private-probe-*")
	if err != nil {
		return observation, state, err
	}
	private.Close()
	defer os.Remove(private.Name())
	nonce := randomToken()
	control, err := url.Parse(s.origin)
	if err != nil {
		return observation, state, err
	}
	port, _ := strconv.Atoi(control.Port())
	_, proxyPort := guestProxyEndpoint(cfg, "127.0.0.1")
	if proxyPort < 1 || proxyPort > 65535 {
		return observation, state, errors.New("Не удалось определить текущий порт прокси, внешняя сеть остаётся закрытой")
	}
	s.setMessage("Чтение облачных AppContainer, WFP и фактических прав каталогов…")
	observation, err = s.remoteWindowsObservation(ctx, map[string]any{"stage": "boundary", "nonce": nonce, "private_file": private.Name(), "control_port": port, "proxy_port": proxyPort})
	if err != nil {
		return observation, state, err
	}
	e := observation.Remote
	if e.Nonce != nonce {
		return observation, state, errors.New("Облачное наблюдение Windows не относится к текущей проверке")
	}
	state, err = client.Status(ctx)
	if err != nil {
		return observation, state, err
	}
	result := func(id string, ok bool, evidence, remedy string) {
		status := cage.CheckFailed
		if ok {
			status = cage.CheckPassed
			remedy = ""
		}
		set(id, status, evidence, remedy)
	}
	settings := windowsGuestSettingsMatch(observation, cfg)
	result("guest_settings", settings,
		fmt.Sprintf("Фактический процесс песочницы: часовой пояс=%s, язык=%s; система Windows: часовой пояс=%s, язык=%s; сохранённые ожидания=%s/%s", observation.TZ, observation.ProcessLocale, observation.SystemTimezone, observation.SystemLocale, cfg.Timezone, cfg.Locale),
		"Конфигурация облачной системы/терминала не совпадает с сохранёнными настройками; настройки браузера не заменяют системное наблюдение")
	result("egress_policy", state.PolicyVerified && state.Configuration == cfg.Fingerprint() && remoteWindowsDenied(e, "public"),
		fmt.Sprintf("Фактический AppContainer без сетевой capability; правила WFP для учётной записи и package и единственный разрешённый прокси прочитаны; публичный TCP вернул Winsock %d", e.TCP["public"]), "Восстановите установленную политику WFP и повторите проверку")
	// Older probes always tested 17896 and did not return the port.
	testedPort := e.ProxyPort
	if testedPort == 0 {
		testedPort = 17896
	}
	requiresSession := s.managementRequiresSession(ctx)
	result("management_boundary", testedPort == proxyPort && requiresSession && remoteWindowsDenied(e, "management", "upstream", "metadata", "loopback6", "metadata6"),
		fmt.Sprintf("Коды ошибок прямого подключения: контроллер=%d, вышестоящий прокси=%d (порт проверки %d, текущий порт %d), метаданные=%d, IPv6 loopback=%d, IPv6 метаданные=%d; интерфейс управления отклоняет анонимный доступ=%t", e.TCP["management"], e.TCP["upstream"], testedPort, proxyPort, e.TCP["metadata"], e.TCP["loopback6"], e.TCP["metadata6"], requiresSession), "Проверьте изоляцию WFP облачного интерфейса управления и package")
	result("udp_policy", e.PolicyVerified && e.UDP4 != nil && *e.UDP4 == 10013 && e.UDP6 != nil && *e.UDP6 == 10013,
		fmt.Sprintf("Коды ошибок UDP/IPv4 в песочнице=%v, UDP/IPv6=%v; только Winsock 10013 считается доказательством отказа, отсутствие ответа не используется", codeValue(e.UDP4), codeValue(e.UDP6)), "Восстановите правила отказа WFP для IPv4/IPv6 package")
	result("ipv6_policy", remoteWindowsDenied(e, "ipv6", "loopback6", "metadata6") && e.UDP6 != nil && *e.UDP6 == 10013,
		fmt.Sprintf("Коды ошибок TCP IPv6 в песочнице: публичный/loopback/метаданные=%d/%d/%d, UDP=%v; правила WFP connect/receive v6 проверены", e.TCP["ipv6"], e.TCP["loopback6"], e.TCP["metadata6"], codeValue(e.UDP6)), "Восстановите правила отказа WFP для IPv6 package")
	projects, projectErr := s.projectPaths()
	s.mu.Lock()
	noShares := len(s.projectShares) == 0
	s.mu.Unlock()
	result("filesystem_boundary", projectErr == nil && len(projects) == 0 && noShares && e.PrivateRead != nil && *e.PrivateRead == 5 && e.HomeRoundtrip,
		fmt.Sprintf("Чтение-запись home в песочнице туда-обратно=%t; код ошибки чтения существующего приватного файла контроллера=%v; число внешних проектов=%d, общий доступ не создан=%t", e.HomeRoundtrip, codeValue(e.PrivateRead), len(projects), noShares), "Сейчас поддерживается только home песочницы; для внешних проектов требуется отдельная авторизация")
	return observation, state, nil
}

func codeValue(code *int) any {
	if code == nil {
		return "не возвращено"
	}
	return *code
}
