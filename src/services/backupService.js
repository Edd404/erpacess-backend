const zlib = require('zlib');
const { query } = require('../config/database');
const logger    = require('../utils/logger');

// ── Tabelas exportadas em cada backup ─────────────────────────
const TABLES = ['users', 'clients', 'service_orders'];

// ── E-mail fixo do destinatário ────────────────────────────────
const BACKUP_RECIPIENT = process.env.BACKUP_EMAIL || 'eddjpog@gmail.com';

// ── Executa o backup completo ──────────────────────────────────
const runBackup = async () => {
  const startedAt = new Date();
  logger.info('🗄️  Iniciando backup diário...');

  const exportData  = {};
  const rowCounts   = {};

  try {
    // 1. Exportar cada tabela
    for (const table of TABLES) {
      const res = await query(
        `SELECT * FROM ${table} WHERE deleted_at IS NULL ORDER BY created_at ASC`
      );
      exportData[table] = res.rows;
      rowCounts[table]  = res.rows.length;
    }

    const fileName = `backup_${startedAt.toISOString().slice(0, 10)}.json.gz`;
    const jsonStr  = JSON.stringify(
      { exportedAt: startedAt.toISOString(), tables: exportData },
      null, 2
    );

    // 2. Comprimir com gzip
    const compressed = await new Promise((resolve, reject) => {
      zlib.gzip(Buffer.from(jsonStr, 'utf8'), { level: 9 }, (err, buf) => {
        if (err) reject(err); else resolve(buf);
      });
    });

    const sizeKB = (compressed.length / 1024).toFixed(1);

    // 3. Enviar por e-mail
    const canSend = process.env.RESEND_API_KEY &&
                    !process.env.RESEND_API_KEY.startsWith('re_xxx');

    if (canSend) {
      const { sendEmail } = require('./emailService');

      const totalRows = Object.values(rowCounts).reduce((a, b) => a + b, 0);
      const dateStr   = startedAt.toLocaleDateString('pt-BR', {
        weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
      });
      const timeStr   = startedAt.toLocaleTimeString('pt-BR', {
        hour: '2-digit', minute: '2-digit',
      });

      const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Backup iStore</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#F2F2F7;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;color:#1C1C1E;-webkit-font-smoothing:antialiased}
  .wrap{max-width:520px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.10)}
  .hd{background:#0C0C0E;padding:26px 28px}
  .hd-top{display:flex;align-items:center;justify-content:space-between;gap:12px}
  .brand h1{color:#fff;font-size:18px;font-weight:700;letter-spacing:-.3px}
  .brand h1 span{color:rgba(255,255,255,.3);font-weight:400}
  .brand p{color:#636366;font-size:11px;margin-top:3px}
  .badge{background:rgba(52,199,89,0.18);color:#34C759;padding:5px 12px;border-radius:999px;font-size:11px;font-weight:600;white-space:nowrap}
  .hd-rule{height:1px;background:rgba(255,255,255,.07);margin:16px 0 12px}
  .hd-sub{color:rgba(255,255,255,.28);font-size:11px;font-family:'Courier New',monospace;letter-spacing:.5px}
  .bd{padding:28px}
  .title{font-size:20px;font-weight:700;color:#0C0C0E;letter-spacing:-.3px;margin-bottom:6px}
  .lead{color:#3A3A3C;font-size:13px;line-height:1.6;margin-bottom:24px}
  .card{border:1px solid #E5E5EA;border-radius:12px;overflow:hidden;margin-bottom:14px}
  .card-title{font-size:9px;font-weight:700;color:#8E8E93;text-transform:uppercase;letter-spacing:1.2px;padding:10px 16px;background:#F9F9FB;border-bottom:1px solid #E5E5EA}
  .row{display:flex;justify-content:space-between;align-items:center;padding:10px 16px;border-bottom:1px solid #F2F2F7}
  .row:last-child{border-bottom:none}
  .lbl{font-size:12px;color:#6C6C70}
  .val{font-size:13px;font-weight:600;color:#0C0C0E}
  .val.green{color:#16A34A}
  .ok{background:#F0FDF4;border:1px solid #86EFAC;border-radius:10px;padding:14px 16px;display:flex;align-items:center;gap:12px;margin-top:4px}
  .ok-icon{width:34px;height:34px;background:#16A34A;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0}
  .ok-text p{font-size:12px;color:#166534;line-height:1.55}
  .ft{background:#F9F9FB;border-top:1px solid #E5E5EA;padding:18px 28px;text-align:center}
  .ft p{font-size:11px;color:#8E8E93;line-height:1.7}
  .ft strong{color:#0C0C0E}
</style>
</head>
<body>
<div class="wrap">
  <div class="hd">
    <div class="hd-top">
      <div class="brand">
        <h1>Acess<span>phones</span></h1>
        <p>Backup Automático — iStore</p>
      </div>
      <div class="badge">✓ Backup OK</div>
    </div>
    <div class="hd-rule"></div>
    <div class="hd-sub">${dateStr} às ${timeStr}</div>
  </div>

  <div class="bd">
    <p class="title">Backup diário concluído 🗄️</p>
    <p class="lead">Todos os dados do iStore foram exportados com sucesso e estão em anexo no arquivo <strong>${fileName}</strong>.</p>

    <div class="card">
      <div class="card-title">Tabelas exportadas</div>
      ${TABLES.map(t => `
      <div class="row">
        <span class="lbl">${t}</span>
        <span class="val">${(rowCounts[t] || 0).toLocaleString('pt-BR')} registros</span>
      </div>`).join('')}
      <div class="row">
        <span class="lbl">Total de registros</span>
        <span class="val green">${totalRows.toLocaleString('pt-BR')}</span>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Arquivo</div>
      <div class="row">
        <span class="lbl">Nome</span>
        <span class="val">${fileName}</span>
      </div>
      <div class="row">
        <span class="lbl">Tamanho comprimido</span>
        <span class="val">${sizeKB} KB</span>
      </div>
      <div class="row">
        <span class="lbl">Formato</span>
        <span class="val">JSON + GZIP</span>
      </div>
    </div>

    <div class="ok">
      <div class="ok-icon">🛡️</div>
      <div class="ok-text">
        <p><strong>Guarde este e-mail.</strong> O arquivo .json.gz pode ser aberto com qualquer descompressor (WinRAR, 7-Zip, macOS nativo). Os dados estão no formato JSON, legível por qualquer editor de texto.</p>
      </div>
    </div>
  </div>

  <div class="ft">
    <p><strong>iStore · Acessphones</strong></p>
    <p>Backup automático gerado às ${timeStr} · Próximo backup amanhã às 03:00</p>
    <p style="margin-top:6px;color:#C7C7CC;font-size:10px">Este e-mail é gerado automaticamente — não responda.</p>
  </div>
</div>
</body>
</html>`;

      await sendEmail({
        to: BACKUP_RECIPIENT,
        subject: `🗄️ Backup iStore — ${startedAt.toLocaleDateString('pt-BR')}`,
        html,
        attachments: [{
          filename: fileName,
          content:  compressed.toString('base64'),
        }],
      });

      logger.info(`✅ Backup enviado para ${BACKUP_RECIPIENT} (${sizeKB} KB)`);
    } else {
      logger.warn('⚠️  Resend não configurado — backup gerado mas não enviado por e-mail.');
    }

    // 4. Registrar no banco
    await query(
      `INSERT INTO backup_logs (status, tables, row_counts, file_name)
       VALUES ($1, $2, $3, $4)`,
      ['success', TABLES, JSON.stringify(rowCounts), fileName]
    );

    logger.info('✅ Backup diário concluído:', rowCounts);
    return { success: true, rowCounts, fileName, sizeKB };

  } catch (err) {
    logger.error('❌ Falha no backup:', err.message);
    await query(
      `INSERT INTO backup_logs (status, error) VALUES ('failed', $1)`,
      [err.message]
    ).catch(() => {});
    return { success: false, error: err.message };
  }
};

// ── Cron diário às 03:00 (sem dependência externa) ─────────────
const startBackupCron = () => {
  const scheduleNext = () => {
    const now  = new Date();
    const next = new Date();

    // Próximas 03:00
    next.setHours(3, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1); // já passou hoje → amanhã

    const delay = next - now;
    const hh    = String(next.getHours()).padStart(2, '0');
    const mm    = String(next.getMinutes()).padStart(2, '0');
    const dd    = next.toLocaleDateString('pt-BR');

    logger.info(`🗄️  Próximo backup agendado: ${dd} às ${hh}:${mm} (em ${Math.round(delay / 60000)} min)`);

    setTimeout(async () => {
      await runBackup();
      scheduleNext(); // reagendar para o dia seguinte
    }, delay);
  };

  scheduleNext();
};

module.exports = { runBackup, startBackupCron };
