const PDFDocument = require('pdfkit');
const { formatCPF, formatDateBR, formatCurrency, calculateWarrantyExpiry } = require('../utils/helpers');
const logger = require('../utils/logger');

// ─── Dados da empresa (via env ou fallback) ────────────────────────────────
const COMPANY = {
  name:    process.env.COMPANY_NAME    || 'AcessPhones',
  cnpj:    process.env.COMPANY_CNPJ    || '37.837.898/0001-67',
  address: process.env.COMPANY_ADDRESS || 'Rua Platina, 275 (Sala 65) - Vila Azevedo',
  city:    process.env.COMPANY_CITY    || 'São Paulo/SP — CEP: 03308-010',
  phone:   process.env.COMPANY_PHONE   || '(11) 99282-5424',
  email:   process.env.COMPANY_EMAIL   || 'contato@acessphones.com.br',
};

// ─── Paleta ────────────────────────────────────────────────────────────────
const C = {
  black:   '#0C0C0E',
  white:   '#FFFFFF',
  gray1:   '#1C1C1E',
  gray2:   '#48484A',
  gray3:   '#8E8E93',
  gray4:   '#C7C7CC',
  gray5:   '#F2F2F7',
  gray6:   '#FAFAFA',
  accent:  '#0A66FF',
  green:   '#16A34A',
  greenBg: '#F0FDF4',
  red:     '#DC2626',
  amber:   '#D97706',
  amberBg: '#FFFBEB',
  border:  '#E5E5EA',
};

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const ML = 44; // margin left
const MR = 44; // margin right
const CW = PAGE_W - ML - MR; // content width

// ─── Helpers ───────────────────────────────────────────────────────────────

const formatPaymentMethods = (methods) => {
  const labels = {
    dinheiro: 'Dinheiro', cartao_credito: 'Cartão de Crédito',
    cartao_debito: 'Cartão de Débito', pix: 'Pix', iphone_entrada: 'iPhone como Entrada',
  };
  if (!methods || !methods.length) return '—';
  const parsed = Array.isArray(methods) ? methods : JSON.parse(methods);
  return parsed.map((m) => labels[m] || m).join(', ');
};

// Extrai notas de pagamento das observações (separadas por \n do restante)
const splitNotes = (notes) => {
  if (!notes) return { paymentLine: null, userNotes: null };
  const lines = notes.split('\n');
  // Primeira linha é sempre o resumo de pagamento gerado pelo frontend
  const paymentLine = lines[0] || null;
  const userNotes = lines.slice(1).join('\n').trim() || null;
  return { paymentLine, userNotes };
};

// ─── Componentes de desenho ────────────────────────────────────────────────

const rect = (doc, x, y, w, h, color, radius = 0) => {
  doc.save();
  if (radius > 0) {
    doc.roundedRect(x, y, w, h, radius).fill(color);
  } else {
    doc.rect(x, y, w, h).fill(color);
  }
  doc.restore();
};

const line = (doc, x1, y1, x2, y2, color = C.border, width = 0.5) => {
  doc.save();
  doc.moveTo(x1, y1).lineTo(x2, y2).strokeColor(color).lineWidth(width).stroke();
  doc.restore();
};

const chip = (doc, x, y, text, bgColor, textColor, w = 90) => {
  rect(doc, x, y, w, 18, bgColor, 9);
  doc.save().fillColor(textColor).fontSize(7.5).font('Helvetica-Bold')
    .text(text, x, y + 5, { width: w, align: 'center' }).restore();
};

const sectionHeader = (doc, title, y) => {
  rect(doc, ML, y, CW, 24, C.gray5, 4);
  line(doc, ML, y, ML, y + 24, C.accent, 3);
  doc.save().fillColor(C.gray2).fontSize(8).font('Helvetica-Bold')
    .text(title.toUpperCase(), ML + 10, y + 8, { characterSpacing: 0.8 }).restore();
  return y + 24 + 8;
};

const infoRow = (doc, label, value, x, y, colW, isLast = false, mono = false) => {
  if (!isLast) line(doc, x, y + 20, x + colW, y + 20);
  doc.save()
    .fillColor(C.gray3).fontSize(7.5).font('Helvetica-Bold')
    .text(label.toUpperCase(), x, y + 4, { characterSpacing: 0.4, width: colW * 0.38 });
  doc.fillColor(C.gray1).fontSize(9)
    .font(mono ? 'Courier' : 'Helvetica-Bold')
    .text(String(value || '—'), x + colW * 0.4, y + 3, { width: colW * 0.58 });
  doc.restore();
  return y + 22;
};

// ─── Geração do PDF ────────────────────────────────────────────────────────

const generateWarrantyPDF = async (orderData) => {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        info: {
          Title: `Comprovante de Atendimento — ${orderData.order_number}`,
          Author: COMPANY.name,
          Subject: 'Comprovante de Atendimento / Termo de Garantia',
          Creator: `${COMPANY.name} System`,
        },
      });

      const buffers = [];
      doc.on('data', (c) => buffers.push(c));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);

      const warrantyMonths = parseInt(orderData.warranty_months) || 0;
      const warrantyExpiry = warrantyMonths > 0
        ? calculateWarrantyExpiry(orderData.created_at, warrantyMonths)
        : null;

      const { paymentLine, userNotes } = splitNotes(orderData.notes);

      // ── HEADER ───────────────────────────────────────────────────────────
      // Barra preta superior
      rect(doc, 0, 0, PAGE_W, 88, C.black);

      // Ícone/logo placeholder (quadrado arredondado com "A")
      rect(doc, ML, 18, 44, 44, C.accent, 8);
      doc.save().fillColor(C.white).fontSize(22).font('Helvetica-Bold')
        .text('A', ML, 24, { width: 44, align: 'center' }).restore();

      // Nome da empresa
      doc.save().fillColor(C.white).fontSize(18).font('Helvetica-Bold')
        .text(COMPANY.name, ML + 52, 20).restore();
      doc.save().fillColor(C.gray4).fontSize(8).font('Helvetica')
        .text(`CNPJ: ${COMPANY.cnpj}  ·  ${COMPANY.phone}  ·  ${COMPANY.email}`, ML + 52, 41).restore();
      doc.save().fillColor(C.gray4).fontSize(8).font('Helvetica')
        .text(`${COMPANY.address} — ${COMPANY.city}`, ML + 52, 53).restore();

      // Número e data (direita)
      const orderType = orderData.type === 'venda' ? 'VENDA' : 'MANUTENÇÃO';
      doc.save().fillColor(C.gray3).fontSize(7.5).font('Helvetica-Bold')
        .text(orderType, 0, 18, { width: PAGE_W - MR, align: 'right', characterSpacing: 1 }).restore();
      doc.save().fillColor(C.white).fontSize(14).font('Helvetica-Bold')
        .text(`Nº ${orderData.order_number}`, 0, 30, { width: PAGE_W - MR, align: 'right' }).restore();
      doc.save().fillColor(C.gray4).fontSize(8.5).font('Helvetica')
        .text(formatDateBR(orderData.created_at), 0, 49, { width: PAGE_W - MR, align: 'right' }).restore();

      // Faixa accent na base do header
      rect(doc, 0, 88, PAGE_W, 4, C.accent);

      let y = 108;

      // ── TÍTULO DO DOCUMENTO ───────────────────────────────────────────────
      doc.save().fillColor(C.black).fontSize(16).font('Helvetica-Bold')
        .text('Comprovante de Atendimento', ML, y, { width: CW, align: 'center' }).restore();
      y += 22;
      doc.save().fillColor(C.gray3).fontSize(9).font('Helvetica')
        .text('Termo de Garantia e Recibo de Serviço', ML, y, { width: CW, align: 'center' }).restore();
      y += 20;
      line(doc, ML, y, ML + CW, y, C.accent, 1.5);
      y += 16;

      // ── DADOS DO CLIENTE & PRODUTO (2 colunas) ────────────────────────────
      const halfW = (CW - 16) / 2;
      const col2X = ML + halfW + 16;

      // Coluna 1: Cliente
      y = sectionHeader(doc, '  Cliente', y);
      const clientRows = [
        ['Nome', orderData.client_name],
        ['CPF', formatCPF(orderData.client_cpf)],
        ['Telefone', orderData.client_phone],
        ['E-mail', orderData.client_email || '—'],
      ];
      let yLeft = y;
      clientRows.forEach((r, i) => {
        yLeft = infoRow(doc, r[0], r[1], ML, yLeft, halfW, i === clientRows.length - 1);
      });

      // Coluna 2: Produto
      const prodLabel = orderData.type === 'venda' ? '  Produto' : '  Serviço';
      let yy = y - 32; // reinicia no mesmo nível
      yy = sectionHeader(doc, prodLabel, yy + 0);
      const prodRows = [
        ['Modelo', orderData.iphone_model],
        ['Capacidade', orderData.capacity || '—'],
        ['Cor', orderData.color || '—'],
        ['IMEI', orderData.imei || '—'],
      ];
      prodRows.forEach((r, i) => {
        yy = infoRow(doc, r[0], r[1], col2X, yy, halfW, i === prodRows.length - 1, r[0] === 'IMEI');
      });

      // Divisor vertical entre colunas
      const colDivX = ML + halfW + 8;
      const colTop = y - 8;
      const colBot = Math.max(yLeft, yy);
      line(doc, colDivX, colTop, colDivX, colBot, C.border, 0.5);

      y = colBot + 16;

      // ── PAGAMENTO ─────────────────────────────────────────────────────────
      y = sectionHeader(doc, '  Pagamento', y);

      // Valor total — destaque
      const valBoxW = 180;
      const valBoxX = PAGE_W - MR - valBoxW;
      rect(doc, ML, y, CW - valBoxW - 10, 36, C.gray5, 6);
      doc.save().fillColor(C.gray3).fontSize(7.5).font('Helvetica-Bold')
        .text('FORMAS DE PAGAMENTO', ML + 10, y + 5, { characterSpacing: 0.5 }).restore();
      doc.save().fillColor(C.gray1).fontSize(10).font('Helvetica-Bold')
        .text(formatPaymentMethods(orderData.payment_methods), ML + 10, y + 17, { width: CW - valBoxW - 20 }).restore();

      rect(doc, valBoxX, y, valBoxW, 36, C.black, 6);
      doc.save().fillColor(C.gray4).fontSize(7).font('Helvetica-Bold')
        .text('VALOR TOTAL', valBoxX, y + 5, { width: valBoxW, align: 'center', characterSpacing: 0.8 }).restore();
      doc.save().fillColor(C.white).fontSize(16).font('Helvetica-Bold')
        .text(formatCurrency(orderData.price), valBoxX, y + 15, { width: valBoxW, align: 'center' }).restore();
      y += 46;

      // Detalhes do pagamento (da nota gerada pelo frontend)
      if (paymentLine) {
        const parts = paymentLine.split(' | ');
        parts.forEach((part, idx) => {
          const isLast = idx === parts.length - 1;
          rect(doc, ML, y, CW, 22, idx % 2 === 0 ? C.gray6 : C.white, 0);
          line(doc, ML, y + 22, ML + CW, y + 22, C.border, 0.3);
          // Detecta se é iPhone entrada
          const isIphone = part.toLowerCase().startsWith('iphone de entrada');
          const [pLabel, ...pValParts] = part.split(': ');
          const pVal = pValParts.join(': ');
          doc.save().fillColor(C.gray3).fontSize(7.5).font('Helvetica-Bold')
            .text(pLabel.trim(), ML + 8, y + 7, { width: 200 }).restore();
          if (pVal) {
            doc.save().fillColor(isIphone ? C.amber : C.gray1).fontSize(8.5).font('Helvetica-Bold')
              .text(pVal.trim(), ML + 210, y + 6, { width: CW - 220 }).restore();
          }
          y += 22;
        });
      }
      y += 10;

      // ── GARANTIA ──────────────────────────────────────────────────────────
      y = sectionHeader(doc, '  Garantia', y);

      if (warrantyMonths > 0 && warrantyExpiry) {
        // Badge de garantia ativa
        rect(doc, ML, y, CW, 50, C.greenBg, 8);
        line(doc, ML, y, ML, y + 50, C.green, 4);

        // Ícone check (círculo verde)
        rect(doc, ML + 14, y + 14, 22, 22, C.green, 11);
        doc.save().fillColor(C.white).fontSize(12).font('Helvetica-Bold')
          .text('✓', ML + 14, y + 17, { width: 22, align: 'center' }).restore();

        doc.save().fillColor(C.green).fontSize(13).font('Helvetica-Bold')
          .text(`${warrantyMonths} ${warrantyMonths === 1 ? 'Mês' : 'Meses'} de Garantia`, ML + 44, y + 10).restore();
        doc.save().fillColor(C.gray2).fontSize(9).font('Helvetica')
          .text(`Válida de ${formatDateBR(orderData.created_at)} até ${formatDateBR(warrantyExpiry)}`, ML + 44, y + 26).restore();

        // Badge no canto direito
        chip(doc, PAGE_W - MR - 90, y + 16, 'GARANTIA ATIVA', C.green, C.white, 90);
        y += 60;
      } else {
        rect(doc, ML, y, CW, 34, C.gray5, 8);
        doc.save().fillColor(C.gray3).fontSize(9).font('Helvetica')
          .text('Este atendimento não possui garantia.', ML + 12, y + 12).restore();
        y += 44;
      }

      // Termos
      const terms = [
        'A garantia cobre defeitos de fabricação e problemas técnicos resultantes do serviço prestado.',
        'Não são cobertos: danos por queda, líquidos, mau uso, oxidação ou reparos realizados por terceiros.',
        'Para acionar a garantia, apresente este documento junto ao produto na loja.',
        'A garantia é intransferível e vinculada ao produto identificado pelo IMEI acima.',
        'Vícios aparentes devem ser reclamados em até 90 dias (CDC, Art. 26).',
      ];
      doc.save();
      terms.forEach((t, i) => {
        doc.fillColor(C.gray3).fontSize(8).font('Helvetica')
          .text(`${i + 1}.  ${t}`, ML + 6, y, { width: CW - 12 });
        y = doc.y + 3;
      });
      doc.restore();
      y += 6;

      // ── OBSERVAÇÕES DO CLIENTE ────────────────────────────────────────────
      if (userNotes) {
        y += 4;
        y = sectionHeader(doc, '  Observações', y);
        // Mede altura real antes de desenhar o fundo (evita NaN com 'auto')
        const notesH = doc.heightOfString(userNotes, { width: CW - 24 }) + 20;
        rect(doc, ML, y, CW, notesH, C.amberBg, 6);
        line(doc, ML, y, ML, y + notesH, C.amber, 3);
        doc.save().fillColor(C.gray1).fontSize(9).font('Helvetica')
          .text(userNotes, ML + 14, y + 8, { width: CW - 24 }).restore();
        y = y + notesH + 12;
      }

      // ── ASSINATURAS ───────────────────────────────────────────────────────
      y += 8;
      const sigLineW = (CW - 40) / 2;

      // Linha loja
      line(doc, ML, y, ML + sigLineW, y, C.gray4, 0.7);
      doc.save().fillColor(C.gray3).fontSize(8).font('Helvetica')
        .text(COMPANY.name, ML, y + 5, { width: sigLineW, align: 'center' }).restore();

      // Linha cliente
      const sigR = ML + CW - sigLineW;
      line(doc, sigR, y, sigR + sigLineW, y, C.gray4, 0.7);
      doc.save().fillColor(C.gray3).fontSize(8).font('Helvetica')
        .text(orderData.client_name, sigR, y + 5, { width: sigLineW, align: 'center' }).restore();

      y += 24;
      doc.save().fillColor(C.gray4).fontSize(7.5).font('Helvetica')
        .text('Assinatura e carimbo da loja', ML, y, { width: sigLineW, align: 'center' }).restore();
      doc.save().fillColor(C.gray4).fontSize(7.5).font('Helvetica')
        .text('Assinatura do cliente', sigR, y, { width: sigLineW, align: 'center' }).restore();

      // ── RODAPÉ ────────────────────────────────────────────────────────────
      const footerY = PAGE_H - 38;
      rect(doc, 0, footerY, PAGE_W, 38, C.black);
      line(doc, 0, footerY, PAGE_W, footerY, C.accent, 2);

      doc.save().fillColor(C.gray3).fontSize(7.5).font('Helvetica')
        .text(
          `Documento gerado em ${formatDateBR(new Date())}  ·  ${COMPANY.name}  ·  ${COMPANY.email}  ·  ${COMPANY.phone}`,
          0, footerY + 10, { width: PAGE_W, align: 'center' }
        ).restore();
      doc.save().fillColor(C.gray4).fontSize(6.5).font('Helvetica')
        .text('Este documento tem validade como comprovante de atendimento e termo de garantia.', 0, footerY + 23, { width: PAGE_W, align: 'center' })
        .restore();

      doc.end();
    } catch (error) {
      logger.error('Erro ao gerar PDF:', error);
      reject(error);
    }
  });
};

module.exports = { generateWarrantyPDF };
