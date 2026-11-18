//go:build !linux

package containerenv

import (
	"context"
	"errors"
	"io"
)

func RunTAP(context.Context, io.Reader, io.Writer, ...string) error {
	return errors.New("Среда выполнения контейнеров Cage поддерживается только на серверах Linux")
}
