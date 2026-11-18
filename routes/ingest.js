
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const {
    createInspection,
    createBatch,
    openBatch,
    closeBatch
} = require("../controllers/ingestController");

const {
    validateInspection,
    validateBatch,
    getInspectionValidationError
} = require("../middleware/validate");

const router = express.Router();
const uploadDirectory = path.resolve(process.env.UPLOAD_DIR || "uploads");

fs.mkdirSync(uploadDirectory, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDirectory);
    },
    filename: (req, file, cb) => {
        const uniqueName =
            Date.now() + "-" +
            Math.round(Math.random() * 1E9) +
            path.extname(file.originalname).toLowerCase();

        cb(null, uniqueName);
    }
});

const upload = multer({
    storage,
    limits: {
        fileSize: 5 * 1024 * 1024
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = [
            "image/jpeg",
            "image/png",
            "image/webp"
        ];

        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error("Only JPG, PNG, and WEBP images are allowed"));
        }
    }
});

// حذف الصورة عند رفض الطلب
async function cleanupImage(req) {
    if (req.file) {
        await fs.promises.unlink(req.file.path).catch(() => {});
    }
}

// التحقق من محتوى الصورة الحقيقي
async function verifyImage(req, res, next) {
    if (!req.file) {
        return next();
    }

    try {
        const { fileTypeFromFile } = await import("file-type");
        const fileType = await fileTypeFromFile(req.file.path);

        const allowedTypes = [
            "image/jpeg",
            "image/png",
            "image/webp"
        ];

        if (!fileType || !allowedTypes.includes(fileType.mime)) {
            await cleanupImage(req);

            return res.status(400).json({
                message: "Invalid image content. Only JPG, PNG, and WEBP are allowed."
            });
        }

        next();
    } catch (error) {
        await cleanupImage(req);
        next(error);
    }
}

// تجهيز بيانات الفحص
function prepareInspection(req, res, next) {
    req.body = req.body || {};

    if (req.body.confidence !== undefined) {
        req.body.confidence = req.body.confidence === ""
            ? Number.NaN
            : Number(req.body.confidence);
    }

    if (req.body.needs_review === "true") {
        req.body.needs_review = true;
    } else if (req.body.needs_review === "false") {
        req.body.needs_review = false;
    }

    if (req.body.batch_id === "") {
        delete req.body.batch_id;
    } else if (req.body.batch_id !== undefined) {
        req.body.batch_id = Number(req.body.batch_id);
    }

    if (req.body.line_id === "") {
        delete req.body.line_id;
    } else if (req.body.line_id !== undefined) {
        req.body.line_id = Number(req.body.line_id);
    }

    if (req.file) {
        req.body.image_url = `/uploads/${req.file.filename}`;
    }

    next();
}

// التحقق من البيانات وحذف الصورة عند وجود خطأ
function validateUploadedInspection(req, res, next) {
    const message = getInspectionValidationError(req.body);

    if (message) {
        return cleanupImage(req).finally(() => {
            res.status(400).json({ message });
        });
    }

    next();
}

// فتح مجموعة جديدة
router.post("/batches/open", openBatch);

// قفل مجموعة
router.post("/batches/:id/close", closeBatch);

// استقبال فحص مع صورة
router.post(
    "/inspection",
    upload.single("image"),
    verifyImage,
    prepareInspection,
    validateUploadedInspection,
    createInspection
);

// استقبال فحص JSON
router.post(
    "/inspection-json",
    validateInspection,
    createInspection
);

// استقبال مجموعة فحوصات
router.post(
    "/inspections/batch",
    validateBatch,
    createBatch
);

module.exports = router;
