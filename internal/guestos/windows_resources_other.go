//go:build !windows

package guestos

import (
	"context"
	"errors"
)

func windowsVMResources(context.Context, string, int, int) (WindowsVMResourceState, error) {
	return WindowsVMResourceState{}, errors.New("Для управления ресурсами гостевой системы Windows нужен хост с Windows Hyper-V")
}
