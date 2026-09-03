// ⚠ Значки берутся из набора слоя, а не из Font Awesome (задача 44).
import { icon } from '/ui/icons.js';

// --- operatorNav.js: иконочная навигация слева (8 вкладок, 7 из них — заглушки) ---

import { clearOperatorIdentity } from './operatorIdentity.js';
import { showToast } from './operatorToast.js';

const NAV_ITEMS = [
    { key: 'desktop', label: 'Рабочий стол', icon: 'cols', active: true },
    { key: 'stats', label: 'Статистика', icon: 'chart-line' },
    { key: 'analytics', label: 'Аналитика', icon: 'magnifying-glass-chart' },
    { key: 'schedule', label: 'График работы', icon: 'calendar' },
    { key: 'mail', label: 'Почта', icon: 'mail' },
    { key: 'knowledge', label: 'База знаний', icon: 'book' },
    { key: 'history', label: 'История', icon: 'history' },
    { key: 'access', label: 'Доступы', icon: 'key' }
];

// beforeLogout — снять оператора с линии перед выходом. Открытый интервал
// состояния иначе остался бы висеть и накрутил бы «На линии» до потолка
// (services/operatorState.js): по таким цифрам нельзя ничего считать.
export function initOperatorNav(options) {
    const nav = document.getElementById('opNav');
    if (!nav) return;
    const beforeLogout = options && options.beforeLogout;

    NAV_ITEMS.forEach((item) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'op-nav-item' + (item.active ? ' active' : '');
        btn.dataset.tooltip = item.label;
        btn.innerHTML = icon(item.icon);
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
    logoutBtn.innerHTML = icon('logout');
    logoutBtn.addEventListener('click', async () => {
        // Не блокируем выход, если запрос не прошёл: человек всё равно уходит,
        // а зависший интервал закроется потолком на сервере.
        if (beforeLogout) {
            try { await beforeLogout(); } catch (e) { /* выход важнее */ }
        }
        clearOperatorIdentity();
        window.location.replace('/operator-login.html');
    });
    nav.appendChild(logoutBtn);
}
