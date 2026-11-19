import { Request, Response } from 'express';
import { pool } from '../config/database';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getQuota, markExhausted, recordAttempt } from '../services/quota';

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
// โมเดลสำรอง (คั่นด้วย ,) ใช้เมื่อโมเดลหลักติดขัดต่อเนื่อง เช่น 503 high demand
const GEMINI_FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS || 'gemini-3.8-flash')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// ลองซ้ำเฉพาะ error ฝั่งเซิร์ฟเวอร์ชั่วคราว
// ไม่ลองซ้ำ 429 (โควตาหมด) เพราะลองซ้ำไม่ช่วย และยิ่งกินโควตา Free Tier (20 คำขอ/วัน/โมเดล) ให้หมดเร็วขึ้น
// เมื่อเจอ 429 จะข้ามไปโมเดลสำรองทันที
const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);
const MAX_ATTEMPTS_PER_MODEL = 2;
// จำกัดเวลาต่อคำขอ และเวลารวมทั้งหมด กันผู้ใช้รอนานเมื่อ Gemini ติดขัด
const REQUEST_TIMEOUT_MS = 12_000;
const TOTAL_BUDGET_MS = 30_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function getErrorStatus(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status: unknown }).status)
    : undefined;
}

// เรียก Gemini โดยลองซ้ำ (backoff) เมื่อ error ชั่วคราว แล้วค่อยสลับไปโมเดลสำรอง
async function generateWithRetry(request: Parameters<ReturnType<typeof genAI.getGenerativeModel>['generateContent']>[0]) {
  const models = [GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS.filter((m) => m !== GEMINI_MODEL)];
  let lastError: unknown;
  const deadline = Date.now() + TOTAL_BUDGET_MS;

  for (const modelName of models) {
    const model = genAI.getGenerativeModel({ model: modelName }, { timeout: REQUEST_TIMEOUT_MS });

    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt++) {
      if (Date.now() >= deadline) throw lastError ?? new Error('Gemini time budget exceeded');
      try {
        recordAttempt(modelName);
        return await model.generateContent(request);
      } catch (error) {
        lastError = error;
        const status = getErrorStatus(error);
        if (status === 429) markExhausted(modelName);
        console.warn(`[Gemini] ${modelName} attempt ${attempt}/${MAX_ATTEMPTS_PER_MODEL} failed (status ${status ?? 'n/a'})`);

        // error ที่ไม่ใช่ชั่วคราว (เช่น คีย์ผิด 400/403, ไม่พบโมเดล 404) ข้ามไปโมเดลถัดไปทันที
        if (status === undefined || !RETRYABLE_STATUS.has(status)) break;
        if (attempt < MAX_ATTEMPTS_PER_MODEL) await sleep(1000); // รอ 1 วินาทีก่อนลองซ้ำ
      }
    }
  }

  throw lastError;
}

// ฟังก์ชันดึงข้อมูล Portfolio ทั้งหมดจาก DB มารวมเป็น JSON String
async function getPortfolioContext() {
  try {
    const teamResult = await pool.query('SELECT * FROM team_info LIMIT 1');
    const membersResult = await pool.query('SELECT * FROM team_members');
    const projectsResult = await pool.query('SELECT * FROM team_projects');

    const portfolioData = {
      team: teamResult.rows[0] || {},
      members: membersResult.rows,
      shared_projects: projectsResult.rows,
    };

    return JSON.stringify(portfolioData, null, 2);
  } catch (error) {
    console.error('Error fetching portfolio context:', error);
    return '{}';
  }
}

export const handleChatMessage = async (req: Request, res: Response) => {
  try {
    const { sessionId, message } = req.body;

    if (!sessionId || !message) {
      return res.status(400).json({ error: 'sessionId and message are required' });
    }

    // ตรวจ env ที่จำเป็น ให้ error ชัดเจนแทนที่จะล้มเงียบ ๆ
    const missingEnv = ['GEMINI_API_KEY', 'DATABASE_URL'].filter((k) => !process.env[k]);
    if (missingEnv.length > 0) {
      console.error(`Chat error: missing environment variables: ${missingEnv.join(', ')}`);
      return res.status(500).json({ error: `Server misconfigured: missing ${missingEnv.join(', ')}` });
    }

    // 1. ตรวจสอบและสร้าง sessionId ในตาราง chat_sessions ก่อน (ป้องกัน Foreign Key Error)
    await pool.query(
     'INSERT INTO chat_sessions (session_id) VALUES ($1) ON CONFLICT (session_id) DO NOTHING',
     [sessionId]
    );

    // 2. ดึง Portfolio Context จาก PostgreSQL
    const portfolioContext = await getPortfolioContext();

    // 3. บันทึกข้อความฝั่ง User ลง PostgreSQL
    await pool.query(
      'INSERT INTO chat_messages (session_id, sender, message) VALUES ($1, $2, $3)',
      [sessionId, 'user', message]
    );

    // 4. ดึงประวัติการสนทนาย้อนหลัง (6 ข้อความล่าสุด)
    const historyResult = await pool.query(
      'SELECT sender, message FROM chat_messages WHERE session_id = $1 ORDER BY created_at DESC LIMIT 6',
      [sessionId]
    );
    const chatHistory = historyResult.rows.reverse();

    // 5. จัดเตรียม System Prompt พร้อมแนบ Portfolio Context
    const systemInstruction = `
You are the official AI representative for our project team. Your job is to answer questions about our team, shared projects, and individual members based strictly on the PORTFOLIO CONTEXT provided below. Be friendly, professional, and enthusiastic.

### PORTFOLIO CONTEXT:
${portfolioContext}
    `;

    // 6. จัดรูปแบบข้อความเพื่อส่งให้ Gemini API
    const chatMessagesForAI = chatHistory.map((row) => ({
      role: row.sender === 'user' ? 'user' : 'model',
      parts: [{ text: row.message }],
    }));

    // 7. เรียกใช้งาน Gemini 3.6 Flash
    const result = await generateWithRetry({
      contents: chatMessagesForAI,
      systemInstruction: systemInstruction,
    });

    const aiReply = result.response.text() || 'ขออภัยครับ เกิดข้อผิดพลาดในการประมวลผลคำตอบ';

    // 8. บันทึกข้อความตอบกลับของ AI ลง PostgreSQL
    await pool.query(
      'INSERT INTO chat_messages (session_id, sender, message) VALUES ($1, $2, $3)',
      [sessionId, 'assistant', aiReply]
    );

    return res.status(200).json({
      reply: aiReply,
    });
  } catch (error) {
    console.error('Chat error:', error);
    const detail = error instanceof Error ? error.message : String(error);

    // Gemini ติดขัดชั่วคราว: ตอบ 503 พร้อมข้อความที่ผู้ใช้อ่านเข้าใจได้
    // โควตา Gemini หมด (429): แจ้งผู้ใช้ตรงๆ แทนข้อความ error ทั่วไป
    if (getErrorStatus(error) === 429) {
      return res.status(429).json({ error: 'โควตาการใช้งาน AI ของวันนี้เต็มแล้ว กรุณาลองใหม่ภายหลัง' });
    }

    const isTimeout = /abort|timeout|timed out/i.test(detail);
    if (getErrorStatus(error) === 503 || isTimeout) {
      return res.status(503).json({ error: 'ระบบ AI กำลังมีผู้ใช้งานจำนวนมาก กรุณาลองใหม่อีกครั้งในอีกสักครู่' });
    }

    return res.status(500).json({
      error: 'Internal Server Error',
      // แสดงรายละเอียดเฉพาะนอก production เพื่อไม่เปิดเผยข้อมูลภายใน
      ...(process.env.NODE_ENV !== 'production' && { detail }),
    });
  }
};

// GET /api/quota : ประมาณการโควตา Gemini ที่เหลือของโมเดลหลัก (ใช้แสดงแถบ HP ฝั่งหน้าเว็บ)
export const handleQuota = async (_req: Request, res: Response) => {
  try {
    return res.status(200).json(await getQuota(GEMINI_MODEL));
  } catch (error) {
    console.error('Quota error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};
