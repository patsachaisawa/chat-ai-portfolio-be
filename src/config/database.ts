import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const connectionString = process.env.DATABASE_URL;
const isLocalDb = !connectionString || /localhost|127\.0\.0\.1/.test(connectionString);

export const pool = new Pool({
  connectionString,
  // Supabase/โฮสต์ภายนอกต้องใช้ SSL
  ssl: isLocalDb ? undefined : { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err);
});
