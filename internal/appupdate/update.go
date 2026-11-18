// Package appupdate checks and downloads releases using host networking first,
// with the selected managed egress as a fallback for connection failures.
// Signature verification and application replacement belong to the native app.
package appupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/sylvinus/agent-vm/internal/appupdate/catalog"
	"github.com/sylvinus/agent-vm/internal/cage"
	"github.com/sylvinus/agent-vm/internal/diagnostics"
	"github.com/sylvinus/agent-vm/internal/host"
	"github.com/sylvinus/agent-vm/internal/managedproxy"
	"github.com/sylvinus/agent-vm/internal/usererror"
	"github.com/sylvinus/agent-vm/internal/version"
)

const repository = catalog.Repository
const releasesURL = catalog.ReleasesURL
const maxArchive = catalog.MaxArchive
const metadataTimeout = 2 * time.Minute

var (
	downloadAttempts = 6
	downloadStall    = 60 * time.Second
	downloadBackoff  = 3 * time.Second
)

const maxMetadata = 4 << 20

type asset = catalog.Asset
type release = catalog.Release
type candidate = catalog.Candidate

// State is one line of the native launcher's private update process protocol.
// ArchivePath is returned only to the native launcher, never as a download URL.
type State struct {
	Phase          string `json:"phase"`
	CurrentVersion string `json:"currentVersion"`
	LatestVersion  string `json:"latestVersion,omitempty"`
	ReceivedBytes  int64  `json:"receivedBytes,omitempty"`
	TotalBytes     int64  `json:"totalBytes,omitempty"`
	Message        string `json:"message,omitempty"`
	Retryable      bool   `json:"retryable,omitempty"`
	RetryAt        string `json:"retryAt"`
	ArchivePath    string `json:"archivePath,omitempty"`
	SHA256         string `json:"sha256,omitempty"`
}

type proxyUnavailableError struct{ message string }

func (e *proxyUnavailableError) Error() string { return e.message }

// Run only accepts fixed operations. URLs and destinations come from the
// verified repository response and the current private profile.
func Run(configPath string, args []string, output io.Writer) int {
	enc := json.NewEncoder(output)
	state := State{CurrentVersion: version.Version}
	emit := func() { _ = enc.Encode(state) }
	fail := func(err error) int {
		var unavailable *proxyUnavailableError
		if len(args) == 1 && args[0] == "check" && errors.As(err, &unavailable) {
			state.Phase, state.Message, state.Retryable = "waiting", err.Error(), true
			emit()
			return 0
		}
		_ = diagnostics.New(filepath.Dir(configPath)).Record("warn", "app-update", fmt.Sprintf("%v; cause=%v", err, errors.Unwrap(err)))
		state.fail(err)
		emit()
		return 1
	}
	if len(args) != 1 || (args[0] != "check" && args[0] != "download") {
		return fail(errors.New("Недопустимая операция обновления"))
	}
	// A locally built binary must not be replaced by the official release: the
	// marker file in the profile directory (or CAGE_DISABLE_APP_UPDATE) turns
	// the native launcher's update check and download into a no-op.
	if updatesDisabled(configPath) {
		state.Phase, state.Message = "current", "Автообновление отключено"
		emit()
		return 0
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	client := updateClient(configPath)
	defer client.CloseIdleConnections()
	state.Phase, state.Message = "checking", "Проверка обновлений"
	emit()
	metadata, finished := context.WithTimeout(ctx, metadataTimeout)
	defer finished()
	c, err := findRelease(metadata, client, version.Version)
	if err != nil {
		return fail(err)
	}
	if c == nil {
		state.Phase, state.Message = "current", "Установлена последняя версия в текущем канале обновлений"
		emit()
		return 0
	}
	state.LatestVersion = c.Version
	if args[0] == "check" {
		state.Phase, state.Message = "available", "Доступна новая версия, можно скачать обновление"
		emit()
		return 0
	}
	if runtime.GOOS == "linux" {
		return fail(errors.New("Версия для Linux обновляется системным пакетом; скачайте новый .deb со страницы выпусков"))
	}
	digest, err := releaseDigest(metadata, client, *c)
	if err != nil {
		return fail(err)
	}
	directory := filepath.Join(filepath.Dir(configPath), "updates")
	if err = host.EnsurePrivateDir(directory); err != nil {
		return fail(errors.New("Не удалось создать приватный каталог обновлений"))
	}
	if st, e := os.Lstat(directory); e != nil || !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
		return fail(errors.New("Каталог обновлений должен быть приватным обычным каталогом"))
	}

	// One stable task directory lets an interrupted transfer continue after a
	// retry or an App restart. The native App removes it after verification.
	job := filepath.Join(directory, "download-resume")
	if err = host.EnsurePrivateDir(job); err != nil {
		return fail(errors.New("Не удалось создать задачу загрузки обновления"))
	}
	if st, e := os.Lstat(job); e != nil || !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
		return fail(errors.New("Каталог задачи загрузки обновления должен быть приватным обычным каталогом"))
	}
	localName := "Cage.dmg"
	if runtime.GOOS == "windows" {
		localName = "Cage-setup.exe"
	}
	archive := filepath.Join(job, localName)
	state.Phase, state.Message, state.TotalBytes = "downloading", "Загрузка обновления", c.Archive.Size
	emit()
	err = download(ctx, client, c.Archive, digest, archive, func(n int64) {
		state.ReceivedBytes, state.Message = n, "Загрузка обновления"
		emit()
	}, func() {
		state.Message = "Соединение прервано, продолжение с загруженной позиции"
		emit()
	})
	if err != nil {
		return fail(err)
	}
	state.Phase, state.Message, state.ArchivePath, state.SHA256 = "downloaded", "Контрольная сумма загрузки проверена, идёт проверка приложения", archive, digest
	emit()
	return 0
}

// updatesDisabled reports whether this build must stay in place. A marker file
// next to the configuration keeps the setting across restarts; the environment
// variable covers portable and test setups.
func updatesDisabled(configPath string) bool {
	if os.Getenv("CAGE_DISABLE_APP_UPDATE") != "" {
		return true
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(configPath), "no-app-update")); err == nil {
		return true
	}
	return false
}

func managedClient(ctx context.Context, configPath string) (*http.Client, error) {
	cfg, err := cage.Load(configPath)
	if err != nil {
		return nil, errors.New("Выбранный в Cage прокси не настроен")
	}
	profile := filepath.Dir(configPath)
	p, err := managedproxy.Applied(profile, cfg.ProxyURL, cfg.ProxyRevision)
	if err != nil {
		return nil, &proxyUnavailableError{"Выбранный в Cage прокси не применён"}
	}
	if !managedproxy.Running(ctx, profile, p) {
		return nil, &proxyUnavailableError{"Выбранный в Cage прокси не запущен"}
	}
	egress, err := cage.NewEgress(cfg)
	if err != nil {
		return nil, errors.New("Недопустимая конфигурация прокси обновлений")
	}
	return updateHTTPClient(&http.Transport{Proxy: nil, DialContext: egress.DialContext, ForceAttemptHTTP2: true, TLSHandshakeTimeout: 15 * time.Second, ResponseHeaderTimeout: 30 * time.Second, IdleConnTimeout: 10 * time.Second}), nil
}

func allowedURL(u *url.URL, redirect bool) bool {
	if u == nil || u.Scheme != "https" || u.User != nil || u.Fragment != "" || (u.Port() != "" && u.Port() != "443") {
		return false
	}
	switch u.Hostname() {
	case "api.github.com":
		path := strings.TrimPrefix(u.Path, "/repos/"+repository+"/")
		if path == u.Path {
			return false
		}
		if path == "releases" || path == "commits/main" {
			return true
		}
		if comparison, ok := strings.CutPrefix(path, "compare/"); ok {
			base, head, found := strings.Cut(comparison, "...")
			return found && validCommit(base) && validCommit(head)
		}
		return false
	case "github.com":
		return strings.HasPrefix(u.Path, "/"+repository+"/releases/download/") && !strings.Contains(u.Path, "/../")
	case "release-assets.githubusercontent.com", "objects.githubusercontent.com":
		return redirect
	}
	return false
}

// transientError marks failures that a later attempt can continue from.
type transientError struct{ error }

func (e *transientError) Unwrap() error { return e.error }

func request(ctx context.Context, client *http.Client, raw string) (*http.Response, error) {
	return requestFrom(ctx, client, raw, 0)
}

// requestFrom asks for the bytes after offset. A source that ignores the range
// answers 200 with the whole file, which the caller must handle.
func requestFrom(ctx context.Context, client *http.Client, raw string, offset int64) (*http.Response, error) {
	u, err := url.Parse(raw)
	if err != nil || !allowedURL(u, false) {
		return nil, errors.New("Адрес обновления не относится к доверенным источникам выпусков Cage")
	}
	req, err := http.NewRequestWithContext(ctx, "GET", raw, nil)
	if err != nil {
		return nil, errors.New("Недопустимый запрос обновления")
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	if u.Hostname() == "api.github.com" {
		req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	}
	if offset > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", offset))
	}
	resp, err := client.Do(req)
	if err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			return nil, errors.New("Загрузка обновления отменена")
		}
		var unavailable *networkUnavailableError
		if errors.As(err, &unavailable) {
			return nil, &transientError{unavailable}
		}
		return nil, &transientError{usererror.Wrap("Подключение к источнику обновлений", errors.Join(ctx.Err(), err), "Проверьте сеть хоста и системный прокси; при сбое подключения хоста также используется выбранный в Cage прокси. После восстановления сети повторите проверку обновлений.")}
	}
	if resp.StatusCode != http.StatusOK && !(offset > 0 && resp.StatusCode == http.StatusPartialContent) {
		resp.Body.Close()
		switch resp.StatusCode {
		case 404:
			if strings.Contains(u.Path, "/compare/") {
				return nil, errors.New("Коммит текущей сборки отсутствует в репозитории исходников; связь коммитов проверить нельзя")
			}
			return nil, errors.New("Источник обновлений не нашёл запрошенную версию или установочный пакет (HTTP 404). Повторите проверку позже; для ручной установки сверьте файл для своей платформы на странице выпусков Cage.")
		case 403, 429:
			return nil, updateSourceError(resp, time.Now())
		default:
			err := fmt.Errorf("Источник обновлений вернул HTTP %d, повторите позже", resp.StatusCode)
			if resp.StatusCode >= 500 {
				return nil, &transientError{err}
			}
			return nil, err
		}
	}
	return resp, nil
}

func limitedBody(resp *http.Response, limit int64) ([]byte, error) {
	defer resp.Body.Close()
	if resp.ContentLength > limit {
		return nil, errors.New("Сведения об обновлении превышают допустимый размер")
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil || int64(len(b)) > limit {
		return nil, errors.New("Загрузка сведений об обновлении прервана или превышен допустимый размер")
	}
	return b, nil
}

func findRelease(ctx context.Context, client *http.Client, current string) (*candidate, error) {
	resp, err := request(ctx, client, releasesURL)
	if err != nil {
		return nil, err
	}
	b, err := limitedBody(resp, maxMetadata)
	if err != nil {
		return nil, err
	}
	var releases []release
	if json.Unmarshal(b, &releases) != nil {
		return nil, errors.New("Источник обновлений вернул некорректные сведения о версии")
	}
	return catalog.Select(releases, current, runtime.GOOS, runtime.GOARCH)
}

func releaseDigest(ctx context.Context, client *http.Client, c candidate) (string, error) {
	if c.Checksums.URL == "" {
		return c.SHA256(nil)
	}
	u, err := url.Parse(c.Checksums.URL)
	if err != nil || u.Hostname() != "github.com" || !strings.HasPrefix(u.Path, "/"+repository+"/releases/download/v"+c.Version+"/") {
		return "", errors.New("Контрольный список относится к другой версии выпуска")
	}
	resp, err := request(ctx, client, c.Checksums.URL)
	if err != nil {
		return "", err
	}
	b, err := limitedBody(resp, 64<<10)
	if err != nil {
		return "", err
	}
	return c.SHA256(b)
}

// download continues a partial file of the same digest and retries dropped
// connections from the bytes already stored. Only a complete file whose size
// and SHA-256 match is moved to path.
func download(ctx context.Context, client *http.Client, a asset, digest, path string, progress func(int64), retrying func()) error {
	if a.Size <= 0 || a.Size > maxArchive {
		return errors.New("Недопустимый размер пакета выпуска или превышение 2 GiB")
	}
	if _, err := catalog.DigestValue("sha256:" + digest); err != nil {
		return err
	}
	partial := path + "." + digest[:16] + ".part"
	if entries, err := os.ReadDir(filepath.Dir(path)); err == nil {
		for _, entry := range entries {
			other := filepath.Join(filepath.Dir(path), entry.Name())
			if strings.HasSuffix(other, ".part") && other != partial {
				_ = os.Remove(other)
			}
		}
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return errors.New("Предыдущий загруженный пакет ещё используется, повторите позже")
	}
	hash := sha256.New()
	var f *os.File
	var offset int64
	if st, err := os.Lstat(partial); err == nil && st.Mode().IsRegular() && st.Size() <= a.Size {
		if f, err = os.OpenFile(partial, os.O_RDWR, 0600); err == nil {
			if offset, err = io.Copy(hash, f); err != nil || offset != st.Size() {
				f.Close()
				f = nil
			}
		}
	}
	if f == nil {
		_ = os.Remove(partial)
		var err error
		if f, err = os.OpenFile(partial, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600); err != nil {
			return errors.New("Не удалось создать приватный файл обновления")
		}
		offset = 0
		hash.Reset()
	}
	discard := false
	defer func() {
		f.Close()
		if discard {
			os.Remove(partial)
		}
	}()
	if err := host.ProtectFile(partial); err != nil {
		discard = true
		return errors.New("Не удалось защитить файл обновления")
	}
	restart := func() error {
		offset = 0
		hash.Reset()
		if err := f.Truncate(0); err != nil {
			return err
		}
		_, err := f.Seek(0, io.SeekStart)
		return err
	}
	if offset > 0 {
		progress(offset)
	}
	var last error
	for attempt := 0; offset < a.Size; attempt++ {
		if attempt >= downloadAttempts {
			return last
		}
		if attempt > 0 {
			retrying()
			select {
			case <-ctx.Done():
				return errors.New("Загрузка обновления отменена")
			case <-time.After(downloadBackoff):
			}
		}
		// The watchdog bounds silence, not the transfer: a slow but moving
		// download may take as long as it needs.
		attemptCtx, cancel := context.WithCancel(ctx)
		watchdog := time.AfterFunc(downloadStall, cancel)
		resp, err := requestFrom(attemptCtx, client, a.URL, offset)
		if err == nil {
			expected := a.Size
			if resp.StatusCode == http.StatusPartialContent {
				expected = a.Size - offset
				if !strings.HasPrefix(resp.Header.Get("Content-Range"), fmt.Sprintf("bytes %d-", offset)) {
					err = errors.New("Источник обновлений вернул неверную позицию возобновления")
				}
			} else if offset > 0 {
				err = restart()
			}
			if err == nil && resp.ContentLength > 0 && resp.ContentLength != expected {
				err = errors.New("Размер пакета выпуска не совпадает со сведениями о выпуске")
			}
			if err != nil {
				resp.Body.Close()
				watchdog.Stop()
				cancel()
				discard = true
				return err
			}
			w := &progressWriter{writer: io.MultiWriter(f, hash), total: offset, notify: func(n int64) {
				watchdog.Reset(downloadStall)
				progress(n)
			}}
			var n int64
			n, err = io.Copy(w, io.LimitReader(resp.Body, a.Size-offset+1))
			resp.Body.Close()
			offset += n
			if err != nil || offset < a.Size {
				err = &transientError{errors.New("Загрузка пакета выпуска прервана или фактический размер не совпадает")}
			}
		}
		stalled := attemptCtx.Err() != nil
		watchdog.Stop()
		cancel()
		if ctx.Err() != nil {
			return errors.New("Загрузка обновления отменена")
		}
		if offset > a.Size {
			discard = true
			return errors.New("Загрузка пакета выпуска прервана или фактический размер не совпадает")
		}
		var transient *transientError
		if err != nil && !stalled && !errors.As(err, &transient) {
			return err
		}
		if stalled && err != nil {
			err = errors.New("При загрузке обновления давно не поступали данные; загруженная часть сохранена, продолжение возможно позже")
		}
		last = err
	}
	if offset != a.Size || hex.EncodeToString(hash.Sum(nil)) != digest {
		discard = true
		return errors.New("Проверка SHA-256 пакета выпуска не удалась, скачайте заново")
	}
	if err := f.Sync(); err != nil {
		return errors.New("Не удалось сохранить файл обновления")
	}
	if err := f.Close(); err != nil {
		return errors.New("Не удалось сохранить файл обновления")
	}
	if err := os.Rename(partial, path); err != nil {
		return errors.New("Не удалось сохранить файл обновления")
	}
	progress(offset)
	return nil
}

type progressWriter struct {
	writer io.Writer
	notify func(int64)
	total  int64
	last   time.Time
}

func (w *progressWriter) Write(p []byte) (int, error) {
	n, err := w.writer.Write(p)
	w.total += int64(n)
	if n > 0 && time.Since(w.last) >= 250*time.Millisecond {
		w.last = time.Now()
		w.notify(w.total)
	}
	return n, err
}
