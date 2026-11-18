require("dotenv").config();

const API_URL = process.env.API_URL || "http://localhost:3000/api/ingest";
const productTypes = ["Tomato", "Orange", "Apple", "Banana", "Grape"];
const sizeCategories = ["small", "medium", "large"];

function getSimulationConfig() {
    const minimumInspections = Number(
        process.env.MIN_INSPECTIONS_FOR_DEFECT_RATE || 50
    );
    const defectRateThreshold = Number(
        process.env.DEFECT_RATE_THRESHOLD || 0.2
    );

    if (!Number.isInteger(minimumInspections) || minimumInspections < 1) {
        throw new Error(
            "MIN_INSPECTIONS_FOR_DEFECT_RATE must be a positive integer"
        );
    }

    if (
        !Number.isFinite(defectRateThreshold) ||
        defectRateThreshold < 0 ||
        defectRateThreshold > 1
    ) {
        throw new Error("DEFECT_RATE_THRESHOLD must be a number between 0 and 1");
    }

    return {
        minimumInspections,
        defectCount: Math.min(
            minimumInspections,
            Math.floor(minimumInspections * defectRateThreshold) + 1
        )
    };
}

async function postJson(path, body) {
    const response = await fetch(`${API_URL}${path}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    });
    const result = await response.json();

    if (!response.ok) {
        throw new Error(result.message || `Request failed with status ${response.status}`);
    }

    return result;
}

async function simulateCV() {
    const { minimumInspections, defectCount } = getSimulationConfig();
    const batch = await postJson("/batches/open", {});

    console.log(
        `Simulating ${minimumInspections} inspections in batch ${batch.batchId} ` +
        `(${defectCount} defective)...`
    );

    try {
        for (let index = 0; index < minimumInspections; index += 1) {
            const defective = index >= minimumInspections - defectCount;
            const inspection = {
                product: productTypes[index % productTypes.length],
                status: defective ? "defective" : "good",
                confidence: defective ? 0.65 : 0.95,
                size_category: sizeCategories[index % sizeCategories.length],
                needs_review: defective,
                model_version: "freshguard-cv-v1",
                batch_id: batch.batchId
            };
            const result = await postJson("/inspection-json", inspection);
            const alertText = result.alert
                ? ` - ALERT: ${result.alertMessage}`
                : "";

            console.log(
                `${index + 1}/${minimumInspections}: ${inspection.product} ` +
                `(${inspection.status})${alertText}`
            );
        }
    } finally {
        await postJson(`/batches/${batch.batchId}/close`, {});
    }

    console.log("CV simulation finished.");
}

simulateCV().catch((error) => {
    console.error("CV simulation failed:", error.message);
    process.exitCode = 1;
});
