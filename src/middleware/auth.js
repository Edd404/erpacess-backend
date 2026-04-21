const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

/**
 * Verifica e decodifica o JWT da requisição
 */
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Token de autenticação não fornecido.',
      code: 'TOKEN_MISSING',
    });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: 'Token expirado. Faça login novamente.',
        code: 'TOKEN_EXPIRED',
      });
    }
    if (error.name === 'JsonWebTokenError') {
      logger.warn(`Token inválido recebido de ${req.ip}`);
      return res.status(401).json({
        error: 'Token inválido.',
        code: 'TOKEN_INVALID',
      });
    }
    logger.error('Erro na verificação do token:', error);
    return res.status(500).json({ error: 'Erro interno na autenticação.' });
  }
};

/**
 * Verifica se o usuário tem a role necessária
 */
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Não autenticado.' });
    }
    if (roles.length && !roles.includes(req.user.role)) {
      logger.warn(`Acesso negado: usuário ${req.user.id} (${req.user.role}) tentou acessar rota restrita`);
      return res.status(403).json({
        error: 'Acesso não autorizado. Permissão insuficiente.',
        code: 'FORBIDDEN',
      });
    }
    next();
  };
};

/**
 * Gera token de acesso
 */
const generateAccessToken = (payload) => {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '8h',
    issuer: 'iphone-store-api',
    audience: 'iphone-store-client',
  });
};

/**
 * Gera refresh token
 */
const generateRefreshToken = (payload) => {
  return jwt.sign(payload, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
    issuer: 'iphone-store-api',
  });
};

module.exports = { authenticate, authorize, generateAccessToken, generateRefreshToken };
