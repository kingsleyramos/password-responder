# 📱 Wedding Password Auto Responder

A lightweight SMS auto-responder built with **Twilio**, **Vercel Serverless Functions**, and **Upstash Redis**.  
Guests text your wedding number to receive the website password.

-   ✅ Whitelisted numbers always get the password
-   ✅ Unknown numbers get fallback reply (with cooldowns & caps)
-   ✅ STOP/START/HELP compliance built-in
-   ✅ Spam/abuse protection + permanent blocklist
-   ✅ Admin tools to unblock numbers via script or URL

---

## 🚀 Features

-   **Node.js + Vercel**: serverless deployment (cheap/free for low traffic).
-   **Twilio SMS Webhook**: connects to your Twilio number.
-   **Redis (Upstash)**: stores whitelist, opt-outs, throttles, and blocklist.
-   **Throttling**: per-number daily cap, per-number cooldown, global/day cap.
-   **Abuse Guards**:
    -   Block non-US numbers
    -   Burst detection (too many messages in a short window)
    -   Global flood breaker
    -   Content sanity (URLs, >160 chars)
-   **Admin Tools**:
    -   Local unblock script (`scripts/unblock.mjs`)
    -   Admin API (`/api/admin/unblock`) with token auth

---

## 🛠 Setup

### 1. Twilio

-   Buy a local or toll-free number in [Twilio Console](https://console.twilio.com/).
-   In **Messaging → Webhook**, set:

```
https\://<your-vercel-app>.vercel.app/api/sms
```

### 2. Vercel

-   Deploy this repo to Vercel.
-   Add Environment Variables (Project → Settings → Environment Variables):

| Name                       | Required | Example                |
| -------------------------- | -------- | ---------------------- |
| `UPSTASH_REDIS_REST_URL`   | ✅       | (from Upstash console) |
| `UPSTASH_REDIS_REST_TOKEN` | ✅       | (from Upstash console) |
| `SITE_PASSWORD`            | ✅       | MyWedding2026          |
| `REQUIRED_TEXT_KEYWORD`    | Optional | PASSWORD               |
| `HELP_MESSAGE`             | Optional | Custom HELP text       |
| `MIN_REPLY_COOLDOWN_MIN`   | Optional | 3                      |
| `MAX_PER_NUMBER_PER_DAY`   | Optional | 3                      |
| `GLOBAL_MAX_PER_DAY`       | Optional | 2000                   |
| `ADMIN_UNBLOCK_TOKEN`      | ✅       | random-secret-string   |

### 3. Redis (Upstash)

-   Create a free Redis DB at [Upstash](https://upstash.com/).
-   Add **guest numbers** to the whitelist:

```bash
# Add
redis-cli SADD whitelist +15551234567 +15559876543

# Remove
redis-cli SREM whitelist +15559876543
```

---

## 📂 Project Structure

```
api/
  sms.js                # Twilio webhook (main logic)
  admin/unblock.js      # Admin API endpoint for unblocking

lib/
  config.js             # Centralized config + constants
  redis.js              # Redis client
  utils.js              # helpers (form parser, dayKey)
  optout.js             # STOP/START logic
  abuse.js              # Abuse guards + blocklist
  throttle.js           # Per-number throttling

scripts/
  unblock.mjs           # CLI script to unblock a number
```

---

## 🔐 Opt-Out / Compliance

-   **STOP** → number added to `optout` + Twilio carrier-level block
-   **START/UNSTOP/YES** → clears opt-out
-   **HELP** → returns custom HELP message
-   If a number is opted-out at carrier level, they **must** text `START` to re-enable delivery.

---

## 🔒 Abuse Protection

-   **Non-US filter**: only accepts `+1XXXXXXXXXX`.
-   **Burst guard**: >5 messages in 60s → permanently blocked.
-   **Flood guard**: >20 unknown messages in 5 minutes → triggers defensive mode.
-   **Content sanity**: URLs or >160 chars → suspicious, repeat offenders permanently blocked.
-   **Permanent blocklist**: stored in `abuse:index`.

---

## 🔧 Admin Tools

### Local unblock script

```bash
node scripts/unblock.mjs 555-123-4567
```

-   Normalizes input (`5551234567`, `(555) 123-4567`, `+15551234567` → all accepted).
-   Removes from blocklist, clears counters.

### Admin API

```bash
GET https://<your-app>.vercel.app/api/admin/unblock?phone=5551234567&token=YOUR_TOKEN
```

-   Requires `ADMIN_UNBLOCK_TOKEN` env var.
-   Normalizes phone input.
-   Logs all actions to Vercel.
-   Returns JSON result:

```json
{
    "ok": true,
    "phone": "+15551234567",
    "removedFromBlocklist": true,
    "burstDeleted": 1,
    "note": "If the user texted STOP, carriers still require START."
}
```

**Tip:** Prefer POST to keep token out of logs:

```bash
curl -X POST "https://<your-app>.vercel.app/api/admin/unblock" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "phone=5551234567" \
  --data-urlencode "token=YOUR_TOKEN"
```

---

## 📝 Development

Run locally with Vercel dev:

```bash
vercel dev
```

Test SMS locally with cURL (simulating Twilio):

```bash
curl -X POST "http://localhost:3000/api/sms" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "From=+15551234567" \
  --data-urlencode "Body=PASSWORD"
```

---

## 💡 Notes

-   Redis keys auto-expire, keeping storage lean.
-   Blocklist (`abuse:index`) persists until you explicitly remove numbers.
-   Even if you unblock a number, if they texted STOP to Twilio, carriers still require `START`.
-   Rotate your `ADMIN_UNBLOCK_TOKEN` after the event (e.g., after the wedding).

---

## 🎉 Use Case

This setup was designed for a wedding website:
Guests text a number → receive password → easy, fun, compliant, and spam-resistant.
