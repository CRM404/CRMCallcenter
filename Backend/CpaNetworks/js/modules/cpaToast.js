// --- cpaToast.js: показ тостов (та же разметка/поведение, что в остальных модулях toast.js) ---

export function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const iconMap = {
        error: '<i class="fas fa-times-circle" style="color:#ef4444;"></i>',
        success: '<i class="fas fa-check-circle" style="color:#22c55e;"></i>',
        info: '<i class="fas fa-info-circle" style="color:#3b82f6;"></i>'
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
