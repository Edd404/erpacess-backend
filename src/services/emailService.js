const logger = require('../utils/logger');
const { formatDateBR, formatCurrency } = require('../utils/helpers');

/**
 * Envia e-mail via Resend API (REST direto, sem SDK)
 * Funciona no free tier: 3.000 e-mails/mês, 100/dia
 */
const sendEmail = async ({ to, subject, html, attachments = [] }) => {
  const payload = {
    from: `${process.env.EMAIL_FROM_NAME || 'iPhone Store'} <${process.env.EMAIL_FROM_ADDRESS}>`,
    to: [to],
    subject,
    html,
    attachments,
  };

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
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

/**
 * Verifica se a chave do Resend está configurada
 */
const verifyEmailConnection = async () => {
  if (!process.env.RESEND_API_KEY || process.env.RESEND_API_KEY.startsWith('re_xxx')) {
    logger.warn('RESEND_API_KEY não configurada. E-mails não serão enviados.');
    return false;
  }
  logger.info('✅ Resend API configurada.');
  return true;
};

/**
 * Envia o Termo de Garantia por e-mail com PDF anexado
 */
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

  const html = `
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        *{margin:0;padding:0;box-sizing:border-box;}
        body{font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;background:#F5F5F7;color:#1D1D1F;}
        .container{max-width:600px;margin:40px auto;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);}
        .header{background:#1D1D1F;padding:40px 40px 30px;text-align:center;}
        .header h1{color:#fff;font-size:24px;font-weight:700;letter-spacing:-.5px;}
        .header p{color:#6E6E73;font-size:13px;margin-top:8px;}
        .badge{display:inline-block;background:#0071E3;color:#fff;padding:8px 20px;border-radius:20px;font-size:12px;font-weight:600;margin-top:16px;letter-spacing:.5px;text-transform:uppercase;}
        .body{padding:40px;}
        .greeting{font-size:22px;font-weight:600;margin-bottom:12px;}
        .subtitle{color:#6E6E73;font-size:15px;line-height:1.6;margin-bottom:32px;}
        .section-title{font-size:11px;font-weight:700;color:#6E6E73;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;}
        .info-card{background:#F5F5F7;border-radius:12px;padding:20px;margin-bottom:20px;}
        .info-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #E5E5EA;}
        .info-row:last-child{border-bottom:none;}
        .info-label{color:#6E6E73;font-size:13px;}
        .info-value{font-size:13px;font-weight:600;}
        .warranty-banner{background:#30D158;border-radius:12px;padding:20px;text-align:center;margin:24px 0;}
        .warranty-banner .wt{color:#fff;font-size:18px;font-weight:700;}
        .warranty-banner .wd{color:rgba(255,255,255,.85);font-size:13px;margin-top:4px;}
        .note{background:#FFF9C4;border-radius:8px;padding:14px;font-size:12px;color:#6E6E73;line-height:1.5;}
        .footer{background:#F5F5F7;padding:24px 40px;text-align:center;border-top:1px solid #E5E5EA;}
        .footer p{color:#6E6E73;font-size:11px;line-height:1.8;}
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>iPhone Store</h1>
          <p>Especializada em iPhones Novos e Usados</p>
          <span class="badge">${typeLabel} Confirmada</span>
        </div>
        <div class="body">
          <p class="greeting">Olá, ${orderData.client_name.split(' ')[0]}! 👋</p>
          <p class="subtitle">Seu atendimento foi registrado. O Termo de Garantia está em anexo (PDF).</p>
          <p class="section-title">Resumo do Atendimento</p>
          <div class="info-card">
            <div class="info-row"><span class="info-label">Nº Atendimento</span><span class="info-value">${orderData.order_number}</span></div>
            <div class="info-row"><span class="info-label">Tipo</span><span class="info-value">${typeLabel}</span></div>
            <div class="info-row"><span class="info-label">Produto</span><span class="info-value">${orderData.iphone_model}${orderData.capacity ? ` ${orderData.capacity}` : ''}</span></div>
            <div class="info-row"><span class="info-label">IMEI</span><span class="info-value">${orderData.imei || '—'}</span></div>
            <div class="info-row"><span class="info-label">Valor</span><span class="info-value">${formatCurrency(orderData.price)}</span></div>
            <div class="info-row"><span class="info-label">Data</span><span class="info-value">${formatDateBR(orderData.created_at)}</span></div>
          </div>
          ${orderData.warranty_months > 0 ? `
          <div class="warranty-banner">
            <div class="wt">✅ ${orderData.warranty_months} ${orderData.warranty_months === 1 ? 'Mês' : 'Meses'} de Garantia</div>
            <div class="wd">Válida a partir de ${formatDateBR(orderData.created_at)}</div>
          </div>` : ''}
          <p class="note">📎 O Termo de Garantia em PDF está anexado. Guarde-o — será necessário para acionar a garantia.</p>
        </div>
        <div class="footer">
          <p>${process.env.EMAIL_FROM_NAME || 'iPhone Store'} · ${process.env.EMAIL_FROM_ADDRESS}<br>E-mail automático, não responda.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  try {
    // Converte o buffer do PDF para base64 (formato que o Resend aceita)
    const pdfBase64 = pdfBuffer.toString('base64');

    const result = await sendEmail({
      to: orderData.client_email,
      subject: `✅ Termo de Garantia — ${orderData.order_number} | iPhone Store`,
      html,
      attachments: [
        {
          filename: `Garantia_${orderData.order_number}.pdf`,
          content: pdfBase64,
        },
      ],
    });

    logger.info(`E-mail enviado via Resend para ${orderData.client_email}. ID: ${result.id}`);
    return { sent: true, messageId: result.id };
  } catch (error) {
    logger.error(`Falha ao enviar e-mail para ${orderData.client_email}:`, error.message);
    return { sent: false, reason: error.message };
  }
};

module.exports = { sendWarrantyEmail, verifyEmailConnection };
