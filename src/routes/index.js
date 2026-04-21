const { Router } = require('express');
const authController = require('../controllers/authController');
const clientController = require('../controllers/clientController');
const orderController = require('../controllers/serviceOrderController');
const { authenticate, authorize } = require('../middleware/auth');
const { authLimiter } = require('../middleware/security');
const { IPHONE_MODELS, CAPACITIES, PAYMENT_METHODS } = require('../config/iphoneModels');
const {
  validateLogin, validateRegisterUser,
  validateCreateClient, validateUpdateClient,
  validateCreateServiceOrder, validatePagination,
} = require('../middleware/validation');

const router = Router();

// ═══════════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════════
const authRouter = Router();

authRouter.post('/login',           authLimiter, validateLogin, authController.login);
authRouter.post('/refresh',         authController.refreshToken);
authRouter.get('/me',               authenticate, authController.getMe);
authRouter.patch('/change-password', authenticate, authController.changePassword);
authRouter.post('/register',        authenticate, authorize('admin'), validateRegisterUser, authController.register);

// ═══════════════════════════════════════════════════════════════
// CLIENT ROUTES
// ═══════════════════════════════════════════════════════════════
const clientRouter = Router();
clientRouter.use(authenticate);

clientRouter.get('/',              validatePagination, clientController.listClients);
clientRouter.get('/cep/:cep',      clientController.lookupCEP);
clientRouter.get('/:id',           clientController.getClient);
clientRouter.post('/',             validateCreateClient, clientController.createClient);
clientRouter.put('/:id',           validateUpdateClient, clientController.updateClient);
clientRouter.delete('/:id',        authorize('admin', 'vendedor'), clientController.deleteClient);

// ═══════════════════════════════════════════════════════════════
// SERVICE ORDER ROUTES
// ═══════════════════════════════════════════════════════════════
const orderRouter = Router();
orderRouter.use(authenticate);

orderRouter.get('/stats',          orderController.getStats);
orderRouter.get('/',               validatePagination, orderController.listOrders);
orderRouter.get('/:id',            orderController.getOrder);
orderRouter.get('/:id/warranty-pdf', orderController.downloadWarrantyPDF);
orderRouter.post('/',              validateCreateServiceOrder, orderController.createOrder);
orderRouter.patch('/:id/status',   orderController.updateStatus);
orderRouter.delete('/:id',         authorize('admin'), orderController.deleteOrder);

// ═══════════════════════════════════════════════════════════════
// CATALOG ROUTES (dados estáticos para o frontend)
// ═══════════════════════════════════════════════════════════════
const catalogRouter = Router();
catalogRouter.use(authenticate);

catalogRouter.get('/iphone-models', (req, res) => {
  const grouped = IPHONE_MODELS.reduce((acc, model) => {
    if (!acc[model.series]) acc[model.series] = [];
    acc[model.series].push(model);
    return acc;
  }, {});
  res.json({ data: { models: IPHONE_MODELS, grouped, capacities: CAPACITIES, payment_methods: PAYMENT_METHODS } });
});

// ═══════════════════════════════════════════════════════════════
// PING — endpoint ultra-leve para o UptimeRobot
// Responde imediatamente sem consultar o banco
// Configure no UptimeRobot: GET /api/v1/ping a cada 5 minutos
// ═══════════════════════════════════════════════════════════════
router.get('/ping', (req, res) => {
  res.status(200).json({ pong: true, ts: Date.now() });
});

// ═══════════════════════════════════════════════════════════════
// HEALTH CHECK — diagnóstico completo (inclui banco de dados)
// ═══════════════════════════════════════════════════════════════
router.get('/health', async (req, res) => {
  const { healthCheck } = require('../config/database');
  const db = await healthCheck();
  const status = db.healthy ? 200 : 503;
  res.status(status).json({
    status: db.healthy ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
    database: db,
    uptime: process.uptime(),
    environment: process.env.NODE_ENV,
  });
});

// Monta os roteadores
router.use('/auth',    authRouter);
router.use('/clients', clientRouter);
router.use('/orders',  orderRouter);
router.use('/catalog', catalogRouter);

module.exports = router;
