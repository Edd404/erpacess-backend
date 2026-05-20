const logger = require('../utils/logger');
const { formatDateBR, formatCurrency } = require('../utils/helpers');

const COMPANY = {
  name:  process.env.COMPANY_NAME  || 'Acessphones',
  phone: process.env.COMPANY_PHONE || '(11) 99282-5424',
  email: process.env.COMPANY_EMAIL || 'contato@acessphones.com.br',
};

const sendEmail = async ({ to, subject, html, attachments = [] }) => {
  const payload = {
    from: `${process.env.EMAIL_FROM_NAME || COMPANY.name} <${process.env.EMAIL_FROM_ADDRESS}>`,
    to: [to],
    subject,
    html,
    attachments,
  };

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Resend API error: ${error.message || response.statusText}`);
  }

  return response.json();
};

const verifyEmailConnection = async () => {
  if (!process.env.RESEND_API_KEY || process.env.RESEND_API_KEY.startsWith('re_xxx')) {
    logger.warn('RESEND_API_KEY não configurada. E-mails não serão enviados.');
    return false;
  }
  logger.info('✅ Resend API configurada.');
  return true;
};

const sendWarrantyEmail = async (orderData, pdfBuffer) => {
  if (!orderData.client_email) {
    logger.info(`Ordem ${orderData.order_number}: cliente sem e-mail, envio ignorado.`);
    return { sent: false, reason: 'Cliente sem e-mail cadastrado.' };
  }

  if (!process.env.RESEND_API_KEY || process.env.RESEND_API_KEY.startsWith('re_xxx')) {
    logger.warn('Resend não configurado. Pulando envio de e-mail.');
    return { sent: false, reason: 'RESEND_API_KEY não configurada.' };
  }

  const typeLabel  = orderData.type === 'venda' ? 'Venda' : 'Manutenção';
  const firstName  = orderData.client_name.split(' ')[0];
  const hasWarranty = orderData.warranty_months > 0;

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Comprovante de Atendimento</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#F2F2F7;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;color:#1C1C1E;-webkit-font-smoothing:antialiased}
  a{color:#0A66FF;text-decoration:none}
  .wrap{max-width:560px;margin:32px auto;background:#FFFFFF;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.10)}

  /* ── Header ── */
  .hd{background:#0C0C0E;padding:28px 32px 24px}
  .hd-top{display:flex;align-items:center;justify-content:space-between;gap:12px}
  .hd-brand h1{color:#FFFFFF;font-size:19px;font-weight:700;letter-spacing:-.3px;line-height:1}
  .hd-brand h1 span{color:rgba(255,255,255,0.32);font-weight:400}
  .hd-brand p{color:#636366;font-size:11px;margin-top:4px}
  .hd-badge{display:inline-flex;align-items:center;gap:5px;background:rgba(10,102,255,0.20);color:#60A5FA;padding:5px 12px;border-radius:999px;font-size:11px;font-weight:600;letter-spacing:.3px;white-space:nowrap;flex-shrink:0}
  .hd-rule{height:1px;background:rgba(255,255,255,0.07);margin:18px 0 14px}
  .hd-os{color:rgba(255,255,255,0.28);font-size:11px;font-family:'Courier New',monospace;letter-spacing:.6px}

  /* ── Body ── */
  .bd{padding:32px 32px 24px}
  .greeting{font-size:22px;font-weight:700;letter-spacing:-.4px;color:#0C0C0E;margin-bottom:8px}
  .lead{color:#3A3A3C;font-size:14px;line-height:1.65;margin-bottom:28px}

  /* ── Cards ── */
  .card{border-radius:12px;border:1px solid #E5E5EA;overflow:hidden;margin-bottom:14px}
  .card-title{font-size:9px;font-weight:700;color:#8E8E93;text-transform:uppercase;letter-spacing:1.2px;padding:11px 16px;background:#F9F9FB;border-bottom:1px solid #E5E5EA}
  .row{display:flex;justify-content:space-between;align-items:center;padding:11px 16px;border-bottom:1px solid #F2F2F7}
  .row:last-child{border-bottom:none}
  .lbl{font-size:13px;color:#6C6C70}
  .val{font-size:13px;font-weight:600;color:#0C0C0E;text-align:right}
  .val.mono{font-family:'Courier New',monospace;font-size:12px;font-weight:400;color:#3A3A3C;letter-spacing:.3px}
  .val.price{font-size:17px;font-weight:700;letter-spacing:-.4px}

  /* ── Warranty ── */
  .warranty{background:#F0FDF4;border-radius:12px;border:1px solid #86EFAC;padding:18px 20px;margin:16px 0;display:flex;align-items:flex-start;gap:14px}
  .w-icon{width:40px;height:40px;background:#16A34A;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0}
  .w-text h3{color:#15803D;font-size:14px;font-weight:700;margin-bottom:4px}
  .w-text p{color:#166534;font-size:12px;line-height:1.55}

  /* ── Note ── */
  .note{background:#FFFBEB;border-radius:10px;border:1px solid #FDE68A;padding:14px 16px;margin-top:14px}
  .note p{font-size:12px;color:#92400E;line-height:1.65}

  /* ── Footer ── */
  .ft{background:#F9F9FB;border-top:1px solid #E5E5EA;padding:22px 32px;text-align:center}
  .ft-name{font-weight:700;color:#0C0C0E;font-size:13px;margin-bottom:6px}
  .ft-info{color:#8E8E93;font-size:12px;line-height:1.7}
  .ft-auto{color:#C7C7CC;font-size:10px;margin-top:10px}
</style>
</head>
<body>
<div class="wrap">

  <!-- Header -->
  <div class="hd">
    <div class="hd-top">
      <div class="hd-brand">
        <h1>Acess<span>phones</span></h1>
        <p>Especializada em iPhones</p>
      </div>
      <div class="hd-badge">✓ ${typeLabel} Confirmada</div>
    </div>
    <div class="hd-rule"></div>
    <div class="hd-os">${orderData.order_number}</div>
  </div>

  <!-- Body -->
  <div class="bd">
    <p class="greeting">Olá, ${firstName}! 👋</p>
    <p class="lead">Seu atendimento foi registrado com sucesso. O comprovante em PDF está em anexo — guarde-o para eventual acionamento da garantia.</p>

    <!-- Resumo -->
    <div class="card">
      <div class="card-title">Resumo do Atendimento</div>
      <div class="row">
        <span class="lbl">Nº Atendimento</span>
        <span class="val">${orderData.order_number}</span>
      </div>
      <div class="row">
        <span class="lbl">Data</span>
        <span class="val">${formatDateBR(orderData.created_at)}</span>
      </div>
      <div class="row">
        <span class="lbl">Tipo</span>
        <span class="val">${typeLabel}</span>
      </div>
    </div>

    <!-- Produto -->
    <div class="card">
      <div class="card-title">Produto</div>
      <div class="row">
        <span class="lbl">Modelo</span>
        <span class="val">${orderData.iphone_model}${orderData.capacity ? ` · ${orderData.capacity}` : ''}${orderData.color ? ` · ${orderData.color}` : ''}</span>
      </div>
      ${orderData.imei ? `
      <div class="row">
        <span class="lbl">IMEI</span>
        <span class="val mono">${orderData.imei}</span>
      </div>` : ''}
      <div class="row">
        <span class="lbl">Valor</span>
        <span class="val price">${formatCurrency(orderData.price)}</span>
      </div>
    </div>

    <!-- Garantia -->
    ${hasWarranty ? `
    <div class="warranty">
      <div class="w-icon">🛡️</div>
      <div class="w-text">
        <h3>${orderData.warranty_months} ${orderData.warranty_months === 1 ? 'Mês' : 'Meses'} de Garantia</h3>
        <p>Válida a partir de ${formatDateBR(orderData.created_at)}.<br>Condições completas no PDF em anexo.</p>
      </div>
    </div>` : ''}

    <!-- Aviso PDF -->
    <div class="note">
      <p>📎 <strong>O Termo de Garantia completo está em anexo.</strong> Salve o arquivo — ele será exigido para acionar a garantia presencialmente na loja.</p>
    </div>
  </div>

  <!-- Footer -->
  <div class="ft">
    <p class="ft-name">Acessphones</p>
    <p class="ft-info">${COMPANY.phone} · <a href="mailto:${COMPANY.email}">${COMPANY.email}</a></p>
    <p class="ft-auto">Este é um e-mail automático — por favor, não responda diretamente.</p>
  </div>

</div>
</body>
</html>`;

  try {
    const pdfBase64 = pdfBuffer.toString('base64');

    const result = await sendEmail({
      to: orderData.client_email,
      subject: `Comprovante Nº ${orderData.order_number} — ${COMPANY.name}`,
      html,
      attachments: [{
        filename: `Comprovante_${orderData.order_number}.pdf`,
        content: pdfBase64,
      }],
    });

    logger.info(`E-mail enviado para ${orderData.client_email}. ID: ${result.id}`);
    return { sent: true, messageId: result.id };
  } catch (error) {
    logger.error(`Falha ao enviar e-mail para ${orderData.client_email}:`, error.message);
    return { sent: false, reason: error.message };
  }
};

module.exports = { sendWarrantyEmail, verifyEmailConnection };
