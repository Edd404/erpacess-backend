const { Router } = require('express');
const authController   = require('../controllers/authController');
const clientController = require('../controllers/clientController');
const orderController  = require('../controllers/serviceOrderController');
const { authenticate, authorize } = require('../middleware/auth');
const { authLimiter }  = require('../middleware/security');
const {
  validateLogin,
  validateCreateClient,
  validateUpdateClient,
  validateCreateServiceOrder,
  validatePagination,
} = require('../middleware/validation');

const router = Router();

// ── PING / HEALTH ─────────────────────────────────────────────
router.get('/ping', (req, res) =>
  res.status(200).json({ pong: true, ts: Date.now() })
);

router.get('/health', async (req, res) => {
  try {
    const { healthCheck } = require('../config/database');
    const db = await healthCheck();
    res.status(db.healthy ? 200 : 503).json({
      status: db.healthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      database: db, uptime: process.uptime(),
      environment: process.env.NODE_ENV,
    });
  } catch (err) {
    res.status(503).json({ status: 'error', error: err.message });
  }
});

// ── AUTH ──────────────────────────────────────────────────────
const authRouter = Router();
authRouter.post('/login',            authLimiter, validateLogin, authController.login);
authRouter.post('/refresh',          authController.refreshToken);
authRouter.get('/me',                authenticate, authController.getMe);
authRouter.patch('/change-password', authenticate, authController.changePassword);

// ── CLIENTS ───────────────────────────────────────────────────
const clientRouter = Router();
clientRouter.use(authenticate);
clientRouter.get('/',            validatePagination, clientController.listClients);
clientRouter.get('/cep/:cep',    clientController.lookupCEP);
clientRouter.get('/search',      clientController.searchClients);
clientRouter.get('/:id/history', clientController.getClientHistory);
clientRouter.get('/:id',         clientController.getClient);
clientRouter.post('/',           validateCreateClient, clientController.createClient);
clientRouter.put('/:id',         validateUpdateClient, clientController.updateClient);
clientRouter.delete('/:id',      authorize('admin', 'gerente'), clientController.deleteClient);

// ── ORDERS ────────────────────────────────────────────────────
const orderRouter = Router();
orderRouter.use(authenticate);
orderRouter.get('/stats', orderController.getStats);
orderRouter.get('/',      validatePagination, orderController.listOrders);
orderRouter.get('/:id',   orderController.getOrder);
orderRouter.post('/',     validateCreateServiceOrder, orderController.createOrder);

// Rotas opcionais — só adiciona se o método existir no controller
if (typeof orderController.searchOrders    === 'function') orderRouter.get('/search', orderController.searchOrders);
if (typeof orderController.updateStatus    === 'function') orderRouter.patch('/:id/status', orderController.updateStatus);
if (typeof orderController.resendPDF       === 'function') orderRouter.patch('/:id/resend-pdf', authorize('admin','gerente'), orderController.resendPDF);
if (typeof orderController.downloadWarrantyPDF === 'function') orderRouter.get('/:id/warranty-pdf', orderController.downloadWarrantyPDF);
if (typeof orderController.deleteOrder     === 'function') orderRouter.delete('/:id', authorize('admin'), orderController.deleteOrder);

// ── MONTA ─────────────────────────────────────────────────────
router.use('/auth',    authRouter);
router.use('/clients', clientRouter);
router.use('/orders',  orderRouter);

module.exports = router;
