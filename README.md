# Chat AI Portfolio — Backend (BE)

Backend ของเว็บ **"ยังไม่ได้นอน | Pixel Hero Quest"** — แชตบอทที่ตอบคำถามเกี่ยวกับโปรไฟล์ทีมและผลงานของสมาชิก
โดยดึงข้อมูลจากฐานข้อมูล Supabase (PostgreSQL) แล้วส่งให้ Google Gemini ช่วยเรียบเรียงคำตอบ

> Frontend อยู่ที่ repo: <https://github.com/patsachaisawa/chat-ai-portfolio-fe>

| ส่วน | Deploy ที่ | URL ตัวอย่าง |
| --- | --- | --- |
| Frontend (React + Vite) | Vercel | `https://chat-ai-portfolio-fe.vercel.app` |
| **Backend (repo นี้)** | **Render** (Web Service, แผนฟรี) | `https://chat-ai-portfolio-be-pubg.onrender.com` |
| ฐานข้อมูล | Supabase (PostgreSQL) | — |
| AI | Google Gemini API | — |

---

## สารบัญ

1. [ภาพรวมการทำงาน](#ภาพรวมการทำงาน)
2. [เทคโนโลยีที่ใช้](#เทคโนโลยีที่ใช้)
3. [โครงสร้างโปรเจกต์](#โครงสร้างโปรเจกต์)
4. [เริ่มต้นใช้งานในเครื่อง](#เริ่มต้นใช้งานในเครื่อง)
5. [Environment Variables](#environment-variables)
6. [ฐานข้อมูล](#ฐานข้อมูล)
7. [API Reference](#api-reference)
8. [กลไกการเรียก Gemini (retry / fallback / โควตา)](#กลไกการเรียก-gemini)
9. [CORS](#cors)
10. [Deploy บน Render](#deploy-บน-render)
11. [แก้ปัญหาที่พบบ่อย](#แก้ปัญหาที่พบบ่อย)
12. [CI](#ci)

---

## ภาพรวมการทำงาน

```
ผู้ใช้ ──► Frontend (Vercel) ──POST /api/chat──► Backend (Render)
                                                   │
                       ┌───────────────────────────┼──────────────────────────┐
                       ▼                           ▼                          ▼
              Supabase: team_info,        Supabase: chat_sessions,     Gemini API
              team_members,               chat_messages               (สร้างคำตอบ)
              team_projects               (ประวัติแชต)
```

เมื่อได้รับข้อความใน `POST /api/chat`:

1. ตรวจว่า `sessionId` และ `message` ครบ และตั้งค่า env จำเป็นไว้แล้ว
2. บันทึกข้อความผู้ใช้ลง `chat_messages` (สร้างแถวใน `chat_sessions` ถ้ายังไม่มี)
3. ดึงข้อมูลทีม สมาชิก และโปรเจกต์ทั้งหมดจากฐานข้อมูลมารวมเป็น "บริบท" ให้ AI
4. ดึงประวัติแชตล่าสุด 6 ข้อความของ session นั้น
5. เรียก Gemini (มี retry, โมเดลสำรอง และงบเวลารวม) แล้วบันทึกคำตอบลงฐานข้อมูล
6. ตอบกลับ `{ "reply": "..." }`

AI ถูกสั่งให้ตอบจากข้อมูลในฐานข้อมูลเท่านั้น ดังนั้น **ถ้าข้อมูลสมาชิกไม่อยู่ในฐานข้อมูล AI จะตอบเรื่องนั้นไม่ได้**

---

## เทคโนโลยีที่ใช้

- **Node.js ≥ 22** + **TypeScript**
- **Express 5** (REST API) + **cors**
- **pg** (node-postgres) เชื่อม Supabase PostgreSQL
- **@google/generative-ai** (Gemini)
- **dotenv**, **tsx** (รันตอนพัฒนา)

---

## โครงสร้างโปรเจกต์

```
.
├── src/
│   ├── app.ts                    # จุดเริ่มต้น: CORS, health check, routes, 404/error handler
│   ├── config/
│   │   └── database.ts           # Connection pool ของ PostgreSQL (เปิด SSL เมื่อไม่ใช่ localhost)
│   ├── routes/
│   │   └── chatRoutes.ts         # POST /api/chat, GET /api/quota
│   ├── controllers/
│   │   └── chatController.ts     # ตรรกะแชต + เรียก Gemini (retry/fallback/timeout)
│   └── services/
│       └── quota.ts              # ประมาณโควตา Gemini ที่เหลือวันนี้
├── .env.example                  # ตัวอย่างไฟล์ตั้งค่า
├── tsconfig.json
└── package.json
```

---

## เริ่มต้นใช้งานในเครื่อง

### สิ่งที่ต้องมี

- Node.js 22 ขึ้นไป (`node -v`)
- บัญชี [Supabase](https://supabase.com) และ connection string ของฐานข้อมูล
- API key จาก [Google AI Studio](https://aistudio.google.com/apikey)

### ขั้นตอน

```bash
# 1) clone
git clone https://github.com/patsachaisawa/chat-ai-portfolio-be.git
cd chat-ai-portfolio-be

# 2) ติดตั้ง dependencies
npm install

# 3) สร้างไฟล์ .env จากตัวอย่าง แล้วแก้ค่าให้ถูกต้อง
cp .env.example .env

# 4) รันโหมดพัฒนา (รีสตาร์ตอัตโนมัติเมื่อแก้โค้ด)
npm run dev
```

เซิร์ฟเวอร์จะรันที่ <http://localhost:5000> ลองเปิด <http://localhost:5000/api/health> ควรเห็น
`{"status":"ok","env":{"GEMINI_API_KEY":true,"DATABASE_URL":true}}`

### สคริปต์ที่ใช้ได้

| คำสั่ง | ทำอะไร |
| --- | --- |
| `npm run dev` | รันโหมดพัฒนาด้วย `tsx watch` |
| `npm run build` | คอมไพล์ TypeScript ไปที่ `dist/` |
| `npm start` | รันโค้ดที่คอมไพล์แล้ว (`node dist/app.js`) — ใช้บน Render |
| `npm run check` | ตรวจชนิดข้อมูล (`tsc --noEmit`) โดยไม่สร้างไฟล์ |

> หมายเหตุ: ใน `package.json` มีสคริปต์ `test` และ `seed` แต่ไฟล์ที่เกี่ยวข้อง (`src/*.test.ts`, `src/seed.ts`)
> ยังไม่อยู่ใน repo ตอนนี้ จึงยังรันสองคำสั่งนี้ไม่ได้

---

## Environment Variables

| ตัวแปร | บังคับ | ค่าเริ่มต้น | คำอธิบาย |
| --- | :---: | --- | --- |
| `GEMINI_API_KEY` | ✅ | — | API key จาก Google AI Studio |
| `DATABASE_URL` | ✅ | — | connection string ของ Supabase (ดูหมายเหตุด้านล่าง) |
| `PORT` | | `5000` | พอร์ต (Render ตั้งให้เอง ไม่ต้องใส่) |
| `CORS_ORIGINS` | | ว่าง | origin เพิ่มเติมที่อนุญาต คั่นด้วย `,` เช่น `https://my-domain.com` |
| `GEMINI_MODEL` | | `gemini-3.6-flash` | โมเดลหลัก ต้องเป็นชื่อที่มีใน Google AI Studio ของบัญชีคุณ |
| `GEMINI_FALLBACK_MODELS` | | `gemini-3.8-flash` | โมเดลสำรอง คั่นด้วย `,` ใช้เมื่อโมเดลหลักติดขัด (เช่น 503) |
| `GEMINI_DAILY_LIMIT` | | `500` | โควตาคำขอต่อวันของโมเดลหลัก ใช้คำนวณแถบ ENERGY ฝั่งหน้าเว็บ ให้ตรงกับ Rate Limit ใน AI Studio |

### เรื่อง `DATABASE_URL` ของ Supabase

ต้องใช้ **Session pooler** (พอร์ต 5432 โฮสต์รูปแบบ `...pooler.supabase.com`) ไม่ใช่ Direct connection
เพราะ Render แผนฟรีไม่รองรับ IPv6 ถ้าใช้ Direct connection จะเจอ error `ENETUNREACH`

```
postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

### ข้อควรระวัง

- **ห้าม commit ไฟล์ `.env`** (อยู่ใน `.gitignore` แล้ว) และห้ามเอา API key ไปวางในแชตหรือโค้ด
- **ไม่ต้องตั้ง `NODE_ENV=production` บน Render** — ถ้าตั้ง Render จะไม่ติดตั้ง devDependencies (เช่น TypeScript) ทำให้ build ล้มเหลว

---

## ฐานข้อมูล

Backend ใช้ 5 ตาราง ใน Supabase (PostgreSQL):

| ตาราง | ใช้ทำอะไร |
| --- | --- |
| `team_info` | ข้อมูลทีม (อ่านแถวแรก) |
| `team_members` | ข้อมูลสมาชิกแต่ละคน |
| `team_projects` | โปรเจกต์ของทีม |
| `chat_sessions` | รายการ session แชต (`session_id`) |
| `chat_messages` | ประวัติข้อความ (`session_id`, `sender`, `message`, `created_at`) |

ข้อมูลในตาราง `team_*` ถูกอ่านด้วย `SELECT *` แล้วส่งให้ AI ทั้งก้อน — **ชื่อคอลัมน์ในตารางเหล่านี้เป็นอิสระ**
แต่ควรตั้งชื่อให้สื่อความหมาย (เช่น `name`, `nickname`, `skills`, `projects`) เพื่อให้ AI เข้าใจ
เมื่อต้องการเพิ่มหรือแก้ข้อมูลสมาชิก ให้แก้ที่ตารางเหล่านี้ใน Supabase ได้เลย ไม่ต้อง deploy ใหม่

ตัวอย่างโครงสร้างของตารางประวัติแชต (ตรวจกับของจริงใน Supabase ของคุณอีกครั้ง):

```sql
CREATE TABLE IF NOT EXISTS chat_sessions (
  session_id TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id         BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(session_id),
  sender     TEXT NOT NULL,            -- 'user' หรือ 'assistant'
  message    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## API Reference

Base URL: `http://localhost:5000` (ในเครื่อง) หรือ URL ของ Render (production)

### `GET /` และ `GET /api/health`

ตรวจสถานะเซิร์ฟเวอร์ (ใช้เป็น Health Check Path บน Render และใช้ปลุกเซิร์ฟเวอร์ที่หลับอยู่)

```json
{ "status": "ok", "env": { "GEMINI_API_KEY": true, "DATABASE_URL": true } }
```

`env` บอกเพียงว่า "ตั้งค่าไว้หรือยัง" (true/false) ไม่เปิดเผยค่าจริง ถ้ามีค่าเป็น `false` แปลว่าลืมตั้ง env

### `POST /api/chat`

ส่งข้อความหา AI

**Request body**

```json
{ "sessionId": "session_abc123", "message": "คุณภัทษชัยมีทักษะด้านไหนบ้าง?" }
```

**Response**

| สถานะ | ความหมาย | ตัวอย่าง body |
| --- | --- | --- |
| `200` | สำเร็จ | `{ "reply": "..." }` |
| `400` | ไม่ได้ส่ง `sessionId` หรือ `message` | `{ "error": "sessionId and message are required" }` |
| `429` | โควตา Gemini ของวันนี้หมด | `{ "error": "..." }` (ข้อความภาษาไทย) |
| `500` | ตั้งค่า env ไม่ครบ หรือเกิดข้อผิดพลาดภายใน | `{ "error": "Server misconfigured: missing ..." }` |
| `503` | Gemini ไม่ว่าง (high demand) หรือตอบช้าเกินกำหนด | `{ "error": "..." }` |

ทดลองด้วย curl:

```bash
curl -X POST http://localhost:5000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"test1","message":"สวัสดี"}'
```

### `GET /api/quota`

ประมาณโควตา Gemini ที่เหลือวันนี้ ใช้แสดงแถบ ENERGY บนหน้าเว็บ

```json
{
  "model": "gemini-3.6-flash",
  "used": 11,
  "limit": 500,
  "remaining": 489,
  "resetsInSeconds": 57600,
  "exhausted": false,
  "estimated": true
}
```

⚠️ **เป็นค่าประมาณ ไม่ใช่ตัวเลขทางการจาก Google** คำนวณจาก (ค่าที่มากกว่าระหว่าง) จำนวนคำขอที่ระบบนับได้ในหน่วยความจำ
กับจำนวนคำตอบของ AI ที่บันทึกในฐานข้อมูลของ "วันนี้" ตามเวลา Pacific (America/Los_Angeles) ซึ่งเป็นรอบที่ Google รีเซ็ตโควตา (เที่ยงคืนเวลา Pacific)
ตัวนับในหน่วยความจำจะรีเซ็ตเมื่อเซิร์ฟเวอร์รีสตาร์ต และถ้าโมเดลหลักตอบ 429 ระบบจะถือว่าโควตาหมดทันที

---

## กลไกการเรียก Gemini

Gemini แผนฟรีมีข้อจำกัดทั้งโควตาต่อวันและช่วงที่ผู้ใช้หนาแน่น โค้ดจึงจัดการดังนี้ (ใน `chatController.ts`):

| กลไก | ค่า | รายละเอียด |
| --- | --- | --- |
| Retry | สูงสุด 2 ครั้งต่อโมเดล | เฉพาะ status `500, 502, 503, 504` (ไม่ retry `429` เพราะจะเปลืองโควตาเปล่า) |
| Fallback | `GEMINI_FALLBACK_MODELS` | เมื่อโมเดลหลักล้มเหลว ลองโมเดลสำรองตามลำดับ |
| Timeout ต่อคำขอ | 12 วินาที | กันค้างเมื่อ Gemini ตอบช้า |
| งบเวลารวม | 30 วินาที | เกินแล้วหยุดและตอบ 503 |
| โควตาหมด (429) | — | ตอบข้อความภาษาไทยให้ผู้ใช้ และบันทึกว่าโมเดลนั้นหมดโควตาวันนี้ |

> **แนะนำ:** ตั้ง `GEMINI_FALLBACK_MODELS` ให้มีหลายโมเดล และดูโควตาจริงของแต่ละโมเดลที่
> Google AI Studio → Rate Limit เนื่องจากโควตาแยกกันตามโมเดล

---

## CORS

อนุญาตเฉพาะ origin ต่อไปนี้ (ที่เหลือจะถูกบล็อก และมี log `[CORS] Blocked origin: ...` บน Render):

- `https://chat-ai-portfolio-fe.vercel.app` (Production)
- `https://*.vercel.app` ทุกโดเมนย่อย (Preview deployment ของ Vercel)
- `http://localhost:<พอร์ตใดก็ได้>` (ตอนพัฒนา)
- origin เพิ่มเติมจาก `CORS_ORIGINS`

ถ้าใช้โดเมนของตัวเอง (เช่น `https://my-domain.com`) ให้เพิ่มใน `CORS_ORIGINS` บน Render

---

## Deploy บน Render

1. สร้าง **Web Service** เชื่อมกับ repo นี้ (branch `main`)
2. ตั้งค่า:
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm start`
   - **Health Check Path:** `/api/health`
3. เพิ่ม Environment Variables ตาม[ตารางด้านบน](#environment-variables) (อย่างน้อย `GEMINI_API_KEY` และ `DATABASE_URL`)
4. Deploy — ทุกครั้งที่ merge เข้า `main` Render จะ deploy ใหม่อัตโนมัติ
5. ตรวจที่ `https://<ชื่อ-service>.onrender.com/api/health` ต้องได้ `GEMINI_API_KEY: true` และ `DATABASE_URL: true`

**ข้อควรรู้ของแผนฟรี:** เซิร์ฟเวอร์จะ "หลับ" เมื่อไม่มีคนใช้สักพัก คำขอแรกหลังตื่นจะช้า (ประมาณ 30–60 วินาที)
ก่อนพรีเซนต์ให้เปิดเว็บทิ้งไว้หรือเรียก `/api/health` ปลุกไว้ล่วงหน้า (หน้าเว็บเรียก `/api/quota` ตอนเปิดหน้าแชตซึ่งช่วยปลุกให้อยู่แล้ว)

---

## แก้ปัญหาที่พบบ่อย

| อาการ | สาเหตุที่เป็นไปได้ | วิธีแก้ |
| --- | --- | --- |
| หน้าเว็บขึ้น "ไม่สามารถเชื่อมต่อกับเซิร์ฟเวอร์" / `Failed to fetch` | Render กำลังตื่น, URL ผิด หรือโดน CORS บล็อก | รอ 1 นาทีแล้วลองใหม่, เช็ก `VITE_API_URL` ฝั่ง FE, ดู log `[CORS] Blocked origin` |
| `/api/health` แสดง `false` | ลืมตั้ง env บน Render | เพิ่ม env แล้ว Save (จะ redeploy เอง) |
| Build บน Render ล้มเหลว (TS5108 / TS5011) | ตั้ง `NODE_ENV=production` ทำให้ devDependencies ไม่ถูกติดตั้ง | ลบ `NODE_ENV` ออกจาก Environment |
| Log เจอ `ENETUNREACH` ตอนเชื่อมฐานข้อมูล | ใช้ Direct connection (IPv6) ของ Supabase | เปลี่ยน `DATABASE_URL` เป็น **Session pooler** |
| แชตตอบ "ระบบ AI กำลังมีผู้ใช้งานจำนวนมาก" (503) | Gemini high demand | ตั้ง `GEMINI_FALLBACK_MODELS` หลายตัว หรือลองใหม่ภายหลัง |
| แชตตอบ "โควตาเต็ม" (429) | โควตารายวันของโมเดลหมด | รอรีเซ็ต (เที่ยงคืนเวลา Pacific ประมาณ 14:00–15:00 น. เวลาไทย ขึ้นกับ daylight saving) / เปลี่ยนโมเดลที่โควตาสูงกว่า / เปิด billing |
| Log เจอ model 404 | ชื่อโมเดลใน `GEMINI_MODEL`/`GEMINI_FALLBACK_MODELS` ไม่มีจริง | ตรวจชื่อให้ตรงกับที่ Google AI Studio แสดง |
| AI ตอบไม่ได้เรื่องสมาชิกบางคน | ไม่มีข้อมูลคนนั้นใน `team_members` / `team_projects` | เพิ่มข้อมูลใน Supabase |

---

## CI

GitHub Actions (`.github/workflows/backend-ci.yml`) ทำงานเมื่อ push/PR เข้า `main`: ติดตั้ง dependencies แล้วตรวจชนิดข้อมูลด้วย `tsc --noEmit`
(ตอนนี้ตั้งให้ไม่ทำให้ CI ล้มเมื่อมี error — ควรเอา `|| true` ออกเมื่อโค้ดพร้อม)

---

## License

MIT
