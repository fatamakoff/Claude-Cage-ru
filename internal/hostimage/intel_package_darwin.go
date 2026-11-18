package hostimage

import (
	"context"
	"errors"
	"os/exec"
	"strings"
)

func verifyApplePackageSignature(ctx context.Context, path string) error {
	data, err := exec.CommandContext(ctx, "/usr/sbin/pkgutil", "--check-signature", path).Output()
	if err != nil {
		return errors.New("Не удалось проверить подпись установочного пакета Apple")
	}
	text := string(data)
	for _, identity := range []string{"Status: signed Apple Software", "Software Update", "Apple Software Update Certification Authority", "Apple Root CA"} {
		if !strings.Contains(text, identity) {
			return errors.New("Установочные материалы не имеют цепочки подписи обновления системы Apple")
		}
	}
	return nil
}
