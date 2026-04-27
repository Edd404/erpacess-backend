const { query } = require('../config/database');
const logger = require('../utils/logger');

/**
 * Exporta as tabelas principais como JSON e envia por e-mail.
 * Roda via cron (ver backupCron abaixo).
 * No Render free tier não há pg_dump, então exportamos via SELECT.
 */
const runBackup = async () => {
  const startedAt = new Date();
  logger.info('🗄️  Iniciando backup semanal...');

  const tables = ['users', 'clients', 'service_orders'];
  const rowCounts = {};
  const exportData = {};

  try {
    for (const table of tables) {
      const res = await query(
        `SELECT * FROM ${table} WHERE deleted_at IS NULL ORDER BY created_at ASC`
      );
      exportData[table] = res.rows;
      rowCounts[table] = res.rows.length;
    }

    const fileName = `backup_${new Date().toISOString().slice(0, 10)}.json`;
    const payload = JSON.stringify({ exportedAt: startedAt.toISOString(), tables: exportData }, null, 2);

    // Envia por e-mail se configurado
    if (process.env.RESEND_API_KEY && !process.env.RESEND_API_KEY.startsWith('re_xxx')) {
      const { sendEmail } = require('./emailService');
      await sendEmail({
        to: process.env.BACKUP_EMAIL || process.env.COMPANY_EMAIL,
        subject: `Backup iStore — ${new Date().toLocaleDateString('pt-BR')}`,
        html: `
          <div style="font-family:sans-serif;padding:24px;max-width:480px">
            <h2 style="color:#0C0C0E">📦 Backup Semanal</h2>
            <p style="color:#6B7280">Backup gerado em ${startedAt.toLocaleString('pt-BR')}</p>
            <table style="width:100%;border-collapse:collapse;margin-top:16px">
              ${tables.map(t => `
                <tr>
                  <td style="padding:8px 0;color:#6B7280;border-bottom:1px solid #E5E5EA">${t}</td>
                  <td style="padding:8px 0;font-weight:600;text-align:right;border-bottom:1px solid #E5E5EA">${rowCounts[t]} registros</td>
                </tr>
              `).join('')}
            </table>
            <p style="color:#6B7280;margin-top:16px;font-size:13px">
              O arquivo JSON com todos os dados está em anexo. Guarde em local seguro.
            </p>
          </div>
        `,
        attachments: [{
          filename: fileName,
          content: Buffer.from(payload).toString('base64'),
        }],
      });
      logger.info(`✅ Backup enviado por e-mail: ${fileName}`);
    }

    // Registra no banco
    await query(
      `INSERT INTO backup_logs (status, tables, row_counts, file_name)
       VALUES ($1, $2, $3, $4)`,
      ['success', tables, JSON.stringify(rowCounts), fileName]
    );

    logger.info('✅ Backup concluído:', rowCounts);
    return { success: true, rowCounts, fileName };

  } catch (err) {
    logger.error('❌ Falha no backup:', err.message);
    await query(
      `INSERT INTO backup_logs (status, error) VALUES ('failed', $1)`,
      [err.message]
    ).catch(() => {});
    return { success: false, error: err.message };
  }
};

/**
 * Inicializa o cron de backup semanal.
 * Chame no app.js após a conexão com o banco.
 */
const startBackupCron = () => {
  // Cron simples sem dependência externa — dispara toda segunda às 03:00
  const INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

  const schedule = () => {
    const now = new Date();
    const next = new Date();
    next.setDate(now.getDate() + (1 + 7 - now.getDay()) % 7 || 7); // próxima segunda
    next.setHours(3, 0, 0, 0);
    const delay = Math.max(next - now, 60_000);

    setTimeout(async () => {
      await runBackup();
      setInterval(runBackup, INTERVAL_MS);
    }, delay);

    logger.info(`🗄️  Backup agendado para ${next.toLocaleString('pt-BR')}`);
  };

  schedule();
};

module.exports = { runBackup, startBackupCron };
