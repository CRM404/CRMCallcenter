// --- scriptsAdminNav.js: вертикальная иконочная навигация хаба слева ---
// Дублирует leadsNav.js/mainNav.js/employeesNav.js/cpaNav.js/sourcesNav.js —
// между статическими папками страниц нет общего кода (имена файлов в css/ и
// js/modules/ обязаны быть уникальны между папками, все они монтируются в один
// корневой путь). Порядок пунктов — продовый, как на остальных страницах:
// в макете он другой, но это иллюстрация, а не спецификация (dialog.md F1).

const NAV_ITEMS = [
    { key: 'requisites', label: 'Реквизиты', icon: 'fa-file-invoice', href: '/main.html' },
    { key: 'employees', label: 'Сотрудники', icon: 'fa-users', href: '/emploees.html' },
    { key: 'cpa', label: 'CPA-сети', icon: 'fa-handshake', href: '/cpa-networks.html' },
    { key: 'operator', label: 'Оператор', icon: 'fa-headset', href: '/operator-login.html' },
    { key: 'scripts', label: 'Скрипты', icon: 'fa-diagram-project', href: '/scripts-admin.html' },
    { key: 'sources', label: 'Источники', icon: 'fa-tower-broadcast', href: '/sources.html' },
    { key: 'leads', label: 'Лиды', icon: 'fa-address-card', href: '/leads.html' }
];

export function initHubNav(activeKey) {
    const nav = document.getElementById('hubNav');
    if (!nav) return;

    NAV_ITEMS.forEach((item) => {
        const el = document.createElement('a');
        el.href = item.href;
        el.className = 'hub-nav-item' + (item.key === activeKey ? ' active' : '');
        el.dataset.tooltip = item.label;
        el.setAttribute('aria-label', item.label);
        el.innerHTML = `<i class="fas ${item.icon}" aria-hidden="true"></i>`;
        nav.appendChild(el);
    });
}
