
const db = require("../database/db");
const { checkAlert } = require("../services/alertService");

function getOrOpenBatchId() {
    const batch = db.prepare(`
        SELECT id
        FROM inspection_batches
        WHERE status = 'open'
        ORDER BY id DESC
        LIMIT 1
    `).get();

    if (batch) {
        return batch.id;
    }

    const result = db.prepare(`
        INSERT INTO inspection_batches (status)
        VALUES ('open')
    `).run();

    return result.lastInsertRowid;
}

// استقبال فحص واحد
function createInspection(req, res) {
    try {
        const {
            product,
            line_id,
            status,
            confidence,
            size_category,
            needs_review,
            model_version,
            image_url,
            batch_id,
            created_at
        } = req.body;

        const saveInspection = db.transaction(() => {
            let inspectionBatchId = batch_id;

            if (inspectionBatchId !== undefined &&
                inspectionBatchId !== null &&
                inspectionBatchId !== "") {
                const batch = db.prepare(
                    "SELECT * FROM inspection_batches WHERE id = ?"
                ).get(inspectionBatchId);

                if (!batch || batch.status !== "open") {
                    throw new Error("Batch not found or already closed");
                }
            } else {
                inspectionBatchId = getOrOpenBatchId();
            }

            const result = db.prepare(`
                INSERT INTO inspections (
                    product, line_id, status, confidence,
                    size_category, needs_review, model_version,
                    image_url, batch_id, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
            `).run(
                product,
                line_id || null,
                status,
                confidence,
                size_category || null,
                needs_review ? 1 : 0,
                model_version || null,
                image_url || null,
                inspectionBatchId,
                created_at ? new Date(created_at).toISOString() : null
            );

            const inspectionId = result.lastInsertRowid;

            const alertResult = checkAlert({
                product,
                status,
                confidence,
                needs_review: needs_review === true
            }, inspectionId, inspectionBatchId, line_id);

            return { inspectionId, alertResult, inspectionBatchId };
        });

        const { inspectionId, alertResult, inspectionBatchId } = saveInspection();

        res.status(201).json({
            message: "Inspection saved successfully!",
            inspectionId,
            batchId: inspectionBatchId,
            lineId: line_id || null,
            imageUrl: image_url || null,
            alert: alertResult.alert,
            alertMessage: alertResult.message
        });
    } catch (error) {
        const statusCode =
            error.message === "Batch not found or already closed" ? 400 : 500;

        res.status(statusCode).json({
            message: error.message
        });
    }
}

// فتح مجموعة فحوصات جديدة
function openBatch(req, res) {
    try {
        const result = db.prepare(`
            INSERT INTO inspection_batches (status)
            VALUES ('open')
        `).run();

        res.status(201).json({
            message: "Batch opened successfully!",
            batchId: result.lastInsertRowid,
            status: "open"
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
}

// قفل مجموعة فحوصات
function closeBatch(req, res) {
    try {
        const batchId = Number(req.params.id);

        if (!Number.isInteger(batchId) || batchId <= 0) {
            return res.status(400).json({
                message: "Invalid batch ID"
            });
        }

        const result = db.prepare(`
            UPDATE inspection_batches
            SET status = 'closed',
                closed_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'open'
        `).run(batchId);

        if (result.changes === 0) {
            const batch = db.prepare(
                "SELECT * FROM inspection_batches WHERE id = ?"
            ).get(batchId);

            return res.status(batch ? 400 : 404).json({
                message: batch
                    ? "Batch is already closed"
                    : "Batch not found"
            });
        }

        res.json({
            message: "Batch closed successfully!",
            batchId,
            status: "closed"
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
}

// استقبال مجموعة فحوصات دفعة واحدة (Bulk)
function createBatch(req, res) {
    try {
        const inspections = req.body.inspections;

        const saveBulk = db.transaction((items) => {
            const batchId = getOrOpenBatchId();
            const insert = db.prepare(`
                INSERT INTO inspections (
                    product, line_id, status, confidence,
                    size_category, needs_review, model_version, image_url,
                    batch_id, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
            `);

            const ids = [];
            const alerts = [];

            items.forEach((item) => {
                const result = insert.run(
                    item.product,
                    item.line_id || null,
                    item.status,
                    item.confidence,
                    item.size_category || null,
                    item.needs_review ? 1 : 0,
                    item.model_version || null,
                    item.image_url || null,
                    batchId,
                    item.created_at ? new Date(item.created_at).toISOString() : null
                );

                const inspectionId = result.lastInsertRowid;
                ids.push(inspectionId);
                alerts.push({
                    product: item.product,
                    inspectionId,
                    ...checkAlert(item, inspectionId, batchId, item.line_id)
                });
            });

            return { ids, alerts, batchId };
        });

        const result = saveBulk(inspections);

        res.status(201).json({
            message: "Batch saved successfully!",
            count: result.ids.length,
            inspectionIds: result.ids,
            batchId: result.batchId,
            alerts: result.alerts
        });
    } catch (error) {
        res.status(500).json({
            message: error.message
        });
    }
}

module.exports = {
    createInspection,
    createBatch,
    openBatch,
    closeBatch
};
