// --- routes/documents.js: документы сотрудника (паспорт, патент, договор и т.д.) ---

const express = require('express');
const { pool } = require('../db');

const router = express.Router();

const ALLOWED_TYPES = ['passport_front', 'passport_back', 'patent', 'contract', 'additional_agreement'];

// GET /api/employees/:id/documents — только метаданные, без file_data
router.get('/employees/:id/documents', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, document_type, file_name, uploaded_at FROM employee_documents WHERE employee_id = $1 ORDER BY document_type`,
            [req.params.id]
        );
        res.json(result.rows.map(r => ({
            id: r.id,
            documentType: r.document_type,
            fileName: r.file_name,
            uploadedAt: r.uploaded_at
        })));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить список документов' });
    }
});

// POST /api/employees/:id/documents — загрузка одного документа (UPSERT по employee_id + document_type)
router.post('/employees/:id/documents', async (req, res) => {
    try {
        const { documentType, fileName, fileData } = req.body;
        if (!documentType || !ALLOWED_TYPES.includes(documentType)) {
            return res.status(400).json({ error: 'Неизвестный тип документа' });
        }
        if (!fileData) {
            return res.status(400).json({ error: 'Файл не передан' });
        }

        const employeeCheck = await pool.query('SELECT id FROM employees WHERE id = $1', [req.params.id]);
        if (employeeCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Сотрудник не найден' });
        }

        const result = await pool.query(
            `INSERT INTO employee_documents (employee_id, document_type, file_name, file_data, uploaded_at)
             VALUES ($1, $2, $3, $4, NOW())
             ON CONFLICT (employee_id, document_type)
             DO UPDATE SET file_name = EXCLUDED.file_name, file_data = EXCLUDED.file_data, uploaded_at = NOW()
             RETURNING id, document_type, file_name, uploaded_at`,
            [req.params.id, documentType, fileName || null, fileData]
        );
        res.status(201).json({
            id: result.rows[0].id,
            documentType: result.rows[0].document_type,
            fileName: result.rows[0].file_name,
            uploadedAt: result.rows[0].uploaded_at
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось загрузить документ' });
    }
});

// GET /api/documents/:documentId/file — сам файл (base64), запрашивается отдельно от списка
router.get('/documents/:documentId/file', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT file_name, file_data FROM employee_documents WHERE id = $1',
            [req.params.documentId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Документ не найден' });
        }
        res.json({ fileName: result.rows[0].file_name, fileData: result.rows[0].file_data });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить файл' });
    }
});

module.exports = router;
