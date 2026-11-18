package guestprofile

import (
	"errors"
	"regexp"
	"strings"
)

var homePattern = regexp.MustCompile(`^/home/[A-Za-z][A-Za-z0-9_.-]{0,62}$`)

func validateHardwareOptions(o Options) error {
	for _, home := range []string{o.WorkHome, o.BrowserHome} {
		if home != "" && !homePattern.MatchString(home) {
			return errors.New("Домашний каталог должен быть отдельным одноуровневым каталогом в /home/ и содержать только буквы, цифры, точки, дефисы и подчёркивания")
		}
		if home == "/home/cage" || home == "/home/cage-browser" {
			return errors.New("Домашний каталог не может использовать каталог зарезервированного аккаунта базового образа")
		}
	}
	if o.WorkHome != "" && o.WorkHome == o.BrowserHome {
		return errors.New("Два аккаунта не могут использовать один домашний каталог")
	}
	switch o.GraphicsBackend {
	case "", "auto", "metal", "d3d11", "vulkan", "opengl", "software":
	default:
		return errors.New("Недопустимый бэкенд графического рендеринга")
	}
	switch o.GPUBackend {
	case "", "default", "virgl":
	default:
		return errors.New("Недопустимый бэкенд виртуального GPU")
	}
	if o.WebGL == "disabled" && o.GraphicsBackend != "" && o.GraphicsBackend != "auto" {
		return errors.New("При отключённом WebGL нельзя требовать определённый бэкенд 3D-рендеринга")
	}
	if o.GPUBackend == "virgl" && o.GraphicsBackend == "vulkan" {
		return errors.New("Текущий путь VirGL даёт только OpenGL; для Vulkan требуется отдельная поддержка Venus/Gfxstream")
	}
	if o.AudioModel != "" {
		m, ok := findAudioModel(o.AudioModel)
		if !ok {
			return errors.New("Модель аудиоустройства не существует")
		}
		if o.AudioDescription != "" && o.AudioDescription != m.Label {
			return errors.New("Описание аудио должно соответствовать выбранной модели")
		}
		if o.AudioName != "" && !strings.HasPrefix(o.AudioName, "alsa_output.usb-"+m.Stem+"_") {
			return errors.New("Имя аудиоустройства не совпадает с выбранной моделью")
		}
	}
	return nil
}

func (p *Profile) WorkHomePath() string {
	if p == nil {
		return "/home/cage"
	}
	if p.WorkHome != "" {
		return p.WorkHome
	}
	return "/home/" + p.Username
}
func (p *Profile) BrowserHomePath() string {
	if p == nil {
		return "/home/cage-browser"
	}
	if p.BrowserHome != "" {
		return p.BrowserHome
	}
	return "/home/" + p.BrowserUsername
}

// Platform refers to the guest OS, not the host. No renderer names are spoofed.
func (o Options) ValidatePlatform(platform string) error {
	if o.GraphicsBackend == "metal" && platform != "darwin" {
		return errors.New("Бэкенд Metal поддерживается только гостевой системой macOS")
	}
	if o.GraphicsBackend == "d3d11" && platform != "windows" {
		return errors.New("Бэкенд D3D11 поддерживается только гостевой системой Windows")
	}
	if o.GraphicsBackend == "vulkan" && platform != "linux" {
		return errors.New("Бэкенд Vulkan сейчас поддерживается только гостевой системой Linux")
	}
	if o.GPUBackend == "virgl" && platform != "linux" {
		return errors.New("Бэкенд VirGL сейчас поддерживается только гостевой системой Linux на QEMU")
	}
	return nil
}

func (p *Profile) GraphicsFlags() []string {
	if p == nil {
		return nil
	}
	switch p.GraphicsBackend {
	case "metal", "d3d11", "vulkan":
		return []string{"--use-gl=angle", "--use-angle=" + p.GraphicsBackend, "--enable-zero-copy"}
	case "opengl":
		return []string{"--use-gl=angle", "--use-angle=gl", "--enable-zero-copy"}
	case "software":
		return []string{"--use-gl=angle", "--use-angle=swiftshader"}
	}
	return nil
}
