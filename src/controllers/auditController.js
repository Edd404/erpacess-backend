const { query } = require('../config/database');
const logger = require('../utils/logger');

/**
 * GET /api/v1/audit
 * Somente admin/gerente
 */
const listAuditLogs = async (req, res) => {
  try {
    const { page = 1, limit = 50, action, entity, user_id, start_date, end_date } = req.query;
    const offset = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);

    const conditions = [];
    const params = [];
    let p = 0;

    if (action)     { p++; conditions.push(`action ILIKE $${p}`);  params.push(`%${action}%`); }
    if (entity)     { p++; conditions.push(`entity = $${p}`);      params.push(entity); }
    if (user_id)    { p++; conditions.push(`user_id = $${p}`);     params.push(user_id); }
    if (start_date) { p++; conditions.push(`created_at >= $${p}`); params.push(start_date); }
    if (end_date)   { p++; conditions.push(`created_at <= $${p}`); params.push(end_date + 'T23:59:59'); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await query(`SELECT COUNT(*) FROM audit_logs ${where}`, params);
    const total = parseInt(countRes.rows[0].count);

    const result = await query(
      `SELECT id, action, entity, entity_id, entity_label, user_name, user_role,
              ip_address, changes, created_at
       FROM audit_logs
       ${where}
       ORDER BY created_at DESC
       LIMIT $${p + 1} OFFSET $${p + 2}`,
      [...params, parseInt(limit), offset]
    );

    res.json({
      data: result.rows,
      meta: { total, page: parseInt(page), limit: parseInt(limit), totalPages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (err) {
    logger.error('Erro ao listar audit logs:', err);
    res.status(500).json({ error: 'Erro ao buscar logs de auditoria.' });
  }
};

module.exports = { listAuditLogs };
