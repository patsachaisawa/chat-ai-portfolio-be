import { Router } from 'express';
import { handleChatMessage, handleQuota } from '../controllers/chatController';

const router = Router();

router.post('/chat', handleChatMessage);
router.get('/quota', handleQuota);

export const chatRoutes = router;
