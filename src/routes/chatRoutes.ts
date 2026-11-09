import { Router } from 'express';
import { handleChatMessage } from '../controllers/chatController';

const router = Router();

router.post('/chat', handleChatMessage);

export const chatRoutes = router;