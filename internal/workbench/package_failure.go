package workbench

import (
	"regexp"
	"strings"

	"github.com/sylvinus/agent-vm/internal/diagnostics"
	"github.com/sylvinus/agent-vm/internal/usererror"
)

const (
	aptFailureMarker  = "APT_FAILED "
	aptTailLines      = 6
	aptTailLineBytes  = 200
	aptCommandBytes   = 300
	aptNotFoundNeedle = "unable to locate package"
)

var aptMissingPackage = regexp.MustCompile(`(?i)unable to locate package ([a-z0-9][a-z0-9+.-]*)|package '?([a-z0-9][a-z0-9+.-]*)'? has no installation candidate`)

// aptEvidence is what the setup script reported about a failed apt-get call.
type aptEvidence struct {
	exit, command string
	packages      []string
	tail          []string
}

// parseAPTFailure reads the last APT failure marker written by
// agent-vm.setup.sh together with the output lines before it. It returns nil
// when the log has no marker, so older guests keep the generic message.
func parseAPTFailure(log string) *aptEvidence {
	lines := strings.Split(strings.ReplaceAll(log, "\r", ""), "\n")
	at := -1
	payload := ""
	for i := len(lines) - 1; i >= 0; i-- {
		// Older setup scripts may still report the former marker.
		for _, marker := range []string{aptFailureMarker, "CAGE_APT_FAILED "} {
			if rest, ok := strings.CutPrefix(strings.TrimSpace(lines[i]), marker); ok {
				at, payload = i, rest
				break
			}
		}
		if at >= 0 {
			break
		}
	}
	if at < 0 {
		return nil
	}
	ev := &aptEvidence{}
	for _, field := range strings.SplitN(payload, " command=", 2) {
		if strings.HasPrefix(field, "exit=") {
			ev.exit = strings.TrimPrefix(field, "exit=")
		} else {
			ev.command = field
		}
	}
	for _, arg := range strings.Fields(ev.command) {
		if !strings.HasPrefix(arg, "-") && arg != "apt-get" && arg != "install" && arg != "update" && !strings.Contains(arg, "=") {
			ev.packages = append(ev.packages, arg)
		}
	}
	for i := at - 1; i >= 0 && len(ev.tail) < aptTailLines; i-- {
		if line := strings.TrimSpace(lines[i]); line != "" {
			ev.tail = append([]string{clip(line, aptTailLineBytes)}, ev.tail...)
		}
	}
	return ev
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return strings.ToValidUTF8(s[:n], "") + "…"
}

// packageInstallFailure explains a failed base package stage. Only fields the
// guest reported are shown, and everything passes through diagnostics.Redact so
// proxy addresses, credentials and paths never reach the interface.
func packageInstallFailure(action string, cause error, log string) error {
	ev := parseAPTFailure(log)
	if ev == nil {
		return nil
	}
	tail := strings.Join(ev.tail, "\n")
	reason := "Команда APT завершилась с кодом " + ev.exit + "; в выводе нет распознаваемой причины"
	next := "Проверьте конец вывода ниже; если причину определить не удаётся, экспортируйте диагностический пакет и приложите эти сведения."
	lower := strings.ToLower(tail)
	matched := false
	for _, rule := range []struct {
		patterns     []string
		reason, next string
	}{
		{[]string{"temporary failure resolving", "could not resolve", "name or service not known"}, "APT не может разрешить имя сервера загрузки", "Проверьте выбранный узел и DNS в настройках сети и прокси, затем продолжите установку."},
		{[]string{"connection timed out", "timed out", "could not connect to", "unable to connect to", "connection failed", "connection refused"}, "APT не смог подключиться к серверу загрузки или превысил тайм-аут", "Проверьте доступность выбранного прокси и продолжите установку."},
		{[]string{"proxy authentication required", "407 proxy"}, "Прокси-сервер отклонил текущие учётные данные", "Обновите аккаунт прокси или подписку в настройках сети и прокси, затем примените узел."},
		{[]string{aptNotFoundNeedle, "has no installation candidate"}, "Нужные пакеты не найдены в репозиториях", "Убедитесь, что репозитории доступны и apt update выполнен успешно, затем продолжите установку."},
		{[]string{"no space left on device"}, "Недостаточно места на диске для продолжения записи", "Освободите место на диске среды и продолжите."},
	} {
		for _, p := range rule.patterns {
			if strings.Contains(lower, p) {
				reason, next, matched = rule.reason, rule.next, true
				break
			}
		}
		if matched {
			break
		}
	}
	pkgs := strings.Join(ev.packages, " ")
	if m := aptMissingPackage.FindStringSubmatch(tail); m != nil {
		if pkg := m[1] + m[2]; pkg != "" {
			pkgs = pkg
		}
	}
	detail := "Команда с ошибкой: " + clip(ev.command, aptCommandBytes)
	if pkgs != "" && strings.Contains(ev.command, "install") {
		detail += "; затронутые пакеты: " + clip(pkgs, aptCommandBytes)
	}
	if tail != "" {
		detail += "; конец вывода ошибок: " + strings.ReplaceAll(tail, "\n", " | ")
	}
	diagnostics.Log("error", "package-install", "reason="+reason+" "+detail)
	return usererror.New(action, reason, diagnostics.Redact(detail)+". "+next, cause)
}
