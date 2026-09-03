// ⚠ Значки из набора слоя, а не из Font Awesome (задача 44).
import { icon } from '/ui/icons.js';

// --- operatorToast.js: показ тостов (та же разметка/поведение, что в Employees/toast.js) ---

export function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const iconMap = {
        // ⚠⚠ РИСУНОК ОШИБКИ — ТРЕУГОЛЬНИК, А НЕ КРЕСТИК В КРУГЕ, и решила
        //    это не задача 44, а оболочка: тост слоя объявляет
        //    `error: 'warn'` (`Shell/ui/toast.js`). Оператор перестаёт быть
        //    исключением. ⓘ Довод и на самом экране: крестик в круге стал бы
        //    ТРЕТЬИМ круглым рядом с `check-circle` и `info`, которые в тостах
        //    стоят тут же.
        // ⚠ Цвет остаётся своим, `style`: в слое есть только `--warn`, а
        //    зелёного и красного значка там нет. Перевод тоста оператора на
        //    тост слоя — не эта задача.
        error: icon('warn', 'sm') .replace('<svg ', '<svg style="color:#ef4444" '),
        success: icon('check-circle', 'sm').replace('<svg ', '<svg style="color:#22c55e" '),
        info: icon('info', 'sm') .replace('<svg ', '<svg style="color:#3b82f6" ')
    };
    toast.innerHTML = `
        ${iconMap[type] || iconMap.info}
        <span>${message}</span>
        <button class="toast-close">&times;</button>
    `;
    container.appendChild(toast);
    toast.querySelector('.toast-close').addEventListener('click', () => toast.remove());
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}
