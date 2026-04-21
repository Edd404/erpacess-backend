const bcrypt = require('bcryptjs');
const { query } = require('../config/database');
const { generateAccessToken, generateRefreshToken } = require('../middleware/auth');
const logger = require('../utils/logger');

/**
 * POST /api/v1/auth/login
 */
const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const result = await query(
      'SELECT id, name, email, password_hash, role, is_active FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    const user = result.rows[0];

    if (!user || !user.is_active) {
      // Tempo constante para evitar timing attacks
      await bcrypt.compare(password, '$2b$12$invalidhashfortimingprotection00000000000000000');
      return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
    }

    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      logger.warn(`Tentativa de login falhou para: ${email}`);
      return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
    }

    // Atualiza último acesso
    await query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

    const payload = { id: user.id, email: user.email, name: user.name, role: user.role };
    const accessToken = generateAccessToken(payload);
    const refreshToken = generateRefreshToken({ id: user.id });

    logger.info(`Login bem-sucedido: ${user.email} (${user.role})`);

    res.json({
      message: 'Login realizado com sucesso.',
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      accessToken,
      refreshToken,
      expiresIn: process.env.JWT_EXPIRES_IN || '8h',
    });
  } catch (error) {
    logger.error('Erro no login:', error);
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
};

/**
 * POST /api/v1/auth/register
 * Apenas admins podem criar usuários
 */
const register = async (req, res) => {
  try {
    const { name, email, password, role = 'vendedor' } = req.body;

    const exists = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (exists.rows.length > 0) {
      return res.status(409).json({ error: 'E-mail já cadastrado.' });
    }

    const saltRounds = parseInt(process.env.BCRYPT_ROUNDS) || 12;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    const result = await query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, role, created_at`,
      [name.trim(), email.toLowerCase(), passwordHash, role]
    );

    logger.info(`Novo usuário criado: ${email} (${role}) por admin ${req.user?.id}`);

    res.status(201).json({
      message: 'Usuário criado com sucesso.',
      user: result.rows[0],
    });
  } catch (error) {
    logger.error('Erro ao criar usuário:', error);
    res.status(500).json({ error: 'Erro ao criar usuário.' });
  }
};

/**
 * POST /api/v1/auth/refresh
 */
const refreshToken = async (req, res) => {
  const { refreshToken: token } = req.body;
  if (!token) return res.status(400).json({ error: 'Refresh token não fornecido.' });

  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);

    const result = await query(
      'SELECT id, name, email, role FROM users WHERE id = $1 AND is_active = true',
      [decoded.id]
    );

    if (!result.rows[0]) {
      return res.status(401).json({ error: 'Usuário não encontrado ou inativo.' });
    }

    const user = result.rows[0];
    const accessToken = generateAccessToken({ id: user.id, email: user.email, name: user.name, role: user.role });

    res.json({ accessToken, expiresIn: process.env.JWT_EXPIRES_IN || '8h' });
  } catch {
    res.status(401).json({ error: 'Refresh token inválido ou expirado.' });
  }
};

/**
 * GET /api/v1/auth/me
 */
const getMe = async (req, res) => {
  try {
    const result = await query(
      'SELECT id, name, email, role, created_at, last_login FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Usuário não encontrado.' });
    res.json({ user: result.rows[0] });
  } catch (error) {
    logger.error('Erro ao buscar usuário:', error);
    res.status(500).json({ error: 'Erro interno.' });
  }
};

/**
 * PATCH /api/v1/auth/change-password
 */
const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    const result = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const user = result.rows[0];

    const match = await bcrypt.compare(currentPassword, user.password_hash);
    if (!match) return res.status(400).json({ error: 'Senha atual incorreta.' });

    const saltRounds = parseInt(process.env.BCRYPT_ROUNDS) || 12;
    const newHash = await bcrypt.hash(newPassword, saltRounds);

    await query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [newHash, req.user.id]);

    logger.info(`Senha alterada para usuário ${req.user.id}`);
    res.json({ message: 'Senha alterada com sucesso.' });
  } catch (error) {
    logger.error('Erro ao alterar senha:', error);
    res.status(500).json({ error: 'Erro interno.' });
  }
};

module.exports = { login, register, refreshToken, getMe, changePassword };
