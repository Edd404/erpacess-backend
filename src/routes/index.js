const { Router } = require('express');
const authController      = require('../controllers/authController');
const clientController    = require('../controllers/clientController');
const orderController     = require('../controllers/serviceOrderController');
const adminController     = require('../controllers/adminController');
const inventoryController = require('../controllers/inventoryController');
const { authenticate, authorize } = require('../middleware/auth');
const { authLimiter }  = require('../middleware/security');
const {
  validateLogin,
  validateCreateClient,
  validateUpdateClient,
  validateCreateServiceOrder,
  validateUpdateServiceOrder,
  validatePagination,
  validateSearch,
} = require('../middleware/validation');

const router = Router();

// ── PING (público — apenas pong, sem info) ────────────────────
router.get('/ping', (req, res) =>
  res.status(200).json({ pong: true })
);

// ── HEALTH (autenticado — só admin/gerente) ───────────────────
router.get('/health', authenticate, authorize('admin', 'gerente'), async (req, res) => {
  try {
    const { healthCheck } = require('../config/database');
    const db = await healthCheck();
    res.status(db.healthy ? 200 : 503).json({
      status: db.healthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      database: db,
    });
  } catch (err) {
    res.status(503).json({ status: 'error' });
  }
});

// ── AUTH ──────────────────────────────────────────────────────
const authRouter = Router();
authRouter.post('/login',            authLimiter, validateLogin, authController.login);
authRouter.post('/refresh',          authController.refreshToken);
authRouter.post('/logout',           authenticate, authController.logout);
authRouter.get('/me',                authenticate, authController.getMe);
authRouter.patch('/change-password', authenticate, authController.changePassword);

// ── CLIENTS ───────────────────────────────────────────────────
const clientRouter = Router();
clientRouter.use(authenticate);
clientRouter.get('/',            validatePagination, clientController.listClients);
clientRouter.get('/search',      validateSearch, clientController.searchClients);
clientRouter.get('/cep/:cep',    clientController.lookupCEP);
clientRouter.get('/:id/history', clientController.getClientHistory);
clientRouter.get('/:id',         clientController.getClient);
clientRouter.post('/',           validateCreateClient, clientController.createClient);
clientRouter.put('/:id',         validateUpdateClient, clientController.updateClient);
clientRouter.delete('/:id',      authorize('admin', 'gerente'), clientController.deleteClient);

// ── ORDERS ────────────────────────────────────────────────────
const orderRouter = Router();
orderRouter.use(authenticate);
// ⚠️ rotas estáticas ANTES de /:id
orderRouter.get('/stats',            orderController.getStats);
orderRouter.get('/search',           validateSearch, orderController.searchOrders);
orderRouter.get('/notifications',    orderController.getNotifications);
orderRouter.get('/seller-ranking',   orderController.getSellerRanking);
orderRouter.get('/model-comparison', orderController.getModelComparison);
orderRouter.get('/',                 validatePagination, orderController.listOrders);
orderRouter.get('/:id/warranty-pdf', orderController.downloadWarrantyPDF);
orderRouter.get('/:id',              orderController.getOrder);
orderRouter.post('/',                validateCreateServiceOrder, orderController.createOrder);
orderRouter.put('/:id',              validateUpdateServiceOrder, orderController.updateOrder);
orderRouter.patch('/:id/status',     orderController.updateStatus);
orderRouter.patch('/:id/resend-pdf', orderController.resendPDF);
// ── Documento assinado (Cloudinary) ───────────────────────────
orderRouter.patch('/:id/document',   orderController.saveDocument);
orderRouter.delete('/:id/document',  orderController.removeDocument);
// ─────────────────────────────────────────────────────────────
orderRouter.delete('/:id',           authorize('admin'), orderController.deleteOrder);

// ── MODELS (público para autenticados) ───────────────────────
const modelsRouter = Router();
modelsRouter.use(authenticate);
modelsRouter.get('/active', adminController.listActiveModels);

// ── INVENTORY (resumo público p/ autenticados; CRUD admin) ───
const inventoryPublicRouter = Router();
inventoryPublicRouter.use(authenticate);
inventoryPublicRouter.get('/summary',    inventoryController.getInventorySummary);
inventoryPublicRouter.get('/by-model',   inventoryController.getInventoryByModel);

// ── ADMIN ─────────────────────────────────────────────────────
const adminRouter = Router();
adminRouter.use(authenticate, authorize('admin'));
// Usuários
adminRouter.get('/users',                   adminController.listUsers);
adminRouter.post('/users',                  adminController.createUser);
adminRouter.patch('/users/:id',             adminController.updateUser);
adminRouter.patch('/users/:id/reset-password', adminController.resetPassword);
// Modelos de iPhone
adminRouter.get('/models',                  adminController.listModels);
adminRouter.get('/models/active',           adminController.listActiveModels);
adminRouter.post('/models',                 adminController.createModel);
adminRouter.patch('/models/:id',            adminController.updateModel);

// Estoque
adminRouter.get('/inventory',              inventoryController.listInventory);
adminRouter.post('/inventory',             inventoryController.createInventoryItem);
adminRouter.post('/inventory/import',      inventoryController.importFromWhatsApp);
adminRouter.patch('/inventory/:id',        inventoryController.updateInventoryItem);
adminRouter.delete('/inventory/:id',       inventoryController.deleteInventoryItem);



// ── RESTORE backup (admin only) ───────────────────────────────
adminRouter.post('/backup/restore', async (req, res) => {
  try {
    const { data, tables, mode } = req.body;

    if (!data || !tables || !Array.isArray(tables) || tables.length === 0) {
      return res.status(400).json({ error: 'Parâmetros inválidos. Envie data, tables e mode.' });
    }

    const ALLOWED_TABLES = ['users', 'clients', 'service_orders'];
    const invalidTables  = tables.filter(t => !ALLOWED_TABLES.includes(t));
    if (invalidTables.length > 0) {
      return res.status(400).json({ error: `Tabelas não permitidas: ${invalidTables.join(', ')}` });
    }

    const { restoreBackup } = require('../services/backupService');
    const results = await restoreBackup({ data, tables, mode: mode || 'missing_only' });

    return res.json({ message: 'Restauração concluída.', results });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── BACKUP manual (admin only) ────────────────────────────────
adminRouter.post('/backup/run', async (req, res) => {
  try {
    const { runBackup } = require('../services/backupService');
    const result = await runBackup();
    if (result.success) {
      return res.json({
        message: 'Backup executado com sucesso.',
        fileName: result.fileName,
        sizeKB:   result.sizeKB,
        rowCounts: result.rowCounts,
      });
    }
    return res.status(500).json({ error: result.error || 'Falha no backup.' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── MONTA ─────────────────────────────────────────────────────
router.use('/auth',      authRouter);
router.use('/clients',   clientRouter);
router.use('/orders',    orderRouter);
router.use('/models',    modelsRouter);
router.use('/inventory', inventoryPublicRouter);
router.use('/admin',     adminRouter);

module.exports = router;
