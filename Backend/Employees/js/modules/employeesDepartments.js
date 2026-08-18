// --- employeesDepartments.js: окно «Управление отделами» ---
//
// Список + инлайн-добавление и правка: форма разворачивается прямо в строке,
// отдельного окна нет. Удаление подтверждается окном слоя на весь экран.
//
// Переименован из departments.js и переведён на фабрику. Заодно ушла общая с
// сотрудниками модалка удаления: раньше «Удалить отдел» переиспользовал
// #deleteModal и каждый раз навешивал на его кнопки свои обработчики со своей
// уборкой — это работало, но ровно до второго владельца того же окна.

/**
 * @param {HTMLElement} root  контейнер панели
 * @param {Object}      deps  { storage, toast, confirmDanger, isAlive, isAbort, onChanged }
 */
export function createDepartments(root, deps) {
    const { storage, toast, confirmDanger, isAlive, isAbort, onChanged } = deps;

    const $ = (sel) => root.querySelector(sel);
    const modal = $('[data-role="departments-modal"]');
    const list = $('[data-role="departments-list"]');

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
                    <button type="button" class="ui-btn ui-btn--secondary ui-btn--sm" data-role="department-cancel">Отмена</button>
                    <button type="button" class="ui-btn ui-btn--sm" data-role="department-save">Сохранить</button>
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
                    <button type="button" class="ui-btn ui-btn--icon ui-btn--sm" data-action="edit" data-id="${d.id}" aria-label="Редактировать" title="Редактировать"><i class="fas fa-pencil" aria-hidden="true"></i></button>
                    <button type="button" class="ui-btn ui-btn--icon ui-btn--sm row-del" data-action="delete" data-id="${d.id}" data-name="${escapeHtml(d.name)}" aria-label="Удалить" title="Удалить"><i class="fas fa-trash" aria-hidden="true"></i></button>
                </div>
            </div>`;
    }

    function renderList() {
        const showEmpty = departments.length === 0 && !(activeForm && activeForm.mode === 'add');
        $('[data-role="departments-empty"]').hidden = !showEmpty;

        const rows = departments.map(rowHtml).join('');
        const addRow = activeForm && activeForm.mode === 'add'
            ? formRowHtml(null)
            : '<button type="button" class="department-add-row" data-role="department-add"><i class="fas fa-plus" aria-hidden="true"></i> Добавить отдел</button>';
        list.innerHTML = rows + addRow;
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
        if (saving) return;
        const name = $('#empDepartmentName').value.trim();
        const organizationId = $('#empDepartmentOrg').value;

        if (!name) { toast('Заполните обязательное поле: Название', 'error'); return; }
        if (!organizationId) { toast('Заполните обязательное поле: Юрлицо', 'error'); return; }

        const data = { name, organizationId: Number(organizationId) };
        const mode = activeForm.mode;
        const id = activeForm.id;

        saving = true;
        const btn = $('[data-role="department-save"]');
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
            title: 'Удаление отдела',
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

    function init() {
        $('[data-role="departments-btn"]').addEventListener('click', async () => {
            activeForm = null;
            modal.hidden = false;
            await loadAndRender();
        });
        $('[data-role="departments-close"]').addEventListener('click', () => {
            modal.hidden = true;
            activeForm = null;
        });
        modal.addEventListener('click', (e) => {
            if (e.target !== modal) return;
            modal.hidden = true;
            activeForm = null;
        });

        // Делегирование: строки перерисовываются на каждое действие, и подписка
        // на каждую кнопку после каждой перерисовки копила бы обработчики.
        list.addEventListener('click', (e) => {
            const editBtn = e.target.closest('[data-action="edit"]');
            if (editBtn) { activeForm = { mode: 'edit', id: Number(editBtn.dataset.id) }; renderList(); return; }

            const delBtn = e.target.closest('[data-action="delete"]');
            if (delBtn) { handleDelete(Number(delBtn.dataset.id), delBtn.dataset.name); return; }

            if (e.target.closest('[data-role="department-add"]')) { activeForm = { mode: 'add' }; renderList(); return; }
            if (e.target.closest('[data-role="department-cancel"]')) { activeForm = null; renderList(); return; }
            if (e.target.closest('[data-role="department-save"]')) handleSave();
        });
    }

    return { init, isOpen: () => !modal.hidden };
}
