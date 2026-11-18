package vm

import (
	"errors"
	"os"
	"path/filepath"
)

// An explicit VirGL request must not silently become a CPU renderer. The
// driver also checks host/guest support; browser diagnostics measure fallback.
func CheckVirGLHost() error {
	paths, _ := filepath.Glob("/dev/dri/renderD*")
	for _, path := range paths {
		info, err := os.Stat(path)
		if err != nil || info.Mode()&os.ModeCharDevice == 0 {
			continue
		}
		f, err := os.OpenFile(path, os.O_RDWR, 0)
		if err == nil {
			f.Close()
			return nil
		}
	}
	return errors.New("VirGL требует доступный текущему пользователю узел DRM render и QEMU с поддержкой OpenGL; драйверы и права доступа к устройствам хоста не изменялись")
}
