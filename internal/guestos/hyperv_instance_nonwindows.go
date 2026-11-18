//go:build !windows

package guestos

import (
	"context"
	"errors"

	"github.com/google/uuid"
)

func InspectHyperV(context.Context, uuid.UUID) (HyperVInspection, error) {
	return HyperVInspection{}, errors.New("--vm-id поддерживает запрос виртуальных машин Windows Hyper-V только на этом компьютере")
}
