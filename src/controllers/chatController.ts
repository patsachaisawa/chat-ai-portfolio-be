import { Request, Response } from 'express';
import { pool } from '../config/database';
import { GoogleGenerativeAI } from '@google/generative-ai';

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

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
    const result = await model.generateContent({
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
    return res.status(500).json({
      error: 'Internal Server Error',
      // แสดงรายละเอียดเฉพาะนอก production เพื่อไม่เปิดเผยข้อมูลภายใน
      ...(process.env.NODE_ENV !== 'production' && { detail }),
    });
  }
};