# Bulk Admin CLI

Local CLI tool for managing phone numbers (unblock, whitelist add/remove) via your deployed Vercel API routes.  
Supports single numbers or bulk from a file. All numbers are automatically normalized into **E.164 US format** (`+1XXXXXXXXXX`).

---

## 📦 Setup

1. **Install dependencies** (once at project root):

    ```bash
    npm install dotenv
    ```

2. **Create a `.env` in the root of your project** (next to `package.json`):

    ```bash
    ADMIN_BASE_URL="https://your-app.vercel.app"
    ADMIN_TOKEN="your-secret-admin-token"
    ```

    - `ADMIN_BASE_URL`: base URL of your deployed Vercel app (no trailing slash).
    - `ADMIN_TOKEN`: same secret your API routes check (`ADMIN_UNBLOCK_TOKEN` in Vercel).

3. Place the script in `tools/bulk-admin.mjs`.
   It will automatically load the root `.env`.

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

### 1. Single / Multiple Numbers

```bash
node tools/bulk-admin.mjs unblock 619-555-1234
node tools/bulk-admin.mjs whitelist-add 6195551234 +16195559876
node tools/bulk-admin.mjs whitelist-remove (619)555-6789
```

All formats like `6195551234`, `619-555-1234`, `(619) 555-6789`, or `+16195551234` are normalized to `+16195551234`.

---

### 2. From a File

File (`phones.txt`):

```
# comments ignored
6195551234
(619) 555-6789
+16195559876, +14155550123
// staging
619.555.8888
```

Run:

```bash
node tools/bulk-admin.mjs whitelist-add --file phones.txt
```

---

## ⚙️ Options

-   `--file <path>`
    Load numbers from a file (newline, comma, tab, or semicolon separated).
    Lines starting with `#` or `//` are ignored.

-   `--concurrency=N`
    Number of requests to run in parallel. Default: 5.
    Example: `--concurrency=15`

-   `--dry-run`
    Print normalized numbers only; no API calls.

---

## 🔁 Retries

Each number will retry up to **3 times** with exponential backoff if the request fails.

---

## 💡 Examples

### Unblock one number

```bash
node tools/bulk-admin.mjs unblock 619-555-1234
```

### Add many to whitelist from a file

```bash
node tools/bulk-admin.mjs whitelist-add --file phones.txt --concurrency=15
```

### Remove numbers and preview normalization only

```bash
node tools/bulk-admin.mjs whitelist-remove --file phones.txt --dry-run
```

---

## 🔒 Notes

-   This CLI calls your **deployed API endpoints** — it does not connect directly to Redis.
-   Keep your `ADMIN_TOKEN` secret. Anyone with it can manage your blocklist/whitelist.
-   Your server API routes strictly validate `+1XXXXXXXXXX`. The CLI auto-normalizes user-friendly formats before sending.
