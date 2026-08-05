// --- operatorLoginApp.js: инициализация экрана входа (operator-login.html) ---

import { operatorLogin } from './operatorStorage.js';
import { setOperatorIdentity, getOperatorIdentity } from './operatorIdentity.js';

document.addEventListener('DOMContentLoaded', function() {
    // Уже вошли в этой вкладке — сразу на страницу оператора.
    if (getOperatorIdentity()) {
        window.location.replace('/operator.html');
        return;
    }

    const form = document.getElementById('opLoginForm');
    const errorBox = document.getElementById('opLoginError');
    const submitBtn = document.getElementById('opLoginSubmitBtn');

    form.addEventListener('submit', async function(e) {
        e.preventDefault();
        errorBox.classList.remove('visible');
        errorBox.textContent = '';

        const email = document.getElementById('opLoginEmail').value.trim();
        const password = document.getElementById('opLoginPassword').value;

        submitBtn.disabled = true;
        try {
            const employee = await operatorLogin(email, password);
            setOperatorIdentity(employee);
            window.location.replace('/operator.html');
        } catch (err) {
            errorBox.textContent = err.message;
            errorBox.classList.add('visible');
            submitBtn.disabled = false;
        }
    });
});
