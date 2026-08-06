// --- app.js: инициализация приложения ---

import { renderTable, initSorting, initTableActions } from './render.js';

import { initModal } from './modal.js';
import { initMassActions } from './massActions.js';
import { initConfirmModals } from './confirmModal.js';
import { initColumnSettings } from './columnSettings.js';
import { initHubNav } from './employeesNav.js';

document.addEventListener('DOMContentLoaded', async function() {

    // 1a. Навигация хаба слева
    initHubNav('employees');

    // 1b. Настройки видимых колонок (шестерёнка у таблицы)
    initColumnSettings();

    // 2. Данные и таблица
    await renderTable();

    // 3. Сортировка
    initSorting();

    // 4. Действия в таблице (редактирование/удаление)
    initTableActions();

    // 5. Модалка сотрудника
    initModal();

    // 6. Модалки подтверждения
    initConfirmModals();
    initMassActions();

    // 7. Фильтры (кнопка "Фильтр")
    const filterToggleBtn = document.getElementById('filterToggleBtn');
    const filterModal = document.getElementById('filterModal');
    const filterModalCloseBtn = document.getElementById('filterModalCloseBtn');
    const filterApplyBtn = document.getElementById('filterApplyBtn');
    const filterClearBtn = document.getElementById('filterClearBtn');

    filterToggleBtn.addEventListener('click', function() {
        filterModal.style.display = 'flex';
        // populateFilterOptions уже вызывается внутри renderTable, но можно обновить
        renderTable();
    });
    filterModalCloseBtn.addEventListener('click', () => { filterModal.style.display = 'none'; });
    filterModal.addEventListener('click', (e) => { if (e.target === filterModal) filterModal.style.display = 'none'; });
    filterApplyBtn.addEventListener('click', function() {
        renderTable();
        filterModal.style.display = 'none';
    });
    filterClearBtn.addEventListener('click', function() {
        document.getElementById('filterStatus').value = '';
        document.getElementById('filterDepartment').value = '';
        document.getElementById('filterPosition').value = '';
        document.getElementById('filterHasWhatsapp').checked = false;
        document.getElementById('filterHasTelegram').checked = false;
        document.getElementById('filterHireDateFrom').value = '';
        document.getElementById('filterHireDateTo').value = '';
        renderTable();
        filterModal.style.display = 'none';
    });

    // 8. Поиск
    document.getElementById('searchInput').addEventListener('input', function() {
        renderTable();
    });
});