const { query } = require('../config/database');
const logger = require('../utils/logger');

/**
 * Registra uma ação no log de auditoria.
 * Falhas de log nunca interrompem o fluxo principal.
 */
const auditLog = async ({
  userId, userName, userRole,
  action, entity, entityId, entityLabel,
  changes, ipAddress, userAgent,
}) => {
  try {
    await query(
      `INSERT INTO audit_logs
        (user_id, user_name, user_role, action, entity, entity_id, entity_label, changes, ip_address, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [userId, userName, userRole, action, entity,
       entityId || null, entityLabel || null,
       changes ? JSON.stringify(changes) : null,
       ipAddress, userAgent]
    );
  } catch (err) {
    logger.error('Falha ao gravar audit log:', err.message);
  }
};

/**
 * Middleware factory — registra automaticamente ações de escrita.
 * Uso: router.post('/', authenticate, audit('order.create', 'order'), handler)
 */
const audit = (action, entity) => async (req, res, next) => {
  const originalJson = res.json.bind(res);

  res.json = function (body) {
    // Só loga se a resposta for bem-sucedida (2xx)
    if (res.statusCode >= 200 && res.statusCode < 300 && req.user) {
      const entityId    = body?.data?.id || body?.id || null;
      const entityLabel = body?.data?.order_number || body?.data?.name || body?.data?.email || null;
      auditLog({
        userId:      req.user.id,
        userName:    req.user.name,
        userRole:    req.user.role,
        action,
        entity,
        entityId,
        entityLabel,
        changes:     null, // enriquecer no controller quando necessário
        ipAddress:   req.ip,
        userAgent:   req.get('User-Agent'),
      });
    }
    return originalJson(body);
  };

  next();
};

/**
 * Helper para controllers — loga com before/after
 */
const logChange = (req, { action, entity, entityId, entityLabel, before, after }) => {
  if (!req.user) return;
  auditLog({
    userId:      req.user.id,
    userName:    req.user.name,
    userRole:    req.user.role,
    action,
    entity,
    entityId,
    entityLabel,
    changes:     before || after ? { before, after } : null,
    ipAddress:   req.ip,
    userAgent:   req.get('User-Agent'),
  });
};

module.exports = { audit, auditLog, logChange };
