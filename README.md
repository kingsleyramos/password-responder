# SMS Password Responder

A tiny serverless webhook that auto-replies to incoming SMS with your wedding website (or for anything) password **only for whitelisted guests**. Unknown numbers get a polite fallback. Includes spam/cost controls and opt-out handling.

- **Runtime**: Vercel Serverless (Node.js)
- **SMS**: Twilio (US/CA)
- **Database**: Upstash Redis (free tier)
- **Features**:
  - Whitelist check (managed in Redis)
  - Optional keyword gate (e.g., require texting “PASSWORD”)
  - STOP/HELP compliance
  - Rate limits for **unknown** numbers only (cooldown, per-day cap, global cap)
  - Minimal cost: most traffic generates **no charge** unless you reply

---

## Architecture

```

Guest phone ──► Twilio Number ──► Webhook (Vercel /api/sms)
│
└──► Upstash Redis (whitelist + rate-limit counters)

```

---

## 1) Prerequisites

- Twilio account + a phone number capable of SMS
- Vercel account (Hobby/free)
- Upstash Redis database (free)
- Node.js 18+ locally (for setup/testing)

---

## 2) Quick Start (Deployment First)

1. **Fork/clone** this repo to your GitHub.
2. **Create** an Upstash Redis DB → note your **REST URL** and **REST TOKEN**.
3. **Deploy to Vercel** (Import GitHub repo).
4. In **Vercel → Project → Settings → Environment Variables**, add:

```

UPSTASH\_REDIS\_REST\_URL=...        # from Upstash
UPSTASH\_REDIS\_REST\_TOKEN=...      # from Upstash
SITE\_PASSWORD=YourWeddingPassword
REQUIRE\_KEYWORD=PASSWORD          # optional; delete to disable
MIN\_REPLY\_COOLDOWN\_MIN=3          # unknown numbers only
MAX\_PER\_NUMBER\_PER\_DAY=3          # unknown numbers only
GLOBAL\_MAX\_PER\_DAY=2000           # applies to unknowns; can extend to all if desired

````

5. **Seed whitelist** in Upstash Console:
```bash
SADD whitelist +15551234567 +15557654321
````

(Use **E.164** format, e.g., `+1xxxxxxxxxx`.)

6. In **Twilio Console → Phone Numbers → Your Number → Messaging**:

   * **A MESSAGE COMES IN** → **Webhook** (POST) →
     `https://<your-vercel-app>.vercel.app/api/sms`
   * **Content Type**: `application/x-www-form-urlencoded`
   * (Optional) Enable **Advanced Opt-Out**.

7. **Test**: text from a whitelisted number (and from a non-whitelisted number).

---

## 3) Local Development (Optional)

If you want to run locally before deploying:

```bash
git clone <your-fork>
cd <repo>
npm install
```

Create `.env` (don’t commit it):

```bash
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
SITE_PASSWORD=YourWeddingPassword
REQUIRE_KEYWORD=PASSWORD
MIN_REPLY_COOLDOWN_MIN=3
MAX_PER_NUMBER_PER_DAY=3
GLOBAL_MAX_PER_DAY=2000
```

> For Vercel serverless routes, local “serve” isn’t required. If you want to test with Twilio live, use an Express dev server + `ngrok` or deploy and test on Vercel directly.

---

## 4) Files

```
api/
  sms.js          # webhook handler
package.json
(vercel.json)     # optional, to pin runtime
```

* **api/sms.js** (highlights):

  * Parses Twilio’s `x-www-form-urlencoded` body
  * Handles `STOP` and `HELP`
  * Optional `REQUIRE_KEYWORD` gate
  * Checks **whitelist first** → whitelisted numbers always get the password (no throttle)
  * Unknown numbers hit cooldown + per-day + global caps
  * Stores counters in Redis with 2-day expirations

---

## 5) Environment Variables

| Name                       | Required | Default    | Notes                                                                      |
| -------------------------- | -------- | ---------- | -------------------------------------------------------------------------- |
| `UPSTASH_REDIS_REST_URL`   | Yes      | —          | From Upstash console                                                       |
| `UPSTASH_REDIS_REST_TOKEN` | Yes      | —          | From Upstash console                                                       |
| `SITE_PASSWORD`            | Yes      | `PASSWORD` | What you want to send to guests                                            |
| `REQUIRE_KEYWORD`          | No       | *(empty)*  | If set (e.g. `PASSWORD`), only messages containing that word are processed |
| `MIN_REPLY_COOLDOWN_MIN`   | No       | `3`        | Per-number cooldown for **unknown** numbers                                |
| `MAX_PER_NUMBER_PER_DAY`   | No       | `3`        | Per-number daily cap for **unknown** numbers                               |
| `GLOBAL_MAX_PER_DAY`       | No       | `2000`     | Global daily cap across replies to **unknowns** (can be extended to all)   |

> If you want the global cap to apply to whitelisted guests too, there’s a commented snippet in `api/sms.js` you can enable.

---

## 6) Managing the Whitelist

Use the Upstash Console:

```bash
# Add guests
SADD whitelist +15551234567 +15557654321

# Remove a guest
SREM whitelist +15551234567

# Check membership
SISMEMBER whitelist +15551234567

# List all (debug; for large sets use SCAN)
SMEMBERS whitelist
```

All changes take effect immediately—no redeploy needed.

---

## 7) Compliance & Consent

Carriers require clear consent for A2P messaging:

* Display a one-liner wherever you share the number (your website, invite):

  > “Text **PASSWORD** to (###) ###-#### to receive our wedding website password. By texting, you consent to an automated SMS reply. Msg & data rates may apply. Reply STOP to opt out.”

* You already handle **STOP/HELP** in code.

* Keep a screenshot of where this disclosure appears (proof of consent).

---

## 8) Costs

* Twilio number: \~**\$1/mo**
* SMS: \~**\$0.0075–\$0.01** per message (inbound/outbound, US)
* Vercel Hobby: **\$0**
* Upstash Redis: **\$0** (free tier)
* With a few hundred guests, total spend is typically **under \$10**.

---

## 9) Troubleshooting

* **No reply received**

  * Twilio Console → **Monitor → Logs → Messaging** to view webhook status/errors.
  * Verify webhook URL, **POST**, and content type is `application/x-www-form-urlencoded`.
  * Ensure env vars are set in Vercel and you redeployed.

* **Message says “keyword required” behavior**

  * If `REQUIRE_KEYWORD` is set (e.g., `PASSWORD`), your text must contain that word. Remove or clear the env var to disable.

* **Rate limits hit too often**

  * Increase `MIN_REPLY_COOLDOWN_MIN` or `MAX_PER_NUMBER_PER_DAY` (unknowns only).
  * Raise or lower `GLOBAL_MAX_PER_DAY` as needed.

* **Twilio wants “proof of consent”**

  * Add the disclosure text to your site/invite.
  * Keep STOP/HELP logic.
  * Describe your opt-in collection in Twilio’s form (guests initiate by texting).

* **Calls to the number**

  * In **Twilio → Phone Numbers → Voice**, set “A CALL COMES IN” to a TwiML Bin with `<Hangup/>` or attach no action. Or purchase an SMS-only number.

---

## 10) Security (Optional)

* **Signature Validation**: You can validate `X-Twilio-Signature` with your Twilio **Auth Token** to ensure only Twilio hits your webhook. This requires a fixed public URL; add later if needed.

---

## 11) FAQ

**Q: Can I keep my guest list in Google Sheets?**
A: Yes. This build uses Redis for speed/simplicity, but you could fetch from Sheets on each request or on a timer and mirror into Redis.

**Q: Can whitelisted guests bypass the keyword gate?**
A: Currently, the keyword gate applies to everyone. Move that check into the “unknown” branch if you want guests to bypass it.

**Q: Can I silence unknown numbers (no reply at all)?**
A: Yes. Replace the fallback reply with `return res.status(204).end();` to avoid any outbound SMS cost for unknowns.

---

### Credits

Built with ❤️ for a stress-free, low-cost wedding password flow.
