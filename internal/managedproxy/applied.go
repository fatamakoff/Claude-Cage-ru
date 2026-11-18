package managedproxy

import "errors"

// Applied is the single source of truth for the private endpoint used by Cage.
func Applied(profile, endpoint, revision string) (Store, error) {
	p, err := Load(profile)
	if err != nil {
		return p, err
	}
	if _, ok := p.Find(p.Selected); !ok {
		return p, errors.New("Узел прокси не выбран: добавьте источник в разделе сети и прокси и выберите узел")
	}
	if revision == "" || p.Revision == "" || revision != p.Revision || endpoint != p.Endpoint() {
		return p, errors.New("Узел прокси не применён или конфигурация не совпадает; примените узел заново; внешняя сеть остаётся закрытой")
	}
	if _, err := p.Route(); err != nil {
		return p, err
	}
	return p, nil
}
