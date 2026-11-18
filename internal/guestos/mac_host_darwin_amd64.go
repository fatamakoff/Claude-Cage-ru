package guestos

import (
	"context"
	"errors"
	"golang.org/x/mod/semver"
	"os/exec"
	"strings"
)

func probeMacHost(ctx context.Context) (MacRestore, error) {
	version, err := exec.CommandContext(ctx, "/usr/bin/sw_vers", "-productVersion").Output()
	if err != nil || !semver.IsValid("v"+strings.TrimSpace(string(version))) || semver.Compare("v"+strings.TrimSpace(string(version)), "v15.4") < 0 {
		return MacRestore{}, errors.New("Локальной гостевой системе на Intel Mac требуется macOS 15.4 или новее для поддержки общего доступа к проектам рабочей области")
	}
	data, err := exec.CommandContext(ctx, "/usr/sbin/sysctl", "-n", "kern.hv_support").Output()
	if err != nil || strings.TrimSpace(string(data)) != "1" {
		return MacRestore{}, errors.New("Hypervisor.framework недоступен на Intel Mac")
	}
	return MacRestore{MinimumCPUs: 2, MinimumMemoryBytes: 4 << 30}, nil
}
