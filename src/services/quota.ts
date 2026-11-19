import { pool } from '../config/database';

// ประมาณการโควตา Gemini ที่เหลือต่อวัน (Google ไม่มี API บอกยอดที่เหลือ จึงเป็นตัวเลขประมาณการเท่านั้น)
// - ตั้ง GEMINI_DAILY_LIMIT ให้ตรงกับที่แสดงใน Google AI Studio > Rate Limit ของโมเดลหลัก (ค่าเริ่มต้น 500)
// - นับจาก 2 แหล่ง แล้วเอาค่าที่มากกว่า: (1) จำนวนคำตอบของ AI ที่บันทึกในฐานข้อมูลวันนี้ (อยู่รอดแม้เซิร์ฟเวอร์รีสตาร์ต)
//   (2) จำนวนคำขอที่เซิร์ฟเวอร์ส่งไป Gemini ตั้งแต่เริ่มทำงาน (รวมครั้งที่ล้มเหลว)
// - ถ้าเจอ 429 จะถือว่าโควตาของโมเดลนั้นหมดทันที
const DAILY_LIMIT = Number(process.env.GEMINI_DAILY_LIMIT) || 500;
// โควตา Gemini รีเซ็ตเที่ยงคืนตามเวลา Pacific
const QUOTA_TZ = 'America/Los_Angeles';

interface MemoryEntry {
  day: string;
  attempts: number;
  exhausted: boolean;
}

const memory = new Map<string, MemoryEntry>();

function pacificDay(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: QUOTA_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function secondsUntilReset(now = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: QUOTA_TZ,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const elapsed = get('hour') * 3600 + get('minute') * 60 + get('second');
  return Math.max(0, 86400 - elapsed);
}

function entryFor(model: string): MemoryEntry {
  const day = pacificDay();
  const current = memory.get(model);
  if (current && current.day === day) return current;
  const fresh: MemoryEntry = { day, attempts: 0, exhausted: false };
  memory.set(model, fresh);
  return fresh;
}

export function recordAttempt(model: string): void {
  entryFor(model).attempts += 1;
}

export function markExhausted(model: string): void {
  entryFor(model).exhausted = true;
}

async function countRepliesToday(): Promise<number | null> {
  try {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS n
         FROM chat_messages
        WHERE sender = 'assistant'
          AND created_at >= (date_trunc('day', now() AT TIME ZONE $1::text) AT TIME ZONE $1::text)`,
      [QUOTA_TZ],
    );
    return Number(result.rows[0]?.n ?? 0);
  } catch (error) {
    console.warn('[Quota] นับคำตอบจากฐานข้อมูลไม่ได้ ใช้ตัวนับในหน่วยความจำแทน:', error);
    return null;
  }
}

export interface QuotaInfo {
  model: string;
  used: number;
  limit: number;
  remaining: number;
  resetsInSeconds: number;
  /** true = โมเดลหลักตอบ 429 (โควตาหมด) แล้ว ระบบอาจใช้โมเดลสำรองแทน */
  exhausted: boolean;
  /** เป็นตัวเลขประมาณการเสมอ ไม่ใช่ยอดทางการจาก Google */
  estimated: true;
}

export async function getQuota(model: string): Promise<QuotaInfo> {
  const entry = entryFor(model);
  const replies = await countRepliesToday();
  let used = Math.max(entry.attempts, replies ?? 0);
  if (entry.exhausted) used = DAILY_LIMIT;
  used = Math.min(used, DAILY_LIMIT);

  return {
    model,
    used,
    limit: DAILY_LIMIT,
    remaining: DAILY_LIMIT - used,
    resetsInSeconds: secondsUntilReset(),
    exhausted: entry.exhausted,
    estimated: true,
  };
}
