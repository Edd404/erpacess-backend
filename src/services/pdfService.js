/**
 * pdfService.js
 * Comprovante de Atendimento + Termo de Garantia — Acessphones
 * Estilo: DANFE-inspired, premium, monocromático
 */

const PDFDocument = require('pdfkit');
const {
  formatCPF, formatDateBR, formatCurrency,
  calculateWarrantyExpiry, formatPhone,
} = require('../utils/helpers');
const logger = require('../utils/logger');

// ── Empresa ────────────────────────────────────────────────────
const COMPANY = {
  name:    process.env.COMPANY_NAME    || 'Acessphones',
  cnpj:    process.env.COMPANY_CNPJ    || '37.837.898/0001-67',
  address: process.env.COMPANY_ADDRESS || 'Rua Platina, 275 — Sala 65 — Vila Azevedo',
  city:    process.env.COMPANY_CITY    || 'São Paulo — SP — CEP 03308-010',
  phone:   process.env.COMPANY_PHONE   || '(11) 99282-5424',
  email:   process.env.COMPANY_EMAIL   || 'contato@acessphones.com.br',
};

// ── Paleta ─────────────────────────────────────────────────────
const C = {
  black:  '#0C0C0E',
  ink2:   '#3A3A3C',
  ink3:   '#6B6B70',
  ink4:   '#AEAEB2',
  ink5:   '#D1D1D6',
  ink6:   '#F5F5F7',
  white:  '#FFFFFF',
  accent: '#0A66FF',
  green:  '#15803D',
  red:    '#DC2626',
  border: '#C7C7CC',
};

const PW = 595.28;
const PH = 841.89;
const ML = 36;
const MR = 36;
const CW = PW - ML - MR;

// ── Helpers de desenho ──────────────────────────────────────────
const fillRect = (doc, x, y, w, h, color) =>
  doc.save().rect(x, y, w, h).fill(color).restore();

const strokeRect = (doc, x, y, w, h, color = C.border, lw = 0.5) =>
  doc.save().rect(x, y, w, h).strokeColor(color).lineWidth(lw).stroke().restore();

const hline = (doc, x1, x2, y, color = C.border, lw = 0.4) =>
  doc.save().moveTo(x1, y).lineTo(x2, y).strokeColor(color).lineWidth(lw).stroke().restore();

// Célula estilo DANFE: rótulo 6px topo + valor abaixo
const cell = (doc, x, y, w, h, label, value, opts = {}) => {
  const {
    valSize    = 9,
    valFont    = 'Helvetica-Bold',
    valColor   = C.black,
    labelColor = C.ink4,
    mono       = false,
    align      = 'left',
    bg         = null,
  } = opts;

  if (bg) fillRect(doc, x, y, w, h, bg);
  strokeRect(doc, x, y, w, h);

  doc.save()
    .fillColor(labelColor).fontSize(6).font('Helvetica')
    .text(label.toUpperCase(), x + 3, y + 3, { width: w - 6, characterSpacing: 0.3 })
    .restore();

  doc.save()
    .fillColor(valColor).fontSize(valSize)
    .font(mono ? 'Courier' : valFont)
    .text(String(value || '—'), x + 3, y + 13, { width: w - 6, align })
    .restore();
};

// Rótulo de seção (faixa cinza clara com texto bold)
const sectionLabel = (doc, title, y) => {
  fillRect(doc, ML, y, CW, 14, C.ink6);
  strokeRect(doc, ML, y, CW, 14, C.border);
  doc.save()
    .fillColor(C.ink3).fontSize(6.5).font('Helvetica-Bold')
    .text(title.toUpperCase(), ML + 4, y + 4, { characterSpacing: 0.8 })
    .restore();
  return y + 14;
};

// ── Helpers de dados ────────────────────────────────────────────
const fmtPayments = (methods) => {
  const map = {
    dinheiro:       'Dinheiro',
    cartao_credito: 'Cartão de Crédito',
    cartao_debito:  'Cartão de Débito',
    pix:            'Pix',
    iphone_entrada: 'iPhone como Entrada',
  };
  if (!methods) return '—';
  const arr = Array.isArray(methods) ? methods : JSON.parse(methods);
  return arr.map(m => map[m] || m).join('  ·  ');
};

const fmtCondition = (c) =>
  c === 'lacrado'  ? 'Lacrado (na caixa, nunca usado)'
  : c === 'seminovo' ? 'Seminovo (usado, bom estado)'
  : '—';

const fmtType = (t) => t === 'venda' ? 'COMPRA E VENDA' : 'ORDEM DE SERVIÇO';

const parseNotes = (notes) => {
  if (!notes) return { services: null, problem: null, free: null };
  const lines = notes.split('\n');
  let services = null, problem = null, free = [];
  lines.forEach(l => {
    if      (l.startsWith('Serviços:'))  services = l.replace('Serviços:', '').trim();
    else if (l.startsWith('Problema:'))  problem  = l.replace('Problema:', '').trim();
    else if (l.trim())                   free.push(l);
  });
  return { services, problem, free: free.join('\n') || null };
};

// ── Gerador principal ───────────────────────────────────────────
const generateWarrantyPDF = async (orderData) => {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        info: {
          Title:   `${fmtType(orderData.type)} — ${orderData.order_number}`,
          Author:  COMPANY.name,
          Subject: 'Comprovante de Atendimento e Termo de Garantia',
          Creator: `${COMPANY.name} Sistema de Gestão`,
        },
      });

      const buffers = [];
      doc.on('data',  b => buffers.push(b));
      doc.on('end',   () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);

      const wMonths   = parseInt(orderData.warranty_months) || 0;
      const wExpiry   = wMonths > 0 ? calculateWarrantyExpiry(orderData.created_at, wMonths) : null;
      const isManut   = orderData.type === 'manutencao';
      const { services, problem, free } = parseNotes(orderData.notes);
      const emitDate  = new Date(orderData.created_at);
      const emitDateFmt = emitDate.toLocaleDateString('pt-BR', { day:'2-digit', month:'long', year:'numeric' });
      const emitTimeFmt = emitDate.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });
      const CH = 28; // altura padrão de célula

      // ── 1. LINHA ACCENT ────────────────────────────────────
      fillRect(doc, 0, 0, PW, 3, C.accent);

      // ── 2. CABEÇALHO DARK ──────────────────────────────────
      fillRect(doc, 0, 3, PW, 80, C.black);

      // Wordmark
      doc.save()
        .fillColor(C.white).fontSize(22).font('Helvetica-Bold')
        .text('Acess', ML, 18, { continued: true })
        .fillColor('rgba(255,255,255,0.35)').font('Helvetica')
        .text('phones')
        .restore();

      // Dados empresa
      doc.save()
        .fillColor(C.ink4).fontSize(7).font('Helvetica')
        .text(`CNPJ ${COMPANY.cnpj}   ·   ${COMPANY.address}`, ML, 44)
        .restore();
      doc.save()
        .fillColor(C.ink4).fontSize(7).font('Helvetica')
        .text(`${COMPANY.city}   ·   ${COMPANY.phone}   ·   ${COMPANY.email}`, ML, 54)
        .restore();

      // Tipo doc (direita)
      doc.save()
        .fillColor(C.ink4).fontSize(6.5).font('Helvetica')
        .text(fmtType(orderData.type), ML, 18, { width: CW, align: 'right', characterSpacing: 1.5 })
        .restore();
      // Número OS
      doc.save()
        .fillColor(C.white).fontSize(15).font('Helvetica-Bold')
        .text(orderData.order_number, ML, 30, { width: CW, align: 'right' })
        .restore();
      // Data
      doc.save()
        .fillColor(C.ink4).fontSize(7.5).font('Helvetica')
        .text(`${emitDateFmt}  ·  ${emitTimeFmt}`, ML, 50, { width: CW, align: 'right' })
        .restore();
      // Vendedor
      if (orderData.seller_name) {
        doc.save()
          .fillColor(C.ink4).fontSize(7).font('Helvetica')
          .text(`Atendente: ${orderData.seller_name}`, ML, 62, { width: CW, align: 'right' })
          .restore();
      }

      let y = 84;

      // ── 3. TÍTULO DO DOCUMENTO ─────────────────────────────
      fillRect(doc, 0, y, PW, 22, C.ink6);
      hline(doc, 0, PW, y,      C.border, 0.5);
      hline(doc, 0, PW, y + 22, C.border, 0.5);
      doc.save()
        .fillColor(C.ink2).fontSize(9).font('Helvetica-Bold')
        .text(
          isManut
            ? 'COMPROVANTE DE ORDEM DE SERVIÇO E TERMO DE GARANTIA'
            : 'COMPROVANTE DE COMPRA E VENDA E TERMO DE GARANTIA',
          0, y + 7, { width: PW, align: 'center', characterSpacing: 0.8 }
        )
        .restore();
      y += 22;

      // ── 4. DESTINATÁRIO ────────────────────────────────────
      y = sectionLabel(doc, 'Destinatário / Cliente', y + 8);

      // L1: Nome | CPF | Telefone
      cell(doc, ML,            y, CW*0.50, CH, 'Nome Completo',  orderData.client_name,  { valSize:9.5, valFont:'Helvetica-Bold' });
      cell(doc, ML + CW*0.50,  y, CW*0.26, CH, 'CPF',           formatCPF(orderData.client_cpf || ''));
      cell(doc, ML + CW*0.76,  y, CW*0.24, CH, 'Telefone',      formatPhone(orderData.client_phone || ''));
      y += CH;

      // L2: Email | Endereço | CEP
      cell(doc, ML,            y, CW*0.40, CH, 'E-mail',         orderData.client_email    || '—');
      cell(doc, ML + CW*0.40,  y, CW*0.38, CH, 'Endereço',
        orderData.client_address
          ? `${orderData.client_address}${orderData.client_complement ? `, ${orderData.client_complement}` : ''}`
          : '—'
      );
      cell(doc, ML + CW*0.78,  y, CW*0.22, CH, 'CEP',            orderData.client_cep      || '—');
      y += CH;

      // L3: Bairro | Cidade | Estado
      cell(doc, ML,            y, CW*0.34, CH, 'Bairro',          orderData.client_neighborhood || '—');
      cell(doc, ML + CW*0.34,  y, CW*0.44, CH, 'Cidade',          orderData.client_city         || '—');
      cell(doc, ML + CW*0.78,  y, CW*0.22, CH, 'Estado',          orderData.client_state         || '—');
      y += CH;

      // ── 5. PRODUTO / APARELHO ──────────────────────────────
      y = sectionLabel(doc, isManut ? 'Aparelho em Serviço' : 'Produto Adquirido', y + 8);

      // L1: Modelo | Capacidade | Cor | Condição
      cell(doc, ML,            y, CW*0.38, CH, 'Modelo do iPhone',     orderData.iphone_model,           { valSize:9.5, valFont:'Helvetica-Bold' });
      cell(doc, ML + CW*0.38,  y, CW*0.16, CH, 'Capacidade',           orderData.capacity                || '—');
      cell(doc, ML + CW*0.54,  y, CW*0.22, CH, 'Cor',                  orderData.color                   || '—');
      cell(doc, ML + CW*0.76,  y, CW*0.24, CH, isManut ? 'Tipo de Serviço' : 'Condição',
        isManut ? 'Manutenção / Reparo' : (orderData.condition_sale === 'lacrado' ? 'Lacrado' : orderData.condition_sale === 'seminovo' ? 'Seminovo' : '—')
      );
      y += CH;

      // L2: IMEI | Descrição da condição
      const imeiDisplay = orderData.imei
        ? orderData.imei.replace(/(\d{2})(\d{6})(\d{6})(\d)/, '$1 $2 $3 $4')
        : '—';
      cell(doc, ML,            y, CW*0.44, CH, 'IMEI do Aparelho',     imeiDisplay, { mono: true, valSize: 9 });
      cell(doc, ML + CW*0.44,  y, CW*0.56, CH,
        isManut ? 'Condição ao Receber' : 'Descrição da Condição',
        isManut
          ? (orderData.device_condition || '—')
          : (orderData.condition_sale === 'lacrado'
              ? 'Produto lacrado, na caixa original, nunca utilizado'
              : orderData.condition_sale === 'seminovo'
              ? 'Produto seminovo em bom estado de funcionamento'
              : '—'),
        { valSize: 7.5, valFont: 'Helvetica' }
      );
      y += CH;

      // ── 6. SERVIÇOS (manutenção) ───────────────────────────
      if (isManut && (services || problem)) {
        y = sectionLabel(doc, 'Serviços Realizados', y + 8);

        if (services) {
          const svcH = Math.max(28, doc.heightOfString(services, { width: CW - 12 }) + 18);
          strokeRect(doc, ML, y, CW, svcH, C.border);
          doc.save().fillColor(C.ink4).fontSize(6).font('Helvetica')
            .text('SERVIÇOS', ML + 3, y + 3, { characterSpacing: 0.3 }).restore();
          doc.save().fillColor(C.black).fontSize(8.5).font('Helvetica-Bold')
            .text(services, ML + 6, y + 13, { width: CW - 12 }).restore();
          y += svcH;
        }

        if (problem) {
          const probH = Math.max(24, doc.heightOfString(problem, { width: CW - 12 }) + 18);
          strokeRect(doc, ML, y, CW, probH, C.border);
          doc.save().fillColor(C.ink4).fontSize(6).font('Helvetica')
            .text('PROBLEMA RELATADO PELO CLIENTE', ML + 3, y + 3, { characterSpacing: 0.3 }).restore();
          doc.save().fillColor(C.ink2).fontSize(8.5).font('Helvetica')
            .text(problem, ML + 6, y + 13, { width: CW - 12 }).restore();
          y += probH;
        }
      }

      // ── 7. PAGAMENTO ───────────────────────────────────────
      y = sectionLabel(doc, 'Informações de Pagamento', y + 8);

      // Parse dados estruturados
      const accList = (() => {
        try { return Array.isArray(orderData.accessories) ? orderData.accessories : JSON.parse(orderData.accessories || '[]') }
        catch { return [] }
      })()

      const pd = (() => {
        try { return typeof orderData.payment_details === 'object' && orderData.payment_details !== null
          ? orderData.payment_details
          : JSON.parse(orderData.payment_details || '{}') }
        catch { return {} }
      })()

      const basePrice    = parseFloat(orderData.price) || 0
      const accTotal     = accList.reduce((s, a) => s + (parseFloat(a.price) || 0), 0)
      const devicePrice  = basePrice - accTotal
      const tradeValue   = parseFloat(pd.iphone_entrada?.value) || 0

      const PAYMENT_LABELS = {
        pix:            'Pix',
        dinheiro:       'Dinheiro',
        cartao_credito: 'Cartão de Crédito',
        cartao_debito:  'Cartão de Débito',
        iphone_entrada: 'iPhone como Entrada',
      }

      // Linha do aparelho (apenas venda)
      if (!isManut) {
        cell(doc, ML, y, CW * 0.72, CH, 'Aparelho', `${orderData.iphone_model}${orderData.capacity ? ' · ' + orderData.capacity : ''}`, { valSize: 9 })
        cell(doc, ML + CW * 0.72, y, CW * 0.28, CH, 'Valor do Aparelho', formatCurrency(devicePrice), { valSize: 9, align: 'right' })
        y += CH
      }

      // Linhas de acessórios (se houver)
      if (accList.length > 0) {
        accList.forEach(acc => {
          const accPrice = parseFloat(acc.price) || 0
          cell(doc, ML, y, CW * 0.72, CH, 'Acessório',       acc.name || '—', { valSize: 9 })
          cell(doc, ML + CW * 0.72, y, CW * 0.28, CH, 'Valor', formatCurrency(accPrice), { valSize: 9, align: 'right' })
          y += CH
        })
      }

      // iPhone de entrada (se houver)
      if (tradeValue > 0 && pd.iphone_entrada) {
        const tradeName = [pd.iphone_entrada.model, pd.iphone_entrada.capacity, pd.iphone_entrada.color]
          .filter(Boolean).join(' · ') || 'iPhone de Entrada'
        const tradeImei = pd.iphone_entrada.imei ? `IMEI: ${pd.iphone_entrada.imei}` : ''

        fillRect(doc, ML, y, CW, CH, '#F5FFF8')
        cell(doc, ML, y, CW * 0.72, CH, 'iPhone como Entrada',
          tradeName + (tradeImei ? '\n' + tradeImei : ''),
          { valSize: 8, valFont: 'Helvetica', bg: '#F5FFF8', labelColor: C.green }
        )
        cell(doc, ML + CW * 0.72, y, CW * 0.28, CH,
          '(–) Abatido', `– ${formatCurrency(tradeValue)}`,
          { valSize: 9, valColor: C.green, bg: '#F5FFF8', align: 'right' }
        )
        y += CH
      }

      // Formas de pagamento em dinheiro/cartão/pix
      const cashMethods = (Array.isArray(orderData.payment_methods)
        ? orderData.payment_methods
        : (() => { try { return JSON.parse(orderData.payment_methods || '[]') } catch { return [] } })()
      ).filter(m => m !== 'iphone_entrada')

      if (cashMethods.length > 0) {
        cashMethods.forEach(method => {
          const methodVal = parseFloat(pd[method]?.value) || 0
          const parcelas  = pd[method]?.parcelas ? parseInt(pd[method].parcelas) : null
          const label     = PAYMENT_LABELS[method] || method
          const suffix    = method === 'cartao_credito' && parcelas && parcelas > 1 ? ` (${parcelas}x)` : ''
          cell(doc, ML, y, CW * 0.72, CH, 'Forma de Pagamento', label + suffix, { valSize: 9 })
          cell(doc, ML + CW * 0.72, y, CW * 0.28, CH, 'Valor Pago',
            methodVal > 0 ? formatCurrency(methodVal) : '—',
            { valSize: 9, align: 'right' }
          )
          y += CH
        })
      }

      // Totalizador destacado
      strokeRect(doc, ML + CW * 0.72, y, CW * 0.28, CH, C.black, 1)
      doc.save().fillColor(C.ink4).fontSize(6).font('Helvetica')
        .text('VALOR TOTAL', ML + CW * 0.72, y + 3, { width: CW * 0.28, align: 'center', characterSpacing: 0.5 }).restore()
      doc.save().fillColor(C.black).fontSize(13).font('Helvetica-Bold')
        .text(formatCurrency(basePrice), ML + CW * 0.72, y + 12, { width: CW * 0.28, align: 'center' }).restore()

      // Célula de formas (resumo) ao lado do total
      const fmtShort = cashMethods.map(m => PAYMENT_LABELS[m] || m).join(' · ')
        + (tradeValue > 0 ? (cashMethods.length ? ' · iPhone Entrada' : 'iPhone Entrada') : '')
      cell(doc, ML, y, CW * 0.72, CH, 'Formas de Pagamento', fmtShort || '—', { valSize: 8.5 })
      y += CH

      // ── 8. GARANTIA ────────────────────────────────────────
      y = sectionLabel(doc, 'Termo de Garantia', y + 8);

      if (wMonths > 0 && wExpiry) {
        const daysLeft  = Math.round((wExpiry - new Date()) / 86400000);
        const expiryFmt = wExpiry.toLocaleDateString('pt-BR', { day:'2-digit', month:'long', year:'numeric' });
        const startFmt  = emitDate.toLocaleDateString('pt-BR', { day:'2-digit', month:'long', year:'numeric' });

        // Caixa certificado de garantia
        const certH = 56;
        strokeRect(doc, ML, y, CW, certH, C.black, 1);
        fillRect(doc, ML, y, CW, 18, C.black);
        doc.save().fillColor(C.white).fontSize(7).font('Helvetica-Bold')
          .text(daysLeft > 0 ? 'GARANTIA ATIVA' : 'GARANTIA EXPIRADA', ML, y + 6,
            { width: CW, align: 'center', characterSpacing: 1.8 }).restore();

        doc.save().fillColor(C.black).fontSize(14).font('Helvetica-Bold')
          .text(`${wMonths} ${wMonths === 1 ? 'mês' : 'meses'} de garantia`, ML + 14, y + 24).restore();

        doc.save().fillColor(C.ink3).fontSize(8).font('Helvetica')
          .text(`Válida de ${startFmt} até ${expiryFmt}`, ML + 14, y + 40).restore();

        const daysLabel = daysLeft > 0
          ? `${daysLeft} dias restantes`
          : `Expirada há ${Math.abs(daysLeft)} dias`;
        doc.save().fillColor(daysLeft > 0 ? C.ink3 : C.red).fontSize(8).font('Helvetica')
          .text(daysLabel, ML, y + 40, { width: CW - 14, align: 'right' }).restore();

        y += certH;

        // Células de datas
        cell(doc, ML,           y, CW*0.34, CH, 'Início da Garantia',  startFmt);
        cell(doc, ML + CW*0.34, y, CW*0.34, CH, 'Válida Até',          expiryFmt, { valColor: daysLeft > 0 ? C.green : C.red });
        cell(doc, ML + CW*0.68, y, CW*0.32, CH, 'Duração Total',       `${wMonths} ${wMonths === 1 ? 'mês' : 'meses'}`);
        y += CH;
      } else {
        const noWH = 22;
        strokeRect(doc, ML, y, CW, noWH, C.border);
        doc.save().fillColor(C.ink3).fontSize(8.5).font('Helvetica')
          .text('Este atendimento não inclui garantia.', ML + 8, y + 7).restore();
        y += noWH;
      }

      // Cláusulas da garantia
      y += 8;
      const clauses = [
        'A garantia cobre exclusivamente defeitos de fabricação e problemas técnicos diretamente relacionados ao serviço prestado pela Acessphones.',
        'Não estão cobertos: danos por queda, impacto, infiltração de líquidos, mau uso, oxidação, tentativa de reparo por terceiros ou qualquer intervenção não autorizada.',
        'Para acionar a garantia, apresente este documento original junto ao aparelho. A garantia é intransferível e vinculada ao IMEI registrado neste documento.',
        'Vícios aparentes devem ser reclamados em até 30 dias para produtos não duráveis e 90 dias para produtos duráveis, conforme Art. 26 do Código de Defesa do Consumidor (Lei 8.078/1990).',
        'A responsabilidade da Acessphones limita-se ao reparo, substituição ou restituição do valor pago, a critério da empresa, dentro do período e condições descritos.',
      ];

      clauses.forEach((clause, i) => {
        const cH = doc.heightOfString(`${i+1}.  ${clause}`, { width: CW - 8 }) + 4;
        doc.save().fillColor(C.ink3).fontSize(7).font('Helvetica')
          .text(`${i+1}.  ${clause}`, ML + 4, y, { width: CW - 8 }).restore();
        y += cH + 2;
      });

      // ── 9. OBSERVAÇÕES ─────────────────────────────────────
      const obsText = free || (!isManut && orderData.notes) ? (free || orderData.notes) : null;
      if (obsText) {
        y += 4;
        y = sectionLabel(doc, 'Observações', y);
        const obsH = Math.max(28, doc.heightOfString(obsText, { width: CW - 16 }) + 18);
        strokeRect(doc, ML, y, CW, obsH, C.border);
        doc.save().fillColor(C.ink2).fontSize(8.5).font('Helvetica')
          .text(obsText, ML + 8, y + 8, { width: CW - 16 }).restore();
        y += obsH;
      }

      // ── 10. DECLARAÇÃO E ASSINATURAS ───────────────────────
      y += 14;
      hline(doc, ML, ML + CW, y, C.border, 0.5);
      y += 8;

      const declaration = `Declaro que recebi o produto/serviço descrito neste documento em perfeitas condições, estando ciente e de acordo com as informações e termos de garantia acima. Este comprovante tem validade jurídica como recibo de ${isManut ? 'ordem de serviço' : 'compra e venda'} nos termos da legislação brasileira.`;
      doc.save().fillColor(C.ink3).fontSize(7.5).font('Helvetica')
        .text(declaration, ML, y, { width: CW, align: 'justify' }).restore();
      y += doc.heightOfString(declaration, { width: CW }) + 20;

      // Linhas de assinatura
      const sigW  = (CW - 40) / 2;
      const sigX2 = ML + CW - sigW;

      hline(doc, ML, ML + sigW, y, C.black, 0.7);
      doc.save().fillColor(C.ink3).fontSize(7.5).font('Helvetica')
        .text(COMPANY.name, ML, y + 5, { width: sigW, align: 'center' }).restore();
      doc.save().fillColor(C.ink4).fontSize(6.5).font('Helvetica')
        .text('Assinatura e Carimbo da Loja', ML, y + 15, { width: sigW, align: 'center' }).restore();

      hline(doc, sigX2, sigX2 + sigW, y, C.black, 0.7);
      doc.save().fillColor(C.ink3).fontSize(7.5).font('Helvetica')
        .text(orderData.client_name, sigX2, y + 5, { width: sigW, align: 'center' }).restore();
      doc.save().fillColor(C.ink4).fontSize(6.5).font('Helvetica')
        .text('Assinatura do Cliente / Comprador', sigX2, y + 15, { width: sigW, align: 'center' }).restore();

      y += 32;
      doc.save().fillColor(C.ink4).fontSize(7.5).font('Helvetica')
        .text(`São Paulo, ${emitDateFmt}`, ML, y, { width: CW, align: 'center' }).restore();

      // ── 11. RODAPÉ ─────────────────────────────────────────
      const footerY = PH - 30;
      hline(doc, 0, PW, footerY - 4, C.border, 0.5);
      fillRect(doc, 0, footerY - 4, PW, 34, C.ink6);
      doc.save().fillColor(C.ink3).fontSize(6.5).font('Helvetica')
        .text(
          `${COMPANY.name}  ·  CNPJ ${COMPANY.cnpj}  ·  ${COMPANY.phone}  ·  ${COMPANY.email}`,
          0, footerY + 2, { width: PW, align: 'center' }
        ).restore();
      doc.save().fillColor(C.ink4).fontSize(6).font('Helvetica')
        .text(
          `Documento gerado em ${formatDateBR(new Date())}  ·  ${orderData.order_number}  ·  Página 1 de 1`,
          0, footerY + 14, { width: PW, align: 'center' }
        ).restore();

      doc.end();
    } catch (error) {
      logger.error('Erro ao gerar PDF:', error);
      reject(error);
    }
  });
};

module.exports = { generateWarrantyPDF };
