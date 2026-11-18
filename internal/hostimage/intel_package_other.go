//go:build !darwin

package hostimage

import (
	"context"
	"errors"
)

func verifyApplePackageSignature(context.Context, string) error {
	return errors.New("Установочный пакет Apple нужно проверять на macOS")
}
