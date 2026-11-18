package workbench

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/sylvinus/agent-vm/internal/guestprofile"
)

type deviceObservation struct {
	UserAgent   string `json:"user_agent"`
	Platform    string `json:"platform"`
	ClientHints *struct {
		Brands []struct {
			Brand   string `json:"brand"`
			Version string `json:"version"`
		} `json:"brands"`
		Platform string `json:"platform"`
		Mobile   bool   `json:"mobile"`
	} `json:"client_hints"`
	Screen struct {
		Width      int     `json:"width"`
		Height     int     `json:"height"`
		ColorDepth int     `json:"color_depth"`
		PixelRatio float64 `json:"pixel_ratio"`
	} `json:"screen"`
	Viewport struct {
		Width  int `json:"width"`
		Height int `json:"height"`
	} `json:"viewport"`
	Canvas struct {
		State    string `json:"state"`
		Checksum string `json:"checksum,omitempty"`
	} `json:"canvas"`
	WebGL struct {
		State    string `json:"state"`
		API      string `json:"api,omitempty"`
		Vendor   string `json:"vendor"`
		Renderer string `json:"renderer"`
		Version  string `json:"version"`
	} `json:"webgl"`
	Audio struct {
		State  string   `json:"state"`
		Labels []string `json:"labels"`
	} `json:"audio"`
	WebGPU bool `json:"webgpu"`
}

type deviceSystemObservation struct {
	Hostname         string `json:"hostname"`
	Username         string `json:"username"`
	Home             string `json:"home"`
	AudioName        string `json:"audio_name"`
	AudioDescription string `json:"audio_description"`
}

type deviceCheckItem struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	State    string `json:"state"`
	Evidence string `json:"evidence"`
}
type deviceCheckReport struct {
	Target        string                   `json:"target"`
	CheckedAt     time.Time                `json:"checked_at"`
	Checks        []deviceCheckItem        `json:"checks"`
	Browser       *deviceObservation       `json:"browser,omitempty"`
	System        *deviceSystemObservation `json:"system,omitempty"`
	Application   *claudeDesktopState      `json:"application,omitempty"`
	RendererClass string                   `json:"renderer_class,omitempty"`
}

func publicDeviceText(s string, limit int) bool {
	return len(s) <= limit && !strings.ContainsAny(s, "\x00\r\n")
}
func (v *deviceObservation) valid() bool {
	if v == nil || !publicDeviceText(v.UserAgent, 1024) || !publicDeviceText(v.Platform, 128) || !publicDeviceText(v.WebGL.Renderer, 512) || !publicDeviceText(v.WebGL.Vendor, 256) || !publicDeviceText(v.WebGL.Version, 256) || len(v.Audio.Labels) > 8 {
		return false
	}
	for _, label := range v.Audio.Labels {
		if !publicDeviceText(label, 128) {
			return false
		}
	}
	if !publicDeviceText(v.WebGL.API, 16) {
		return false
	}
	if v.Canvas.State != "passed" && v.Canvas.State != "failed" && v.Canvas.State != "blocked" && v.Canvas.State != "unavailable" {
		return false
	}
	if v.WebGL.State != "passed" && v.WebGL.State != "failed" && v.WebGL.State != "unavailable" && v.WebGL.State != "readback_blocked" {
		return false
	}
	if v.Canvas.Checksum != "" && !regexp.MustCompile(`^[a-f0-9]{8}$`).MatchString(v.Canvas.Checksum) {
		return false
	}
	if v.ClientHints != nil {
		if len(v.ClientHints.Brands) > 8 || !publicDeviceText(v.ClientHints.Platform, 128) {
			return false
		}
		for _, brand := range v.ClientHints.Brands {
			if !publicDeviceText(brand.Brand, 64) || !publicDeviceText(brand.Version, 32) {
				return false
			}
		}
	}
	return v.Screen.Width >= 0 && v.Screen.Width <= 32768 && v.Screen.Height >= 0 && v.Screen.Height <= 32768 && v.Screen.PixelRatio >= 0 && v.Screen.PixelRatio <= 16 && v.Viewport.Width >= 0 && v.Viewport.Width <= 32768 && v.Viewport.Height >= 0 && v.Viewport.Height <= 32768
}

var chromeMajor = regexp.MustCompile(`(?:Chrome|Chromium|Edg)/([0-9]+)\.`)
var softwareRenderer = regexp.MustCompile(`(?i)swiftshader|llvmpipe|softpipe|software|\bwarp\b|basic render`)
var virtualRenderer = regexp.MustCompile(`(?i)virgl|paravirtual|virtio`)

func evaluateDevice(p *guestprofile.Profile, v *deviceObservation) ([]deviceCheckItem, string) {
	if !v.valid() {
		return []deviceCheckItem{{"browser-evidence", "Наблюдение браузера", "unknown", "Гостевая система ещё не предоставила полные и корректные локальные данные наблюдения; обновите компоненты и повторите проверку."}}, "unobserved"
	}
	items := []deviceCheckItem{}
	add := func(id, title, state, evidence string) {
		items = append(items, deviceCheckItem{id, title, state, evidence})
	}
	ua := chromeMajor.FindStringSubmatch(v.UserAgent)
	if len(ua) == 2 && v.ClientHints != nil {
		matched := false
		inconsistent := false
		platform := ""
		switch {
		case strings.Contains(v.UserAgent, "Windows NT"):
			platform = "Windows"
		case strings.Contains(v.UserAgent, "Macintosh"):
			platform = "macOS"
		case strings.Contains(v.UserAgent, "X11; Linux"):
			platform = "Linux"
		}
		if platform != "" && v.ClientHints.Platform != "" && platform != v.ClientHints.Platform {
			inconsistent = true
		}
		for _, brand := range v.ClientHints.Brands {
			if brand.Brand == "Chromium" || brand.Brand == "Google Chrome" || brand.Brand == "Microsoft Edge" {
				matched = true
				if brand.Version != ua[1] {
					inconsistent = true
				}
			}
		}
		if inconsistent {
			add("user-agent", "UA браузера и Client Hints", "failed", "Основная версия браузера или платформа системы не совпадают; восстановите исходные настройки идентичности браузера.")
		} else if matched {
			add("user-agent", "UA браузера и Client Hints", "passed", "Предоставленные основная версия браузера и сведения о платформе совпадают. Проверка не подтверждает источник установки браузера.")
		} else {
			add("user-agent", "UA браузера и Client Hints", "unknown", "Браузер не предоставил проверяемую версию бренда Chromium.")
		}
	} else {
		add("user-agent", "UA браузера и Client Hints", "unknown", "Текущий документ не раскрывает Client Hints, поэтому судить о совпадении версии нельзя.")
	}
	class := "unobserved"
	if v.WebGL.Renderer != "" && v.WebGL.Renderer != "WebKit WebGL" && v.WebGL.Renderer != "WebGL" {
		class = "driver-reported"
		if softwareRenderer.MatchString(v.WebGL.Renderer) {
			class = "software"
		} else if virtualRenderer.MatchString(v.WebGL.Renderer) {
			class = "virtual-gpu"
		}
	}
	if p != nil && p.WebGL == "disabled" {
		if v.WebGL.State == "unavailable" {
			add("webgl-render", "Корректность рендеринга WebGL", "passed", "WebGL не создал контекст, что соответствует сохранённой опции отключения.")
		} else {
			add("webgl-render", "Корректность рендеринга WebGL", "failed", "В настройках WebGL отключён, но текущий документ всё ещё создаёт контекст; перезапустите браузер и проверьте компоненты.")
		}
	} else if v.WebGL.State == "passed" {
		add("webgl-render", "Корректность рендеринга WebGL", "passed", "Компиляция и компоновка шейдеров, а также чтение пикселей 4×4 соответствуют эталонным цветам. Результат не доказывает прямой доступ к физическому GPU.")
	} else if v.WebGL.State == "failed" {
		add("webgl-render", "Корректность рендеринга WebGL", "failed", "Шейдеры или чтение пикселей не соответствуют ожиданиям; проверьте выбранный бэкенд и драйвер.")
	} else {
		add("webgl-render", "Корректность рендеринга WebGL", "unknown", "WebGL недоступен или чтение пикселей ограничено; проверка корректности рендеринга не выполнена.")
	}
	backend := "auto"
	if p != nil && p.GraphicsBackend != "" {
		backend = p.GraphicsBackend
	}
	if class == "software" && backend != "software" {
		state := "warning"
		if backend != "auto" {
			state = "failed"
		}
		add("graphics-backend", "Фактический графический бэкенд", state, "Обнаружен программный рендеринг: "+v.WebGL.Renderer)
	} else if class == "unobserved" {
		add("graphics-backend", "Фактический графический бэкенд", "unknown", "Рендерер не наблюдается; утверждать включение аппаратного ускорения нельзя.")
	} else {
		state := "passed"
		evidence := v.WebGL.Renderer
		if class == "virtual-gpu" {
			evidence = "Драйвер виртуального GPU: " + evidence
		}
		if backend == "software" && class != "software" {
			state = "failed"
			evidence = "Выбранный программный бэкенд не совпадает с фактическим рендерером: " + evidence
		}
		markers := map[string]string{"metal": "metal", "d3d11": "direct3d11", "vulkan": "vulkan", "opengl": "opengl"}
		if marker := markers[backend]; marker != "" && !strings.Contains(strings.ToLower(v.WebGL.Renderer), marker) {
			state = "unknown"
			evidence = "Отчёт драйвера не подтвердил выбранный API: " + evidence
		}
		if p != nil && p.GPUBackend == "virgl" && !strings.Contains(strings.ToLower(v.WebGL.Renderer), "virgl") {
			state = "failed"
			evidence = "Запрошенный рендерер VirGL не обнаружен: " + evidence
		}
		add("graphics-backend", "Фактический графический бэкенд", state, evidence)
	}
	if p != nil && p.Canvas == "blocked" && (v.Canvas.State == "passed" || v.Canvas.State == "failed") {
		add("canvas-render", "Рендеринг и чтение Canvas", "failed", "Чтение Canvas заблокировано в настройках, но текущий документ всё ещё читает пиксели; перезапустите браузер и проверьте компоненты.")
	} else if v.Canvas.State == "passed" {
		add("canvas-render", "Рендеринг и чтение Canvas", "passed", "Эталонные цвета прочитаны успешно; контрольная сумма шрифтового образца — "+v.Canvas.Checksum+"; разные устройства не обязаны давать разные значения.")
	} else if p != nil && p.Canvas == "blocked" && v.Canvas.State == "blocked" {
		add("canvas-render", "Рендеринг и чтение Canvas", "passed", "Чтение изображений ограничено, что соответствует сохранённой опции.")
	} else if v.Canvas.State == "failed" {
		add("canvas-render", "Рендеринг и чтение Canvas", "failed", "Чтение эталонных цветов не соответствует ожиданиям.")
	} else {
		add("canvas-render", "Рендеринг и чтение Canvas", "unknown", "Сейчас невозможно прочитать пиксели Canvas; реальные характеристики изображения не определены.")
	}
	if len(v.Audio.Labels) == 0 {
		add("browser-audio", "Аудиоустройства браузера", "unknown", "Документ не получил разрешение на метки устройств; проверка не запрашивает доступ к микрофону и не считает пустые метки успехом.")
	} else {
		add("browser-audio", "Аудиоустройства браузера", "observed", strings.Join(v.Audio.Labels, "; "))
	}
	return items, class
}

// Fixed local commands return only public fields. No process arguments,
// account files, application profiles or full PulseAudio properties leave it.
const deviceSystemProbe = `python3 - <<'CAGE_DEVICE_SYSTEM'
import json, os, pwd, socket, subprocess
account=pwd.getpwuid(os.getuid())
result={'hostname':socket.gethostname(),'username':account.pw_name,'home':account.pw_dir,'audio_name':'','audio_description':''}
try:
    text=subprocess.run(['pactl','--server=unix:/run/cage-audio/native','-f','json','list','sinks'],capture_output=True,text=True,timeout=3,check=True).stdout
    sinks=json.loads(text)
    if len(sinks)==1:
        result['audio_name']=str(sinks[0].get('name',''))[:120]
        result['audio_description']=str(sinks[0].get('description',''))[:128]
except Exception:
    pass
print(json.dumps(result))
CAGE_DEVICE_SYSTEM`

func (s *Server) deviceCheck(w http.ResponseWriter, r *http.Request) {
	if !s.hasTrustedView(r) {
		http.Error(w, "Проверку гостевой системы выполняйте в доверенной рабочей области", http.StatusForbidden)
		return
	}
	var in struct {
		Target string `json:"target"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if in.Target != "browser" && in.Target != "desktop" {
		http.Error(w, "Недопустимый объект проверки", 400)
		return
	}
	if !s.vmRunning() {
		http.Error(w, "Сначала запустите гостевую систему", 409)
		return
	}
	if !s.op.TryLock() {
		http.Error(w, "Выполняется операция со средой; повторите проверку позже", 409)
		return
	}
	defer s.op.Unlock()
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	p, err := guestprofile.Load(s.profile)
	if err != nil {
		requestError(w, err)
		return
	}
	report := deviceCheckReport{Target: in.Target, CheckedAt: time.Now(), Checks: []deviceCheckItem{}}
	if s.macosGuest == nil && s.windowsGuest == nil {
		if data, e := s.guest(ctx, deviceSystemProbe); e == nil {
			var machine deviceSystemObservation
			if json.Unmarshal(data, &machine) == nil && publicDeviceText(machine.Hostname, 255) && publicDeviceText(machine.Username, 64) && publicDeviceText(machine.Home, 128) && publicDeviceText(machine.AudioName, 120) && publicDeviceText(machine.AudioDescription, 128) {
				report.System = &machine
			}
		}
	}
	if report.System != nil && p != nil {
		for _, item := range []struct{ id, title, observed, expected string }{{"hostname", "Имя хоста гостевой системы", report.System.Hostname, p.Hostname}, {"username", "Рабочий аккаунт", report.System.Username, p.Username}, {"home", "Рабочий домашний каталог", report.System.Home, p.WorkHomePath()}, {"audio-model", "Системное аудиоустройство", report.System.AudioDescription, p.AudioDescription}} {
			state := "passed"
			if item.observed == "" {
				state = "unknown"
			} else if item.observed != item.expected && !(item.id == "hostname" && strings.EqualFold(item.observed, item.expected)) {
				state = "failed"
			}
			report.Checks = append(report.Checks, deviceCheckItem{item.id, item.title, state, "Фактическое значение: " + item.observed})
		}
	}
	if in.Target == "desktop" {
		state, err := s.deviceDesktopState(ctx)
		if err == nil {
			report.Application = state
			status := "unknown"
			evidence := "Приложение не запущено; состояние процесса наблюдать невозможно."
			if state.Running {
				status = "observed"
				evidence = "Наблюдается работа Claude Desktop и версия " + state.Version
			}
			report.Checks = append(report.Checks, deviceCheckItem{"desktop-process", "Приложение Claude Desktop", status, evidence})
		}
		report.Checks = append(report.Checks, deviceCheckItem{"desktop-renderer", "Внутренний рендерер Claude Desktop", "unknown", "Официальное приложение не имеет поддерживаемого локального интерфейса самопроверки рендеринга; данные входа не считывались, код не внедрялся, отладочный порт не открывался, результаты браузера не заменяют наблюдение внутри приложения."})
	} else {
		cfg, e := loadConfig(s.configPath)
		if e != nil {
			requestError(w, e)
			return
		}
		var observation browserObservation
		s.mu.Lock()
		token := s.credentials.Token
		s.mu.Unlock()
		body, _ := json.Marshal(map[string]any{"timezone": cfg.Timezone, "network": false, "device": true})
		data, err := s.guestAPI(ctx, token, http.MethodPost, "/audit", body)
		if err == nil {
			err = json.Unmarshal(data, &observation)
		}
		if err != nil {
			report.Checks = append(report.Checks, deviceCheckItem{"browser-evidence", "Наблюдение браузера", "unknown", "Локальный диагностический документ не завершён; убедитесь в доступности браузера и компонентов гостевой системы и повторите проверку."})
		} else {
			items, class := evaluateDevice(p, observation.Device)
			report.Checks = append(report.Checks, items...)
			report.RendererClass = class
			if observation.Device.valid() {
				report.Browser = observation.Device
			}
		}
	}
	jsonReply(w, report)
}

func (s *Server) deviceDesktopState(ctx context.Context) (*claudeDesktopState, error) {
	var state claudeDesktopState
	if s.windowsGuest != nil {
		err := s.windowsDesktopRequest(ctx, "status", nil, &state)
		return &state, err
	}
	if s.macosGuest != nil {
		data, err := s.guest(ctx, `test -d /Applications/Claude.app && printf 'installed\n'; /usr/bin/pgrep -x Claude >/dev/null && printf 'running\n'; /usr/bin/defaults read /Applications/Claude.app/Contents/Info CFBundleShortVersionString 2>/dev/null || true`)
		if err != nil {
			return nil, err
		}
		lines := strings.Fields(string(data))
		for _, line := range lines {
			if line == "installed" {
				state.Installed = true
			} else if line == "running" {
				state.Running = true
			} else if regexp.MustCompile(`^[0-9]+(?:\.[0-9]+){1,4}$`).MatchString(line) {
				state.Version = line
			}
		}
		return &state, nil
	}
	data, err := s.guestQuick(ctx, claudeDesktopSnapshot)
	if err != nil {
		return nil, err
	}
	if json.Unmarshal(data, &state) != nil {
		return nil, errors.New("Недопустимое состояние приложения")
	}
	return &state, nil
}
