// Package usererror describes known system failures without exposing raw
// command arguments, network responses or credentials in the user interface.
package usererror

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"syscall"
	"unicode"
)

type failure struct {
	message string
	cause   error
}

func (e *failure) Error() string { return e.message }
func (e *failure) Unwrap() error { return e.cause }

func New(action, reason, next string, cause error) error {
	return &failure{message: action + " — ошибка: " + strings.TrimRight(reason, "。；;") + ". " + next, cause: cause}
}

func Wrap(action string, cause error, next string) error {
	if cause == nil {
		return nil
	}
	reason := Reason(cause)
	if reason == "" {
		reason = "Не удалось получить распознаваемую причину ошибки"
	}
	return New(action, reason, next, cause)
}

// Existing Chinese validation messages describe product rules and must survive
// unchanged. Unknown system exceptions receive an operation and a next step.
func Display(action string, cause error, next string) error {
	if cause == nil {
		return nil
	}
	switch cause.(type) {
	case *fs.PathError, *os.SyscallError, syscall.Errno, *exec.ExitError, net.Error:
		return Wrap(action, cause, next)
	}
	if strings.IndexFunc(cause.Error(), func(r rune) bool { return unicode.Is(unicode.Han, r) }) >= 0 {
		return cause
	}
	return Wrap(action, cause, next)
}

func Reason(err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, context.Canceled) {
		return "Операция отменена"
	}
	var timeout net.Error
	if errors.Is(err, context.DeadlineExceeded) || errors.As(err, &timeout) && timeout.Timeout() {
		return "Истекло время ожидания ответа"
	}
	var dns *net.DNSError
	if errors.As(err, &dns) {
		return "Не удалось определить имя домена сервера"
	}
	var authority x509.UnknownAuthorityError
	var hostname x509.HostnameError
	var certificate x509.CertificateInvalidError
	var record tls.RecordHeaderError
	if errors.As(err, &authority) || errors.As(err, &hostname) || errors.As(err, &certificate) {
		return "Проверка сертификата сервера не пройдена"
	}
	if errors.As(err, &record) {
		return "Сервер не вернул корректный ответ зашифрованного соединения"
	}
	switch {
	case errors.Is(err, fs.ErrPermission):
		return "Система запретила доступ к нужному файлу или каталогу"
	case errors.Is(err, fs.ErrNotExist), errors.Is(err, exec.ErrNotFound):
		return "Нужный файл или программа отсутствует"
	case errors.Is(err, syscall.ENOSPC) || runtime.GOOS == "windows" && (errors.Is(err, syscall.Errno(112)) || errors.Is(err, syscall.Errno(39))):
		return "Недостаточно свободного места на диске"
	case errors.Is(err, syscall.EROFS):
		return "Целевой диск доступен только для чтения, запись невозможна"
	case errors.Is(err, syscall.ECONNREFUSED):
		return "Целевая служба отклонила подключение"
	case errors.Is(err, syscall.ECONNRESET), errors.Is(err, syscall.EPIPE), errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF):
		return "Соединение прервано до получения полного результата"
	case errors.Is(err, syscall.ENETUNREACH), errors.Is(err, syscall.EHOSTUNREACH):
		return "Текущая сеть не позволяет достичь целевой службы"
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return fmt.Sprintf("Программа завершилась досрочно (код выхода %d), распознаваемая причина не получена", exit.ExitCode())
	}
	return ""
}
