"# FreshGuard AI Backend

## Setup

```powershell
npm ci
Copy-Item .env.example .env
npm start
```

The API listens on `http://localhost:3000`.

## Ingest tests

```powershell
npm run test:ingest
```

The ingest test suite uses a temporary SQLite database and upload directory, then removes both when it finishes. It does not read or modify `freshguard.db`.

## CV simulation

With the API running in another terminal:

```powershell
npm run simulate:cv
```

`DEFECT_RATE_THRESHOLD` controls the defective-rate alert (default `0.2`), and `MIN_INSPECTIONS_FOR_DEFECT_RATE` controls its minimum sample size (default `50`). `ALERT_THRESHOLD` controls confidence alerts (default `0.8`)."

## Ingest data contract

`product` is checked against `ALLOWED_PRODUCTS` (default: apple, banana, grape, orange, peach, pepper, tomato). `created_at` may be supplied as an ISO 8601 timestamp; otherwise SQLite assigns the current time. `line_id` is optional and must be a positive integer; the database adds this nullable column without renaming existing fields."
