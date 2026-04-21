require('dotenv').config();
const express = require('express');
const morgan = require('morgan');
const compression = require('compression');
const path = require('path');
const fs = require('fs');

const logger = require('./utils/logger');
const routes = require('./routes');
const {
  helmetConfig,
  generalLimiter,
  corsConfig,
  xssSanitizer,
  parameterPollutionProtection,
  suspiciousRequestLogger,
} = require('./middleware/security');

// ─── Garante que a pasta de logs existe ─────────────────────────
const logsDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const app = express();

// ═══════════════════════════════════════════════════════════════
// MIDDLEWARE DE SEGURANÇA (ordem importa!)
// ═══════════════════════════════════════════════════════════════
app.set('trust proxy', 1);         // Para rate limiting correto atrás de proxy/Nginx
app.disable('x-powered-by');       // Segurança: não revela tecnologia
app.use(helmetConfig);             // Headers HTTP seguros
app.use(corsConfig);               // CORS configurado
app.use(generalLimiter);           // Rate limiting

// ═══════════════════════════════════════════════════════════════
// PARSING E SANITIZAÇÃO
// ═══════════════════════════════════════════════════════════════
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(xssSanitizer);                    // Sanitização XSS
app.use(parameterPollutionProtection);    // Proteção contra HPP
app.use(suspiciousRequestLogger);         // Log de requisições suspeitas
app.use(compression());                   // Compressão gzip

// ═══════════════════════════════════════════════════════════════
// LOGGING HTTP
// ═══════════════════════════════════════════════════════════════
const morganFormat = process.env.NODE_ENV === 'production'
  ? ':remote-addr - :method :url :status :res[content-length] - :response-time ms'
  : 'dev';

app.use(morgan(morganFormat, {
  stream: { write: (msg) => logger.http(msg.trim()) },
  skip: (req) => ['/api/v1/health', '/api/v1/ping'].includes(req.path),
}));

// ═══════════════════════════════════════════════════════════════
// ROTAS DA API
// ═══════════════════════════════════════════════════════════════
const API_PREFIX = `/api/${process.env.API_VERSION || 'v1'}`;
app.use(API_PREFIX, routes);

// Rota raiz
app.get('/', (req, res) => {
  res.json({
    name: 'iPhone Store API',
    version: '1.0.0',
    docs: `${API_PREFIX}/health`,
    timestamp: new Date().toISOString(),
  });
});

// ═══════════════════════════════════════════════════════════════
// TRATAMENTO DE ERROS
// ═══════════════════════════════════════════════════════════════

// 404
app.use((req, res) => {
  res.status(404).json({
    error: 'Rota não encontrada.',
    path: req.path,
    method: req.method,
  });
});

// Erro global (deve ser o último middleware)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Erros de JSON malformado
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON inválido no corpo da requisição.' });
  }

  // Erros de CORS
  if (err.message === 'Não permitido pelo CORS') {
    return res.status(403).json({ error: 'Origem não permitida pelo CORS.' });
  }

  const statusCode = err.statusCode || err.status || 500;

  logger.error('Erro não tratado:', {
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    path: req.path,
    method: req.method,
    ip: req.ip,
  });

  res.status(statusCode).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Erro interno do servidor.'
      : err.message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

// ═══════════════════════════════════════════════════════════════
// INICIALIZAÇÃO
// ═══════════════════════════════════════════════════════════════
const PORT = parseInt(process.env.PORT) || 3001;

const startServer = async () => {
  try {
    // Verifica conexão com o banco antes de subir
    const { healthCheck } = require('./config/database');
    const dbStatus = await healthCheck();

    if (!dbStatus.healthy) {
      logger.error('Falha ao conectar ao banco de dados. Abortando inicialização.');
      process.exit(1);
    }

    logger.info('✅ Banco de dados conectado com sucesso.');

    // Verifica e-mail (não fatal)
    const { verifyEmailConnection } = require('./services/emailService');
    await verifyEmailConnection();

    const server = app.listen(PORT, () => {
      logger.info(`🚀 iPhone Store API rodando na porta ${PORT}`);
      logger.info(`   Ambiente: ${process.env.NODE_ENV || 'development'}`);
      logger.info(`   Endpoint: http://localhost:${PORT}${API_PREFIX}`);
      logger.info(`   Health:   http://localhost:${PORT}${API_PREFIX}/health`);
    });

    // Graceful shutdown
    const shutdown = (signal) => {
      logger.info(`Sinal ${signal} recebido. Encerrando servidor graciosamente...`);
      server.close(async () => {
        const { pool } = require('./config/database');
        await pool.end();
        logger.info('Conexões encerradas. Servidor desligado.');
        process.exit(0);
      });
      setTimeout(() => {
        logger.error('Timeout no shutdown. Forçando encerramento.');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    logger.error('Erro fatal ao iniciar servidor:', error);
    process.exit(1);
  }
};

startServer();

module.exports = app; // Export para testes
