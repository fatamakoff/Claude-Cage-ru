//go:build !linux

package containerenv

import (
	"context"
	"errors"
)

func (r *Runtime) ensureResourceSlice(context.Context) error {
	return errors.New("Границы ресурсов контейнера поддерживаются только в Linux")
}
func (r *Runtime) verifyHostResources(context.Context, string) (resourceEvidence, error) {
	return resourceEvidence{}, errors.New("Границы ресурсов контейнера поддерживаются только в Linux")
}
