package remotehost

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"github.com/sylvinus/agent-vm/internal/host"
)

var uuidPattern = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
var instancePattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var hostnamePattern = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$`)
var storeLocks sync.Map

type Store struct {
	profile string
	mu      *sync.Mutex
}
type storedHosts struct {
	Version int           `json:"version"`
	Hosts   []HostProfile `json:"hosts"`
}

func NewStore(profileDir string) *Store {
	absolute, err := filepath.Abs(profileDir)
	if err == nil {
		profileDir = absolute
	}
	lock, _ := storeLocks.LoadOrStore(filepath.Clean(profileDir), &sync.Mutex{})
	return &Store{profile: profileDir, mu: lock.(*sync.Mutex)}
}

func newID() string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		panic(err)
	}
	raw[6] = (raw[6] & 15) | 64
	raw[8] = (raw[8] & 63) | 128
	s := hex.EncodeToString(raw[:])
	return s[:8] + "-" + s[8:12] + "-" + s[12:16] + "-" + s[16:20] + "-" + s[20:]
}

func hasControl(s string) bool {
	return strings.ContainsFunc(s, func(r rune) bool { return r < 32 || r == 127 })
}

func normalizeProfile(p HostProfile) (HostProfile, error) {
	p.Name = strings.TrimSpace(p.Name)
	p.Host = strings.TrimSpace(p.Host)
	p.User = strings.TrimSpace(p.User)
	if p.Platform == "" {
		p.Platform = "linux"
	}
	if p.Platform != "linux" && p.Platform != "windows" {
		return p, failure("invalid_profile", "Для удалённого хоста выберите Linux или Windows")
	}
	if p.Port == 0 {
		p.Port = 22
	}
	if p.Executable == "" {
		p.Executable = "cage"
	}
	if p.ID != "" && !uuidPattern.MatchString(p.ID) {
		return p, failure("invalid_profile", "Недопустимый идентификатор хоста")
	}
	if p.Name == "" || len(p.Name) > 200 || hasControl(p.Name) {
		return p, failure("invalid_profile", "Укажите корректное имя хоста")
	}
	if p.Host == "" || len(p.Host) > 253 || (net.ParseIP(p.Host) == nil && !hostnamePattern.MatchString(p.Host)) || strings.Contains(p.Host, "..") {
		return p, failure("invalid_profile", "Укажите имя хоста или IP-адрес")
	}
	if p.Port < 1 || p.Port > 65535 || p.User == "" || len(p.User) > 128 || hasControl(p.User) {
		return p, failure("invalid_profile", "Недопустимое имя пользователя или порт SSH")
	}
	if p.Auth.Kind != "key_file" && p.Auth.Kind != "agent" {
		return p, failure("invalid_profile", "Выберите файл ключа SSH или локальный SSH agent")
	}
	if p.Auth.Kind == "key_file" && (!filepath.IsAbs(p.Auth.IdentityFile) || hasControl(p.Auth.IdentityFile)) {
		return p, failure("invalid_profile", "Для файла ключа SSH нужен абсолютный путь на локальном компьютере")
	}
	if p.Auth.Kind == "agent" {
		p.Auth.IdentityFile = ""
	}
	absolute := path.IsAbs
	if p.Platform == "windows" {
		// Validate the remote path independently of the client's OS. UNC and
		// device paths would execute outside this machine's installed payload.
		absolute = func(value string) bool {
			return len(value) >= 3 && ((value[0] >= 'A' && value[0] <= 'Z') || (value[0] >= 'a' && value[0] <= 'z')) &&
				value[1] == ':' && (value[2] == '\\' || value[2] == '/') && !strings.Contains(value[2:], ":")
		}
	}
	if (p.Executable != "cage" && !absolute(p.Executable)) || hasControl(p.Executable) || len(p.Executable) > 4096 {
		return p, failure("invalid_profile", "Программа Cage на удалённом хосте должна задаваться абсолютным путём или как cage")
	}
	if (p.ConfigPath != "" && !absolute(p.ConfigPath)) || hasControl(p.ConfigPath) || len(p.ConfigPath) > 4096 {
		return p, failure("invalid_profile", "Файл конфигурации на удалённом хосте должен задаваться абсолютным путём")
	}
	if p.HostKey != nil {
		key := *p.HostKey
		raw, err := base64.RawStdEncoding.DecodeString(strings.TrimPrefix(key.Fingerprint, "SHA256:"))
		if key.Algorithm == "" || len(key.Algorithm) > 128 || hasControl(key.Algorithm) || !strings.HasPrefix(key.Fingerprint, "SHA256:") || err != nil || len(raw) != 32 {
			return p, failure("invalid_profile", "Недопустимый отпечаток ключа хоста SSH")
		}
		p.HostKey = &key
	}
	return p, nil
}

func (s *Store) read() ([]HostProfile, error) {
	filename := filepath.Join(s.profile, "remote-hosts.json")
	if err := host.CheckPrivateFile(filename); err != nil {
		if os.IsNotExist(err) {
			return []HostProfile{}, nil
		}
		return nil, failure("profile_permissions", "Небезопасные права доступа к конфигурации удалённых хостов")
	}
	f, err := os.Open(filename)
	if err != nil {
		return nil, failure("profile_read", "Не удалось прочитать конфигурацию удалённых хостов")
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.Size() > 1<<20 {
		return nil, failure("profile_invalid", "Конфигурация удалённых хостов слишком велика или недоступна для чтения")
	}
	var data storedHosts
	decoder := json.NewDecoder(io.LimitReader(f, 1<<20))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&data) != nil || data.Version != 1 || len(data.Hosts) > 100 {
		return nil, failure("profile_invalid", "Конфигурация удалённых хостов повреждена, существующий файл не изменён")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return nil, failure("profile_invalid", "Недопустимое содержимое конфигурации удалённых хостов")
	}
	seen := map[string]bool{}
	for i, p := range data.Hosts {
		normalized, err := normalizeProfile(p)
		if err != nil || p.ID == "" || seen[p.ID] {
			return nil, failure("profile_invalid", "Недопустимое содержимое конфигурации удалённых хостов")
		}
		data.Hosts[i] = normalized
		seen[p.ID] = true
	}
	if data.Hosts == nil {
		data.Hosts = []HostProfile{}
	}
	return data.Hosts, nil
}

func (s *Store) write(profiles []HostProfile) error {
	if err := host.EnsurePrivateDir(s.profile); err != nil {
		return failure("profile_permissions", "Не удалось создать приватный каталог конфигурации удалённых хостов")
	}
	file, err := os.CreateTemp(s.profile, ".remote-hosts-*")
	if err != nil {
		return failure("profile_write", "Не удалось сохранить конфигурацию удалённых хостов")
	}
	tmp := file.Name()
	defer os.Remove(tmp)
	if err = host.ProtectFile(tmp); err == nil {
		err = json.NewEncoder(file).Encode(storedHosts{1, profiles})
	}
	if err == nil {
		err = file.Sync()
	}
	err = errors.Join(err, file.Close())
	if err == nil {
		err = os.Rename(tmp, filepath.Join(s.profile, "remote-hosts.json"))
	}
	if err != nil {
		return failure("profile_write", "Конфигурацию удалённых хостов сохранить не удалось, существующий файл не изменён")
	}
	return nil
}

func (s *Store) List() ([]HostProfile, error) { s.mu.Lock(); defer s.mu.Unlock(); return s.read() }
func (s *Store) Get(id string) (HostProfile, error) {
	profiles, err := s.List()
	if err != nil {
		return HostProfile{}, err
	}
	for _, p := range profiles {
		if p.ID == id {
			return p, nil
		}
	}
	return HostProfile{}, failure("host_not_found", "Конфигурация удалённого хоста больше не существует")
}
func (s *Store) Upsert(profile HostProfile) (HostProfile, error) {
	profile, err := normalizeProfile(profile)
	if err != nil {
		return profile, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	profiles, err := s.read()
	if err != nil {
		return profile, err
	}
	if profile.ID == "" {
		if len(profiles) >= 100 {
			return profile, failure("profile_limit", "Можно сохранить не более 100 удалённых хостов")
		}
		profile.ID = newID()
		profiles = append(profiles, profile)
	} else {
		found := false
		for i, p := range profiles {
			if p.ID == profile.ID {
				profiles[i] = profile
				found = true
				break
			}
		}
		if !found {
			return profile, failure("host_not_found", "Конфигурация удалённого хоста больше не существует")
		}
	}
	return profile, s.write(profiles)
}
func (s *Store) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	profiles, err := s.read()
	if err != nil {
		return err
	}
	for i, p := range profiles {
		if p.ID == id {
			return s.write(append(profiles[:i], profiles[i+1:]...))
		}
	}
	return failure("host_not_found", "Конфигурация удалённого хоста больше не существует")
}
