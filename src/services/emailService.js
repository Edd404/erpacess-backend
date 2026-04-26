const logger = require('../utils/logger');
const { formatDateBR, formatCurrency } = require('../utils/helpers');

const COMPANY = {
  name:  process.env.COMPANY_NAME  || 'AcessPhones',
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

  const typeLabel = orderData.type === 'venda' ? 'Venda' : 'Manutenção';
  const firstName = orderData.client_name.split(' ')[0];
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
  .wrap{max-width:580px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.08)}

  /* Header */
  .hd{background:#0C0C0E;padding:32px 36px 28px}
  .hd-top{display:flex;align-items:center;gap:16px;margin-bottom:16px}
  .hd-icon{width:48px;height:48px;background:#0A66FF;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;color:#fff;flex-shrink:0;line-height:1}
  .hd-brand{flex:1}
  .hd-brand h1{color:#fff;font-size:20px;font-weight:700;letter-spacing:-.3px}
  .hd-brand p{color:#8E8E93;font-size:12px;margin-top:2px}
  .hd-badge{display:inline-flex;align-items:center;gap:6px;background:#0A66FF;color:#fff;padding:6px 14px;border-radius:999px;font-size:12px;font-weight:600;letter-spacing:.3px}
  .hd-divider{height:2px;background:linear-gradient(90deg,#0A66FF,#0C0C0E);margin-top:20px;border-radius:1px}

  /* Body */
  .bd{padding:36px}
  .greeting{font-size:22px;font-weight:700;letter-spacing:-.3px;margin-bottom:8px}
  .lead{color:#48484A;font-size:15px;line-height:1.6;margin-bottom:28px}

  /* Cards */
  .card{background:#F2F2F7;border-radius:12px;padding:20px;margin-bottom:16px}
  .card-title{font-size:10px;font-weight:700;color:#8E8E93;text-transform:uppercase;letter-spacing:1px;margin-bottom:14px}
  .row{display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid #E5E5EA}
  .row:last-child{border-bottom:none;padding-bottom:0}
  .row-label{font-size:13px;color:#8E8E93}
  .row-val{font-size:13px;font-weight:600;color:#1C1C1E}
  .row-val.mono{font-family:'Courier New',monospace;font-size:12px}
  .row-val.price{font-size:16px;font-weight:700;color:#0C0C0E}

  /* Warranty banner */
  .warranty{background:#F0FDF4;border-radius:12px;border:1.5px solid #86EFAC;padding:20px;margin:20px 0;display:flex;align-items:center;gap:16px}
  .warranty-icon{width:44px;height:44px;background:#16A34A;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0}
  .warranty-text h3{color:#16A34A;font-size:15px;font-weight:700;margin-bottom:2px}
  .warranty-text p{color:#166534;font-size:12px}

  /* CTA Note */
  .note{background:#FFF9C4;border-left:3px solid #D97706;border-radius:0 8px 8px 0;padding:14px 16px;margin-top:16px}
  .note p{font-size:12px;color:#92400E;line-height:1.6}

  /* Footer */
  .ft{background:#F2F2F7;border-top:1px solid #E5E5EA;padding:20px 36px;text-align:center}
  .ft p{color:#8E8E93;font-size:11px;line-height:1.8}
  .ft .company{font-weight:600;color:#48484A;font-size:12px;margin-bottom:4px}
</style>
</head>
<body>
<div class="wrap">

  <div class="hd">
    <div class="hd-top">
      <div class="hd-icon">A</div>
      <div class="hd-brand">
        <h1>${COMPANY.name}</h1>
        <p>Especializada em iPhones Novos e Usados</p>
      </div>
    </div>
    <div class="hd-badge">✓ ${typeLabel} Confirmada</div>
    <div class="hd-divider"></div>
  </div>

  <div class="bd">
    <p class="greeting">Olá, ${firstName}! 👋</p>
    <p class="lead">Seu atendimento foi registrado com sucesso. O comprovante em PDF está em anexo — guarde-o para eventual acionamento da garantia.</p>

    <div class="card">
      <div class="card-title">Resumo do Atendimento</div>
      <div class="row">
        <span class="row-label">Nº Atendimento</span>
        <span class="row-val">${orderData.order_number}</span>
      </div>
      <div class="row">
        <span class="row-label">Data</span>
        <span class="row-val">${formatDateBR(orderData.created_at)}</span>
      </div>
      <div class="row">
        <span class="row-label">Tipo</span>
        <span class="row-val">${typeLabel}</span>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Produto</div>
      <div class="row">
        <span class="row-label">Modelo</span>
        <span class="row-val">${orderData.iphone_model}${orderData.capacity ? ` · ${orderData.capacity}` : ''}${orderData.color ? ` · ${orderData.color}` : ''}</span>
      </div>
      ${orderData.imei ? `
      <div class="row">
        <span class="row-label">IMEI</span>
        <span class="row-val mono">${orderData.imei}</span>
      </div>` : ''}
      <div class="row">
        <span class="row-label">Valor</span>
        <span class="row-val price">${formatCurrency(orderData.price)}</span>
      </div>
    </div>

    ${hasWarranty ? `
    <div class="warranty">
      <div class="warranty-icon">🛡️</div>
      <div class="warranty-text">
        <h3>${orderData.warranty_months} ${orderData.warranty_months === 1 ? 'Mês' : 'Meses'} de Garantia</h3>
        <p>A partir de ${formatDateBR(orderData.created_at)} — verifique as condições no PDF anexo.</p>
      </div>
    </div>` : ''}

    <div class="note">
      <p>📎 <strong>O Termo de Garantia em PDF está em anexo.</strong> Salve o arquivo — ele será exigido para acionar a garantia presencialmente na loja.</p>
    </div>
  </div>

  <div class="ft">
    <p class="company">${COMPANY.name}</p>
    <p>${COMPANY.phone} · <a href="mailto:${COMPANY.email}">${COMPANY.email}</a></p>
    <p style="margin-top:8px;font-size:10px">Este é um e-mail automático. Por favor, não responda.</p>
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
