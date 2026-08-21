// --- employeesDepartments.js: окно «Управление отделами» ---
//
// Список + инлайн-добавление и правка: форма разворачивается прямо в строке,
// отдельного окна нет. Удаление подтверждается окном слоя на весь экран.
//
// Переименован из departments.js и переведён на фабрику. Заодно ушла общая с
// сотрудниками модалка удаления: раньше «Удалить отдел» переиспользовал
// #deleteModal и каждый раз навешивал на его кнопки свои обработчики со своей
// уборкой — это работало, но ровно до второго владельца того же окна.
//
// Само окно списка собирает слой (К110, К111): в разметке раздела остался
// только шаблон полей.

import { openModal } from '/ui/modal.js';

/**
 * @param {HTMLElement} root  контейнер панели
 * @param {Object}      deps  { storage, toast, confirmDanger, isAlive, isAbort, onChanged }
 */
export function createDepartments(root, deps) {
    const { storage, toast, confirmDanger, isAlive, isAbort, onChanged } = deps;

    const $ = (sel) => root.querySelector(sel);
    const tpl = $('[data-role="departments-tpl"]');

    let modal = null;   // открытое окно слоя или null
    let list = null;    // список внутри открытого окна
    let departments = [];
    let organization = null;
    let activeForm = null;   // null | { mode: 'add' } | { mode: 'edit', id }
    let saving = false;

    function escapeHtml(value) {
        if (value === null || value === undefined || value === '') return '';
        return String(value).replace(/[&<>"]/g, (m) => {
            if (m === '&') return '&amp;';
            if (m === '<') return '&lt;';
            if (m === '>') return '&gt;';
            if (m === '"') return '&quot;';
            return m;
        });
    }

    function orgOptionsHtml(selectedId) {
        let html = '<option value="">— Выберите организацию —</option>';
        if (organization) {
            const selected = selectedId != null && String(selectedId) === String(organization.id) ? ' selected' : '';
            html += `<option value="${organization.id}"${selected}>${escapeHtml(organization.name)}</option>`;
        }
        return html;
    }

    function formRowHtml(current) {
        const name = current ? current.name : '';
        const orgId = current ? current.organizationId : (organization ? organization.id : null);
        return `
            <div class="department-row department-row-form">
                <div class="ui-form-grid">
                    <div class="ui-field">
                        <label class="ui-field__label ui-field__label--required" for="empDepartmentName">Название отдела</label>
                        <input class="ui-field__control" type="text" id="empDepartmentName" value="${escapeHtml(name)}" placeholder="Отдел продаж">
                    </div>
                    <div class="ui-field">
                        <label class="ui-field__label ui-field__label--required" for="empDepartmentOrg">Юрлицо</label>
                        <select class="ui-field__control" id="empDepartmentOrg">${orgOptionsHtml(orgId)}</select>
                    </div>
                </div>
                <div class="department-form-actions">
                    <button type="button" class="ui-btn ui-btn--ghost" data-role="department-cancel">Отмена</button>
                    <button type="button" class="ui-btn" data-role="department-save">Сохранить</button>
                </div>
            </div>`;
    }

    function rowHtml(d) {
        if (activeForm && activeForm.mode === 'edit' && activeForm.id === d.id) return formRowHtml(d);
        return `
            <div class="department-row" data-id="${d.id}">
                <div class="department-row-info">
                    <span class="department-row-name">${escapeHtml(d.name)}</span>
                    <span class="department-row-org">${escapeHtml(d.organizationName || '—')}</span>
                </div>
                <div class="department-row-actions">
                    <button type="button" class="ui-btn ui-btn--icon ui-btn--row" data-action="edit" data-id="${d.id}" aria-label="Редактировать" title="Редактировать"><svg class="ui-ic ui-ic--sm" aria-hidden="true"><use href="#ui-ic-edit"></use></svg></button>
                    <button type="button" class="ui-btn ui-btn--icon ui-btn--row ui-btn--danger" data-action="delete" data-id="${d.id}" data-name="${escapeHtml(d.name)}" aria-label="Удалить" title="Удалить"><svg class="ui-ic ui-ic--sm" aria-hidden="true"><use href="#ui-ic-trash"></use></svg></button>
                </div>
            </div>`;
    }

    function renderList() {
        if (!list) return;
        const showEmpty = departments.length === 0 && !(activeForm && activeForm.mode === 'add');
        list.parentElement.querySelector('[data-role="departments-empty"]').hidden = !showEmpty;

        const rows = departments.map(rowHtml).join('');
        const addRow = activeForm && activeForm.mode === 'add'
            ? formRowHtml(null)
            : '<button type="button" class="department-add-row" data-role="department-add"><svg class="ui-ic ui-ic--sm" aria-hidden="true"><use href="#ui-ic-plus"></use></svg> Добавить отдел</button>';
        list.innerHTML = rows + addRow;

        // Форма развернулась на месте кнопки, которой её открыли, — фокус надо
        // перевести руками, иначе он падает в документ вместе с исчезнувшей
        // кнопкой и следующий Tab начинает обход заново.
        if (activeForm) {
            const nameInput = list.querySelector('#empDepartmentName');
            if (nameInput) nameInput.focus();
        }
    }

    async function loadAndRender() {
        try {
            const [depts, org] = await Promise.all([storage.fetchDepartments(), storage.fetchOrganization()]);
            if (!isAlive()) return;
            departments = depts;
            organization = org;
        } catch (err) {
            if (!isAlive() || isAbort(err)) return;
            toast(err.message, 'error');
            return;
        }
        renderList();
    }

    async function handleSave() {
        if (saving || !list) return;
        const name = list.querySelector('#empDepartmentName').value.trim();
        const organizationId = list.querySelector('#empDepartmentOrg').value;

        if (!name) { toast('Заполните обязательное поле: Название', 'error'); return; }
        if (!organizationId) { toast('Заполните обязательное поле: Юрлицо', 'error'); return; }

        const data = { name, organizationId: Number(organizationId) };
        const mode = activeForm.mode;
        const id = activeForm.id;

        saving = true;
        const btn = list.querySelector('[data-role="department-save"]');
        if (btn) btn.disabled = true;
        try {
            if (mode === 'edit') await storage.updateDepartment(id, data);
            else await storage.createDepartment(data);
            if (!isAlive()) return;
        } catch (err) {
            if (!isAlive() || isAbort(err)) return;
            toast(err.message, 'error');
            return;
        } finally {
            saving = false;
            if (btn) btn.disabled = false;
        }

        toast(mode === 'edit' ? 'Отдел обновлён' : 'Отдел добавлен', 'success');
        activeForm = null;
        await loadAndRender();
        if (onChanged) await onChanged();
    }

    async function handleDelete(id, name) {
        const ok = await confirmDanger({
            title: 'Удалить отдел?',
            message: `Удалить отдел «${name}»? Действие необратимо.`
        });
        if (!ok || !isAlive()) return;
        try {
            await storage.deleteDepartment(id);
            if (!isAlive()) return;
        } catch (err) {
            if (!isAlive() || isAbort(err)) return;
            toast(err.message, 'error');
            return;
        }
        toast('Отдел удалён', 'success');
        await loadAndRender();
        if (onChanged) await onChanged();
    }

    async function openDepartments() {
        if (modal) return;
        activeForm = null;
        const body = document.createElement('div');
        body.appendChild(tpl.content.cloneNode(true));
        list = body.querySelector('[data-role="departments-list"]');

        // Делегирование: строки перерисовываются на каждое действие, и подписка
        // на каждую кнопку после каждой перерисовки копила бы обработчики.
        list.addEventListener('click', onListClick);

        modal = openModal({
            title: 'Управление отделами',
            body,
            scope: root,
            // Подвал у окна-списка (Н3). Кнопка одна и она не сохраняет: отделы
            // заводятся и правятся прямо в списке, каждое действие уходит на
            // сервер сразу. «Готово» здесь — выход, а не «применить».
            actions: [{ label: 'Готово', role: 'departments-done', value: true }]
        });
        // Крестик, «Готово», Esc и щелчок по затемнению — четыре двери в один
        // выход: незакрытая форма не должна пережить ни одну из них.
        modal.result.then(() => { modal = null; list = null; activeForm = null; });

        await loadAndRender();
        if (!modal) return;   // окно успели закрыть, пока шёл запрос

        // Фокус — не на крестик (К110). Поля, которое ждала дизайн-сессия, на
        // момент открытия ещё нет: окно начинается со списка, а поле нового
        // отдела появляется по «Добавить отдел». Поэтому фокус берёт эта
        // кнопка, а поле получает его, когда разворачивается форма.
        const add = list.querySelector('[data-role="department-add"]')
            || list.querySelector('button, input');
        if (add) add.focus();
    }

    function init() {
        $('[data-role="departments-btn"]').addEventListener('click', openDepartments);
    }

    function onListClick(e) {
        const editBtn = e.target.closest('[data-action="edit"]');
        if (editBtn) { activeForm = { mode: 'edit', id: Number(editBtn.dataset.id) }; renderList(); return; }

        const delBtn = e.target.closest('[data-action="delete"]');
        if (delBtn) { handleDelete(Number(delBtn.dataset.id), delBtn.dataset.name); return; }

        if (e.target.closest('[data-role="department-add"]')) { activeForm = { mode: 'add' }; renderList(); return; }
        if (e.target.closest('[data-role="department-cancel"]')) { activeForm = null; renderList(); return; }
        if (e.target.closest('[data-role="department-save"]')) handleSave();
    }

    return { init, isOpen: () => modal !== null };
}
