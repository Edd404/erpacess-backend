const { Router } = require('express');
const authController = require('../controllers/authController');
const clientController = require('../controllers/clientController');
const orderController = require('../controllers/serviceOrderController');
const auditController = require('../controllers/auditController');
const { authenticate, authorize } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const { authLimiter } = require('../middleware/security');
const { IPHONE_MODELS, CAPACITIES, PAYMENT_METHODS } = require('../config/iphoneModels');
const {
  validateLogin, validateRegisterUser,
  validateCreateClient, validateUpdateClient,
  validateCreateServiceOrder, validatePagination,
} = require('../middleware/validation');

const router = Router();

// ═══════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════
const authRouter = Router();
authRouter.post('/login',            authLimiter, validateLogin, authController.login);
authRouter.post('/refresh',          authController.refreshToken);
authRouter.get('/me',                authenticate, authController.getMe);
authRouter.patch('/change-password', authenticate, authController.changePassword);
authRouter.post('/register',         authenticate, authorize('admin'), validateRegisterUser,
                                     audit('user.create', 'user'), authController.register);

// ═══════════════════════════════════════════════════════════════
// CLIENTS
// ═══════════════════════════════════════════════════════════════
const clientRouter = Router();
clientRouter.use(authenticate);

clientRouter.get('/',             validatePagination, clientController.listClients);
clientRouter.get('/cep/:cep',     clientController.lookupCEP);
clientRouter.get('/search',       clientController.searchClients);          // busca global
clientRouter.get('/:id',          clientController.getClient);
clientRouter.get('/:id/history',  clientController.getClientHistory);       // histórico completo
clientRouter.post('/',            validateCreateClient, audit('client.create','client'), clientController.createClient);
clientRouter.put('/:id',          validateUpdateClient, audit('client.update','client'), clientController.updateClient);
clientRouter.delete('/:id',       authorize('admin','gerente'), audit('client.delete','client'), clientController.deleteClient);

// ═══════════════════════════════════════════════════════════════
// SERVICE ORDERS
// ═══════════════════════════════════════════════════════════════
const orderRouter = Router();
orderRouter.use(authenticate);

orderRouter.get('/stats',           orderController.getStats);
orderRouter.get('/stats/advanced',  orderController.getAdvancedStats);      // novas métricas
orderRouter.get('/search',          orderController.searchOrders);           // busca global
orderRouter.get('/',                validatePagination, orderController.listOrders);
orderRouter.get('/:id',             orderController.getOrder);
orderRouter.get('/:id/warranty-pdf', orderController.downloadWarrantyPDF);
orderRouter.post('/',               validateCreateServiceOrder,
                                    audit('order.create','order'), orderController.createOrder);
orderRouter.patch('/:id/status',    authorize('admin','gerente','vendedor'),
                                    audit('order.status_update','order'), orderController.updateStatus);
orderRouter.patch('/:id/resend-pdf', authorize('admin','gerente'),          // reenviar PDF
                                    orderController.resendPDF);
orderRouter.delete('/:id',          authorize('admin'), audit('order.delete','order'), orderController.deleteOrder);

// ═══════════════════════════════════════════════════════════════
// AUDIT LOGS (admin + gerente)
// ═══════════════════════════════════════════════════════════════
const auditRouter = Router();
auditRouter.use(authenticate, authorize('admin', 'gerente'));
auditRouter.get('/', auditController.listAuditLogs);

// ═══════════════════════════════════════════════════════════════
// REPORTS
// ═══════════════════════════════════════════════════════════════
const reportRouter = Router();
reportRouter.use(authenticate, authorize('admin', 'gerente'));
reportRouter.post('/monthly', async (req, res) => {
  try {
    const { generateMonthlyReport } = require('../services/reportService');
    const { month, year } = req.body;
    const result = await generateMonthlyReport(month, year);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao gerar relatório.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// BACKUP (admin only)
// ═══════════════════════════════════════════════════════════════
const backupRouter = Router();
backupRouter.use(authenticate, authorize('admin'));
backupRouter.post('/run', async (req, res) => {
  const { runBackup } = require('../services/backupService');
  const result = await runBackup();
  res.json(result);
});

// ═══════════════════════════════════════════════════════════════
// CATALOG
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
// PING / HEALTH
// ═══════════════════════════════════════════════════════════════
router.get('/ping', (req, res) => res.status(200).json({ pong: true, ts: Date.now() }));
router.get('/health', async (req, res) => {
  const { healthCheck } = require('../config/database');
  const db = await healthCheck();
  const status = db.healthy ? 200 : 503;
  res.status(status).json({
    status: db.healthy ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
    database: db, uptime: process.uptime(), environment: process.env.NODE_ENV,
  });
});

// Monta
router.use('/auth',    authRouter);
router.use('/clients', clientRouter);
router.use('/orders',  orderRouter);
router.use('/audit',   auditRouter);
router.use('/reports', reportRouter);
router.use('/backup',  backupRouter);
router.use('/catalog', catalogRouter);

module.exports = router;
