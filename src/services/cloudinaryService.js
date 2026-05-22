/**
 * cloudinaryService.js  (BACKEND)
 * Gera URLs assinadas com expiração — nunca expõe URLs permanentes de documentos.
 */
const crypto = require('crypto');

const CLOUD_NAME  = process.env.CLOUDINARY_CLOUD_NAME;
const API_KEY     = process.env.CLOUDINARY_API_KEY;
const API_SECRET  = process.env.CLOUDINARY_API_SECRET;
const URL_TTL_SEC = 60 * 60; // 1 hora

/**
 * Gera uma URL assinada do Cloudinary que expira em 1 hora.
 * Usa apenas módulos nativos do Node — sem SDK externo.
 *
 * @param {string} publicId  — ex: "istore/documentos/OS-001_1234567890"
 * @returns {string|null}    — URL assinada ou null se credenciais ausentes
 */
const signedUrl = (publicId) => {
  if (!publicId) return null;
  if (!CLOUD_NAME || !API_KEY || !API_SECRET) {
    // Credenciais não configuradas — retorna URL pública como fallback
    return `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/${publicId}`;
  }

  const expiresAt = Math.floor(Date.now() / 1000) + URL_TTL_SEC;

  // String a assinar conforme spec do Cloudinary
  const toSign = `expires_at=${expiresAt}&public_id=${publicId}${API_SECRET}`;
  const signature = crypto.createHash('sha256').update(toSign).digest('hex');

  return (
    `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/` +
    `s--${signature.slice(0, 8)}--/` +
    `fl_attachment,expires_at_${expiresAt}/` +
    `${publicId}`
  );
};

/**
 * Substitui signed_document_url por URL assinada gerada no servidor.
 * Nunca devolve a URL permanente armazenada no banco.
 *
 * @param {object} order — linha da tabela service_orders
 * @returns {object}     — ordem com document_url assinada (sem signed_document_url do banco)
 */
const attachSignedDocumentUrl = (order) => {
  if (!order) return order;

  const { signed_document_url, signed_document_public_id, ...rest } = order;

  return {
    ...rest,
    signed_document_at: order.signed_document_at,
    // Gera URL assinada a partir do public_id — nunca usa a URL permanente
    document_url: signed_document_public_id
      ? signedUrl(signed_document_public_id)
      : null,
    has_document: !!signed_document_public_id,
  };
};

module.exports = { signedUrl, attachSignedDocumentUrl };
