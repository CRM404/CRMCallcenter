// --- cpaNav.js: вертикальная иконочная навигация хаба слева (паттерн operatorNav.js) ---
// Дублирует mainNav.js/employeesNav.js — между статическими папками нет общего
// кода. Порядок пунктов: Реквизиты, Сотрудники, CPA-сети, Оператор (заглушка),
// Управление скриптом (заглушка).

import { showToast } from './cpaToast.js';

const NAV_ITEMS = [
    { key: 'requisites', label: 'Реквизиты', icon: 'fa-file-invoice', href: '/main.html' },
    { key: 'employees', label: 'Сотрудники', icon: 'fa-users', href: '/emploees.html' },
    { key: 'cpa', label: 'CPA-сети', icon: 'fa-handshake', href: '/cpa-networks.html' },
    { key: 'operator', label: 'Оператор', icon: 'fa-headset', href: '/operator-login.html' },
    { key: 'scripts', label: 'Управление скриптом', icon: 'fa-diagram-project', href: '/scripts-admin.html' },
    { key: 'sources', label: 'Источники', icon: 'fa-tower-broadcast', href: '/sources.html' },
    { key: 'leads', label: 'Лиды', icon: 'fa-address-card', href: '/leads.html' }
];

export function initHubNav(activeKey) {
    const nav = document.getElementById('hubNav');
    if (!nav) return;

    NAV_ITEMS.forEach((item) => {
        const el = document.createElement(item.href ? 'a' : 'button');
        if (item.href) {
            el.href = item.href;
        } else {
            el.type = 'button';
        }
        el.className = 'hub-nav-item' + (item.key === activeKey ? ' active' : '');
        el.dataset.tooltip = item.label;
        el.setAttribute('aria-label', item.label);
        el.innerHTML = `<i class="fas ${item.icon}" aria-hidden="true"></i>`;
        if (!item.href) {
            el.addEventListener('click', () => showToast(`${item.label}: скоро появится`, 'info'));
        }
        nav.appendChild(el);
    });
}
