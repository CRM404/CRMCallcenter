// --- operatorScript.js: линейный текст скрипта звонка ---
//
// Решение владельца (15.08.2026): скрипт стал ЛИНЕЙНЫМ. Пошагового показа с
// кнопками перехода под текстом больше нет — оператор читает текст подряд, как
// написано. Возражения из дерева ушли в поиск (operatorObjections.js), поэтому
// сюда приходят только statement-узлы: отбор делает сервер (routes/scripts.js),
// клиент не решает, что показывать.
//
// content вставляется как HTML: он приходит уже санитизированным белым списком
// тегов с бэкенда (rich-text тулбар в scriptsAdminNodes.js). Так было и в
// пошаговой версии — форматирование в репликах оператора поддерживалось всегда.

export function createScriptView(container, script) {
    const nodes = script.nodes || [];
    if (!nodes.length) {
        container.innerHTML = `
            <div class="op-panel-head">
                <h2><span class="op-card-icon"><i class="fas fa-file-lines" aria-hidden="true"></i></span>Скрипт разговора</h2>
            </div>
            <p class="op-script-end">Скрипт пуст.</p>
        `;
        return;
    }

    container.innerHTML = `
        <div class="op-panel-head">
            <h2><span class="op-card-icon"><i class="fas fa-file-lines" aria-hidden="true"></i></span>Скрипт разговора</h2>
            <span class="op-script-title">${escapeHtml(script.title)}</span>
        </div>
        <div class="op-script-content">
            ${nodes.map((node) => `<div class="op-script-block">${node.content}</div>`).join('')}
        </div>
    `;
}

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
