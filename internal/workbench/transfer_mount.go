package workbench

import "github.com/sylvinus/agent-vm/internal/containerenv"

// Lima can change its base share only while stopped. Reconnecting a running
// instance must not keep serving the former project as the transfer directory.
func (s *Server) requireCurrentLinuxTransferMount() error {
	if s.macosGuest != nil || s.windowsGuest != nil || containerenv.Configured(s.profile) || !s.vmRunning() {
		return nil
	}
	if shares, _ := s.inspectVMLayout(); shares {
		return nil
	}
	failure := &projectShareError{Recovery: "environment-restart", Message: "Каталог загрузок не соответствует активному общему доступу к файлам. Сохраните работу, остановите среду и запустите её заново; файлы проектов, сессии и состояние входа сохранятся."}
	s.mu.Lock()
	s.ready = false
	s.mu.Unlock()
	_ = s.closeProxyGate(failure.Message)
	return failure
}
