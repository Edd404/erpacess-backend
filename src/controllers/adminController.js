/**
 * adminController.js
 * Rotas exclusivas para role=admin
 * Usuários + Modelos de iPhone
 */

const bcrypt = require('bcryptjs');
const { query } = require('../config/database');
const logger    = require('../utils/logger');

// ─────────────────────────────────────────────────────────────
// USUÁRIOS
// ─────────────────────────────────────────────────────────────

/** GET /admin/users — lista todos os usuários */
const listUsers = async (req, res) => {
  try {
    const result = await query(
      `SELECT id, name, email, role, is_active, created_at, last_login
       FROM users
       ORDER BY created_at DESC`
    );
    res.json({ data: result.rows });
  } catch (err) {
    logger.error('Erro ao listar usuários:', err);
    res.status(500).json({ error: 'Erro ao buscar usuários.' });
  }
};

/** POST /admin/users — cria novo usuário */
const createUser = async (req, res) => {
  try {
    const { name, email, password, role = 'vendedor' } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Nome, e-mail e senha são obrigatórios.' });
    }
    if (!['admin', 'gerente', 'vendedor'].includes(role)) {
      return res.status(400).json({ error: 'Role inválida.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Senha deve ter ao menos 6 caracteres.' });
    }

    const exists = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (exists.rows.length) {
      return res.status(409).json({ error: 'E-mail já cadastrado.' });
    }

    const saltRounds = parseInt(process.env.BCRYPT_ROUNDS) || 12;
    const hash = await bcrypt.hash(password, saltRounds);

    const result = await query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, role, is_active, created_at`,
      [name.trim(), email.toLowerCase(), hash, role]
    );

    logger.info(`Usuário criado: ${email} (${role}) por ${req.user.id}`);
    res.status(201).json({ message: 'Usuário criado com sucesso.', data: result.rows[0] });
  } catch (err) {
    logger.error('Erro ao criar usuário:', err);
    res.status(500).json({ error: 'Erro ao criar usuário.' });
  }
};

/** PATCH /admin/users/:id — edita nome/role/status */
const updateUser = async (req, res) => {
  try {
    const { name, role, is_active } = req.body;
    const { id } = req.params;

    if (id === req.user.id) {
      return res.status(400).json({ error: 'Você não pode editar sua própria conta aqui.' });
    }
    if (role && !['admin', 'gerente', 'vendedor'].includes(role)) {
      return res.status(400).json({ error: 'Role inválida.' });
    }

    const fields = [], values = [];
    let p = 1;
    if (name      !== undefined) { fields.push(`name = $${p++}`);      values.push(name.trim()); }
    if (role      !== undefined) { fields.push(`role = $${p++}`);      values.push(role); }
    if (is_active !== undefined) { fields.push(`is_active = $${p++}`); values.push(is_active); }

    if (!fields.length) return res.status(400).json({ error: 'Nenhum campo para atualizar.' });

    fields.push(`updated_at = NOW()`);
    values.push(id);

    const result = await query(
      `UPDATE users SET ${fields.join(', ')}
       WHERE id = $${p}
       RETURNING id, name, email, role, is_active, created_at`,
      values
    );

    if (!result.rows[0]) return res.status(404).json({ error: 'Usuário não encontrado.' });

    logger.info(`Usuário ${id} atualizado por ${req.user.id}`);
    res.json({ message: 'Usuário atualizado.', data: result.rows[0] });
  } catch (err) {
    logger.error('Erro ao atualizar usuário:', err);
    res.status(500).json({ error: 'Erro ao atualizar usuário.' });
  }
};

/** PATCH /admin/users/:id/reset-password — redefine senha */
const resetPassword = async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Nova senha deve ter ao menos 6 caracteres.' });
    }

    const saltRounds = parseInt(process.env.BCRYPT_ROUNDS) || 12;
    const hash = await bcrypt.hash(password, saltRounds);

    const result = await query(
      `UPDATE users SET password_hash = $1, updated_at = NOW()
       WHERE id = $2 RETURNING id, name, email`,
      [hash, req.params.id]
    );

    if (!result.rows[0]) return res.status(404).json({ error: 'Usuário não encontrado.' });

    logger.info(`Senha redefinida para ${result.rows[0].email} por ${req.user.id}`);
    res.json({ message: 'Senha redefinida com sucesso.' });
  } catch (err) {
    logger.error('Erro ao redefinir senha:', err);
    res.status(500).json({ error: 'Erro ao redefinir senha.' });
  }
};

// ─────────────────────────────────────────────────────────────
// MODELOS DE iPHONE
// ─────────────────────────────────────────────────────────────

/** GET /admin/models — lista modelos */
const listModels = async (req, res) => {
  try {
    const result = await query(
      `SELECT id, name, series, year, capacities, is_active, created_at
       FROM iphone_models
       ORDER BY year DESC, name ASC`
    );
    res.json({ data: result.rows });
  } catch (err) {
    logger.error('Erro ao listar modelos:', err);
    res.status(500).json({ error: 'Erro ao buscar modelos.' });
  }
};

/** GET /admin/models/active — lista só os ativos (usado pelo NewOrderPage) */
const listActiveModels = async (req, res) => {
  try {
    const result = await query(
      `SELECT id, name, category, series, year, capacities, suggested_price
       FROM iphone_models
       WHERE is_active = TRUE
       ORDER BY year DESC, name ASC`
    );
    res.json({ data: result.rows });
  } catch (err) {
    logger.error('Erro ao listar modelos ativos:', err);
    res.status(500).json({ error: 'Erro ao buscar modelos.' });
  }
};

/** POST /admin/models — cria novo modelo (iphone | acessorio | outro) */
const createModel = async (req, res) => {
  try {
    const { name, category = 'iphone', series, year, capacities, suggested_price } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Nome e obrigatorio.' });
    }

    const isIphone = category === 'iphone';

    if (isIphone) {
      if (!series || !series.trim()) {
        return res.status(400).json({ error: 'Serie e obrigatoria para iPhones.' });
      }
      if (!Array.isArray(capacities) || capacities.length === 0) {
        return res.status(400).json({ error: 'Selecione ao menos uma capacidade.' });
      }
    }

    const exists = await query(
      'SELECT id FROM iphone_models WHERE LOWER(name) = LOWER($1)', [name.trim()]
    );
    if (exists.rows.length) {
      return res.status(409).json({ error: 'Item ja cadastrado com esse nome.' });
    }

    const result = await query(
      `INSERT INTO iphone_models (name, category, series, year, capacities, suggested_price)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, category, series, year, capacities, suggested_price, is_active, created_at`,
      [
        name.trim(),
        category,
        isIphone && series ? series.trim() : null,
        isIphone && year ? parseInt(year) : null,
        isIphone ? (capacities || []) : [],
        suggested_price ? parseFloat(String(suggested_price).replace(',', '.')) : null,
      ]
    );

    logger.info('Modelo criado: ' + name + ' (' + category + ') por ' + req.user.id);
    res.status(201).json({ message: 'Item criado com sucesso.', data: result.rows[0] });
  } catch (err) {
    logger.error('Erro ao criar modelo:', err);
    res.status(500).json({ error: 'Erro ao criar item no catalogo.' });
  }
};

/** PATCH /admin/models/:id — edita modelo */
const updateModel = async (req, res) => {
  try {
    const { name, series, year, capacities, suggested_price, is_active } = req.body;

    const fields = [], values = [];
    let p = 1;
    if (name            !== undefined) { fields.push(`name = $${p++}`);            values.push(name.trim()); }
    if (series          !== undefined) { fields.push(`series = $${p++}`);          values.push(series ? series.trim() : null); }
    if (year            !== undefined) { fields.push(`year = $${p++}`);            values.push(year ? parseInt(year) : null); }
    if (capacities      !== undefined) { fields.push(`capacities = $${p++}`);      values.push(capacities); }
    if (suggested_price !== undefined) { fields.push(`suggested_price = $${p++}`); values.push(suggested_price ? parseFloat(String(suggested_price).replace(',','.')) : null); }
    if (is_active       !== undefined) { fields.push(`is_active = $${p++}`);       values.push(is_active); }

    if (!fields.length) return res.status(400).json({ error: 'Nenhum campo para atualizar.' });

    fields.push(`updated_at = NOW()`);
    values.push(req.params.id);

    const result = await query(
      `UPDATE iphone_models SET ${fields.join(', ')}
       WHERE id = $${p}
       RETURNING id, name, category, series, year, capacities, suggested_price, is_active`,
      values
    );

    if (!result.rows[0]) return res.status(404).json({ error: 'Modelo nao encontrado.' });

    logger.info('Modelo ' + req.params.id + ' atualizado por ' + req.user.id);
    res.json({ message: 'Modelo atualizado.', data: result.rows[0] });
  } catch (err) {
    logger.error('Erro ao atualizar modelo:', err);
    res.status(500).json({ error: 'Erro ao atualizar modelo.' });
  }
};

module.exports = {
  listUsers, createUser, updateUser, resetPassword,
  listModels, listActiveModels, createModel, updateModel,
};
