import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { chatRoutes } from './routes/chatRoutes';

dotenv.config();

const app = express();
// Render จะกำหนด PORT ให้ผ่าน process.env.PORT
const PORT = Number(process.env.PORT) || 5000;

// ---- CORS ----
// อนุญาต: localhost, Vercel Production, Preview (*.vercel.app) และ origin เพิ่มเติมจาก env CORS_ORIGINS (คั่นด้วย ,)
const PRODUCTION_ORIGIN = 'https://chat-ai-portfolio-fe.vercel.app';
const extraOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((o) => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);

const allowedOrigins = new Set([PRODUCTION_ORIGIN, ...extraOrigins]);
const localhostPattern = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const vercelPreviewPattern = /^https:\/\/[a-z0-9-]+\.vercel\.app$/i;

const corsOptions: cors.CorsOptions = {
  origin(origin, callback) {
    // ไม่มี origin = curl / server-to-server / health check
    if (!origin) return callback(null, true);

    if (allowedOrigins.has(origin) || localhostPattern.test(origin) || vercelPreviewPattern.test(origin)) {
      return callback(null, true);
    }

    console.warn(`[CORS] Blocked origin: ${origin}`);
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
};

app.use(cors(corsOptions));
app.options('/{*splat}', cors(corsOptions)); // รองรับ preflight (Express 5 syntax)
app.use(express.json());

// Health check (ใช้ตั้งเป็น Health Check Path บน Render และปลุกเซิร์ฟเวอร์)
app.get('/', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', service: 'chat-ai-portfolio-be' });
});
app.get('/api/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    env: {
      GEMINI_API_KEY: Boolean(process.env.GEMINI_API_KEY),
      DATABASE_URL: Boolean(process.env.DATABASE_URL),
    },
  });
});

// Routes
app.use('/api', chatRoutes);

// 404 เป็น JSON
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: `Not Found: ${req.method} ${req.originalUrl}` });
});

// Error handler กลาง
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// เตือนตั้งแต่ตอนสตาร์ทถ้าขาด env สำคัญ
for (const key of ['GEMINI_API_KEY', 'DATABASE_URL']) {
  if (!process.env[key]) {
    console.error(`[ENV] Missing required environment variable: ${key}`);
  }
}

// bind 0.0.0.0 ให้ Render ตรวจพบ port
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});
