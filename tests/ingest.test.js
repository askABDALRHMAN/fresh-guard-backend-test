
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

let server;
let API;
let SERVER_URL;
let app;
let db;
let testDirectory;
let originalDbPath;
let originalUploadDirectory;

before(async () => {
    testDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "freshguard-ingest-"));
    originalDbPath = process.env.DB_PATH;
    originalUploadDirectory = process.env.UPLOAD_DIR;
    process.env.DB_PATH = path.join(testDirectory, "freshguard-test.db");
    process.env.UPLOAD_DIR = path.join(testDirectory, "uploads");

    app = require("../server");
    db = require("../database/db");
    server = app.listen(0);
    await once(server, "listening");

    const port = server.address().port;
    SERVER_URL = `http://localhost:${port}`;
    API = `${SERVER_URL}/api/ingest`;
});

after(async () => {
    if (server) {
        await new Promise((resolve, reject) => {
            server.close(error => {
                if (error) reject(error);
                else resolve();
            });
        });
    }

    if (db && db.open) {
        db.close();
    }

    if (testDirectory) {
        await fs.rm(testDirectory, { recursive: true, force: true });
    }

    if (originalDbPath === undefined) {
        delete process.env.DB_PATH;
    } else {
        process.env.DB_PATH = originalDbPath;
    }

    if (originalUploadDirectory === undefined) {
        delete process.env.UPLOAD_DIR;
    } else {
        process.env.UPLOAD_DIR = originalUploadDirectory;
    }
});

async function post(path, body) {
    return fetch(`${API}${path}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    });
}

test("يجب تشغيل الاختبارات على قاعدة مؤقتة منفصلة", () => {
    const mainDatabase = db.pragma("database_list").find(
        (database) => database.name === "main"
    );

    assert.equal(mainDatabase.file, process.env.DB_PATH);
    assert.ok(mainDatabase.file.startsWith(os.tmpdir()));
});

test("يجب حفظ فحص صحيح بنجاح", async () => {
    const response = await post("/inspection-json", {
        product: "Apple",
        status: "good",
        confidence: 0.95
    });

    assert.equal(response.status, 201);

    const data = await response.json();
    assert.equal(data.message, "Inspection saved successfully!");
    assert.ok(data.inspectionId);
});

test("يجب رفض confidence أكبر من 1", async () => {
    const response = await post("/inspection-json", {
        product: "Apple",
        status: "good",
        confidence: 1.5
    });

    assert.equal(response.status, 400);
});

test("يجب رفض البيانات الناقصة", async () => {
    const response = await post("/inspection-json", {
        status: "good",
        confidence: 0.9
    });

    assert.equal(response.status, 400);
});

test("يجب رفض حالة فحص غير مدعومة", async () => {
    const response = await post("/inspection-json", {
        product: "Apple",
        status: "spoiled",
        confidence: 0.9
    });

    assert.equal(response.status, 400);
    const data = await response.json();
    assert.match(data.message, /status must be good or defective/);
});

test("يجب رفض منتج غير معروف", async () => {
    const response = await post("/inspection-json", {
        product: "Dragonfruit",
        status: "good",
        confidence: 0.95
    });

    assert.equal(response.status, 400);
    assert.match((await response.json()).message, /Unknown product type/);
});

test("يجب رفض line_id الكسري أو النصي وقبول الرقم الصحيح", async () => {
    for (const lineId of [1.5, "2"]) {
        const response = await post("/inspection-json", {
            product: "Apple",
            status: "good",
            confidence: 0.95,
            line_id: lineId
        });

        assert.equal(response.status, 400);
        assert.match((await response.json()).message, /line_id must be a positive integer/);
    }

    const response = await post("/inspection-json", {
        product: "Apple",
        status: "good",
        confidence: 0.95,
        line_id: 2
    });

    assert.equal(response.status, 201);
    const data = await response.json();
    assert.equal(data.lineId, 2);
    assert.equal(
        db.prepare("SELECT line_id FROM inspections WHERE id = ?").get(data.inspectionId).line_id,
        2
    );
});

test("يجب رفض أنواع الحقول الاختيارية غير الصحيحة", async () => {
    const invalidFields = [
        ["size_category", 3, /size_category must be a string/],
        ["needs_review", "yes", /needs_review must be true or false/],
        ["model_version", 5, /model_version must be a string/]
    ];

    for (const [field, value, message] of invalidFields) {
        const response = await post("/inspection-json", {
            product: "Apple",
            status: "good",
            confidence: 0.95,
            [field]: value
        });

        assert.equal(response.status, 400);
        assert.match((await response.json()).message, message);
    }
});

test("يجب رفض التاريخ غير الصحيح وقبول timestamp بصيغة ISO", async () => {
    const invalidResponse = await post("/inspection-json", {
        product: "Apple",
        status: "good",
        confidence: 0.95,
        created_at: "not-a-date"
    });

    assert.equal(invalidResponse.status, 400);
    assert.match(
        (await invalidResponse.json()).message,
        /created_at must be a valid ISO 8601 timestamp/
    );

    const createdAt = "2025-01-02T03:04:05.000Z";
    const validResponse = await post("/inspection-json", {
        product: "Apple",
        status: "good",
        confidence: 0.95,
        created_at: createdAt
    });

    assert.equal(validResponse.status, 201);
    const data = await validResponse.json();
    const storedInspection = db.prepare(
        "SELECT created_at FROM inspections WHERE id = ?"
    ).get(data.inspectionId);
    assert.equal(storedInspection.created_at, createdAt);
});

test("يجب فتح Batch وإضافة فحص ثم إغلاقه", async () => {
    const openResponse = await post("/batches/open", {});
    assert.equal(openResponse.status, 201);

    const batch = await openResponse.json();

    const inspectionResponse = await post("/inspection-json", {
        product: "Banana",
        status: "good",
        confidence: 0.94,
        batch_id: batch.batchId
    });

    assert.equal(inspectionResponse.status, 201);

    const closeResponse = await post(
        `/batches/${batch.batchId}/close`,
        {}
    );

    assert.equal(closeResponse.status, 200);

    const rejectedResponse = await post("/inspection-json", {
        product: "Orange",
        status: "good",
        confidence: 0.9,
        batch_id: batch.batchId
    });

    assert.equal(rejectedResponse.status, 400);

    const missingBatchResponse = await post("/inspection-json", {
        product: "Apple",
        status: "good",
        confidence: 0.9,
        batch_id: 999999
    });
    assert.equal(missingBatchResponse.status, 400);
});

test("يجب حفظ مجموعة فحوصات Bulk", async () => {
    const response = await post("/inspections/batch", {
        inspections: [
            {
                product: "Peach",
                status: "good",
                confidence: 0.96
            },
            {
                product: "Grape",
                status: "defective",
                confidence: 0.6,
                needs_review: true
            }
        ]
    });

    assert.equal(response.status, 201);

    const data = await response.json();
    assert.equal(data.count, 2);
    assert.equal(data.inspectionIds.length, 2);
});

test("يجب فتح دفعة تلقائيًا وتجديدها بعد إغلاقها", async () => {
    const firstResponse = await post("/inspection-json", {
        product: "Apple",
        status: "good",
        confidence: 0.95
    });

    assert.equal(firstResponse.status, 201);
    const firstInspection = await firstResponse.json();
    assert.ok(firstInspection.batchId);

    const closeFirstResponse = await post(
        `/batches/${firstInspection.batchId}/close`,
        {}
    );
    assert.equal(closeFirstResponse.status, 200);

    const secondResponse = await post("/inspection-json", {
        product: "Apple",
        status: "good",
        confidence: 0.95
    });

    assert.equal(secondResponse.status, 201);
    const secondInspection = await secondResponse.json();
    assert.notEqual(secondInspection.batchId, firstInspection.batchId);

    const closeSecondResponse = await post(
        `/batches/${secondInspection.batchId}/close`,
        {}
    );
    assert.equal(closeSecondResponse.status, 200);
});

test("لا يتكرر تنبيه تجاوز 20% خلال عشر دقائق ولا يظهر قبل 50 فحصًا", async () => {
    const originalConfidenceThreshold = process.env.ALERT_THRESHOLD;
    const originalDefectThreshold = process.env.DEFECT_RATE_THRESHOLD;
    const originalMinimum = process.env.MIN_INSPECTIONS_FOR_DEFECT_RATE;
    process.env.ALERT_THRESHOLD = "0.8";
    process.env.DEFECT_RATE_THRESHOLD = "0.2";
    process.env.MIN_INSPECTIONS_FOR_DEFECT_RATE = "50";

    let batchId;
    try {
        const openResponse = await post("/batches/open", {});
        assert.equal(openResponse.status, 201);
        batchId = (await openResponse.json()).batchId;

        const first49Response = await post("/inspections/batch", {
            inspections: Array.from({ length: 49 }, (_, index) => ({
                product: "Apple",
                status: index >= 39 ? "defective" : "good",
                confidence: 0.95,
                needs_review: false
            }))
        });

        assert.equal(first49Response.status, 201);
        const first49 = await first49Response.json();
        assert.equal(first49.alerts.some((alert) => alert.alert), false);

        const crossingResponse = await post("/inspection-json", {
            product: "Apple",
            status: "defective",
            confidence: 0.95,
            needs_review: false,
            batch_id: batchId
        });

        assert.equal(crossingResponse.status, 201);
        const crossing = await crossingResponse.json();
        assert.equal(crossing.alert, true);
        assert.match(crossing.alertMessage, /Defective rate exceeded threshold/);

        const recoveryResponse = await post("/inspections/batch", {
            inspections: Array.from({ length: 5 }, (_, index) => ({
                product: "Apple",
                status: "good",
                confidence: 0.95,
                needs_review: false
            }))
        });
        assert.equal(recoveryResponse.status, 201);

        const repeatCrossingResponse = await post("/inspection-json", {
            product: "Apple",
            status: "defective",
            confidence: 0.95,
            needs_review: false,
            batch_id: batchId
        });

        assert.equal(repeatCrossingResponse.status, 201);
        const repeatCrossing = await repeatCrossingResponse.json();
        assert.equal(repeatCrossing.alert, false);
    } finally {
        if (batchId !== undefined) {
            const closeResponse = await post(`/batches/${batchId}/close`, {});
            assert.equal(closeResponse.status, 200);
        }

        if (originalConfidenceThreshold === undefined) {
            delete process.env.ALERT_THRESHOLD;
        } else {
            process.env.ALERT_THRESHOLD = originalConfidenceThreshold;
        }

        if (originalDefectThreshold === undefined) {
            delete process.env.DEFECT_RATE_THRESHOLD;
        } else {
            process.env.DEFECT_RATE_THRESHOLD = originalDefectThreshold;
        }

        if (originalMinimum === undefined) {
            delete process.env.MIN_INSPECTIONS_FOR_DEFECT_RATE;
        } else {
            process.env.MIN_INSPECTIONS_FOR_DEFECT_RATE = originalMinimum;
        }
    }
});

test("يجب رفض الحقول الاختيارية غير الصحيحة في مجموعة الفحوصات", async () => {
    const response = await post("/inspections/batch", {
        inspections: [
            {
                product: "Apple",
                status: "good",
                confidence: 0.95,
                size_category: 3
            }
        ]
    });

    assert.equal(response.status, 400);
    const data = await response.json();
    assert.match(data.message, /Inspection 1: size_category must be a string/);
});

test("يجب تحديد رقم العنصر غير الصحيح في طلب المجموعة", async () => {
    const response = await post("/inspections/batch", {
        inspections: [
            { product: "Apple", status: "good", confidence: 0.95 },
            { product: "Apple", status: "bad", confidence: 0.95 }
        ]
    });

    assert.equal(response.status, 400);
    assert.match((await response.json()).message, /Inspection 2/);
});

test("يجب قبول صورة JPEG سليمة", async () => {
    const image = await fs.readFile("./test.jpg.jpeg");

    const form = new FormData();
    form.append("product", "Tomato");
    form.append("status", "good");
    form.append("confidence", "0.95");
    form.append(
        "image",
        new Blob([image], { type: "image/jpeg" }),
        "test.jpg"
    );

    const response = await fetch(`${API}/inspection`, {
        method: "POST",
        body: form
    });

    assert.equal(response.status, 201);

    const data = await response.json();
    assert.ok(data.imageUrl);

    const imageResponse = await fetch(`${SERVER_URL}${data.imageUrl}`);
    assert.equal(imageResponse.status, 200);
    assert.match(imageResponse.headers.get("content-type"), /image\/jpeg/);
});

test("يجب قبول صورة PNG سليمة وعرضها من رابطها", async () => {
    const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lSQAAAAASUVORK5CYII=",
        "base64"
    );
    const form = new FormData();
    form.append("product", "Pepper");
    form.append("status", "good");
    form.append("confidence", "0.95");
    form.append("image", new Blob([png], { type: "image/png" }), "test.png");

    const response = await fetch(`${API}/inspection`, {
        method: "POST",
        body: form
    });

    assert.equal(response.status, 201);
    const data = await response.json();
    const imageResponse = await fetch(`${SERVER_URL}${data.imageUrl}`);
    assert.equal(imageResponse.status, 200);
    assert.match(imageResponse.headers.get("content-type"), /image\/png/);
});

test("يجب رفض صيغة صورة غير مسموحة", async () => {
    const form = new FormData();
    form.append("product", "Pepper");
    form.append("status", "good");
    form.append("confidence", "0.95");
    form.append("image", new Blob([Buffer.from("gif")], { type: "image/gif" }), "test.gif");

    const response = await fetch(`${API}/inspection`, {
        method: "POST",
        body: form
    });

    assert.equal(response.status, 400);
    assert.match((await response.json()).message, /Only JPG, PNG, and WEBP/);
});

test("يجب إرسال تنبيه عند تفعيل needs_review", async () => {
    const response = await post("/inspection-json", {
        product: "Apple",
        status: "good",
        confidence: 0.95,
        needs_review: true
    });

    assert.equal(response.status, 201);
    const data = await response.json();
    assert.equal(data.alert, true);
    assert.match(data.alertMessage, /Inspection needs review/);
});

test("يجب رفض قيمة needs_review غير الصحيحة في multipart وحذف الصورة", async () => {
    const beforeCount = (await fs.readdir(process.env.UPLOAD_DIR)).length;
    const image = await fs.readFile("./test.jpg.jpeg");
    const form = new FormData();
    form.append("product", "Tomato");
    form.append("status", "good");
    form.append("confidence", "0.95");
    form.append("needs_review", "maybe");
    form.append(
        "image",
        new Blob([image], { type: "image/jpeg" }),
        "test.jpg"
    );

    const response = await fetch(`${API}/inspection`, {
        method: "POST",
        body: form
    });

    assert.equal(response.status, 400);
    const data = await response.json();
    assert.match(data.message, /needs_review must be true or false/);
    assert.equal((await fs.readdir(process.env.UPLOAD_DIR)).length, beforeCount);
});

test("يجب حذف الصورة عند رفض بيانات الفحص", async () => {
    const beforeCount = (await fs.readdir(process.env.UPLOAD_DIR)).length;
    const image = await fs.readFile("./test.jpg.jpeg");

    const form = new FormData();
    form.append("product", "Tomato");
    form.append("status", "good");
    form.append("confidence", "1.5");
    form.append(
        "image",
        new Blob([image], { type: "image/jpeg" }),
        "test.jpg"
    );

    const response = await fetch(`${API}/inspection`, {
        method: "POST",
        body: form
    });

    assert.equal(response.status, 400);

    const data = await response.json();
    assert.match(data.message, /Confidence must be a number/);

    const afterCount = (await fs.readdir(process.env.UPLOAD_DIR)).length;
    assert.equal(afterCount, beforeCount);
});

test("يجب رفض ملف نصي متنكّر كصورة", async () => {
    const file = await fs.readFile("./package.json");

    const form = new FormData();
    form.append("product", "Tomato");
    form.append("status", "good");
    form.append("confidence", "0.95");
    form.append(
        "image",
        new Blob([file], { type: "image/jpeg" }),
        "fake.jpg"
    );

    const response = await fetch(`${API}/inspection`, {
        method: "POST",
        body: form
    });

    assert.equal(response.status, 400);

    const data = await response.json();
    assert.match(data.message, /Invalid image content/);
});

test("يجب رفض صورة أكبر من 5MB", async () => {
    const file = Buffer.alloc(5 * 1024 * 1024 + 1);

    const form = new FormData();
    form.append("product", "Tomato");
    form.append("status", "good");
    form.append("confidence", "0.95");
    form.append(
        "image",
        new Blob([file], { type: "image/jpeg" }),
        "large.jpg"
    );

    const response = await fetch(`${API}/inspection`, {
        method: "POST",
        body: form
    });

    assert.equal(response.status, 400);

    const data = await response.json();
    assert.match(data.message, /Maximum size is 5MB/);
});
