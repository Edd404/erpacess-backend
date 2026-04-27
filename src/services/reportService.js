const { query } = require('../config/database');
const logger = require('../utils/logger');

const brl = (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v || 0);
const fmt = (d) => new Date(d).toLocaleDateString('pt-BR');

const COMPANY = {
  name:  process.env.COMPANY_NAME  || 'AcessPhones',
  email: process.env.COMPANY_EMAIL || 'contato@acessphones.com.br',
  phone: process.env.COMPANY_PHONE || '(11) 99282-5424',
};

/**
 * Gera relatório mensal e envia por e-mail.
 * @param {number} month - 1-12 (padrão: mês anterior)
 * @param {number} year  - padrão: ano atual
 */
const generateMonthlyReport = async (month, year) => {
  const now = new Date();
  const targetYear  = year  || now.getFullYear();
  const targetMonth = month || (now.getMonth() === 0 ? 12 : now.getMonth()); // mês anterior

  const start = new Date(targetYear, targetMonth - 1, 1).toISOString();
  const end   = new Date(targetYear, targetMonth, 0, 23, 59, 59).toISOString();

  const monthName = new Date(targetYear, targetMonth - 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

  logger.info(`📊 Gerando relatório de ${monthName}...`);

  // ── Queries
  const [summary, prevSummary, byType, topModels, topServices, dailyRevenue] = await Promise.all([
    // Resumo do mês
    query(`
      SELECT
        COUNT(*) as total_orders,
        COUNT(*) FILTER (WHERE type='venda') as sales,
        COUNT(*) FILTER (WHERE type='manutencao') as manutencoes,
        COUNT(*) FILTER (WHERE status='concluido') as concluidos,
        COALESCE(SUM(price), 0) as revenue,
        COALESCE(AVG(price), 0) as avg_ticket,
        COUNT(DISTINCT client_id) as unique_clients
      FROM service_orders
      WHERE deleted_at IS NULL AND created_at BETWEEN $1 AND $2
    `, [start, end]),

    // Mês anterior para comparativo
    query(`
      SELECT COALESCE(SUM(price), 0) as revenue, COUNT(*) as total_orders
      FROM service_orders
      WHERE deleted_at IS NULL
        AND created_at BETWEEN $1 AND $2
    `, [
      new Date(targetYear, targetMonth - 2, 1).toISOString(),
      new Date(targetYear, targetMonth - 1, 0, 23, 59, 59).toISOString(),
    ]),

    // Por tipo
    query(`
      SELECT type, COUNT(*) as count, COALESCE(SUM(price), 0) as revenue
      FROM service_orders
      WHERE deleted_at IS NULL AND created_at BETWEEN $1 AND $2
      GROUP BY type
    `, [start, end]),

    // Top modelos
    query(`
      SELECT iphone_model, COUNT(*) as count, COALESCE(SUM(price), 0) as revenue
      FROM service_orders
      WHERE deleted_at IS NULL AND type='venda' AND created_at BETWEEN $1 AND $2
      GROUP BY iphone_model ORDER BY revenue DESC LIMIT 5
    `, [start, end]),

    // Serviços mais lucrativos (extraído das notas)
    query(`
      SELECT
        COALESCE(SUM(price), 0) as revenue,
        COUNT(*) as count
      FROM service_orders
      WHERE deleted_at IS NULL AND type='manutencao' AND created_at BETWEEN $1 AND $2
    `, [start, end]),

    // Receita diária
    query(`
      SELECT DATE(created_at) as day, COALESCE(SUM(price), 0) as revenue, COUNT(*) as orders
      FROM service_orders
      WHERE deleted_at IS NULL AND created_at BETWEEN $1 AND $2
      GROUP BY DATE(created_at) ORDER BY day ASC
    `, [start, end]),
  ]);

  const s   = summary.rows[0];
  const ps  = prevSummary.rows[0];
  const rev = parseFloat(s.revenue);
  const prevRev = parseFloat(ps.revenue);
  const revGrowth = prevRev > 0 ? ((rev - prevRev) / prevRev * 100).toFixed(1) : 0;

  // ── HTML do e-mail
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#F2F2F7;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;color:#1C1C1E}
  .wrap{max-width:600px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.08)}
  .hd{background:#0C0C0E;padding:28px 32px}
  .hd h1{color:#fff;font-size:20px;font-weight:700}
  .hd p{color:#8E8E93;font-size:13px;margin-top:4px}
  .accent{height:3px;background:#0A66FF}
  .bd{padding:28px 32px}
  .kpi-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:24px}
  .kpi{background:#F2F2F7;border-radius:10px;padding:16px}
  .kpi-label{font-size:11px;font-weight:600;color:#8E8E93;text-transform:uppercase;letter-spacing:.5px}
  .kpi-value{font-size:22px;font-weight:700;color:#0C0C0E;margin-top:4px}
  .kpi-sub{font-size:11px;color:#8E8E93;margin-top:2px}
  .section{margin-bottom:24px}
  .section-title{font-size:11px;font-weight:700;color:#8E8E93;text-transform:uppercase;letter-spacing:.8px;margin-bottom:12px}
  .row{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #E5E5EA}
  .row:last-child{border-bottom:none}
  .badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600}
  .green{color:#16A34A;background:#F0FDF4}
  .red{color:#DC2626;background:#FEF2F2}
  .ft{background:#F2F2F7;padding:16px 32px;text-align:center}
  .ft p{color:#8E8E93;font-size:11px}
</style></head>
<body>
<div class="wrap">
  <div class="hd">
    <h1>📊 Relatório Mensal</h1>
    <p>${monthName.charAt(0).toUpperCase() + monthName.slice(1)} · ${COMPANY.name}</p>
  </div>
  <div class="accent"></div>
  <div class="bd">

    <div class="kpi-grid">
      <div class="kpi">
        <div class="kpi-label">Receita total</div>
        <div class="kpi-value">${brl(rev)}</div>
        <div class="kpi-sub">${revGrowth >= 0 ? '▲' : '▼'} ${Math.abs(revGrowth)}% vs mês anterior</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Atendimentos</div>
        <div class="kpi-value">${s.total_orders}</div>
        <div class="kpi-sub">${s.concluidos} concluídos</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Ticket médio</div>
        <div class="kpi-value">${brl(s.avg_ticket)}</div>
        <div class="kpi-sub">Por atendimento</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Clientes ativos</div>
        <div class="kpi-value">${s.unique_clients}</div>
        <div class="kpi-sub">${s.sales} vendas · ${s.manutencoes} manutenções</div>
      </div>
    </div>

    ${topModels.rows.length > 0 ? `
    <div class="section">
      <div class="section-title">Modelos mais vendidos</div>
      ${topModels.rows.map((m, i) => `
        <div class="row">
          <span style="font-size:13px;color:#3A3A3C">${i + 1}. ${m.iphone_model}</span>
          <div style="text-align:right">
            <div style="font-size:13px;font-weight:600">${brl(m.revenue)}</div>
            <div style="font-size:11px;color:#8E8E93">${m.count} un.</div>
          </div>
        </div>
      `).join('')}
    </div>` : ''}

    <div class="section">
      <div class="section-title">Por tipo</div>
      ${byType.rows.map(t => `
        <div class="row">
          <span style="font-size:13px;color:#3A3A3C">${t.type === 'venda' ? '📱 Vendas' : '🔧 Manutenções'}</span>
          <div style="text-align:right">
            <div style="font-size:13px;font-weight:600">${brl(t.revenue)}</div>
            <div style="font-size:11px;color:#8E8E93">${t.count} atend.</div>
          </div>
        </div>
      `).join('')}
    </div>

    <div style="background:#F0FDF4;border-radius:10px;padding:16px;margin-top:8px">
      <div style="font-size:12px;color:#16A34A;font-weight:600">
        ${parseFloat(revGrowth) >= 0
          ? `✅ Crescimento de ${revGrowth}% em relação ao mês anterior`
          : `⚠️ Queda de ${Math.abs(revGrowth)}% em relação ao mês anterior`}
      </div>
      <div style="font-size:11px;color:#166534;margin-top:4px">
        Mês anterior: ${brl(prevRev)} · ${ps.total_orders} atendimentos
      </div>
    </div>

  </div>
  <div class="ft">
    <p>${COMPANY.name} · ${COMPANY.phone} · ${COMPANY.email}</p>
    <p style="margin-top:4px">Relatório gerado automaticamente em ${fmt(new Date())}</p>
  </div>
</div>
</body></html>`;

  // Envia e-mail
  let emailSent = false;
  if (process.env.RESEND_API_KEY && !process.env.RESEND_API_KEY.startsWith('re_xxx')) {
    try {
      const { sendEmail } = require('./emailService');
      await sendEmail({
        to: process.env.REPORT_EMAIL || process.env.COMPANY_EMAIL,
        subject: `Relatório Mensal ${monthName} — ${COMPANY.name}`,
        html,
      });
      emailSent = true;
      logger.info(`✅ Relatório mensal enviado para ${process.env.REPORT_EMAIL || process.env.COMPANY_EMAIL}`);
    } catch (err) {
      logger.error('Falha ao enviar relatório:', err.message);
    }
  }

  return {
    month: targetMonth, year: targetYear, monthName,
    metrics: { revenue: rev, totalOrders: parseInt(s.total_orders), avgTicket: parseFloat(s.avg_ticket), uniqueClients: parseInt(s.unique_clients), revGrowth },
    emailSent,
  };
};

/**
 * Cron mensal — dispara no dia 1 às 07:00
 */
const startReportCron = () => {
  const scheduleNext = () => {
    const now  = new Date();
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1, 7, 0, 0);
    const delay = next - now;
    setTimeout(async () => {
      await generateMonthlyReport();
      scheduleNext();
    }, delay);
    logger.info(`📊 Relatório mensal agendado para ${next.toLocaleString('pt-BR')}`);
  };
  scheduleNext();
};

module.exports = { generateMonthlyReport, startReportCron };
