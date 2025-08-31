# Bulk Admin Tools

This folder contains local CLI utilities to manage phone numbers (unblock, whitelist add/remove) via your deployed Vercel API routes.

These scripts let you:

-   **Unblock** numbers (clear blocklist, throttles, burst keys).
-   **Add to whitelist**.
-   **Remove from whitelist**.
-   Run on a **single number**, a **list in a file**, or from **stdin**.
-   Batch process with concurrency, retries, and optional strict phone validation.

---

## 📦 Setup

1. Navigate into `tools/` and initialize:

    ```bash
    cd tools
    npm init -y
    ```

2. Edit `tools/package.json`:

    ```json
    {
        "name": "tools",
        "version": "1.0.0",
        "type": "module",
        "private": true
    }
    ```

    The `"type": "module"` ensures you can use `import` syntax.

3. Make sure you have a **single `.env` in your root** with:

    ```bash
    ADMIN_BASE_URL="https://your-app.vercel.app"
    ADMIN_TOKEN="your-secret-admin-token"
    ```

    - `ADMIN_BASE_URL`: the base URL of your deployed Vercel app (no trailing slash).
    - `ADMIN_TOKEN`: must match the `ADMIN_UNBLOCK_TOKEN` env you use in your API routes.

4. Place `bulk-admin.mjs` inside `tools/`.

---

## 🚀 Usage

Run with Node:

```bash
node tools/bulk-admin.mjs <command> [numbers...] [options]
```

### Commands

-   `unblock` → calls `/api/admin/unblock`
-   `whitelist-add` → calls `/api/admin/whitelist-add`
-   `whitelist-remove` → calls `/api/admin/whitelist-remove`

---

### 1. Single Numbers

```bash
node tools/bulk-admin.mjs unblock +12135551234
node tools/bulk-admin.mjs whitelist-add +12135551234
node tools/bulk-admin.mjs whitelist-remove +12135551234
```

---

### 2. From a File

File (`phones.txt`):

```
# comments are ignored
+12135551234
+16175559876, +18185550123
// staging
+14155550123
```

Run:

```bash
node tools/bulk-admin.mjs whitelist-add --file phones.txt
```

---

### 3. From stdin (pipe)

```bash
cat phones.csv | node tools/bulk-admin.mjs unblock --stdin
```

---

## ⚙️ Options

-   `--file <path>`
    Load numbers from a file (newline, comma, tab, or semicolon separated).

-   `--stdin`
    Read numbers from stdin (useful with pipes).

-   `--strict`
    Require numbers in strict E.164 US format (`+1XXXXXXXXXX`).
    If omitted, non-strict inputs are passed through and the API may normalize them (only for `unblock`).

-   `--concurrency=N`
    Number of requests to run in parallel. Default: 5.
    Example: `--concurrency=20`

-   `--dry-run`
    Parse & validate numbers only, don’t call the API.
    Useful to sanity check your input files.

---

## 🔁 Retries

Each number will retry up to **3 times** with a small backoff if the request fails.

---

## 💡 Examples

### Unblock one-off number

```bash
ADMIN_BASE_URL=... ADMIN_TOKEN=... \
node tools/bulk-admin.mjs unblock +12135551234
```

### Add many to whitelist with concurrency

```bash
node tools/bulk-admin.mjs whitelist-add --file phones.txt --strict --concurrency=15
```

### Remove using pipe

```bash
cat remove-list.txt | node tools/bulk-admin.mjs whitelist-remove --stdin --strict
```

### Validate only (no API calls)

```bash
node tools/bulk-admin.mjs unblock --file phones.txt --strict --dry-run
```

---

## 🔒 Notes

-   These scripts **call your deployed API endpoints** — they do not connect directly to Redis.
-   Keep your `ADMIN_TOKEN` secret. Anyone with it can manage your block/whitelist.
-   For huge batches, increase `--concurrency` carefully (Vercel + Upstash have rate limits).
-   Recommended: **use `--strict`** for whitelist operations to avoid accidental misformats.
