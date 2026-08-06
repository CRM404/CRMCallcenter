// --- toast.js: показ тостов ---

export function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const iconMap = {
        error: '<i class="fas fa-circle-exclamation" style="color:#ef4444;"></i>',
        success: '<i class="fas fa-circle-check" style="color:#22c55e;"></i>',
        info: '<i class="fas fa-circle-info" style="color:#3b82f6;"></i>'
    };
    toast.innerHTML = `
        ${iconMap[type] || iconMap.info}
        <span>${message}</span>
        <button class="toast-close"><i class="fas fa-xmark" aria-hidden="true"></i></button>
    `;
    container.appendChild(toast);
    toast.querySelector('.toast-close').addEventListener('click', () => toast.remove());
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}