// --- operatorNav.js: иконочная навигация слева (8 вкладок, 7 из них — заглушки) ---

import { clearOperatorIdentity } from './operatorIdentity.js';
import { showToast } from './operatorToast.js';

const NAV_ITEMS = [
    { key: 'desktop', label: 'Рабочий стол', icon: 'fa-table-columns', active: true },
    { key: 'stats', label: 'Статистика', icon: 'fa-chart-line' },
    { key: 'analytics', label: 'Аналитика', icon: 'fa-magnifying-glass-chart' },
    { key: 'schedule', label: 'График работы', icon: 'fa-calendar-days' },
    { key: 'mail', label: 'Почта', icon: 'fa-envelope' },
    { key: 'knowledge', label: 'База знаний', icon: 'fa-book' },
    { key: 'history', label: 'История', icon: 'fa-clock-rotate-left' },
    { key: 'access', label: 'Доступы', icon: 'fa-key' }
];

export function initOperatorNav() {
    const nav = document.getElementById('opNav');
    if (!nav) return;

    NAV_ITEMS.forEach((item) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'op-nav-item' + (item.active ? ' active' : '');
        btn.dataset.tooltip = item.label;
        btn.innerHTML = `<i class="fas ${item.icon}" aria-hidden="true"></i>`;
        btn.setAttribute('aria-label', item.label);
        if (!item.active) {
            btn.addEventListener('click', () => showToast(`${item.label}: скоро появится`, 'info'));
        }
        nav.appendChild(btn);
    });

    const spacer = document.createElement('div');
    spacer.className = 'op-nav-spacer';
    nav.appendChild(spacer);

    const logoutBtn = document.createElement('button');
    logoutBtn.type = 'button';
    logoutBtn.className = 'op-nav-item op-nav-logout';
    logoutBtn.dataset.tooltip = 'Выход';
    logoutBtn.setAttribute('aria-label', 'Выход');
    logoutBtn.innerHTML = '<i class="fas fa-right-from-bracket" aria-hidden="true"></i>';
    logoutBtn.addEventListener('click', () => {
        clearOperatorIdentity();
        window.location.replace('/operator-login.html');
    });
    nav.appendChild(logoutBtn);
}
