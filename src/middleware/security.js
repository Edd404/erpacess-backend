const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const xss = require('xss');
const logger = require('../utils/logger');

const helmetConfig = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
    },
  },
  crossOriginEmbedderPolicy: true,
  crossOriginOpenerPolicy: true,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  dnsPrefetchControl: { allow: false },
  frameguard: { action: 'deny' },
  hidePoweredBy: true,
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  ieNoOpen: true,
  noSniff: true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  xssFilter: true,
});

const generalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Tente novamente em alguns minutos.', retryAfter: null },
  handler: (req, res, next, options) => {
    logger.warn(`Rate limit excedido: ${req.ip} - ${req.path}`);
    res.status(429).json(options.message);
  },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.AUTH_RATE_LIMIT_MAX) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Muitas tentativas de login. Aguarde 15 minutos antes de tentar novamente.' },
  handler: (req, res, next, options) => {
    logger.warn(`Brute force detectado: ${req.ip} - ${req.body?.email || 'unknown'}`);
    res.status(429).json(options.message);
  },
});

const corsConfig = cors({
  origin: (origin, callback) => {
    const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:3000').split(',');
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      logger.warn(`CORS bloqueado para origem: ${origin}`);
      callback(new Error('Não permitido pelo CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['X-Total-Count', 'X-Page', 'X-Per-Page'],
  credentials: true,
  maxAge: 86400,
});

/**
 * Middleware de sanitização XSS
 * CORRIGIDO: arrays agora são preservados corretamente.
 * Antes, ["pix","cartao_credito"] virava {"0":"pix","1":"cartao_credito"}
 * porque Object.entries() indexava o array como objeto.
 */
const xssSanitizer = (req, res, next) => {
  const XSS_OPTIONS = {
    whiteList: {},
    stripIgnoreTag: true,
    stripIgnoreTagBody: ['script', 'style'],
  };

  const sanitize = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;

    // ✅ Trata arrays separadamente — preserva o tipo
    if (Array.isArray(obj)) {
      return obj.map((item) => {
        if (typeof item === 'string') return xss(item, XSS_OPTIONS);
        if (typeof item === 'object' && item !== null) return sanitize(item);
        return item;
      });
    }

    // Objetos normais
    const sanitized = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        sanitized[key] = xss(value, XSS_OPTIONS);
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = sanitize(value);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  };

  if (req.body)  req.body  = sanitize(req.body);
  if (req.query) req.query = sanitize(req.query);
  next();
};

const parameterPollutionProtection = (req, res, next) => {
  if (req.query) {
    for (const key in req.query) {
      if (Array.isArray(req.query[key])) {
        req.query[key] = req.query[key][req.query[key].length - 1];
      }
    }
  }
  next();
};

const suspiciousRequestLogger = (req, res, next) => {
  const suspiciousPatterns = [
    /(\<script|\<\/script|javascript:|on\w+\s*=)/i,
    /(union|select|insert|update|delete|drop|truncate|exec|execute)\s/i,
    /\.\.\//g,
    /(%00|%0d%0a|%0a%0d)/i,
  ];

  const checkString = (str) => suspiciousPatterns.some((p) => p.test(str));
  const bodyStr  = JSON.stringify(req.body  || {});
  const queryStr = JSON.stringify(req.query || {});

  if (checkString(bodyStr) || checkString(queryStr)) {
    logger.warn('Requisição suspeita detectada', {
      ip: req.ip, method: req.method, path: req.path,
      userAgent: req.get('User-Agent'),
    });
  }
  next();
};

module.exports = {
  helmetConfig, generalLimiter, authLimiter, corsConfig,
  xssSanitizer, parameterPollutionProtection, suspiciousRequestLogger,
};
