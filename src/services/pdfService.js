const PDFDocument = require('pdfkit');
const { formatCPF, formatDateBR, formatCurrency, calculateWarrantyExpiry } = require('../utils/helpers');
const logger = require('../utils/logger');

/**
 * Gera o PDF do Termo de Garantia
 * @param {Object} orderData - Dados completos da ordem de serviço
 * @returns {Buffer} Buffer do PDF gerado
 */
const generateWarrantyPDF = async (orderData) => {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 60, bottom: 60, left: 60, right: 60 },
        info: {
          Title: `Termo de Garantia - ${orderData.order_number}`,
          Author: 'iPhone Store',
          Subject: 'Termo de Garantia de Produto/Serviço',
          Creator: 'iPhone Store System',
        },
      });

      const buffers = [];
      doc.on('data', (chunk) => buffers.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);

      const colors = {
        primary: '#1D1D1F',
        secondary: '#6E6E73',
        accent: '#0071E3',
        light: '#F5F5F7',
        border: '#D2D2D7',
        success: '#30D158',
      };

      const warrantyExpiry = orderData.warranty_months > 0
        ? calculateWarrantyExpiry(orderData.created_at, orderData.warranty_months)
        : null;

      // ─── CABEÇALHO ───────────────────────────────────────────────
      doc.rect(0, 0, doc.page.width, 120).fill(colors.primary);

      doc.fillColor('white')
        .fontSize(24)
        .font('Helvetica-Bold')
        .text('iPhone Store', 60, 35);

      doc.fillColor(colors.accent)
        .fontSize(11)
        .font('Helvetica')
        .text('Especializada em iPhones Novos e Usados', 60, 65);

      doc.fillColor('white')
        .fontSize(9)
        .text('CNPJ: 00.000.000/0001-00  |  contato@iphonestore.com.br  |  (11) 99999-9999', 60, 90);

      // Número do atendimento (canto direito)
      doc.fillColor('white')
        .fontSize(9)
        .font('Helvetica-Bold')
        .text(`Nº ${orderData.order_number}`, 60, 35, {
          align: 'right',
          width: doc.page.width - 120,
        });

      doc.fillColor(colors.accent)
        .fontSize(8)
        .font('Helvetica')
        .text(formatDateBR(orderData.created_at), 60, 50, {
          align: 'right',
          width: doc.page.width - 120,
        });

      // ─── TÍTULO ──────────────────────────────────────────────────
      doc.moveDown(4);
      doc.fillColor(colors.primary)
        .fontSize(18)
        .font('Helvetica-Bold')
        .text('TERMO DE GARANTIA', { align: 'center' });

      // Linha decorativa
      doc.moveDown(0.5);
      const lineY = doc.y;
      doc.moveTo(60, lineY).lineTo(doc.page.width - 60, lineY)
        .strokeColor(colors.accent).lineWidth(2).stroke();
      doc.moveDown(1.5);

      // ─── SEÇÃO: DADOS DO CLIENTE ─────────────────────────────────
      drawSectionHeader(doc, '👤  DADOS DO CLIENTE', colors);

      const clientData = [
        ['Nome Completo', orderData.client_name],
        ['CPF', formatCPF(orderData.client_cpf)],
        ['Telefone', orderData.client_phone],
        ['E-mail', orderData.client_email || '—'],
        ['Endereço', orderData.client_address
          ? `${orderData.client_address}, ${orderData.client_city}/${orderData.client_state}`
          : '—'],
      ];

      drawTable(doc, clientData, colors);
      doc.moveDown(1.2);

      // ─── SEÇÃO: DADOS DO PRODUTO/SERVIÇO ────────────────────────
      const sectionTitle = orderData.type === 'venda'
        ? '📱  DADOS DO PRODUTO'
        : '🛠️  DADOS DO SERVIÇO';
      drawSectionHeader(doc, sectionTitle, colors);

      const productData = [
        ['Tipo de Atendimento', orderData.type === 'venda' ? 'Venda' : 'Manutenção'],
        ['Modelo', orderData.iphone_model],
        ['Capacidade', orderData.capacity || '—'],
        ['Cor', orderData.color || '—'],
        ['IMEI', orderData.imei || '—'],
        ['Valor', formatCurrency(orderData.price)],
        ['Forma de Pagamento', formatPaymentMethods(orderData.payment_methods)],
      ];

      drawTable(doc, productData, colors);
      doc.moveDown(1.2);

      // ─── SEÇÃO: GARANTIA ─────────────────────────────────────────
      drawSectionHeader(doc, '✅  CONDIÇÕES DE GARANTIA', colors);

      if (orderData.warranty_months > 0 && warrantyExpiry) {
        // Badge de garantia ativa
        const badgeX = 60;
        const badgeY = doc.y + 5;
        doc.rect(badgeX, badgeY, 200, 45).fill(colors.success);
        doc.fillColor('white')
          .fontSize(11)
          .font('Helvetica-Bold')
          .text(`${orderData.warranty_months} ${orderData.warranty_months === 1 ? 'MÊS' : 'MESES'} DE GARANTIA`, badgeX, badgeY + 8, {
            width: 200, align: 'center',
          });
        doc.fillColor('white')
          .fontSize(9)
          .font('Helvetica')
          .text(`Válida até: ${formatDateBR(warrantyExpiry)}`, badgeX, badgeY + 25, {
            width: 200, align: 'center',
          });

        doc.moveDown(3.5);
      } else {
        doc.fillColor(colors.secondary)
          .fontSize(10)
          .font('Helvetica')
          .text('Este serviço não possui garantia.', { indent: 10 });
        doc.moveDown(1);
      }

      // Termos e condições
      const terms = [
        'A garantia cobre defeitos de fabricação e problemas técnicos resultantes do serviço prestado.',
        'Não estão cobertos: danos por queda, líquidos, uso inadequado ou tentativas de reparo por terceiros.',
        'Para acionar a garantia, apresente este documento e o produto na loja.',
        'A garantia é intransferível e válida somente para o produto identificado pelo IMEI acima.',
        'Prazo para reclamação de vícios aparentes: 90 dias (Código de Defesa do Consumidor, Art. 26).',
      ];

      doc.moveDown(0.5);
      terms.forEach((term, i) => {
        doc.fillColor(colors.secondary)
          .fontSize(9)
          .font('Helvetica')
          .text(`${i + 1}. ${term}`, { indent: 10, width: doc.page.width - 120 });
        doc.moveDown(0.4);
      });

      // ─── OBSERVAÇÕES ─────────────────────────────────────────────
      if (orderData.notes) {
        doc.moveDown(0.8);
        drawSectionHeader(doc, '📝  OBSERVAÇÕES', colors);
        doc.fillColor(colors.primary)
          .fontSize(10)
          .font('Helvetica')
          .text(orderData.notes, { indent: 10, width: doc.page.width - 120 });
        doc.moveDown(1);
      }

      // ─── ASSINATURAS ─────────────────────────────────────────────
      doc.moveDown(2);
      const sigY = doc.y;
      const midX = doc.page.width / 2;

      // Linha esquerda (loja)
      doc.moveTo(60, sigY).lineTo(midX - 30, sigY)
        .strokeColor(colors.border).lineWidth(1).stroke();
      doc.fillColor(colors.secondary).fontSize(9).text('iPhone Store', 60, sigY + 5, {
        width: midX - 90, align: 'center',
      });

      // Linha direita (cliente)
      doc.moveTo(midX + 30, sigY).lineTo(doc.page.width - 60, sigY)
        .strokeColor(colors.border).lineWidth(1).stroke();
      doc.fillColor(colors.secondary).fontSize(9).text('Cliente', midX + 30, sigY + 5, {
        width: midX - 90, align: 'center',
      });

      // ─── RODAPÉ ──────────────────────────────────────────────────
      const footerY = doc.page.height - 50;
      doc.rect(0, footerY - 10, doc.page.width, 60).fill(colors.light);
      doc.fillColor(colors.secondary)
        .fontSize(8)
        .text(
          `Documento gerado eletronicamente em ${formatDateBR(new Date())} | iPhone Store © ${new Date().getFullYear()}`,
          60, footerY,
          { align: 'center', width: doc.page.width - 120 }
        );

      doc.end();
    } catch (error) {
      logger.error('Erro ao gerar PDF:', error);
      reject(error);
    }
  });
};

// ─── Funções auxiliares de layout ────────────────────────────────────────────

const drawSectionHeader = (doc, title, colors) => {
  doc.rect(60, doc.y, doc.page.width - 120, 26).fill(colors.light);
  doc.fillColor(colors.primary)
    .fontSize(10)
    .font('Helvetica-Bold')
    .text(title, 68, doc.y - 20);
  doc.moveDown(0.8);
};

const drawTable = (doc, rows, colors) => {
  rows.forEach(([label, value], index) => {
    const rowY = doc.y;
    const isEven = index % 2 === 0;
    if (isEven) {
      doc.rect(60, rowY - 3, doc.page.width - 120, 20).fill('#FAFAFA');
    }
    doc.fillColor(colors.secondary)
      .fontSize(9)
      .font('Helvetica-Bold')
      .text(label, 68, rowY, { width: 160 });
    doc.fillColor(colors.primary)
      .fontSize(9)
      .font('Helvetica')
      .text(String(value || '—'), 235, rowY, { width: doc.page.width - 300 });
    doc.moveDown(0.6);
  });
};

const formatPaymentMethods = (methods) => {
  const labels = {
    dinheiro: 'Dinheiro',
    cartao_credito: 'Cartão de Crédito',
    cartao_debito: 'Cartão de Débito',
    pix: 'Pix',
    iphone_entrada: 'iPhone como Entrada',
  };
  if (!methods || !methods.length) return '—';
  const parsed = Array.isArray(methods) ? methods : JSON.parse(methods);
  return parsed.map((m) => labels[m] || m).join(', ');
};

module.exports = { generateWarrantyPDF };
