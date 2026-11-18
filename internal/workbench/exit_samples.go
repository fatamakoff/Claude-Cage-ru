package workbench

import (
	"fmt"
	"strings"

	"github.com/sylvinus/agent-vm/internal/diagnostics"
	"github.com/sylvinus/agent-vm/internal/usererror"
)

// All guest platforms return the same observation contract. Do not infer a
// transport failure from an unavailable sample or expose raw guest output.
func incompleteExitSamples(hostIP string, hostErr error, terminal networkObservation, terminalErr error, browser networkObservation, browserErr error) string {
	var missing []string
	for _, sample := range []struct {
		name        string
		observation networkObservation
		err         error
	}{
		{"Хост", networkObservation{Status: 200, IP: hostIP}, hostErr},
		{"Терминал ВМ", terminal, terminalErr},
		{"Браузер", browser, browserErr},
	} {
		var reason string
		switch {
		case sample.err != nil:
			reason = diagnostics.Redact(usererror.Display("Чтение образцов", sample.err, "Запустите проверку заново.").Error())
		case sample.observation.Status == 0:
			reason = "Канал проверки не ответил"
		case sample.observation.Status != 200:
			reason = fmt.Sprintf("Канал проверки вернул HTTP %d без адреса выхода", sample.observation.Status)
		case sample.observation.IP == "":
			reason = "Канал проверки не вернул адрес выхода"
		}
		if reason != "" {
			missing = append(missing, sample.name+": "+reason)
		}
	}
	if len(missing) == 0 {
		return ""
	}
	return "Выборка исходящих подключений неполная, охват конфигурации определить нельзя (" + strings.Join(missing, "; ") + ")"
}
